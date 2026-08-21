// @ts-nocheck
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { getRecentQueries, getTrendingQueries } from '../utils/analytics'
import { API_BASE, authFetch } from '../utils/api'
import { useToast } from './Toast'

interface QuickSearchProps {
  open: boolean
  onClose: () => void
  onSearch: (query: string) => void
}

/**
 * Command palette / quick search overlay (⌘K / Ctrl+K).
 * Shows recent + trending queries, type to search.
 */
export function QuickSearch({ open, onClose, onSearch }: QuickSearchProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const recent = getRecentQueries(4)
  const trending = getTrendingQueries(4)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSuggestions([])
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // Fetch document suggestions as user types
  useEffect(() => {
    if (!open || query.length < 2) { setSuggestions([]); return }
    const t = setTimeout(async () => {
      try {
        setLoading(true)
        const r = await authFetch(`${API_BASE}/api/documents?limit=5`)
        const docs = await r.json()
        const q = query.toLowerCase()
        setSuggestions(
          docs.filter((d: any) =>
            d.number?.toLowerCase().includes(q) ||
            d.title?.toLowerCase().includes(q)
          ).slice(0, 5)
        )
      } catch {} finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [query, open])

  if (!open) return null

  const handleSubmit = (q: string) => {
    if (!q.trim()) return
    onSearch(q.trim())
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden dark:bg-slate-800 dark:border-slate-700">
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400 shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit(query); if (e.key === 'Escape') onClose() }}
            placeholder="Поиск по нормативам…"
            className="flex-1 outline-none text-[15px] bg-transparent text-slate-900 dark:text-white placeholder:text-slate-400"
          />
          <kbd className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[10px] font-mono text-slate-500">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[350px] overflow-auto">
          {/* Document suggestions */}
          {suggestions.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1">Документы</div>
              {suggestions.map((d: any) => (
                <button key={d.id} onClick={() => handleSubmit(d.number)} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center gap-3 transition">
                  <span className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900 flex items-center justify-center text-blue-600 dark:text-blue-400 text-xs">📄</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-white truncate">{d.number}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{d.title?.slice(0, 60)}</div>
                  </div>
                  {d.status === 'active' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-400">✓</span>}
                </button>
              ))}
            </div>
          )}

          {/* Recent searches */}
          {!query && recent.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1">🕐 Недавние</div>
              {recent.map(q => (
                <button key={q} onClick={() => handleSubmit(q)} className="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-700 dark:text-slate-300 transition">{q}</button>
              ))}
            </div>
          )}

          {/* Trending */}
          {!query && trending.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1">🔥 Популярные</div>
              {trending.map(q => (
                <button key={q} onClick={() => handleSubmit(q)} className="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 text-sm text-slate-700 dark:text-slate-300 transition">{q}</button>
              ))}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="px-5 py-4 text-center text-xs text-slate-400">Поиск документов…</div>
          )}

          {/* Empty */}
          {!query && recent.length === 0 && trending.length === 0 && !loading && (
            <div className="px-5 py-8 text-center">
              <div className="text-sm text-slate-500 dark:text-slate-400">Начните вводить запрос</div>
              <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">Или выберите из недавних / популярных</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-750 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between text-[10px] text-slate-400">
          <span>↑↓ навигация • Enter выбор • Esc закрыть</span>
          <span>snippy.llm</span>
        </div>
      </div>
    </div>
  )
}
