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
  paragraph?: string
  page?: number
  quote?: string
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

async function fetchEmbedOnce(q: string, mode?: 'fast' | 'deep'): Promise<{ embedding: number[]; credits?: CreditsState }> {
  const r = await fetch(`${WORKER_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': localStorage.getItem('snip_device_id') || '' },
    body: JSON.stringify({ query: q, mode }),
  })
  const d = await r.json().catch(() => ({}) as any)
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
    throw e
  }
  if (d.credits?.daily) dispatchCredits(d.credits as CreditsState)
  return { embedding: d.embedding as number[], credits: d.credits }
}

async function embedQuery(q: string, mode?: 'fast' | 'deep'): Promise<number[]> {
  const key = q.trim().toLowerCase()
  // fast всегда идёт на сервер (там списание); deep берём из кэша
  const useCache = mode !== 'fast'
  if (useCache) {
    const hit = embedCache.get(key)
    if (hit) return hit
    const running = inflight.get(key)
    if (running) return running
  }
  const p = (async () => {
    // Авто-ретрай при 429 (лимит Cohere): до 3 попыток, уважаем Retry-After (cap 10с),
    // иначе backoff 1.5с → 3с. 402/4xx кроме 429 — без ретрая. Воркер уже ретраит
    // 429/5xx внутри (3 попытки), так что это второй рубеж против коротких всплесков.
    let lastErr: any = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { embedding } = await fetchEmbedOnce(q, mode)
        return embedding
      } catch (e: any) {
        lastErr = e
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
    embedCache.set(key, v)
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

// ---------- Гибридный поиск → legacy shape ----------

export async function hybridSearchLegacy(
  query: string,
  mode: 'fast' | 'deep',
  topK = mode === 'deep' ? 20 : 10
): Promise<{ results: LegacySearchResult[]; took_ms: number; weak: boolean; degraded?: boolean; degradedReason?: string }> {
  const res: EngineResult = await search(query, { mode, topK, embed: (t) => embedQuery(t, mode) })
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

// ---------- ИИ-ответ через Worker /ask (списание 10⚡ за глубокий поиск) ----------

export interface AskResponse {
  answer: LegacyAnswer
  sources: Array<{ i: number; d: number; p: string; pg: number }>
  credits: CreditsState | null
}

export async function askAI(query: string, mode: 'fast' | 'deep', chunkIds: string[]): Promise<AskResponse> {
  const r = await authFetch(`${WORKER_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, chunkIds: chunkIds.map(Number).slice(0, 5) }),
  })
  if (r.status === 402) {
    const b = await r.json().catch(() => ({} as any))
    throw Object.assign(new Error(b.detail || 'Недостаточно кредитов'), {
      insufficientCredits: true,
      need: Number(b.need) || 0,
    })
  }
  if (!r.ok) throw new Error(`ask failed: ${r.status}`)
  const d = await r.json()
  return {
    answer: {
      answer: d.answer?.answer ?? '',
      quote: d.answer?.quote || undefined,
      paragraph: d.answer?.paragraph || undefined,
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
  history: FollowUpTurn[]
): Promise<AskResponse> {
  const r = await authFetch(`${WORKER_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'deep',
      chunkIds: chunkIds.map(Number).slice(0, 5),
      followUp: true,
      history: history.slice(-2).map((h) => ({ q: h.q.slice(0, 300), a: h.a.slice(0, 800) })),
    }),
  })
  if (r.status === 402) {
    const b = await r.json().catch(() => ({} as any))
    throw Object.assign(new Error(b.detail || 'Недостаточно кредитов'), {
      insufficientCredits: true,
      need: Number(b.need) || 0,
    })
  }
  if (!r.ok) throw new Error(`ask failed: ${r.status}`)
  const d = await r.json()
  if (d.credits?.daily) dispatchCredits(d.credits as CreditsState)
  return {
    answer: {
      answer: d.answer?.answer ?? '',
      quote: d.answer?.quote || undefined,
      paragraph: d.answer?.paragraph || undefined,
      is_grounded: !!d.answer?.is_grounded,
      extractive: !!d.answer?.extractive,
      provider: d.provider || undefined,
    },
    sources: d.sources ?? [],
    credits: (d.credits as CreditsState) ?? null,
  }
}
