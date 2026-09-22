import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { HighlightPaletteSettings } from './HighlightPaletteSettings'
import type { PaletteId, ContextMarkMode } from '../utils/highlight'
import { isSemanticMode, setSemanticMode } from '../search/engine'
import { loadQuickExamples, saveQuickExamples, resetQuickExamples, QUICK_EXAMPLES_MAX } from '../utils/examples'
import { ConfirmDialog } from './ConfirmDialog'
import { isAdminEmail, BILLING_DISABLED_HINT } from '../utils/admin'
import { Icon } from './Icon'
import { ListRow } from './ListRow'
import { ResetTimer } from './ResetTimer'
import {
  fetchCredits, fetchCreditHistory, purchaseDemo,
  FAST_COST, DEEP_COST, CATALOG,
  type CreditsState, type LedgerItem,
} from '../utils/credits'
import { authFetch, WORKER_BASE } from '../utils/api'



/** Логика привязки Telegram: ссылка-токен + поллинг подтверждения из бота. */
function useTelegramLink(user: any) {
  const [linkedName, setLinkedName] = useState<string | null>(user?.tg_username ?? null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refreshMe = async (): Promise<string | null> => {
    const r = await authFetch(`${WORKER_BASE}/api/me`)
    if (!r.ok) return null
    const d = await r.json().catch(() => ({}))
    return d?.telegram?.linked ? (d.telegram.username || 'привязан') : null
  }

  const link = async (): Promise<boolean> => {
    setErr(null); setBusy(true)
    try {
      const r = await authFetch(`${WORKER_BASE}/api/tg/link`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(d.detail || d.error || 'Бот недоступен'); return false }
      window.open(d.url, '_blank', 'noopener')
      setWaiting(true)
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 3000))
        const name = await refreshMe()
        if (name) { setLinkedName(name); setWaiting(false); return true }
      }
      setWaiting(false)
      setErr('Не дождались подтверждения. Попробуйте ещё раз — ссылка живёт 15 минут.')
      return false
    } catch { setErr('Не удалось соединиться с сервером'); return false } finally { setBusy(false) }
  }

  const unlink = async () => {
    setBusy(true)
    try { await authFetch(`${WORKER_BASE}/api/tg/unlink`, { method: 'POST' }); setLinkedName(null) }
    catch { setErr('Не удалось отвязать') } finally { setBusy(false) }
  }

  return { linkedName, busy, waiting, err, link, unlink }
}

/** Ячейка Telegram в сетке профиля. */
function TelegramLink({ tg }: { tg: ReturnType<typeof useTelegramLink> }) {
  const { linkedName, busy, waiting, err, link, unlink } = tg
  return (
    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl px-3 py-2.5 border border-slate-200 dark:border-slate-700">
      <div className="text-xs text-slate-500 dark:text-slate-400">Telegram</div>
      {linkedName ? (
        <>
          <div className="font-medium text-slate-900 dark:text-white mt-0.5">{linkedName.startsWith('@') ? linkedName : `@${linkedName}`}</div>
          <button onClick={unlink} disabled={busy} className="text-xs text-slate-400 hover:text-red-500 mt-1 underline">Отвязать</button>
        </>
      ) : (
        <>
          <div className="font-medium text-slate-900 dark:text-white mt-0.5">Не привязан</div>
          <button onClick={link} disabled={busy || waiting} className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1">
            {waiting ? 'Ждём подтверждения в боте…' : busy ? 'Готовим ссылку…' : 'Привязать'}
          </button>
        </>
      )}
      {err && <div className="text-xs text-red-600 dark:text-red-400 mt-2">{err}</div>}
    </div>
  )
}

function stringToColor(str: string) {
  let hash = 0
  for (let i=0;i<str.length;i++) hash = str.charCodeAt(i) + ((hash<<5)-hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h} 70% 45%)`
}

type SectionId = 'overview' | 'usage' | 'help' | 'billing' | 'settings'

const SECTIONS: {id: SectionId, label: string}[] = [
  {id:'overview', label:'Обзор'},
  {id:'usage', label:'Использование'},
  {id:'help', label:'Помощь'},
  {id:'billing', label:'Оплата'},
  {id:'settings', label:'Настройки'},
]


function displayNameFromEmail(email: string): string {
  const local = (email || '').split('@')[0] || 'Архитектор'
  const parts = local.replace(/[._\-+]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'Архитектор'
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
}




const KIND_LABELS: Record<string, string> = {
  spend_fast: 'Быстрый поиск',
  spend_deep: 'Глубокий поиск',
  spend_followup: 'Уточняющий вопрос',
  purchase: 'Пополнение баланса',
  subscription: 'Подписка',
  grant: 'Бонус',
}
function kindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]
  if (kind.startsWith('refund')) return 'Возврат токенов'
  return kind
}

/** Страница «Оплата»: подписки (часовой лимит) + разовые пакеты токенов. Демо-активация — только админам. */
export function BillingSection() {
  const { user } = useAuth()
  const isAdmin = isAdminEmail(user?.email)
  const [purchasing, setPurchasing] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [credits, setCredits] = useState<CreditsState | null>(null)

  useEffect(() => { fetchCredits(true).then(setCredits) }, [user?.id])

  const currentPlan = credits?.plan === 'pro' ? 'sub_pro' : credits?.plan === 'business' ? 'sub_business' : 'free'

  const buy = async (sku: string, label: string) => {
    if (!isAdmin) {
      setNotice({ ok: false, text: BILLING_DISABLED_HINT })
      return
    }
    setPurchasing(sku)
    setNotice(null)
    const res = await purchaseDemo(sku)
    if (res.ok) {
      setNotice({ ok: true, text: sku === 'free' ? '«Free» активирован (демо). Подписка отменена.' : `«${label}» активирован (демо). Токены зачислены.` })
      const s = await fetchCredits()
      setCredits(s)
    } else {
      setNotice({ ok: false, text: res.detail || 'Не удалось активировать' })
    }
    setPurchasing(null)
  }

  const fmt = (n: number) => n.toLocaleString('ru-RU')
  const disabledHint = !isAdmin ? BILLING_DISABLED_HINT : undefined

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-md:p-4">
        <h3 className="font-semibold text-slate-900 dark:text-white">Оплата</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Тарифы и пополнение появятся после бета-тестирования • сейчас сервис бесплатен</p>
        {!isAdmin && (
          <div className="mt-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
            <Icon name="clock" size={14} className="mt-0.5 shrink-0" />
            <div><b>Сервис в бета-тестировании.</b> Оплата и пополнение баланса будут добавлены позже — все лимиты сейчас бесплатны.</div>
          </div>
        )}
        <div className="mt-3 p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900 text-xs text-indigo-800 dark:text-indigo-300 flex items-start gap-2">
          <Icon name="lightbulb" size={14} className="mt-0.5 shrink-0" />
          <div>
            <b>Как работает квота.</b> Каждый час зарегистрированным начисляется <b>300 токенов</b> — неизрасходованный остаток сгорает в начале следующего часа. Списание идёт сначала с часового лимита, затем с накопительного баланса (пакеты на балансе не сгорают).
            {credits && <> Доступно сейчас: <b>{credits.daily.remaining}</b> {credits.reset === 'hourly' ? 'в этом часе' : 'сегодня'} + <b>{credits.balance}</b> на балансе.</>}
          </div>
        </div>
        {notice && (
          <div className={`mt-3 p-3 rounded-xl border text-xs ${notice.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-700'}`}>{notice.text}</div>
        )}

        {/* Подписки */}
        <div className="mt-5 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">Подписки — лимит</div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          {CATALOG.plans.map(p => {
            const active = currentPlan === p.sku
            const locked = !isAdmin
            // Будущие тарифы скрыты блюром до конца беты; Free — текущее состояние, виден.
            return (
              <div key={p.sku} className={`rounded-2xl border-2 p-5 bg-white dark:bg-slate-900 flex flex-col ${active ? 'border-slate-900' : 'border-slate-200 dark:border-slate-700'}`}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-slate-900 dark:text-white">{p.label}</div>
                  {active && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-900 text-white">активен</span>}
                </div>
                {p.sku !== 'free' ? (
                  <div className="relative mt-1 flex-1 flex flex-col">
                    <div className="beta-blur flex-1" aria-hidden>
                      <div className="text-2xl font-bold text-slate-900 dark:text-white">{fmt(p.price)} ₸ <span className="text-xs font-normal text-slate-500 dark:text-slate-400">/ мес</span></div>
                      <ul className="text-xs text-slate-600 dark:text-slate-300 mt-3 space-y-1 list-disc ml-4">
                        {p.perks.map(perk => <li key={perk}>{perk}</li>)}
                      </ul>
                    </div>
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="badge bg-white dark:bg-slate-900 shadow-sm text-xs px-3 py-1.5">Скоро</span>
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">0 ₸ <span className="text-xs font-normal text-slate-500 dark:text-slate-400">/ мес</span></div>
                    <ul className="text-xs text-slate-600 dark:text-slate-300 mt-3 space-y-1 list-disc ml-4 flex-1">
                      {p.perks.map(perk => <li key={perk}>{perk}</li>)}
                    </ul>
                  </>
                )}
                <button
                  disabled={active || purchasing !== null || locked}
                  title={locked ? disabledHint : undefined}
                  onClick={() => buy(p.sku, p.label)}
                  className={`mt-4 px-3 py-2 rounded-xl text-xs font-semibold transition ${active || locked ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50'}`}
                >
                  {active ? 'Текущий план' : locked ? <span className="inline-flex items-center gap-1"><Icon name="lock" size={11} /> Недоступно</span> : purchasing === p.sku ? 'Активируем…' : p.sku === 'free' ? 'На Free (демо)' : 'Активировать (демо)'}
                </button>
              </div>
            )
          })}
        </div>

        {/* Пакеты */}
        <div className="mt-6 text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">Пакеты токенов — на баланс, не сгорают</div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          {CATALOG.packs.map(pk => (
            <div key={pk.sku} className="rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-md:p-4 bg-white dark:bg-slate-900 flex flex-col hover:border-slate-300 dark:hover:border-slate-600 transition">
              <div className="text-sm font-bold text-slate-900 dark:text-white">{pk.label}</div>
              <div className="relative mt-1">
                <div className="beta-blur" aria-hidden>
                  <div className="text-2xl font-bold text-slate-900 dark:text-white inline-flex items-center gap-1">{fmt(pk.credits)}<Icon name="bolt" size={16} className="text-slate-400 dark:text-slate-500" /></div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{fmt(pk.price)} ₸ • ≈{Math.round(pk.price / pk.credits)} ₸ за токен</div>
                </div>
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="badge bg-white dark:bg-slate-900 shadow-sm text-xs px-3 py-1.5">Скоро</span>
                </span>
              </div>
              <button
                disabled={purchasing !== null || !isAdmin}
                title={!isAdmin ? disabledHint : undefined}
                onClick={() => buy(pk.sku, pk.label)}
                className="btn btn-sm btn-primary mt-4 py-2"
              >
                {!isAdmin ? <><Icon name="lock" size={11} /> Недоступно</> : purchasing === pk.sku ? 'Зачисляем…' : 'Купить (демо)'}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-5 text-[11px] text-slate-400 leading-relaxed">
          Списание: сначала бесплатный часовой лимит (300 токенов каждый час для зарегистрированных), затем накопительный баланс. Быстрый поиск — {FAST_COST} токенов, глубокий — {DEEP_COST}.
          Оплата будет добавлена после бета-тестирования.
        </div>
      </div>
    </div>
  )
}


export function CreditsPanel({ onTopUp }: { onTopUp?: () => void }) {
  const { user } = useAuth()
  const isAdmin = isAdminEmail(user?.email)
  const [state, setState] = useState<CreditsState | null>(null)
  const [history, setHistory] = useState<LedgerItem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [s, h] = await Promise.all([fetchCredits(true), fetchCreditHistory(20)])
    setState(s)
    setHistory(h)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh, user?.id])

  const pct = state && state.daily.limit ? Math.min(100, Math.round((state.daily.remaining / state.daily.limit) * 100)) : 0

  if (loading && !state) return <div className="text-sm text-slate-500 dark:text-slate-400 p-4">Загружаем баланс…</div>
  if (!state) return (
    <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
      Не удалось загрузить баланс — сервис токенов временно недоступен.
      <button onClick={refresh} className="ml-2 underline">Повторить</button>
    </div>
  )

  const topUpLocked = !!user && !isAdmin

  return (
    <div className="space-y-4">
      {/* Баланс */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="text-xs text-blue-700 font-medium">{state.reset === 'daily' ? 'Дневной лимит (бесплатно)' : 'Часовой лимит (бесплатно)'}</div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1">{state.daily.remaining}<span className="text-sm text-slate-500 dark:text-slate-400 font-normal"> / {state.daily.limit}</span></div>
          <div className="mt-2 h-1.5 rounded-full bg-white dark:bg-slate-900 overflow-hidden"><div className="h-full rounded-full bg-slate-900 dark:bg-white transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="text-[11px] text-blue-600 mt-1.5">Обновляется каждый час • пополнение через <ResetTimer />{state.plan && state.plan !== 'free' ? ` • план повышает лимит` : ''}</div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-xs text-emerald-700 font-medium">Накопительный баланс</div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 inline-flex items-center gap-1">{state.balance}<Icon name="bolt" size={16} className="text-emerald-500" /></div>
          <div className="text-[11px] text-emerald-700 mt-3">Пакеты токенов — не сгорают</div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">Тариф</div>
          <div className="text-2xl font-bold text-slate-900 dark:text-white mt-1 capitalize">{state.plan === 'pro' ? 'Pro' : state.plan === 'business' ? 'Business' : 'Free'}</div>
          {topUpLocked ? (
            <button disabled title={BILLING_DISABLED_HINT} className="btn btn-sm mt-2 bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed"><Icon name="lock" size={11} /> Пополнение скоро</button>
          ) : (
            <button onClick={onTopUp} disabled={!onTopUp} title={!onTopUp ? 'Войдите, чтобы пополнять баланс' : undefined} className="btn btn-sm mt-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200"><Icon name="plus" size={11} /> Пополнить баланс</button>
          )}
          {topUpLocked && <div className="text-[11px] text-slate-400 mt-1.5">Пополнение появится после беты</div>}
          {!user && <div className="text-[11px] text-slate-400 mt-1.5">Пополнение доступно после входа</div>}
        </div>
      </div>

      {/* Тарифы списания */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-center justify-between"><span className="text-slate-600 dark:text-slate-300">Быстрый поиск — 3 результата</span><span className="font-bold text-slate-900 dark:text-white inline-flex items-center gap-1"><Icon name="bolt" size={12} className="text-slate-400" />{FAST_COST}</span></div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 flex items-center justify-between"><span className="text-slate-600 dark:text-slate-300">Глубокий — до 30 результатов + ответ</span><span className="font-bold text-slate-900 dark:text-white inline-flex items-center gap-1"><Icon name="bolt" size={12} className="text-slate-400" />{DEEP_COST}</span></div>
      </div>

      {/* История */}
      <div>
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase mb-2">Последние операции</div>
        {history.length === 0 ? (
          <div className="text-sm text-slate-400 p-4 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-center">Операций пока нет — сделайте первый поиск</div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
            {history.map(item => (
              <ListRow
                key={item.id}
                compact
                className="rounded-none border-0 px-4 py-2.5"
                lead={
                  <span className={`w-7 h-7 rounded-full inline-flex items-center justify-center shrink-0 text-sm leading-none ${item.delta > 0 ? 'bg-emerald-50 text-emerald-600' : item.delta < 0 ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' : 'bg-blue-50 text-blue-600'}`}>
                    {item.delta > 0 ? '+' : item.delta < 0 ? '−' : '•'}
                  </span>
                }
                title={<span className="font-medium text-slate-800 dark:text-slate-100">{kindLabel(item.kind)}</span>}
                titleAttr={kindLabel(item.kind)}
                subtitle={<span className="text-slate-400">{new Date(item.created_at).toLocaleString('ru-RU')}</span>}
                subtitleAttr={new Date(item.created_at).toLocaleString('ru-RU')}
                trail={
                  <span className={`font-semibold tabular-nums inline-flex items-center justify-end gap-1 whitespace-nowrap ${item.delta > 0 ? 'text-emerald-600' : item.delta < 0 ? 'text-slate-500 dark:text-slate-400' : 'text-slate-400'}`}>
                    {item.delta !== 0 ? <>{item.delta > 0 ? '+' : ''}{item.delta}<Icon name="bolt" size={11} /></> : '—'}
                  </span>
                }
                trailWide
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Редактор имени: первая установка свободна, дальше — раз в 30 дней + ахтунг-подтверждение. */
function NameEditor() {
  const { user, updateName } = useAuth()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(user?.full_name ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  useEffect(() => { if (!editing) setValue(user?.full_name ?? '') }, [user?.full_name, editing])

  if (!user) return null
  const current = user.full_name || displayNameFromEmail(user.email)
  const isFirst = !user.full_name
  const cooldownUntil = user.name_can_change_at ? new Date(user.name_can_change_at) : null
  const locked = !!cooldownUntil && cooldownUntil.getTime() > Date.now() && !isFirst

  const doSave = async () => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (v.length < 2) { setErr('Имя — минимум 2 символа'); return }
    if (v.length > 50) { setErr('Имя — максимум 50 символов'); return }
    if (v === (user.full_name ?? '')) { setEditing(false); return }
    setSaving(true); setErr(null)
    try {
      await updateName(v)
      setEditing(false)
    } catch (e: any) {
      setErr(e.message || 'Не удалось сменить имя')
    } finally {
      setSaving(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div>
      {!editing ? (
        <div>
          <div className="font-medium text-slate-900 dark:text-white mt-0.5 truncate">{current}</div>
          <div className="text-[11px] text-slate-400 mt-1">
            {isFirst ? 'Дальше смена раз в 30 дней' : locked
              ? `Смена с ${cooldownUntil!.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`
              : 'Смена раз в 30 дней'}
          </div>
          {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
          <button
            onClick={() => { setErr(null); setValue(user.full_name ?? ''); setEditing(true) }}
            disabled={locked}
            title={locked ? `Подождите до ${cooldownUntil!.toLocaleDateString('ru-RU')}` : 'Изменить имя'}
            className="btn btn-sm btn-secondary mt-1.5 py-1"
          ><Icon name="edit" size={12} /> Изменить</button>
        </div>
      ) : (
        <div className="mt-1.5">
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            maxLength={50}
            placeholder="Например: Айдос Проектировщик"
            className="input"
          />
          {err && <div className="text-[11px] text-red-600 mt-1">{err}</div>}
          <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1"><Icon name="alertCircle" size={12} /> Имя меняется раз в 30 дней. Проверьте написание перед сохранением.</div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={saving || value.replace(/\s+/g, ' ').trim().length < 2}
              className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200"
            >{saving ? 'Сохраняем…' : 'Сохранить'}</button>
            <button onClick={() => { setEditing(false); setErr(null) }} className="btn btn-sm btn-secondary">Отмена</button>
          </div>
          <ConfirmDialog
            open={confirmOpen}
            title="Имя меняется раз в месяц!"
            message={`Новое имя: «${value.replace(/\s+/g, ' ').trim()}». Следующая смена будет доступна только через 30 дней. Всё верно?`}
            confirmLabel="Да, сменить имя"
            cancelLabel="Проверить ещё"
            danger
            onConfirm={doSave}
            onCancel={() => setConfirmOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

/** Карточка нормативной базы: что реально доступно в поиске (общий пакет, не «личные доки»). */
function NormsStats({ stats, docs }: { stats?: any; docs?: any[] }) {
  const total = stats?.total_documents ?? docs?.length ?? null
  const active = stats?.active_documents ?? (docs ? docs.filter(d => d.status === 'active').length : null)
  const chunks = stats?.total_chunks ?? null
  const built = stats?.builtAt ? new Date(stats.builtAt).toLocaleDateString('ru-RU') : null
  const byType = (() => {
    if (!docs?.length) return null
    const m = new Map<string, number>()
    for (const d of docs) m.set(String(d.type || '—'), (m.get(String(d.type || '—')) ?? 0) + 1)
    return [...m.entries()].slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' • ')
  })()
  return (
    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 border border-slate-200 dark:border-slate-700 md:col-span-2">
      <div className="text-xs text-slate-500 dark:text-slate-400">Нормативная база в поиске</div>
      <div className="font-medium text-slate-900 dark:text-white mt-1.5">
        {total != null ? `${total} док.` : '—'}{active != null ? ` • ${active} действ.` : ''}{chunks != null ? ` • ${Number(chunks).toLocaleString('ru-RU')} фрагментов` : ''}
      </div>
      <div className="text-[11px] text-slate-400 mt-1">
        {byType ? `${byType}` : 'Единый пакет норм РК для всех пользователей'}{built ? ` • обновлено ${built}` : ''}
      </div>
    </div>
  )
}

/** Тумблер смыслового режима поиска (состояние живёт в search/engine + localStorage). */
function SemanticToggle() {
  const [on, setOn] = useState(() => isSemanticMode())
  return (
    <div className="mt-3 flex items-center gap-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700">
      <button
        role="switch"
        aria-checked={on}
        onClick={() => { const v = !on; setOn(v); setSemanticMode(v) }}
        className={`relative w-11 h-6 rounded-full transition shrink-0 ${on ? 'bg-slate-900 dark:bg-white' : 'bg-slate-300 dark:bg-slate-600'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px] dark:bg-slate-900' : 'left-0.5'}`} />
      </button>
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900 dark:text-white">Смысловой поиск {on ? 'включён' : 'выключен'}</div>
        <div className="text-[11px] text-slate-400">Векторный приоритет + расширенные синонимы • применяется к следующему поиску</div>
      </div>
    </div>
  )
}

/** Карточка активности пользователя: акция, участие, операции. */
function ActivityStats() {
  const { user } = useAuth()
  const [spent, setSpent] = useState<number | null>(null)
  const [ops, setOps] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    fetchCreditHistory(100).then(items => {
      if (!alive) return
      setOps(items.length)
      setSpent(items.reduce((s, it) => s + (it.delta < 0 ? -it.delta : 0), 0))
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  const since = user?.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : null
  return (
    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 border border-slate-200 dark:border-slate-700 md:col-span-2">
      <div className="text-xs text-slate-500 dark:text-slate-400">Ваша статистика</div>
      <div className="font-medium text-slate-900 dark:text-white mt-1.5">
        Акция: 300 токенов каждый час{spent != null && spent > 0 ? ` • потрачено ${spent}` : ''}{ops != null && ops > 0 ? ` • операций: ${ops}` : ''}
      </div>
      <div className="text-[11px] text-slate-400 mt-1">
        Быстрый поиск — {FAST_COST} токенов • глубокий — {DEEP_COST}{since ? ` • с нами с ${since}` : ''}
      </div>
    </div>
  )
}

export function ProfilePage({ stats, docs, onLogout, highlightPalette, setHighlightPalette, monoHex, setMonoHex, contextMarkMode, setContextMarkMode, initialSection }: {
  stats?: any,
  docs?: any[],
  onLogout?: ()=>void,
  highlightPalette?: PaletteId,
  setHighlightPalette?: (v:PaletteId)=>void,
  monoHex?: string,
  setMonoHex?: (v:string)=>void,
  contextMarkMode?: ContextMarkMode,
  setContextMarkMode?: (v:ContextMarkMode)=>void,
  initialSection?: string | null,
}) {
  const { user, logout } = useAuth()
  const [section, setSection] = useState<SectionId>((initialSection as SectionId) || 'overview')
  const tg = useTelegramLink(user)
  // Компактное предложение привязать ТГ: один раз при входе в профиль,
  // не чаще раза в 3 дня (localStorage), и только если ещё не привязан
  const [tgPrompt, setTgPrompt] = useState(false)
  useEffect(() => {
    if (section !== 'overview' || tg.linkedName || tg.waiting) return
    try {
      const last = Number(localStorage.getItem('snip_tg_prompt_at') ?? 0)
      if (Date.now() - last > 3 * 86400000) setTgPrompt(true)
    } catch { setTgPrompt(true) }
  }, [section, tg.linkedName, tg.waiting]) // eslint-disable-line
  const dismissTgPrompt = () => {
    setTgPrompt(false)
    try { localStorage.setItem('snip_tg_prompt_at', String(Date.now())) } catch {}
  }

  // Navigate to a section when requested from outside (e.g. the profile dropdown menu)
  useEffect(() => {
    if (initialSection) setSection(initialSection as SectionId)
  }, [initialSection])

  // --- Quick suggestions editor state ---
  const [quickExamples, setQuickExamples] = useState<string[]>(() => loadQuickExamples())

  // Гость/сессия потеряна: никогда не пустой блок — карточка входа.
  if (!user) {
    return (
      <div className="max-w-md mx-auto bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-lg text-center">
        <img src="/logo-64.png" alt="snippy.llm" className="w-12 h-12 mx-auto rounded-xl object-cover border border-slate-200 dark:border-slate-700 bg-white" />
        <h3 className="font-semibold text-slate-900 dark:text-white mt-3">Профиль — войдите</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Документы и поиск работают без входа. Войдите чтобы видеть профиль, ключи и статистику.</p>
        <div className="mt-4 text-xs text-slate-400">Нажмите «Войти» в шапке</div>
      </div>
    )
  }
  const displayName = user.full_name || displayNameFromEmail(user.email)
  const first = (displayName[0] || user.email[0] || '?').toUpperCase()
  const bg = stringToColor(user.email)



  const updateQuickExample = (i: number, val: string) => {
    const next = quickExamples.slice()
    next[i] = val
    setQuickExamples(next)
    saveQuickExamples(next)
  }
  const removeQuickExample = (i: number) => {
    const next = quickExamples.slice()
    next.splice(i, 1)
    setQuickExamples(next)
    saveQuickExamples(next)
  }
  const addQuickExample = () => {
    if (quickExamples.length >= QUICK_EXAMPLES_MAX) return
    const next = [...quickExamples, '']
    setQuickExamples(next)
    saveQuickExamples(next)
  }

  return (
    <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6">
      {/* Sidebar — без эмодзи и дескрипций */}
      <aside className="w-full md:w-56 shrink-0">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="p-4 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{displayName}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</div>
            </div>
          </div>
          {/* Навигация секций: на мобайле — скролл-чипсы в строку */}
          <nav className="p-2 space-y-1 max-md:flex max-md:space-y-0 max-md:gap-1.5 max-md:overflow-x-auto no-scrollbar">
            {SECTIONS.map(s=> (
              <button
                key={s.id}
                onClick={()=>setSection(s.id)}
                className={`w-full max-md:w-auto max-md:shrink-0 max-md:whitespace-nowrap px-3 py-2.5 max-md:min-h-[44px] rounded-xl text-sm font-medium transition text-left ${section===s.id ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="p-3 border-t border-slate-100 dark:border-slate-800">
            <button onClick={()=>{ if(onLogout) onLogout(); else logout() }} className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">Выйти</button>
          </div>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-6">
        {section==='overview' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              {/* увеличен отступ: h-20 и -mt-8 + pb-2 + pt-2 чтобы синий не прилипал к почте */}
              <div className="h-16 bg-slate-900 dark:bg-slate-800" />
              <div className="px-6 max-md:px-4 pb-6 max-md:pb-4 pt-2">
                <div className="flex items-end gap-4 -mt-8">
                  <div className="w-20 h-20 rounded-full border-4 border-white shadow-lg flex items-center justify-center text-white text-2xl font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
                  <div className="flex-1 min-w-0 pb-2 pt-1">
                    <div className="font-semibold text-slate-900 dark:text-white text-lg truncate">{displayName}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</div>
                  </div>
                </div>
                <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl px-3 py-2.5 border border-slate-200 dark:border-slate-700">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Email</div>
                    <div className="font-medium text-slate-900 dark:text-white mt-0.5 break-all">{user.email}</div>
                  </div>
                  <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl px-3 py-2.5 border border-slate-200 dark:border-slate-700">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Имя</div>
                    <NameEditor />
                  </div>
                  <TelegramLink tg={tg} />
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <NormsStats stats={stats} docs={docs} />
                  <ActivityStats />
                </div>
              </div>
            </div>
            {tgPrompt && !tg.linkedName && (
              <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-4 animate-[fadeIn_.15s_ease-out]" onClick={dismissTgPrompt}>
                <div className="relative w-full max-w-xs bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl p-5 text-center space-y-3 animate-[popIn_.18s_ease-out]" onClick={(e) => e.stopPropagation()}>
                  <div className="w-11 h-11 mx-auto rounded-full bg-gradient-to-br from-sky-400 to-blue-600 text-white flex items-center justify-center text-lg">✈</div>
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">Привязать Telegram?</div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">Коды восстановления будут приходить в бота мгновенно — без ожидания администратора.</p>
                  </div>
                  <div className="space-y-2 pt-1">
                    <button
                      onClick={async () => { const ok = await tg.link(); if (ok) dismissTgPrompt(); else setTgPrompt(false) }}
                      disabled={tg.busy || tg.waiting}
                      className="btn btn-md w-full py-2.5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200"
                    >{tg.waiting ? 'Ждём подтверждения…' : tg.busy ? 'Готовим ссылку…' : 'Привязать'}</button>
                    <button onClick={dismissTgPrompt} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">Не сейчас</button>
                  </div>
                  {tg.err && <div className="text-xs text-red-600 dark:text-red-400">{tg.err}</div>}
                </div>
              </div>
            )}
          </div>
        )}

        {section==='usage' && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Использование</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Баланс токенов и история операций • акция 300 токенов в час</p>
              <div className="mt-4">
                <CreditsPanel onTopUp={() => setSection('billing')} />
              </div>
            </div>
          </div>
        )}

        {section==='help' && (
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Помощь</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Как пользоваться snippy.llm • поддержка всегда на связи</p>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-4">
                  <div className="font-semibold text-blue-800 dark:text-blue-300 flex items-center gap-1.5"><Icon name="bolt" size={13} /> Быстрый поиск — {FAST_COST} токенов</div>
                  <div className="text-blue-700 dark:text-blue-400 mt-1 leading-relaxed">Мгновенно находит 3 самых релевантных фрагмента нормы прямо в браузере — когда нужно быстро проверить цифру.</div>
                </div>
                <div className="rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/30 p-4">
                  <div className="font-semibold text-indigo-800 dark:text-indigo-300 flex items-center gap-1.5"><Icon name="lightbulb" size={13} /> Глубокий поиск — {DEEP_COST} токенов</div>
                  <div className="text-indigo-700 dark:text-indigo-400 mt-1 leading-relaxed" title="Ответ только при найденной норме; без источника — честно говорит «не найдено»">До 30 результатов плюс ответ с дословной цитатой, пунктом и страницей. Принцип: нет источника → нет утверждения.</div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 text-xs font-semibold text-slate-700 dark:text-slate-200">Горячие клавиши</div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                  {[['/', 'Фокус на строку поиска'], ['⌘K / Ctrl+K', 'Быстрый поиск по документам'], ['?', 'Все горячие клавиши'], ['←  →', 'Страницы PDF в режиме просмотра']].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between px-4 py-2">
                      <span className="text-slate-600 dark:text-slate-300">{v}</span>
                      <kbd className="px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono text-xs text-slate-700 dark:text-slate-200">{k}</kbd>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 p-4 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                <div className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Токены и подписка</div>
                Гостям — 30 токенов каждый час, зарегистрированным — 300. Пакеты токенов не сгорают, подписки Pro и Business повышают лимит и открывают объяснятор фрагментов в PDF.
                <button onClick={() => setSection('billing')} className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200 mt-2">Тарифы и пакеты <Icon name="arrowRight" size={12} /></button>
              </div>

              <div className="mt-4 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-4 text-xs text-emerald-800 dark:text-emerald-300">
                <div className="font-semibold mb-1">Нашли ошибку или устаревшую норму?</div>
                Напишите нам: <a href="mailto:postalarchive@gmail.com" className="underline font-medium">postalarchive@gmail.com</a> — поправим пакет нормативов в ближайшем обновлении индекса.
              </div>
            </div>
          </div>
        )}

        {section==='billing' && (
          <BillingSection />
        )}

        {section==='settings' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Подсветка совпадений</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Готовые пресеты убраны: оставлен дефолт и режим моно, а также ваши кастомные палитры (максимум 5 с дефолтом). Каждое слово запроса подсвечивается своим цветом.</p>
              {highlightPalette && setHighlightPalette && monoHex !== undefined && setMonoHex && (
                <HighlightPaletteSettings
                  highlightPalette={highlightPalette}
                  setHighlightPalette={setHighlightPalette}
                  monoHex={monoHex}
                  setMonoHex={setMonoHex}
                  contextMarkMode={contextMarkMode}
                  setContextMarkMode={setContextMarkMode}
                />
              )}
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Режим поиска</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Смысловой режим находит требования по смыслу, а не только по буквам: «перила» найдёт «элементы ограждения». Без доплат — те же токены, что обычно.</p>
              <SemanticToggle />
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Быстрые подсказки под поиском</h3>              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Кнопки-подсказки под строкой поиска. Редактируйте текст, добавляйте или удаляйте — применяется сразу и сохраняется локально.</p>
              <div className="mt-3 space-y-2">
                {quickExamples.map((ex, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={ex}
                      onChange={e => updateQuickExample(i, e.target.value)}
                      placeholder="Текст подсказки…"
                      className="input flex-1"
                    />
                    <button onClick={() => removeQuickExample(i)} title="Удалить" className="icon-btn border border-slate-200 dark:border-slate-700 hover:text-red-500 hover:border-red-200"><Icon name="close" size={14} /></button>
                  </div>
                ))}
                {quickExamples.length === 0 && <div className="text-xs text-slate-400 p-3 border border-dashed rounded-xl text-center">Подсказок нет — добавьте ниже</div>}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={addQuickExample}
                  disabled={quickExamples.length >= QUICK_EXAMPLES_MAX}
                  className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200"
                ><Icon name="plus" size={12} /> Добавить подсказку</button>
                <span className="text-[11px] text-slate-400">{quickExamples.length} / {QUICK_EXAMPLES_MAX}</span>
                <button
                  onClick={() => setQuickExamples(resetQuickExamples())}
                  className="btn btn-sm btn-secondary ml-auto text-[11px]"
                >Сбросить к умолчанию</button>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-md:p-4">
              <h3 className="font-semibold text-slate-900 dark:text-white">Токены</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Быстрый поиск — {FAST_COST} токенов (3 результата). Глубокий — {DEEP_COST} (до 30 результатов + ответ с цитатой). Сначала тратится бесплатный лимит, затем накопительный баланс.</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60"><div className="text-slate-500 dark:text-slate-400">Гость</div><div className="font-semibold text-slate-900 dark:text-white mt-0.5">30 / день</div></div>
                <div className="p-3 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30"><div className="text-blue-700 dark:text-blue-300">Зарегистрирован</div><div className="font-semibold text-blue-900 dark:text-blue-200 mt-0.5">300 / час + баланс</div></div>
              </div>
              {isAdminEmail(user?.email) ? (
                <button onClick={() => setSection('billing')} className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200 mt-3"><Icon name="plus" size={11} /> Пополнить баланс</button>
              ) : (
                <button disabled title={BILLING_DISABLED_HINT} className="btn btn-sm mt-3 bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed"><Icon name="lock" size={11} /> Пополнение скоро</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
