// @ts-nocheck — как и остальные views, типы правим инкрементально
import { useEffect, useState } from 'react'
import { SnakeState } from '../components/SnakeState'
import { isAdminEmail } from '../utils/admin'
import {
  fetchAdminStats, fetchAdminUsers, fetchAdminActivity, freezeUser,
  fetchDeletionReasons, fetchArchivedUsers, deleteUserToArchive, restoreUserFromArchive,
  type DeletionReason, type ArchivedUser,
  fetchAdminSettings, fetchAdminHealth, saveAdminSetting, displaySubject,
  fetchAdminFeedback,
} from '../hooks/useAdmin'
import { ModelUsageCard } from '../components/admin/ModelUsage'
import { QuotaCard, QUOTA_FIELDS, CAP_FIELDS } from '../components/admin/QuotaEditor'
import { Icon } from '../components/Icon'
import { ListRow } from '../components/ListRow'

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Gemini',
  jina: 'Jina',
  voyage: 'Voyage',
  cohere: 'Cohere',
  mistral: 'Mistral',
}

type SectionId = 'overview' | 'quotas' | 'users' | 'archive' | 'activity' | 'errors' | 'params' | 'feedback'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'quotas', label: 'Квоты ИИ' },
  { id: 'feedback', label: 'Фидбек' },
  { id: 'users', label: 'Пользователи' },
  { id: 'archive', label: 'Архив' },
  { id: 'activity', label: 'Активность' },
  { id: 'errors', label: 'Ошибки' },
  { id: 'params', label: 'Параметры' },
]

const KIND_LABELS: Record<string, string> = {
  spend_fast: 'Быстрый поиск',
  spend_deep: 'Глубокий поиск',
  spend_followup: 'Уточняющий вопрос',
  purchase: 'Пополнение баланса',
  subscription: 'Подписка',
  grant: 'Бонус / корректировка',
}
function kindLabel(kind: string, meta?: string | null): string {
  try {
    if (meta && JSON.parse(meta)?.freeze) return 'Заморозка (админ)'
  } catch {}
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]
  if (kind.startsWith('refund')) return 'Возврат токенов'
  return kind
}

const ACTIVITY_KINDS = [
  { key: 'spend_fast', label: 'Быстрые' },
  { key: 'spend_deep', label: 'Глубокие' },
  { key: 'spend_followup', label: 'Уточнения' },
  { key: 'purchase', label: 'Пополнения' },
  { key: 'subscription', label: 'Подписки' },
  { key: 'grant', label: 'Бонусы' },
  { key: 'refund_deep', label: 'Возвраты' },
]

const FEEDBACK_REASON_LABEL: Record<string, string> = {
  wrong_paragraph: 'Неверный пункт',
  no_quote: 'Нет цитаты',
  off_topic: 'Не по теме',
  outdated: 'Устарело',
  other: 'Другое',
}

/** Строки LLM-цепочки: порядок, вкл/выкл, счётчик срабатываний за период. */
function ChainRows({ stats, settings, onToggle }: { stats: any; settings: any; onToggle: (key: string, v: number) => void }) {
  const fb = stats?.model_usage?.ask?.fb || {}
  const vals = settings?.values || {}
  const keySet = Object.fromEntries((stats?.providers?.llm_fallbacks || []).map((f: any) => [f.id, !!f.key_set]))
  const hintNoKey = (base: string, id: string) => (keySet[id] === false ? `${base} • нет ключа` : base)
  const rows = [
    { n: 1, label: 'Groq · основная', hint: stats.providers?.llm?.model || '', key: null as string | null, count: null as number | null, on: true },
    { n: 2, label: 'Groq · запасные модели', hint: 'safeguard→qwen→minimax→120b — отдельные бакеты', key: 'llm_groq_alt', count: fb.groq_alt ?? 0 },
    { n: 3, label: 'Gemini Flash', hint: hintNoKey('тем же ключом, ~20–250/день', 'gemini'), key: 'llm_gemini', count: fb.gemini ?? 0 },
    { n: 4, label: 'Cerebras', hint: hintNoKey('llama-3.1-8b, быстрый free-tier', 'cerebras'), key: 'llm_cerebras', count: fb.cerebras ?? 0 },
    { n: 5, label: 'OpenRouter', hint: hintNoKey('llama-3.1-8b :free', 'openrouter'), key: 'llm_openrouter', count: fb.openrouter ?? 0 },
    { n: 6, label: 'DeepSeek', hint: hintNoKey('deepseek-chat', 'deepseek'), key: 'llm_deepseek', count: fb.deepseek ?? 0 },
    { n: 7, label: 'Mistral', hint: hintNoKey('mistral-small, тем же ключом', 'mistral-chat'), key: 'llm_mistral_chat', count: fb.mistral_chat ?? 0 },
    { n: 8, label: 'Cohere', hint: hintNoKey('command-r-plus, тем же ключом', 'cohere-chat'), key: 'llm_cohere_chat', count: fb.cohere_chat ?? 0 },
    { n: 9, label: 'Свой endpoint', hint: hintNoKey('OpenAI-совместимый, задаётся env', 'custom'), key: 'llm_custom', count: fb.custom ?? 0 },
    { n: 10, label: 'Workers AI', hint: 'binding AI, ~1–2K/день', key: 'llm_workers', count: fb.workers ?? 0 },
    { n: 11, label: 'Zen · MiMo Free', hint: hintNoKey('mimo-v2.5-free • ВЫКЛ по умолч.: free-tier только в OpenCode-клиенте', 'zen'), key: 'llm_zen', count: fb.zen ?? 0 },
    { n: 12, label: 'Pollinations', hint: 'без ключа, негарантирован', key: 'llm_pollinations', count: fb.pollinations ?? 0 },
    { n: 13, label: 'Экстрактивный ответ', hint: 'цитаты из норм — бесконечно', key: 'llm_extractive', count: fb.extractive ?? 0 },
    { n: 14, label: 'Кэш ответов', hint: 'повторы без LLM • всегда включён', key: null as string | null, count: fb.cache ?? 0 },
  ]
  return (
    <>
      {rows.map((r) => {
        // llm_zen — opt-in: дефолт "0" (как на бэке в zenOptIn), у остальных "1"
        const on = r.key === null ? true : String(vals[r.key] ?? (r.key === 'llm_zen' ? '0' : '1')) === '1'
        return (
          <div key={r.n} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
            <span className="text-slate-400 tabular-nums w-4 shrink-0">{r.n}</span>
            <span className={`w-2 h-2 rounded-full shrink-0 ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-slate-700 dark:text-slate-200 truncate" title={r.label}>{r.label}</div>
              <div className="text-slate-400 truncate" title={typeof r.hint === 'string' ? r.hint : undefined}>{r.hint}</div>
            </div>
            <span className="ml-auto tabular-nums text-slate-500 shrink-0 w-[52px] text-right">{r.count === null ? '—' : `${r.count}×`}</span>
            {r.key && (
              <button
                onClick={() => onToggle(r.key as string, on ? 0 : 1)}
                title={on ? 'Выключить звено' : 'Включить звено'}
                className={`px-2 py-0.5 rounded-full text-[11px] border shrink-0 min-w-[52px] inline-flex items-center justify-center ${on ? 'border-emerald-200 dark:border-emerald-900 text-emerald-600' : 'border-slate-200 dark:border-slate-700 text-slate-400'}`}
              >
                {on ? 'вкл' : 'выкл'}
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}

function Card({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
      <div className="text-xs text-slate-500 dark:text-slate-400">{title}</div>
      <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1">{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-1">{sub}</div>}
    </div>
  )
}

export function AdminView({ user }: { user: any }) {
  const [section, setSection] = useState<SectionId>('overview')
  const [stats, setStats] = useState<any>(null)
  const [settings, setSettings] = useState<any>(null)
  const [health, setHealth] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  // users
  const [uq, setUq] = useState('')
  const [users, setUsers] = useState<any[]>([])
  const [uTotal, setUTotal] = useState(0)
  const [uOff, setUOff] = useState(0)
  // activity (мультифильтр галочками)
  const [kinds, setKinds] = useState<string[]>([])
  const [acts, setActs] = useState<any[]>([])
  const [aTotal, setATotal] = useState(0)
  const [aOff, setAOff] = useState(0)
  const [freezing, setFreezing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<any>(null) // пользователь в модалке удаления
  const [reasons, setReasons] = useState<DeletionReason[]>([])
  const [delReason, setDelReason] = useState<DeletionReason | null>(null)
  const [delText, setDelText] = useState('')
  const [delBusy, setDelBusy] = useState(false)
  const [archived, setArchived] = useState<ArchivedUser[]>([])
  // feedback
  const [fbRating, setFbRating] = useState<'all' | '1' | '-1'>('all')
  const [fbItems, setFbItems] = useState<any[]>([])
  const [fbTotal, setFbTotal] = useState(0)
  const [fbOff, setFbOff] = useState(0)
  const [fbAgg, setFbAgg] = useState<{ pos: number; neg: number; total: number } | null>(null)

  if (!isAdminEmail(user?.email)) {
    return (
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10">
        <SnakeState variant="failed" title="Нет доступа" subtitle="Раздел «Админка» — только для администраторов." size={120} />
      </main>
    )
  }

  const loadStats = async (d = days) => {
    setLoading(true); setError(null)
    try { setStats(await fetchAdminStats(d)) }
    catch (e: any) { setError(e?.message === 'not_admin' ? 'Нет доступа' : 'Не удалось загрузить статистику') }
    finally { setLoading(false) }
  }
  const loadSettings = async () => {
    try { setSettings(await fetchAdminSettings()) } catch { /* покажем limits из stats */ }
  }
  const loadHealth = async () => {
    try { setHealth(await fetchAdminHealth()) } catch (e: any) { setError('Не удалось загрузить здоровье воркера') }
  }
  const reloadQuotas = async () => {
    await Promise.all([loadStats(), loadSettings()])
  }
  const loadUsers = async (off = 0) => {
    setLoading(true)
    try {
      const r = await fetchAdminUsers(uq, 50, off)
      setUsers(r.items); setUTotal(r.total); setUOff(off)
    } catch { setError('Не удалось загрузить пользователей') }
    finally { setLoading(false) }
  }
  const loadActs = async (off = 0, ks: string[] = kinds) => {
    setLoading(true)
    try {
      const r = await fetchAdminActivity(ks, 50, off)
      setActs(r.items); setATotal(r.total); setAOff(off)
    } catch { setError('Не удалось загрузить активность') }
    finally { setLoading(false) }
  }
  const toggleKind = (k: string) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]
    setKinds(next)
    loadActs(0, next)
  }

  useEffect(() => { loadStats() }, [])
  useEffect(() => { if (section === 'users' && !users.length) loadUsers(0) }, [section]) // eslint-disable-line
  useEffect(() => {
    if (section !== 'archive' || archived.length) return
    fetchArchivedUsers().then((d) => setArchived(d.archived)).catch(() => {})
  }, [section]) // eslint-disable-line
  useEffect(() => { if ((section === 'activity' || section === 'errors') && !acts.length) loadActs(0, kinds) }, [section])
  useEffect(() => { if ((section === 'quotas' || section === 'params') && !settings) loadSettings() }, [section])
  useEffect(() => { if (section === 'params' && !health) loadHealth() }, [section])
  const loadFb = async (off = 0, rating: 'all' | '1' | '-1' = fbRating) => {
    setLoading(true)
    try {
      const r = await fetchAdminFeedback(rating, 50, off)
      setFbItems(r.items); setFbTotal(r.total); setFbOff(off); setFbAgg(r.agg)
    } catch { setError('Не удалось загрузить фидбек') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (section === 'feedback' && !fbItems.length) loadFb(0, fbRating) }, [section])

  const refunds = (stats?.ledger_by_kind || []).filter((k: any) => k.kind.startsWith('refund'))
  const refundTotal = refunds.reduce((s: number, k: any) => s + k.n, 0)
  const mu = stats?.model_usage
  const setVals = settings?.values || {
    quota_anon: stats?.limits?.anon, quota_user: stats?.limits?.user,
    cost_fast: stats?.limits?.fast, cost_deep: stats?.limits?.deep,
    explain_cap: stats?.explain?.cap, cap_groq_rpd: 1000, cap_embed_rpd: 100000,
  }
  const setMeta = settings?.meta || stats?.settings_meta || {}

  return (
    <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            Админка <span className="badge border-violet-200 dark:border-violet-900 bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300"><Icon name="shield" size={11} /> только админы</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Статистика • квоты ИИ • пользователи • логи — без автообновления (экономим D1)</p>
        </div>
        <button onClick={() => { loadStats(); if (section === 'users') loadUsers(uOff); if (section === 'activity' || section === 'errors') loadActs(aOff, kinds); if (section === 'quotas' || section === 'params') loadSettings(); if (section === 'params') loadHealth(); if (section === 'feedback') loadFb(fbOff, fbRating) }} className="btn btn-md btn-secondary py-2"><Icon name="refresh" size={14} /> Обновить</button>
      </div>

      {error && <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-3 text-sm mb-4">{error}</div>}

      <div className="flex flex-col md:flex-row gap-6">
        <aside className="w-full md:w-56 shrink-0">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800">
              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{user?.email}</div>
              <div className="text-[11px] text-violet-600 dark:text-violet-400">администратор</div>
            </div>
            <nav className="p-2">
              {SECTIONS.map((s) => (
                <button key={s.id} onClick={() => setSection(s.id)} className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition ${section === s.id ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white font-medium' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{s.label}</button>
              ))}
            </nav>
          </div>
        </aside>

        <div className="flex-1 min-w-0 space-y-4">
          {loading && !stats && section === 'overview' && <div className="text-sm text-slate-500">Загружаем…</div>}

          {section === 'overview' && stats && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-500 dark:text-slate-400">Период:</span>
                {[1, 7, 30].map((d) => (
                  <button key={d} onClick={() => { setDays(d); loadStats(d) }} className={`px-3 py-1 rounded-full text-xs ${days === d ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700'}`}>{d === 1 ? '24ч' : `${d}д`}</button>
                ))}
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Card title="Пользователей" value={String(stats.users.total)} sub={`+${stats.users.fresh} за период`} />
                <Card title="Активность/день (макс)" value={String(Math.max(0, ...(stats.usage_by_day || []).map((x: any) => x.n)) || '—')} sub="уникальных субъектов" />
                <Card title="Потрачено за период" value={String((stats.usage_by_day || []).reduce((s: number, x: any) => s + x.s, 0))} sub="токенов • дневные лимиты" />
                <Card title="Объяснения" value={`${stats.explain.used}/${stats.explain.cap * days}`} sub={`кэш: ${stats.explain.cached}`} />
              </div>
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="text-sm font-semibold text-slate-900 dark:text-white mb-2">Активность по дням</div>
                {(stats.usage_by_day || []).length === 0 && <div className="text-xs text-slate-400">Пока пусто</div>}
                {(stats.usage_by_day || []).map((x: any) => (
                  <div key={x.d} className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <span className="text-slate-500 tabular-nums w-24">{x.d}</span>
                    <span className="text-slate-700 dark:text-slate-200">{x.n} польз.</span>
                    <span className="text-slate-400 inline-flex items-center gap-0.5">{x.s}<Icon name="bolt" size={10} /></span>
                  </div>
                ))}
              </div>
            </>
          )}

          {section === 'quotas' && stats && (
            <>
              <div className="text-sm font-semibold text-slate-900 dark:text-white">Лимиты и стоимость <span className="font-normal text-xs text-slate-400">— редактируется по клику</span></div>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {QUOTA_FIELDS.map((f) => (
                  setVals[f.key] !== undefined && (
                    <QuotaCard key={f.key} field={f} value={setVals[f.key]} meta={setMeta[f.key]} onSaved={reloadQuotas} />
                  )
                ))}
              </div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white pt-2">
                Использование ИИ {days === 1 ? 'сегодня' : `за ${days} дн.`} <span className="font-normal text-xs text-slate-400">— нажмите на карточку: кто сколько</span>
              </div>
              {mu ? (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                    <ModelUsageCard title="Groq · ответы" model={stats.providers?.llm?.model || stats.limits.groq_model} usage={mu.ask} kind="ask" />
                    <ModelUsageCard title="Groq · объяснятор" model={stats.providers?.llm?.model || stats.limits.groq_model} usage={mu.explain} kind="explain" />
                    <ModelUsageCard
                      title={`${PROVIDER_LABEL[stats.providers?.active_embed?.provider] || 'Эмбеддинги'} · эмбеддинги`}
                      model={stats.providers?.active_embed?.model || stats.limits.embed_model}
                      usage={mu.embed}
                      kind="embed"
                    />
                  </div>
                  <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                    <div className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Эмбеддинг-провайдеры</div>
                    <div className="text-[11px] text-slate-400 mb-2">
                      Активный определяется собранным индексом (сейчас: <b>{PROVIDER_LABEL[stats.providers?.active_embed?.provider] || stats.providers?.active_embed?.provider || '—'}</b>).
                      Смена провайдера = пересборка индекса + redeploy, иначе поиск молча сломается. LLM-фолбэка нет — только Groq.
                    </div>
                    {(stats.providers?.embed_fallbacks || []).map((f: any) => (
                      <div key={f.id} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${f.active ? 'bg-emerald-500' : f.key_set ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                        <span className="font-medium text-slate-700 dark:text-slate-200">{PROVIDER_LABEL[f.id] || f.id}</span>
                        <span className="ml-auto text-slate-400">
                          {f.active ? '● активен' : f.key_set ? 'ключ настроен (готов)' : 'нет ключа'}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-xs text-slate-400">Нет данных — обновите статистику</div>
              )}
              <div className="text-[11px] text-slate-400">
                N для Groq — дневной RPD free-плана (console.groq.com); N для эмбеддингов правится ниже. Токены (TPD) не логируются — следим за запросами.
              </div>
              <div className="text-sm font-semibold text-slate-900 dark:text-white pt-2">Потолки моделей <span className="font-normal text-xs text-slate-400">— N для карточек выше</span></div>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {CAP_FIELDS.map((f) => (
                  setVals[f.key] !== undefined && (
                    <QuotaCard key={f.key} field={f} value={setVals[f.key]} meta={setMeta[f.key]} onSaved={reloadQuotas} />
                  )
                ))}
              </div>
            </>
          )}

          {section === 'feedback' && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="text-sm font-semibold text-slate-900 dark:text-white">Отзывы под ответами</div>
                {fbAgg && fbAgg.total > 0 && (
                  <span className="badge border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                    <Icon name="thumbUp" size={11} /> {fbAgg.pos} / <Icon name="thumbDown" size={11} /> {fbAgg.neg} · {Math.round((fbAgg.pos / fbAgg.total) * 100)}% положительных
                  </span>
                )}
                <div className="ml-auto flex gap-1.5">
                  {(['all', '1', '-1'] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => { setFbRating(r); loadFb(0, r) }}
                      className={`px-3 py-1.5 rounded-full text-xs border transition ${fbRating === r ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'}`}
                    >
                      {r === 'all' ? 'Все' : <Icon name={r === '1' ? 'thumbUp' : 'thumbDown'} size={13} />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="text-xs text-slate-400 mb-2">Всего: {fbTotal}</div>
              {fbItems.length === 0 && <div className="text-xs text-slate-400">Пока пусто</div>}
              {fbItems.map((f: any) => {
                const subj = displaySubject(f.email, f.subject)
                const meta = [subj, f.mode, f.paragraph ? `п. ${f.paragraph}` : '', f.provider, f.reason ? (FEEDBACK_REASON_LABEL[f.reason] || f.reason) : '', new Date(f.created_at).toLocaleString('ru-RU')].filter(Boolean).join(' • ')
                return (
                <div key={f.id} className="py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <ListRow
                    compact
                    className="px-2"
                    lead={<span className={f.rating === 1 ? 'text-emerald-600 inline-flex' : 'text-red-500 inline-flex'}><Icon name={f.rating === 1 ? 'thumbUp' : 'thumbDown'} size={14} /></span>}
                    title={<span className="text-[13px] font-medium text-slate-800 dark:text-slate-100">{f.query}</span>}
                    titleAttr={f.query}
                    subtitle={<span className="text-slate-400">{meta}</span>}
                    subtitleAttr={meta}
                    trail={
                      <span className="text-[11px] text-slate-400 tabular-nums whitespace-nowrap">
                        {new Date(f.created_at).toLocaleDateString('ru-RU')}
                      </span>
                    }
                    trailWide
                  />
                  {f.comment && <div className="text-xs text-slate-600 dark:text-slate-300 mt-1 ml-11 mr-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-2.5 py-1.5 line-clamp-2 [overflow-wrap:anywhere]" title={f.comment}>{f.comment}</div>}
                </div>
                )
              })}
              <div className="flex gap-2 mt-3">
                <button disabled={fbOff === 0} onClick={() => loadFb(fbOff - 50, fbRating)} className="btn btn-sm btn-secondary"><Icon name="arrowLeft" size={12} /> Назад</button>
                <button disabled={fbOff + 50 >= fbTotal} onClick={() => loadFb(fbOff + 50, fbRating)} className="btn btn-sm btn-secondary">Вперёд <Icon name="arrowRight" size={12} /></button>
              </div>
            </div>
          )}

          {section === 'users' && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
              <form onSubmit={(e) => { e.preventDefault(); loadUsers(0) }} className="flex gap-2 mb-3">
                <input value={uq} onChange={(e) => setUq(e.target.value)} placeholder="Поиск по email…" className="input flex-1" />
                <button className="btn btn-md btn-primary py-2"><Icon name="search" size={14} /> Найти</button>
              </form>
              <div className="text-xs text-slate-400 mb-2">Всего: {uTotal}</div>
              {users.map((u: any) => {
                const umeta = `${u.plan}${u.sub ? ` • ${u.sub}` : ''} • баланс ${u.balance} • потрачено ${u.spent}`
                return (
                <div key={u.id} className="flex items-center gap-2 text-xs py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate" title={u.email}>{u.email}</div>
                    <div className="text-slate-400 truncate" title={umeta}>{umeta}</div>
                  </div>
                  <button disabled={freezing === u.id} onClick={async () => { if (!confirm(`Заморозить ${u.email}? Баланс ${u.balance} будет обнулён.`)) return; setFreezing(u.id); try { const r = await freezeUser(u.id, 'freeze from admin'); alert(`Заморожено: ${r.frozen}`); loadUsers(uOff) } catch { alert('Ошибка заморозки') } finally { setFreezing(null) } }} className="btn btn-sm border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 bg-transparent hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0 w-[110px] justify-center">Заморозить</button>
                  <button onClick={async () => { setDeleting(u); if (!reasons.length) { try { const d = await fetchDeletionReasons(); setReasons(d.reasons) } catch {} } }} className="btn btn-sm border border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 bg-transparent hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0 w-[110px] justify-center"><Icon name="trash" size={12} /> Удалить</button>
                </div>
                )
              })}
              <div className="flex gap-2 mt-3">
                <button disabled={uOff === 0} onClick={() => loadUsers(uOff - 50)} className="btn btn-sm btn-secondary"><Icon name="arrowLeft" size={12} /> Назад</button>
                <button disabled={uOff + 50 >= uTotal} onClick={() => loadUsers(uOff + 50)} className="btn btn-sm btn-secondary">Вперёд <Icon name="arrowRight" size={12} /></button>
              </div>
            </div>
          )}

          {/* Модалка удаления аккаунта в архив */}
          {deleting && (
            <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !delBusy && setDeleting(null)}>
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-5 max-w-lg w-full space-y-3" onClick={(e) => e.stopPropagation()}>
                <div className="font-semibold text-slate-900 dark:text-white">Удалить аккаунт в архив</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {deleting.email} • аккаунт исчезнет из системы, но 30 дней будет храниться в архиве (можно восстановить).
                </div>
                <select
                  value={delReason?.id ?? ''}
                  onChange={(e) => {
                    const r = reasons.find((x) => x.id === e.target.value) ?? null
                    setDelReason(r)
                    if (r) setDelText((r.template || '').replaceAll('{имя}', deleting.full_name || 'пользователь'))
                  }}
                  className="input"
                >
                  <option value="" disabled>Выберите причину…</option>
                  {reasons.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
                {delReason && (
                  <>
                    <textarea value={delText} onChange={(e) => setDelText(e.target.value)} rows={6} className="input text-sm" />
                    <div className="text-[11px] text-slate-400">Это письмо увидит пользователь при попытке входа. Обращение «Уважаемый …» добавится автоматически.</div>
                  </>
                )}
                <div className="flex gap-2 justify-end pt-1">
                  <button disabled={delBusy} onClick={() => { setDeleting(null); setDelReason(null); setDelText('') }} className="btn btn-sm btn-secondary">Отмена</button>
                  <button
                    disabled={delBusy || !delReason}
                    onClick={async () => {
                      if (!deleting || !delReason) return
                      setDelBusy(true)
                      try {
                        await deleteUserToArchive(deleting.id, delReason.id, delText)
                        setDeleting(null); setDelReason(null); setDelText('')
                        loadUsers(uOff)
                      } catch (e: any) { alert(e.message || 'Ошибка удаления') } finally { setDelBusy(false) }
                    }}
                    className="btn btn-sm bg-red-600 hover:bg-red-700 text-white"
                  >Удалить</button>
                </div>
              </div>
            </div>
          )}

          {section === 'archive' && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
              <div className="text-xs text-slate-400 mb-2">Удалённые аккаунты • хранятся 30 дней, затем очищаются автоматически</div>
              {!archived.length && <div className="text-sm text-slate-500">Архив пуст.</div>}
              {archived.map((a) => (
                <div key={a.email} className="flex items-center gap-2 text-xs py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate" title={a.email}>{a.email}{a.full_name ? ` • ${a.full_name}` : ''}</div>
                    <div className="text-slate-400 truncate" title={`${a.reason_title}: ${a.reason_text}`}>
                      {a.reason_title} • удалил {a.deleted_by} • {new Date(a.deleted_at).toLocaleDateString('ru-RU')} • осталось {a.days_left} дн.
                    </div>
                  </div>
                  <button
                    onClick={async () => { if (!confirm(`Восстановить ${a.email}?`)) return; try { await restoreUserFromArchive(a.email); setArchived((prev) => prev.filter((x) => x.email !== a.email)) } catch (e: any) { alert(e.message || 'Ошибка восстановления') } }}
                    className="btn btn-sm btn-secondary shrink-0 w-[110px] justify-center"
                  >Восстановить</button>
                </div>
              ))}
              <button onClick={() => { setArchived([]); fetchArchivedUsers().then((d) => setArchived(d.archived)).catch(() => {}) }} className="btn btn-sm btn-secondary mt-3"><Icon name="refresh" size={12} /> Обновить</button>
            </div>
          )}

          {(section === 'activity' || section === 'errors') && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
              {section === 'activity' ? (
                <div className="mb-3">
                  <div className="flex flex-wrap gap-1.5">
                    {ACTIVITY_KINDS.map((k) => {
                      const on = kinds.includes(k.key)
                      return (
                        <button
                          key={k.key}
                          onClick={() => toggleKind(k.key)}
                          className={`chip py-1.5 ${on ? 'chip-active' : ''}`}
                        >
                          {on && <Icon name="check" size={11} />}{k.label}
                        </button>
                      )
                    })}
                    {kinds.length > 0 && (
                      <button onClick={() => { setKinds([]); loadActs(0, []) }} className="px-3 py-1.5 text-xs text-blue-600 underline">Сбросить</button>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-2">
                    {kinds.length === 0 ? 'Показаны все операции' : `Фильтр: ${kinds.map((k) => kindLabel(k)).join(', ')}`} • Всего: {aTotal}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                  Возвратов за период: <b>{refundTotal}</b> (refund — авто-возврат при пустом индексе/ошибке Groq).
                  Стек-трейсы 500 — в Cloudflare Dashboard → Workers → Logs / <code>wrangler tail</code> (в D1 не пишем — экономим writes).
                </div>
              )}
              {(section === 'errors' ? acts.filter((a: any) => a.kind.startsWith('refund')) : acts).map((a: any) => {
                const asub = displaySubject(a.email, a.subject)
                const asub2 = `${asub} • ${new Date(a.created_at).toLocaleString('ru-RU')}`
                return (
                <ListRow
                  key={a.id}
                  compact
                  className="px-2"
                  title={<span className="text-xs font-medium text-slate-700 dark:text-slate-200"><span className="text-slate-400 tabular-nums font-normal">#{a.id} </span>{kindLabel(a.kind, a.meta)}</span>}
                  titleAttr={`#${a.id} ${kindLabel(a.kind, a.meta)}`}
                  subtitle={<span className="text-slate-400">{asub2}</span>}
                  subtitleAttr={asub2}
                  trail={
                    <span className={`tabular-nums inline-flex items-center justify-end gap-0.5 text-xs whitespace-nowrap ${a.delta < 0 ? 'text-red-500' : 'text-emerald-600'}`}>{a.delta > 0 ? `+${a.delta}` : a.delta}<Icon name="bolt" size={10} /></span>
                  }
                  trailWide
                />
                )
              })}
              {section === 'activity' && (
                <div className="flex gap-2 mt-3">
                  <button disabled={aOff === 0} onClick={() => loadActs(aOff - 50, kinds)} className="btn btn-sm btn-secondary"><Icon name="arrowLeft" size={12} /> Назад</button>
                  <button disabled={aOff + 50 >= aTotal} onClick={() => loadActs(aOff + 50, kinds)} className="btn btn-sm btn-secondary">Вперёд <Icon name="arrowRight" size={12} /></button>
                </div>
              )}
            </div>
          )}

          {section === 'params' && stats && (
            <div className="space-y-4">
              <div className="text-[11px] text-slate-400">
                Лимиты и стоимость правятся в разделе «Квоты ИИ» <button onClick={() => setSection('quotas')} className="text-blue-600 dark:text-blue-400 underline">перейти</button>
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Провайдеры ИИ и фолбэки</div>
                <div className="text-[11px] text-slate-400 mb-2">Активный эмбеддинг диктуется собранным индексом • LLM-цепочка ниже</div>
                <div className="text-xs py-2 border-b border-slate-100 dark:border-slate-800">
                  <div className="font-medium text-slate-700 dark:text-slate-200">
                    Эмбеддинги: {PROVIDER_LABEL[stats.providers?.active_embed?.provider] || stats.providers?.active_embed?.provider || '—'} ● активен
                  </div>
                  <div className="font-mono text-[11px] text-slate-500 mt-0.5">
                    {stats.providers?.active_embed?.model || '—'}
                    {stats.providers?.active_embed?.dim ? ` • ${stats.providers.active_embed.dim}d • ${Number(stats.providers.active_embed.count || 0).toLocaleString('ru-RU')} векторов` : ''}
                    {stats.providers?.active_embed?.builtAt ? ` • сборка ${new Date(stats.providers.active_embed.builtAt).toLocaleDateString('ru-RU')}` : ''}
                  </div>
                </div>
                <div className="text-xs py-2 border-b border-slate-100 dark:border-slate-800">
                  <div className="font-medium text-slate-700 dark:text-slate-200">Groq · ответы и объяснятор (общий пул + цепочка фолбэков ниже)</div>
                  <div className="font-mono text-[11px] text-slate-500 mt-0.5">{stats.providers?.llm?.model || stats.limits.groq_model}</div>
                  <div className="text-slate-400 mt-0.5">1K RPD / 8K TPM / 200K TPD (free) • <a className="underline text-blue-600" href="https://console.groq.com/docs/rate-limits" target="_blank" rel="noreferrer">лимиты Groq</a></div>
                </div>
                <div className="text-[11px] text-slate-400 mt-3 mb-1 tracking-widest uppercase">LLM-цепочка (порядок срабатывания • сегодня)</div>
                <ChainRows stats={stats} settings={settings} onToggle={async (key: string, v: number) => { await saveAdminSetting(key, v); loadSettings(); loadStats() }} />
                {(stats.providers?.embed_fallbacks || []).map((f: any) => (
                  <div key={f.id} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${f.active ? 'bg-emerald-500' : f.key_set ? 'bg-amber-400' : 'bg-slate-300 dark:bg-slate-600'}`} />
                    <span className="text-slate-600 dark:text-slate-300">{PROVIDER_LABEL[f.id] || f.id}</span>
                    <span className="ml-auto text-slate-400">{f.active ? 'активен' : f.key_set ? 'ключ настроен' : 'нет ключа'}</span>
                  </div>
                ))}
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Здоровье воркера</div>
                {!health ? (
                  <div className="text-xs text-slate-400">Загружаем…</div>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2 text-xs mb-2">
                      <span className={`px-2 py-0.5 rounded-full border ${health.index?.ok ? 'bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600'}`}>
                        индекс {health.index?.ok ? `ок (${Number(health.index?.count || 0).toLocaleString('ru-RU')} векторов)` : 'НЕДОСТУПЕН'}
                      </span>
                      <span className="px-2 py-0.5 rounded-full border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500">
                        R2 PDF: {health.r2_norms ? 'включён' : 'выключен (статика Pages)'}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mb-1">Строк в таблицах D1 • {new Date(health.now).toLocaleString('ru-RU')}</div>
                    {Object.entries(health.tables || {}).map(([t, c]: any) => (
                      <div key={t} className="flex text-xs py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <span className="font-mono text-slate-500">{t}</span>
                        <span className="ml-auto tabular-nums text-slate-700 dark:text-slate-200">{Number(c).toLocaleString('ru-RU')}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="text-sm font-semibold text-slate-900 dark:text-white mb-1">Биллинг-каталог <span className="font-normal text-xs text-slate-400">— справочно (демо-режим, меняется кодом)</span></div>
                {!health?.billing ? (
                  <div className="text-xs text-slate-400">Загружаем…</div>
                ) : (
                  <>
                    <div className="text-[11px] text-slate-400 mt-2 mb-1 tracking-widest uppercase">Подписки</div>
                    {Object.entries(health.billing.plans || {}).map(([sku, p]: any) => (
                      <div key={sku} className="flex text-xs py-1 border-b border-slate-100 dark:border-slate-800">
                        <span className="font-mono text-slate-500">{sku}</span>
                        <span className="ml-2 text-slate-700 dark:text-slate-200">{p.label}</span>
                        <span className="ml-auto tabular-nums text-slate-500">{Number(p.price).toLocaleString('ru-RU')}₸ • {p.dailyLimit}/день • {p.days} дн.</span>
                      </div>
                    ))}
                    <div className="text-[11px] text-slate-400 mt-3 mb-1 tracking-widest uppercase">Пакеты токенов</div>
                    {Object.entries(health.billing.packs || {}).map(([sku, p]: any) => (
                      <div key={sku} className="flex text-xs py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                        <span className="font-mono text-slate-500">{sku}</span>
                        <span className="ml-2 text-slate-700 dark:text-slate-200">{p.label}</span>
                        <span className="ml-auto tabular-nums text-slate-500">{Number(p.price).toLocaleString('ru-RU')}₸ • +{Number(p.credits).toLocaleString('ru-RU')} кр.</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
