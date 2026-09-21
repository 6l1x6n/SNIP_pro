import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { ListRow } from './ListRow'
import { getSession, sessionSnippet } from '../utils/sessions'

type HistorySearchModalProps = {
  open: boolean
  history: string[]
  pins: string[]
  activeQuery: string
  onPick: (q: string) => void
  onClose: () => void
}

/**
 * HistorySearchModal — красивый центральный поиск по сессиям истории.
 * Открытие сессии восстанавливает прошлый результат БЕЗ квоты и токенов.
 */
export function HistorySearchModal({
  open,
  history,
  pins,
  activeQuery,
  onPick,
  onClose,
}: HistorySearchModalProps) {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setFilter('')
      setIndex(0)
      setTimeout(() => inputRef.current?.focus(), 60)
    }
  }, [open ])

  const { pinnedShown, restShown } = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const match = (h: string) => !f || h.toLowerCase().includes(f)
    const pinSet = new Set(pins)
    // только записи с сохранённой сессией (открываются без списания токенов)
    return {
      pinnedShown: pins.filter((p) => history.includes(p) && match(p) && getSession(p)),
      restShown: history.filter((h) => !pinSet.has(h) && match(h) && getSession(h)).slice(0, 10),
    }
  }, [history, pins, filter])

  const flat = useMemo(() => [...pinnedShown, ...restShown], [pinnedShown, restShown])

  useEffect(() => {
    setIndex(0)
  }, [filter])

  if (!open) return null

  const choose = (q: string) => {
    if (!q.trim()) return
    onPick(q)
    onClose()
  }

  const row = (h: string, i: number) => {
    const saved = !!getSession(h)
    return (
      <ListRow
        key={h}
        compact
        wholeRow
        className={`transition ${
          i === index ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800'
        } ${h === activeQuery ? 'border-slate-200 dark:border-slate-700' : ''}`}
        lead={
          <span className="text-slate-400 dark:text-slate-500 inline-flex">
            <Icon name={pins.includes(h) ? 'pin' : 'clock'} size={14} />
          </span>
        }
        title={<span className="text-sm font-normal text-slate-700 dark:text-slate-200">{h}</span>}
        titleAttr={h}
        subtitle={
          saved ? <span className="text-slate-400 dark:text-slate-500">{sessionSnippet(getSession(h))}</span> : undefined
        }
        onOpen={() => choose(h)}
        titleOpenLabel={saved ? `Открыть сессию «${h}» бесплатно — токены не спишутся` : `Вставить «${h}» в поиск`}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] p-4" role="dialog" aria-modal="true" aria-label="Поиск по истории">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-[fadeIn_.15s_ease-out]" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-[popIn_.18s_ease-out]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <Icon name="search" size={19} className="text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const target = flat[index] ?? flat[0]
                if (target) choose(target)
              } else if (e.key === 'Escape') {
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((v) => Math.min(v + 1, flat.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((v) => Math.max(v - 1, 0))
              }
            }}
            placeholder="Поиск по сессиям…"
            aria-label="Поиск по сессиям истории"
            className="flex-1 min-w-0 outline-none text-[15px] bg-transparent text-slate-900 dark:text-white placeholder:text-slate-400"
          />
          <kbd className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[10px] font-mono text-slate-500 shrink-0">ESC</kbd>
        </div>

        <div className="max-h-[350px] overflow-y-auto px-3 py-2">
          {flat.length === 0 && (
            <div className="px-2 py-8 text-center">
              <div className="text-sm text-slate-500 dark:text-slate-400">
                {history.length === 0 ? 'История пока пуста' : `Ничего не найдено по «${filter.trim()}»`}
              </div>
              <div className="text-xs text-slate-400 mt-1">Сессии сохраняются после каждого поиска</div>
            </div>
          )}
          {pinnedShown.length > 0 && (
            <div className="pb-1">
              <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1 flex items-center gap-1.5">
                <Icon name="pin" size={11} /> Закреплённые
              </div>
              {pinnedShown.map((h) => row(h, flat.indexOf(h)))}
            </div>
          )}
          {restShown.length > 0 && (
            <div className="pb-1">
              {pinnedShown.length > 0 && (
                <div className="text-[10px] font-semibold text-slate-500 tracking-widest uppercase px-2 py-1 flex items-center gap-1.5">
                  <Icon name="clock" size={11} /> Недавние
                </div>
              )}
              {restShown.map((h) => row(h, flat.indexOf(h)))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
          <span>↑↓ навигация • Enter открыть бесплатно • Esc закрыть</span>
          <span>snippy.llm</span>
        </div>
      </div>
    </div>
  )
}
