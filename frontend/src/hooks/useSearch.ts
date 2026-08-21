import { useState, useCallback } from 'react'
import { API_BASE, authFetch } from '../utils/api'

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
  const [searchPinnedOnly, setSearchPinnedOnly] = useState(false)
  const [quotaExceeded, setQuotaExceeded] = useState(false)

  const doSearch = useCallback(async (q: string = query) => {
    if (!q.trim()) return
    setQuotaExceeded(false)
    // Update history
    const qq = q.trim()
    setSearchHistory(prev => {
      const next = [qq, ...prev.filter(x => x !== qq)].slice(0, 12)
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
    setShowHistory(false)
    setLoading(true)
    setError(null)

    const filters: Record<string, string> = {}
    if (filterType) filters.type = filterType
    if (filterStatus) filters.status = filterStatus

    try {
      const r = await authFetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          mode,
          top_k: mode === 'deep' ? 20 : 10,
          filters: Object.keys(filters).length ? filters : undefined,
        }),
      })
      if (r.status === 429) {
        const body = await r.json().catch(() => ({}))
        const msg = body.detail?.message || body.message || 'Лимит запросов исчерпан. Зарегистрируйтесь чтобы продолжить.'
        setQuotaExceeded(true)
        setError(msg)
        return
      }
      if (!r.ok) throw new Error(await r.text())
      const data: SearchResponse = await r.json()
      setResp(data)
    } catch (e: any) {
      setError(e.message || 'Ошибка поиска')
    } finally {
      setLoading(false)
    }
  }, [query, mode, filterType, filterStatus])

  const clearHistory = useCallback(() => {
    setSearchHistory([])
    try { localStorage.removeItem('snip_search_hist') } catch {}
  }, [])

  return {
    query, setQuery,
    mode, setMode,
    loading,
    resp, setResp,
    error,
    searchHistory, clearHistory,
    showHistory, setShowHistory,
    filterType, setFilterType,
    filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    searchPinnedOnly, setSearchPinnedOnly,
    doSearch,
    quotaExceeded,
    setQuotaExceeded,
  }
}
