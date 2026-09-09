import { useState, useCallback, useRef } from 'react'
import { hybridSearchLegacy, askAI } from '../search/searchClient'
import { dispatchCredits } from '../utils/credits'

export type SearchResult = {
  chunk_id: string
  document_id: string
  document_number: string
  document_title: string
  paragraph?: string
  section?: string
  page?: number
  text: string
  quote: string
  score: number
  relevance_percent: number
  relevance_label: string
  status: string
  source_url?: string
}

export type Answer = {
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

export type SearchResponse = {
  query: string
  mode: string
  answer?: Answer
  results: SearchResult[]
  took_ms: number
  total_found: number
  message?: string
  degraded?: boolean
}

type SearchMode = 'fast' | 'deep'

/**
 * Кэш последнего ответа в sessionStorage: рефреш страницы с ?q= восстанавливает
 * результаты БЕЗ повторного поиска — квота не тратится дважды.
 * Живёт только в пределах вкладки; TTL 2 часа на случай долгоживущих вкладок.
 */
const LAST_RESP_KEY = 'snip_last_resp_v1'
const LAST_RESP_TTL = 2 * 3600 * 1000

interface LastRespCache {
  q: string
  mode: SearchMode
  filterType: string
  filterStatus: string
  savedAt: number
  resp: SearchResponse
}

function saveLastResp(entry: Omit<LastRespCache, 'savedAt'>) {
  try {
    const payload: LastRespCache = { ...entry, savedAt: Date.now() }
    sessionStorage.setItem(LAST_RESP_KEY, JSON.stringify(payload))
  } catch {}
}

export function loadLastResp(q: string, mode: string, filterType: string, filterStatus: string): SearchResponse | null {
  try {
    const raw = sessionStorage.getItem(LAST_RESP_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as LastRespCache
    if (!c || !c.resp) return null
    if (Date.now() - (c.savedAt || 0) > LAST_RESP_TTL) return null
    if (c.q === q && c.mode === mode && (c.filterType || '') === (filterType || '') && (c.filterStatus || '') === (filterStatus || '')) {
      return c.resp as SearchResponse
    }
    return null
  } catch {
    return null
  }
}

interface UseSearchOptions {
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
}

export function useSearch(_opts: UseSearchOptions) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('fast')
  const [loading, setLoading] = useState(false)
  const [resp, setResp] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const r = localStorage.getItem('snip_search_hist')
      return r ? JSON.parse(r) : []
    } catch { return [] }
  })
  const [showHistory, setShowHistory] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('active')
  const [showFilters, setShowFilters] = useState(false)
  const [insufficientCredits, setInsufficientCredits] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const doSearch = useCallback(async (q: string = query) => {
    const trimmed = q.trim()
    if (!trimmed) return
    if (abortRef.current) {
      try { abortRef.current.abort() } catch {}
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setInsufficientCredits(false)
    // Update history
    const qq = trimmed
    setSearchHistory(prev => {
      const next = [qq, ...prev.filter(x => x !== qq)].slice(0, 12)
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
    setShowHistory(false)
    setLoading(true)
    setError(null)

    try {
      // Гибридный поиск — целиком в браузере. fast → 3 результата, deep → до 30.
      // Списание fast (5⚡) происходит внутри /api/embed; 402 прилетает оттуда же.
      // При 429/502 эмбеддингов engine деградирует до BM25-only (degraded) вместо ошибки.
      let allResults, took_ms, weak: boolean, degraded: boolean | undefined, degradedReason: string | undefined
      try {
        ({ results: allResults, took_ms, weak, degraded, degradedReason } = await hybridSearchLegacy(trimmed, mode, mode === 'deep' ? 30 : 3))
      } catch (e: any) {
        if (e?.insufficientCredits) {
          if (!ctrl.signal.aborted) setInsufficientCredits(true)
          return
        }
        throw e
      }

      // фильтры клиента по документам
      let results = allResults
      if (filterStatus && filterStatus !== 'all') {
        results = results.filter(r => r.status === filterStatus)
      }
      if (filterType) {
        results = results.filter(r => r.document_number.toUpperCase().startsWith(filterType.toUpperCase()))
      }
      // Глубокий: отсекаем слабые совпадения (<55%)
      if (mode === 'deep') {
        results = results.filter(r => r.relevance_percent >= 55)
      }

      const respBase: SearchResponse = {
        query: trimmed,
        mode,
        results,
        took_ms,
        total_found: results.length,
        message: degraded && degradedReason
          ? degradedReason
          : weak && !results.length
            ? 'В доступной нормативной базе точного требования не найдено.'
            : undefined,
        degraded,
      }

      if (!ctrl.signal.aborted) {
        setResp(respBase)
        saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: respBase })
      }

      // ИИ-ответ — только в глубоком режиме, /ask списывает 10⚡ при успехе
      if (mode === 'deep' && results.length && !weak && !ctrl.signal.aborted) {
        try {
          const ask = await askAI(trimmed, mode, results.slice(0, 5).map(r => r.chunk_id))
          if (!ctrl.signal.aborted) {
            const full = { ...respBase, answer: ask.answer }
            setResp(full)
            saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: full })
            if (ask.credits) dispatchCredits(ask.credits)
          }
        } catch (e: any) {
          if (e?.insufficientCredits) {
            if (!ctrl.signal.aborted) setInsufficientCredits(true)
            return
          }
          console.warn('ask failed', e)
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      // Дружелюбный текст вместо "embed failed: 502 — cohere embed 429"
      if (e?.rateLimited || e?.status === 429) {
        const wait = typeof e?.retryAfterMs === 'number' ? ` (повтор через ~${Math.max(1, Math.ceil(e.retryAfterMs / 1000))} с)` : ''
        setError(`Лимит эмбеддингов временно исчерпан${wait} — подождите и нажмите поиск ещё раз. Кредиты за неудавшийся векторный поиск не тратятся повторно из кэша.`)
      } else if (typeof e?.message === 'string' && e.message.startsWith('embed failed')) {
        setError('Векторный поиск временно недоступен — попробуйте ещё раз через несколько секунд.')
      } else {
        setError(e.message || 'Ошибка поиска')
      }
    } finally {
      if (abortRef.current === ctrl) setLoading(false)
    }
  }, [query, mode, filterType, filterStatus])

  const clearHistory = useCallback(() => {
    setSearchHistory([])
    try { localStorage.removeItem('snip_search_hist') } catch {}
  }, [])

  const removeHistoryItem = useCallback((item: string) => {
    setSearchHistory(prev => {
      const next = prev.filter(x => x !== item)
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  return {
    query, setQuery,
    mode, setMode,
    loading,
    resp, setResp,
    error,
    searchHistory, clearHistory, removeHistoryItem,
    showHistory, setShowHistory,
    filterType, setFilterType,
    filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    doSearch,
    insufficientCredits,
    setInsufficientCredits,
  }
}
