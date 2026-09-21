import { useEffect, useState, useCallback } from 'react'
import { fetchCredits, availableTotal, type CreditsState } from '../utils/credits'
import { useAuth } from '../context/AuthContext'
import { Icon } from './Icon'

/**
 * Бейдж токенов в хедере: доступно = остаток дневного лимита + накопительный баланс.
 * Обновляется после поисков/покупок (событие snip:credits), при входе/выходе.
 * Клик открывает страницу «Использование».
 */
export function CreditsBadge({ onOpenUsage }: { onOpenUsage?: () => void }) {
  const { user } = useAuth()
  const [state, setState] = useState<CreditsState | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async (force = false) => {
    const c = await fetchCredits(force)
    if (c) { setState(c); setFailed(false) }
    else setFailed(true)
  }, [])

  useEffect(() => {
    // При смене пользователя/выходе — принудительно свежий баланс, не из кэша.
    refresh(true)
    const onCredits = (e: Event) => {
      const d = (e as CustomEvent).detail as CreditsState | undefined
      if (d && d.daily) setState(d)
      else refresh()
    }
    window.addEventListener('snip:credits', onCredits as any)
    return () => window.removeEventListener('snip:credits', onCredits as any)
  }, [user, refresh])

  const shell = 'flex items-center gap-1.5 h-9 px-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shrink-0 transition'

  // Сервис недоступен — заглушка вместо бейджа
  if (failed) {
    return (
      <button onClick={onOpenUsage} title="Токены: сервис временно недоступен" className={`${shell} opacity-70 hover:opacity-100 cursor-pointer`}>
        <Icon name="bolt" size={14} className="text-slate-400" />
        <span className="text-xs font-semibold text-slate-400">—</span>
      </button>
    )
  }

  if (!state) {
    return (
      <div className={`${shell} animate-pulse`} title="Загружаем баланс…">
        <Icon name="bolt" size={14} className="text-slate-300 dark:text-slate-600" />
        <span className="w-7 h-3 rounded bg-slate-100 dark:bg-slate-700" />
      </div>
    )
  }

  const total = availableTotal(state)
  const low = total <= 10

  return (
    <button
      onClick={onOpenUsage}
      title={`Доступно: ${total} токенов\n• Часовой лимит: ${state.daily.remaining} из ${state.daily.limit}\n• Накопительный баланс: ${state.balance}${state.plan ? `\n• План: ${state.plan}` : ''}\nНажмите, чтобы открыть «Использование»`}
      className={`${shell} hover:border-slate-400 dark:hover:border-slate-500 cursor-pointer text-left`}
    >
      <Icon name="bolt" size={14} className={low ? 'text-amber-500' : 'text-slate-400 dark:text-slate-500'} />
      <span className={`text-xs font-semibold tabular-nums ${low ? 'text-amber-600 dark:text-amber-400' : 'text-slate-700 dark:text-slate-200'}`}>
        {total}
      </span>
    </button>
  )
}
