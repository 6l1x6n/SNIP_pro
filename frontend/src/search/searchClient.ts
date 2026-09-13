/**
 * searchClient.ts — мост между браузерным движком (engine.ts),
 * Worker-эмбеддингами и legacy-форматом ответов для UI (snake_case).
 */
import { loadIndex, search, setEmbedProvider, type SearchResult as EngineResult } from './engine'
import { WORKER_BASE, authFetch } from '../utils/api'
import { dispatchCredits } from '../utils/credits'
import type { CreditsState } from '../utils/credits'

export type { SearchMode } from './engine'

// ---------- Legacy-типы UI (useSearch/SearchView) ----------

export interface LegacySearchResult {
  chunk_id: string
  document_id: string
  document_number: string
  document_title: string
  paragraph?: string
  page?: number
  text: string
  quote: string
  score: number
  relevance_percent: number
  relevance_label: string
  status: string
}

export interface LegacyAnswer {
  answer: string
  normative_basis?: string
  paragraph?: string
  page?: number
  quote?: string
  status?: string
  date_actual?: string
  is_grounded: boolean
  extractive?: boolean
  provider?: string
}

function labelFor(p: number): string {
  if (p >= 85) return 'высокая'
  if (p >= 70) return 'средняя'
  if (p >= 55) return 'низкая'
  return 'слабая'
}

// ---------- Эмбеддинги через Worker (+кэш и дедуп) ----------

const embedCache = new Map<string, number[]>()
const inflight = new Map<string, Promise<number[]>>()
// fast-кэш на 30с: дабл-клик/повтор того же запроса не создаёт новый POST /api/embed
// и не списывает второй раз (серверный refund — второй рубеж, этот — первый).
const FAST_CACHE_TTL_MS = 30_000
const fastCache = new Map<string, { v: number[]; at: number }>()

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

function parseRetryAfterMs(v: string | null, fallbackBody?: any): number | null {
  if (v) {
    const secs = Number(v.trim())
    if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 10_000)
  }
  const b = Number(fallbackBody?.retryAfter)
  if (Number.isFinite(b) && b > 0) return Math.min(b * 1000, 10_000)
  return null
}

async function fetchEmbedOnce(q: string, mode?: 'fast' | 'deep', signal?: AbortSignal): Promise<{ embedding: number[]; credits?: CreditsState }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': localStorage.getItem('snip_device_id') || '',
  }
  // Токен обязателен: иначе fast-списание ляжет в anon:device и админ увидится «Гостем» в логах.
  try {
    const t = localStorage.getItem('snip_token')
    if (t) headers['Authorization'] = `Bearer ${t}`
  } catch {}
  const r = await fetch(`${WORKER_BASE}/api/embed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: q, mode }),
    signal,
  })
  const d = await r.json().catch(() => ({}) as any)
  // Сервер всегда прикладывает свежий баланс (и refunded:true после авто-возврата) —
  // обновляем бейдж даже из ошибок, иначе цифра врёт до истечения TTL.
  if (d?.credits?.daily) dispatchCredits(d.credits as CreditsState)
  if (r.status === 402) {
    throw Object.assign(new Error(d.detail || 'Недостаточно кредитов'), { insufficientCredits: true, need: Number(d?.need) || 0 })
  }
  if (r.status === 429) {
    const retryAfterMs = parseRetryAfterMs(r.headers.get('Retry-After'), d)
    const e: any = new Error(d.detail || 'Лимит провайдера эмбеддингов — повтор через несколько секунд')
    e.rateLimited = true
    e.status = 429
    e.provider = d.provider
    if (retryAfterMs != null) e.retryAfterMs = retryAfterMs
    throw e
  }
  if (!r.ok) {
    const e: any = new Error(`embed failed: ${r.status}${d.detail ? ` — ${d.detail}` : ''}`)
    e.status = r.status
    if (d.provider) e.provider = d.provider
    if (d.refunded) e.refunded = true
    throw e
  }
  // успех: credits уже задиспатчены выше из тела (единая точка обновления бейджа)
  return { embedding: d.embedding as number[], credits: d.credits }
}

async function embedQuery(q: string, mode?: 'fast' | 'deep', signal?: AbortSignal): Promise<number[]> {
  const key = q.trim().toLowerCase()
  if (mode === 'fast') {
    // fast: короткий TTL-кэш + дедуп inflight — повтор не бьёт по квоте.
    const hit = fastCache.get(key)
    if (hit && Date.now() - hit.at < FAST_CACHE_TTL_MS) return hit.v
    const running = inflight.get(key)
    if (running) return running
  } else {
    // deep идёт на сервер бесплатно — берём из кэша
    const hit = embedCache.get(key)
    if (hit) return hit
    const running = inflight.get(key)
    if (running) return running
  }
  const p = (async () => {
    // Авто-ретрай при 429 (лимит Cohere): до 3 попыток, уважаем Retry-After (cap 10с),
    // иначе backoff 1.5с → 3с. 402/4xx кроме 429 — без ретрая. Воркер уже ретраит
    // 429/5xx внутри (3 попытки), так что это второй рубеж против коротких всплесков.
    // Abort — не ретраим: новый поиск уже идёт, серверный refund покрывает снятое.
    let lastErr: any = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
        const { embedding } = await fetchEmbedOnce(q, mode, signal)
        return embedding
      } catch (e: any) {
        lastErr = e
        if (e?.name === 'AbortError') throw e
        if (e?.insufficientCredits) throw e
        const retryable = e?.rateLimited === true || e?.status === 502 || e?.status === 503 || e?.status === 504
        if (!retryable || attempt === 2) throw e
        const waitMs = e?.rateLimited
          ? (typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : [1500, 3000][attempt] ?? 3000)
          : 1500
        console.warn(`embed 429/5xx — повтор ${attempt + 1}/2 через ${Math.round(waitMs)}мс`, e?.provider ?? '', e?.message ?? '')
        await sleep(waitMs + Math.random() * 300)
      }
    }
    throw lastErr ?? new Error('embed failed: retry exhausted')
  })()
  inflight.set(key, p)
  try {
    const v = await p
    if (mode === 'fast') fastCache.set(key, { v, at: Date.now() })
    else embedCache.set(key, v)
    return v
  } finally {
    inflight.delete(key)
  }
}

let initialized = false

/** Вызвать один раз при старте приложения. */
export async function initSearchClient(): Promise<void> {
  if (initialized) return
  setEmbedProvider(embedQuery)
  initialized = true
  await loadIndex().catch((e) => console.error('index load failed', e))
}

/** Эмбеддинг запроса через worker (кэш + дедуп) — для дополнительных кандидатов. */
export async function embedQueryCached(q: string, mode?: 'fast' | 'deep', signal?: AbortSignal): Promise<number[]> {
  return embedQuery(q, mode, signal)
}

// ---------- Понимание запроса (worker /api/rewrite, кэш в памяти) ----------

export interface RewriteResult {
  standalone: string
  queries: string[]
  terms: string[]
}

const rewriteCache = new Map<string, RewriteResult>()
const rewriteInflight = new Map<string, Promise<RewriteResult | null>>()

/** LLM-переформулировка вопроса в поисковые запросы (deep). Fail-open: null → поиск как раньше. */
export async function rewriteQuery(
  query: string,
  opts?: { history?: Array<{ q: string; a: string }>; followUp?: boolean; timeoutMs?: number; signal?: AbortSignal }
): Promise<RewriteResult | null> {
  const q = query.trim()
  if (!q) return null
  const histKey = (opts?.history ?? []).map((h) => `${h.q}|${h.a}`).join('~').slice(0, 400)
  const key = `${opts?.followUp ? 'f' : 'q'}|${q.toLowerCase()}|${histKey}`
  const hit = rewriteCache.get(key)
  if (hit) return hit
  const running = rewriteInflight.get(key)
  if (running) return running
  const p = (async (): Promise<RewriteResult | null> => {
    try {
      const rewriteHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Device-Id': localStorage.getItem('snip_device_id') || '',
      }
      try {
        const t = localStorage.getItem('snip_token')
        if (t) rewriteHeaders['Authorization'] = `Bearer ${t}`
      } catch {}
      const r = await fetch(`${WORKER_BASE}/api/rewrite`, {
        method: 'POST',
        headers: rewriteHeaders,
        body: JSON.stringify({
          query: q,
          followUp: opts?.followUp === true,
          history: (opts?.history ?? []).slice(-2).map((h) => ({ q: h.q.slice(0, 300), a: h.a.slice(0, 500) })),
        }),
        // Сигнал отмены поиска приоритетнее таймаута; иначе — свой таймаут fail-open.
        signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 3500),
      })
      if (!r.ok) return null
      const d = (await r.json()) as Partial<RewriteResult>
      const out: RewriteResult = {
        standalone: typeof d.standalone === 'string' ? d.standalone : q,
        queries: Array.isArray(d.queries) ? d.queries.filter((x): x is string => typeof x === 'string').slice(0, 3) : [],
        terms: Array.isArray(d.terms) ? d.terms.filter((x): x is string => typeof x === 'string').slice(0, 6) : [],
      }
      if (!out.queries.length && out.standalone === q) return null
      rewriteCache.set(key, out)
      return out
    } catch (e) {
      console.warn('rewrite недоступен', e)
      return null
    }
  })()
  rewriteInflight.set(key, p)
  try {
    return await p
  } finally {
    rewriteInflight.delete(key)
  }
}

// ---------- Гибридный поиск → legacy shape ----------

export async function hybridSearchLegacy(
  query: string,
  mode: 'fast' | 'deep',
  topK = mode === 'deep' ? 20 : 10,
  opts?: { extraVariants?: string[]; vectorQueries?: string[]; signal?: AbortSignal }
): Promise<{ results: LegacySearchResult[]; took_ms: number; weak: boolean; degraded?: boolean; degradedReason?: string }> {
  opts?.signal?.throwIfAborted?.()
  const res: EngineResult = await search(query, {
    mode,
    topK,
    embed: (t) => embedQuery(t, mode, opts?.signal),
    extraVariants: opts?.extraVariants,
    vectorQueries: opts?.vectorQueries,
  })
  const results: LegacySearchResult[] = res.hits.map((h) => ({
    chunk_id: String(h.chunk.i),
    document_id: String(h.chunk.d),
    document_number: h.doc?.number ?? '',
    document_title: h.doc?.title ?? '',
    paragraph: h.chunk.p,
    page: h.chunk.pg,
    text: h.chunk.t,
    quote: h.chunk.t.slice(0, 200),
    score: Number(h.vecScore.toFixed(4)),
    relevance_percent: h.relevancePercent,
    relevance_label: labelFor(h.relevancePercent),
    status: h.doc?.status ?? 'active',
  }))
  return { results, took_ms: res.tookMs, weak: res.weak, degraded: res.degraded, degradedReason: res.degradedReason }
}

// ---------- BM25-only fallback без сети и квот (deep без кредитов = 3 как fast) ----------

export async function hybridSearchBm25Only(
  query: string,
  topK = 3,
): Promise<{ results: LegacySearchResult[]; took_ms: number; weak: boolean; degraded?: boolean; degradedReason?: string }> {
  // embed бросает мгновенно без fetch: engine деградирует до локального BM25,
  // провайдерские квоты (embed/rewrite/LLM) и кредиты не тратятся вообще.
  const res: EngineResult = await search(query, {
    mode: 'fast',
    topK,
    embed: async () => {
      throw Object.assign(new Error('no-credits-fallback'), { noNetwork: true })
    },
  })
  const results: LegacySearchResult[] = res.hits.map((h) => ({
    chunk_id: String(h.chunk.i),
    document_id: String(h.chunk.d),
    document_number: h.doc?.number ?? '',
    document_title: h.doc?.title ?? '',
    paragraph: h.chunk.p,
    page: h.chunk.pg,
    text: h.chunk.t,
    quote: h.chunk.t.slice(0, 200),
    score: Number(h.vecScore.toFixed(4)),
    relevance_percent: h.relevancePercent,
    relevance_label: labelFor(h.relevancePercent),
    status: h.doc?.status ?? 'active',
  }))
  return { results, took_ms: res.tookMs, weak: res.weak, degraded: true, degradedReason: res.degradedReason }
}

// ---------- ИИ-ответ через Worker /ask (списание 10⚡ за глубокий поиск) ----------

export interface AskResponse {
  answer: LegacyAnswer
  sources: Array<{ i: number; d: number; p: string; pg: number }>
  credits: CreditsState | null
}

export async function askAI(query: string, mode: 'fast' | 'deep', chunkIds: string[], signal?: AbortSignal): Promise<AskResponse> {
  const r = await authFetch(`${WORKER_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, candidates: chunkIds.map(Number).slice(0, 32) }),
    signal,
  })
  if (r.status === 402) {
    const b = await r.json().catch(() => ({} as any))
    if (b?.credits?.daily) dispatchCredits(b.credits as CreditsState)
    throw Object.assign(new Error(b.detail || 'Недостаточно кредитов'), {
      insufficientCredits: true,
      need: Number(b?.need) || 0,
    })
  }
  if (!r.ok) {
    const b = await r.json().catch(() => ({} as any))
    if (b?.credits?.daily) dispatchCredits(b.credits as CreditsState)
    const e: any = new Error(`ask failed: ${r.status}`)
    e.status = r.status
    throw e
  }
  const d = await r.json()
  return {
    answer: {
      answer: d.answer?.answer ?? '',
      normative_basis: d.answer?.normative_basis || undefined,
      quote: d.answer?.quote || undefined,
      paragraph: d.answer?.paragraph || undefined,
      page: typeof d.answer?.page === 'number' ? d.answer.page : undefined,
      status: d.answer?.status || undefined,
      date_actual: d.answer?.date_actual || undefined,
      is_grounded: !!d.answer?.is_grounded,
      extractive: !!d.answer?.extractive,
      provider: d.provider || undefined,
    },
    sources: d.sources ?? [],
    credits: (d.credits as CreditsState) ?? null,
  }
}

export interface FollowUpTurn {
  q: string
  a: string
}

/** Уточняющий вопрос: поиск не повторяется — переиспользуем chunkIds ответа + историю (до 2 витков). */
export async function askFollowUp(
  query: string,
  chunkIds: string[],
  history: FollowUpTurn[],
  signal?: AbortSignal
): Promise<AskResponse> {
  const r = await authFetch(`${WORKER_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'deep',
      candidates: chunkIds.map(Number).slice(0, 32),
      followUp: true,
      history: history.slice(-2).map((h) => ({ q: h.q.slice(0, 300), a: h.a.slice(0, 800) })),
    }),
    signal,
  })
  if (r.status === 402) {
    const b = await r.json().catch(() => ({} as any))
    if (b?.credits?.daily) dispatchCredits(b.credits as CreditsState)
    throw Object.assign(new Error(b.detail || 'Недостаточно кредитов'), {
      insufficientCredits: true,
      need: Number(b?.need) || 0,
    })
  }
  if (!r.ok) {
    const b = await r.json().catch(() => ({} as any))
    if (b?.credits?.daily) dispatchCredits(b.credits as CreditsState)
    const e: any = new Error(`ask failed: ${r.status}`)
    e.status = r.status
    throw e
  }
  const d = await r.json()
  if (d.credits?.daily) dispatchCredits(d.credits as CreditsState)
  return {
    answer: {
      answer: d.answer?.answer ?? '',
      normative_basis: d.answer?.normative_basis || undefined,
      quote: d.answer?.quote || undefined,
      paragraph: d.answer?.paragraph || undefined,
      page: typeof d.answer?.page === 'number' ? d.answer.page : undefined,
      status: d.answer?.status || undefined,
      date_actual: d.answer?.date_actual || undefined,
      is_grounded: !!d.answer?.is_grounded,
      extractive: !!d.answer?.extractive,
      provider: d.provider || undefined,
    },
    sources: d.sources ?? [],
    credits: (d.credits as CreditsState) ?? null,
  }
}
