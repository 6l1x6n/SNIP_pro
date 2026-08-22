import { useState, useCallback, useRef } from 'react'
import { hybridSearchLegacy, askAI, dispatchCredits } from '../search/searchClient'

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
}

export type SearchResponse = {
  query: string
  mode: string
  answer?: Answer
  results: SearchResult[]
  took_ms: number
  total_found: number
  message?: string
}

type SearchMode = 'fast' | 'deep'

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
  const [quotaExceeded, setQuotaExceeded] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const doSearch = useCallback(async (q: string = query) => {
    const trimmed = q.trim()
    if (!trimmed) return
    if (abortRef.current) {
      try { abortRef.current.abort() } catch {}
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setQuotaExceeded(false)
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
      // 1. Гибридный поиск — целиком в браузере (бесплатно)
      const { results: allResults, took_ms, weak } = await hybridSearchLegacy(trimmed, mode, mode === 'deep' ? 20 : 10)

      // фильтры клиента по документам
      let results = allResults
      if (filterStatus && filterStatus !== 'all') {
        results = results.filter(r => r.status === filterStatus)
      }
      if (filterType) {
        results = results.filter(r => r.document_number.toUpperCase().startsWith(filterType.toUpperCase()))
      }

      const respBase: SearchResponse = {
        query: trimmed,
        mode,
        results,
        took_ms,
        total_found: results.length,
        message: weak && !results.length
          ? 'В доступной нормативной базе точного требования не найдено.'
          : undefined,
      }

      if (!ctrl.signal.aborted) setResp(respBase)

      // 2. ИИ-ответ — Worker /ask со списанием кредитов (только если есть результаты)
      if (results.length && !weak && !ctrl.signal.aborted) {
        try {
          const ask = await askAI(trimmed, mode, results.slice(0, 5).map(r => r.chunk_id))
          if (!ctrl.signal.aborted) {
            setResp({ ...respBase, answer: ask.answer })
            if (ask.creditsRemaining != null) dispatchCredits(ask.creditsRemaining, ask.creditsLimit)
          }
        } catch (e: any) {
          if (e?.quotaExceeded) {
            if (!ctrl.signal.aborted) {
              setQuotaExceeded(true)
              setError(e.message)
              dispatchCredits(0, null)
            }
            return
          }
          console.warn('ask failed', e)
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError(e.message || 'Ошибка поиска')
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
    quotaExceeded,
    setQuotaExceeded,
  }
}
