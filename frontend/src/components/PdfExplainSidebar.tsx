import { useCallback, useEffect, useState } from 'react'
import { WORKER_BASE, authFetch } from '../utils/api'
import { useAuth } from '../context/AuthContext'
import { fetchCredits, type CreditsState } from '../utils/credits'
import { Icon } from './Icon'

export interface ExplainItem {
  id: number
  quote: string
  explanation?: string
  error?: string
  cached?: boolean
  truncated?: boolean
}

const SUBSCRIBER_PLANS = ['pro', 'business']

/** Сайдбар-объяснятор: дефиниция выделенного фрагмента норматива. Только для подписчиков. */
export function PdfExplainSidebar({ docNumber, items, onTopUp }: {
  docNumber: string
  items: ExplainItem[]
  onTopUp: () => void
}) {
  const { user } = useAuth()
  const [plan, setPlan] = useState<string | null>(null)
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null)
  const [explainingId, setExplainingId] = useState<number | null>(null)
  const [updateTick, setUpdateTick] = useState(0)

  const refreshPlan = useCallback(async () => {
    const st: CreditsState | null = await fetchCredits()
    setPlan(st?.plan ?? null)
    if (st) setUsage(null)
  }, [])

  useEffect(() => { refreshPlan() }, [refreshPlan])

  const isSubscriber = !!plan && SUBSCRIBER_PLANS.includes(plan)

  const explain = async (item: ExplainItem) => {
    setExplainingId(item.id)
    try {
      const r = await authFetch(`${WORKER_BASE}/api/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.quote, doc_number: docNumber }),
      })
      const d = await r.json().catch(() => ({}) as any)
      if (r.ok && d.explanation) {
        item.explanation = d.explanation
        item.cached = !!d.cached
        if (d.usage) setUsage(d.usage)
        if (d.credits?.plan !== undefined) setPlan(d.credits.plan ?? null)
      } else {
        item.error =
          d.detail ||
          (r.status === 401 ? 'Войдите в аккаунт' :
           r.status === 403 ? 'Только для подписчиков Pro/Business' :
           r.status === 429 ? 'Дневной лимит объяснений исчерпан — обновится в 00:00 UTC' :
           'Не удалось получить объяснение')
      }
    } catch (e: any) {
      item.error = 'Нет соединения с сервером'
    }
    setExplainingId(null)
    setUpdateTick((t) => t + 1)
  }

  return (
    <div className="flex flex-col h-full min-h-0" data-tick={updateTick}>
      {/* Заголовок */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-lg bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center"><Icon name="lightbulb" size={13} /></span>
          <div className="font-semibold text-sm text-slate-900 dark:text-white">Объяснятор Snippy</div>
          {usage && (
            <span className="ml-auto text-[10px] text-slate-400 tabular-nums">{usage.used}/{usage.cap} сегодня</span>
          )}
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
          Выдели текст в документе — Snippy объяснит термин или требование{docNumber ? ` • ${docNumber}` : ''}
        </p>
      </div>

      {/* Контент */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {!user && (
          <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 p-3 text-xs text-blue-800 dark:text-blue-300">
            Войдите и оформите подписку, чтобы объяснять выделенные фрагменты.
          </div>
        )}

        {items.length === 0 && (
          <div className="text-xs text-slate-400 dark:text-slate-500 text-center pt-8 px-4 leading-relaxed">
            <span className="max-md:hidden">Выдели фрагмент текста в PDF слева — здесь появится его объяснение.</span>
            <span className="md:hidden">Выдели фрагмент текста в документе выше — здесь появится его объяснение.</span>
            <br /><br />
            Это не поиск: только определения терминов и требований из выделенного.
          </div>
        )}

        {items.map(item => (
          <div key={item.id} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-3 pt-3 pb-2">
              <div className="text-[11px] font-medium text-slate-400 mb-1 flex items-center gap-1.5 flex-wrap">
                Выделенный фрагмент
                {item.truncated && <span className="px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-400">первые 1500 символов</span>}
                {item.cached && <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400">кэш</span>}
              </div>
              <div className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 max-h-24 overflow-y-auto bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 border border-slate-100 dark:border-slate-800">{item.quote}</div>
            </div>
            <div className="px-3 pb-3">
              {item.explanation ? (
                <div className="text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap">{item.explanation}</div>
              ) : item.error ? (
                <div className="space-y-2">
                  <div className={`text-xs rounded-lg p-2 border ${item.error.includes('подписчик') || item.error.includes('Войдите') ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300' : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900 text-red-700 dark:text-red-400'}`}>{item.error}</div>
                  {(item.error.includes('подписчик') || item.error.includes('Войдите')) && (
                    <button onClick={onTopUp} className="btn btn-sm btn-primary w-full py-2 bg-indigo-600 hover:bg-indigo-700">
                      Оформить подписку <Icon name="arrowRight" size={12} />
                    </button>
                  )}
                </div>
              ) : explainingId === item.id ? (
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span className="w-3.5 h-3.5 border-2 border-slate-300 dark:border-slate-600 border-t-indigo-600 rounded-full animate-spin" />
                  Snippy формулирует определение…
                </div>
              ) : (
                isSubscriber ? (
                  <button onClick={() => explain(item)} className="btn btn-sm w-full py-1.5 bg-indigo-600 text-white hover:bg-indigo-700">Объяснить</button>
                ) : user ? (
                  <button onClick={() => explain(item)} className="btn btn-sm w-full py-1.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"><Icon name="lock" size={11} /> Объяснить (Pro)</button>
                ) : (
                  <button onClick={onTopUp} className="btn btn-sm btn-primary w-full py-1.5 bg-indigo-600 hover:bg-indigo-700">Оформить подписку <Icon name="arrowRight" size={11} /></button>
                )
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 shrink-0" title="Объяснятор отвечает только по выделенному тексту; без источника — не утверждает">
        Дефиниции по выделенному тексту • не является поиском по нормам • Нет источника → нет утверждения
      </div>
    </div>
  )
}
