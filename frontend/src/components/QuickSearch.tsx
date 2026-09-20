import { useState, useEffect, useRef } from 'react'
import { getRecentQueries, getTrendingQueries } from '../utils/analytics'
import { Icon } from './Icon'
import { ListRow } from './ListRow'

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

  // Fetch document suggestions as user types (static index)
  useEffect(() => {
    if (!open || query.length < 2) { setSuggestions([]); return }
    const t = setTimeout(async () => {
      try {
        setLoading(true)
        const r = await fetch('/index/docs.json')
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
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden dark:bg-slate-900 dark:border-slate-700">
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <Icon name="search" size={19} className="text-slate-400 shrink-0" />
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
                <ListRow
                  key={d.id}
                  compact
                  wholeRow
                  className="hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                  lead={<span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 inline-flex items-center justify-center text-slate-500 dark:text-slate-400 shrink-0"><Icon name="file" size={14} /></span>}
                  title={<span className="text-slate-900 dark:text-white">{d.number}</span>}
                  titleAttr={d.number}
                  subtitle={<span className="text-slate-500 dark:text-slate-400">{d.title?.slice(0, 60)}</span>}
                  subtitleAttr={d.title}
                  onOpen={() => handleSubmit(d.number)}
                  titleOpenLabel={`Искать ${d.number}`}
                  trail={d.status === 'active'
                    ? <span className="w-5 h-5 shrink-0 inline-flex items-center justify-center text-emerald-600 dark:text-emerald-400"><Icon name="check" size={13} /></span>
                    : <span className="w-5 h-5 shrink-0" aria-hidden />}
                />
              ))}
            </div>
          )}

          {/* Recent searches */}
          {!query && recent.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1 flex items-center gap-1.5"><Icon name="clock" size={11} /> Недавние</div>
              {recent.map(q => (
                <ListRow
                  key={q}
                  compact
                  wholeRow
                  className="hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                  lead={<span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 inline-flex items-center justify-center text-slate-400 shrink-0"><Icon name="clock" size={13} /></span>}
                  title={<span className="text-sm font-normal text-slate-700 dark:text-slate-300">{q}</span>}
                  titleAttr={q}
                  onOpen={() => handleSubmit(q)}
                  titleOpenLabel={`Искать ${q}`}
                />
              ))}
            </div>
          )}

          {/* Trending */}
          {!query && trending.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1 flex items-center gap-1.5"><Icon name="flame" size={11} /> Популярные</div>
              {trending.map(q => (
                <ListRow
                  key={q}
                  compact
                  wholeRow
                  className="hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                  lead={<span className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-slate-800 inline-flex items-center justify-center text-slate-400 shrink-0"><Icon name="flame" size={13} /></span>}
                  title={<span className="text-sm font-normal text-slate-700 dark:text-slate-300">{q}</span>}
                  titleAttr={q}
                  onOpen={() => handleSubmit(q)}
                  titleOpenLabel={`Искать ${q}`}
                />
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
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
          <span>↑↓ навигация • Enter выбор • Esc закрыть</span>
          <span>snippy.llm</span>
        </div>
      </div>
    </div>
  )
}
