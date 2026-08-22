import { useEffect, useState, useCallback } from 'react'
import { fetchCredits } from '../search/searchClient'
import { useAuth } from '../context/AuthContext'

/**
 * ⚡ 20/30 в хедере: остаток ИИ-кредитов на сегодня.
 * Обновляется после каждого /ask (событие snip:credits) и при входе/выходе.
 */
export function CreditsBadge() {
  const { user } = useAuth()
  const [credits, setCredits] = useState<{ remaining: number; limit: number } | null>(null)

  const refresh = useCallback(async () => {
    const c = await fetchCredits()
    if (c) setCredits({ remaining: c.remaining, limit: c.limit })
  }, [])

  useEffect(() => {
    refresh()
    const onCredits = (e: Event) => {
      const d = (e as CustomEvent).detail as { remaining: number; limit: number }
      if (d && typeof d.remaining === 'number') setCredits({ remaining: d.remaining, limit: d.limit })
      else refresh()
    }
    window.addEventListener('snip:credits', onCredits as any)
    return () => window.removeEventListener('snip:credits', onCredits as any)
  }, [user, refresh])

  if (!credits || !credits.limit) return null
  const pct = Math.max(0, Math.min(100, Math.round((credits.remaining / credits.limit) * 100)))
  const low = pct <= 33

  return (
    <div
      title={`ИИ-ответы на сегодня: ${credits.remaining} из ${credits.limit} (10 кредитов = 1 ответ). Поиск — бесплатный.`}
      className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0"
    >
      <span className={`text-xs ${low ? 'text-amber-500' : 'text-slate-400 dark:text-slate-500'}`}>⚡</span>
      <span className={`text-xs font-semibold tabular-nums ${low ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200'}`}>
        {credits.remaining}/{credits.limit}
      </span>
      <span className="w-8 h-1 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
        <span
          className={`block h-full rounded-full transition-all ${low ? 'bg-amber-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  )
}
