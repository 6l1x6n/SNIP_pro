/**
 * searchClient.ts — мост между браузерным движком (engine.ts),
 * Worker-эмбеддингами и legacy-форматом ответов для UI (snake_case).
 */
import { loadIndex, search, setEmbedProvider, type SearchResult as EngineResult } from './engine'
import { WORKER_BASE, authFetch } from '../utils/api'

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

async function embedQuery(q: string): Promise<number[]> {
  const key = q.trim().toLowerCase()
  const hit = embedCache.get(key)
  if (hit) return hit
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const r = await fetch(`${WORKER_BASE}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': localStorage.getItem('snip_device_id') || '' },
      body: JSON.stringify({ query: q }),
    })
    if (!r.ok) throw new Error(`embed failed: ${r.status}`)
    const d = await r.json()
    return d.embedding as number[]
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
): Promise<{ results: LegacySearchResult[]; took_ms: number; weak: boolean }> {
  const res: EngineResult = await search(query, { mode, topK, embed: embedQuery })
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
  return { results, took_ms: res.tookMs, weak: res.weak }
}

// ---------- ИИ-ответ через Worker /ask (списание кредитов) ----------

export interface AskResponse {
  answer: LegacyAnswer
  sources: Array<{ i: number; d: number; p: string; pg: number }>
  creditsRemaining: number | null
  creditsLimit: number | null
}

export async function askAI(query: string, mode: 'fast' | 'deep', chunkIds: string[]): Promise<AskResponse> {
  const r = await authFetch(`${WORKER_BASE}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode, chunkIds: chunkIds.map(Number).slice(0, 5) }),
  })
  if (r.status === 429) {
    const b = await r.json().catch(() => ({} as any))
    throw Object.assign(new Error(b.detail || 'Лимит исчерпан'), { quotaExceeded: true })
  }
  if (!r.ok) throw new Error(`ask failed: ${r.status}`)
  const d = await r.json()
  return {
    answer: {
      answer: d.answer?.answer ?? '',
      quote: d.answer?.quote || undefined,
      paragraph: d.answer?.paragraph || undefined,
      is_grounded: !!d.answer?.is_grounded,
    },
    sources: d.sources ?? [],
    creditsRemaining: r.headers.get('X-Credits-Remaining') ? Number(r.headers.get('X-Credits-Remaining')) : null,
    creditsLimit: r.headers.get('X-Credits-Limit') ? Number(r.headers.get('X-Credits-Limit')) : null,
  }
}

export async function fetchCredits(): Promise<{ remaining: number; limit: number } | null> {
  try {
    const r = await authFetch(`${WORKER_BASE}/api/credits`)
    if (!r.ok) return null
    const d = await r.json()
    return { remaining: Math.max(0, d.limit - d.used), limit: d.limit }
  } catch {
    return null
  }
}

/** Диспетчер обновления бейджа кредитов (после /ask или вручную). */
export function dispatchCredits(remaining?: number | null, limit?: number | null): void {
  window.dispatchEvent(new CustomEvent('snip:credits', { detail: { remaining, limit } }))
}
