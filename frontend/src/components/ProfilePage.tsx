import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { HighlightPaletteSettings } from './HighlightPaletteSettings'
import type { PaletteId } from '../utils/highlight'
import { loadQuickExamples, saveQuickExamples, resetQuickExamples, QUICK_EXAMPLES_MAX } from '../utils/examples'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8001'
const DISPLAY_API = 'https://snippy.llm'

function stringToColor(str: string) {
  let hash = 0
  for (let i=0;i<str.length;i++) hash = str.charCodeAt(i) + ((hash<<5)-hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h} 70% 45%)`
}

type SectionId = 'overview' | 'usage' | 'keys' | 'members' | 'billing' | 'settings'

const SECTIONS: {id: SectionId, label: string}[] = [
  {id:'overview', label:'Обзор'},
  {id:'usage', label:'Использование'},
  {id:'keys', label:'API ключи'},
  {id:'members', label:'Члены'},
  {id:'billing', label:'Оплата'},
  {id:'settings', label:'Настройки'},
]

function maskKey(k: string | null) {
  if (!k) return '—'
  if (k.length <= 12) return k
  return k.slice(0, 6) + '••••••••' + k.slice(-4)
}

function maskToken(tok: string | null) {
  if (!tok) return '—'
  if (tok.length < 12) return tok.slice(0,2)+'****'+tok.slice(-2)
  return tok.slice(0,8)+'****'+tok.slice(-4)
}

function shortenToken(tok: string | null) {
  if (!tok) return '—'
  if (tok.length <= 40) return tok
  return tok.slice(0, 18) + '…' + tok.slice(-10)
}

function decodeJwt(tok: string | null) {
  if (!tok) return null
  try {
    const p = tok.split('.')[1]
    if (!p) return null
    const b = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
    return b
  } catch { return null }
}

function CopyIcon({ onClick }: { onClick: ()=>void }) {
  return (
    <button onClick={onClick} title="Копировать" className="shrink-0 w-7 h-7 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3" /></svg>
    </button>
  )
}

export function ProfilePage({ stats, onLogout, highlightPalette, setHighlightPalette, monoHex, setMonoHex, initialSection }: {
  stats?: any,
  onLogout?: ()=>void,
  highlightPalette?: PaletteId,
  setHighlightPalette?: (v:PaletteId)=>void,
  monoHex?: string,
  setMonoHex?: (v:string)=>void,
  initialSection?: string | null,
}) {
  const { user, logout } = useAuth()
  const [section, setSection] = useState<SectionId>((initialSection as SectionId) || 'overview')

  // Navigate to a section when requested from outside (e.g. the profile dropdown menu)
  useEffect(() => {
    if (initialSection) setSection(initialSection as SectionId)
  }, [initialSection])
  const [showToken, setShowToken] = useState(false)
  const [token, setToken] = useState<string | null>(()=>{ try{ return localStorage.getItem('snip_token')}catch{return null}})
  const [members] = useState<any[]>([])
  const [membersLoading] = useState(false)
  const [membersError, setMembersError] = useState<string|null>(null)

  // --- Real API key state ---
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [apiKeyLoading] = useState(false)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  // --- Quick suggestions editor state ---
  const [quickExamples, setQuickExamples] = useState<string[]>(() => loadQuickExamples())

  const loadApiKey = useCallback(async () => {
    // API-ключи отключены вместе с бэкендом — поиск работает без ключей
    setApiKey(null)
    setApiKeyError('API-ключи больше не нужны: пользуйтесь поиском на сайте')
  }, [])

  const regenerateApiKey = async () => {
    setApiKeyError('API-ключи больше не поддерживаются')
  }

  useEffect(()=>{
    if(!user) return
    if(section==='members'){
      // список пользователей недоступен без сервера
      setMembersError('Раздел участников отключён')
    }
  }, [section, user])

  useEffect(()=>{
    try{ setToken(localStorage.getItem('snip_token')) }catch{}
  }, [section])

  // Load the real API key whenever the user opens Обзор or API ключи
  useEffect(()=>{
    if(!user) return
    if(section==='overview' || section==='keys') loadApiKey()
  }, [section, user, loadApiKey])

  if (!user) return null
  const first = (user.email[0] || '?').toUpperCase()
  const bg = stringToColor(user.email)

  const handleCopy = (txt: string) => {
    navigator.clipboard?.writeText(txt).catch(()=>{})
  }

  const jwtPayload = decodeJwt(token)
  const jwtExp = jwtPayload?.exp ? new Date(Number(jwtPayload.exp) * 1000).toLocaleString('ru-RU') : null

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
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-4 flex items-center gap-3 border-b border-slate-100">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 truncate">{user.email}</div>
              <div className="text-xs text-slate-500 truncate">snippy.llm</div>
            </div>
          </div>
          <nav className="p-2 space-y-1">
            {SECTIONS.map(s=> (
              <button
                key={s.id}
                onClick={()=>setSection(s.id)}
                className={`w-full px-3 py-2.5 rounded-xl text-sm font-medium transition text-left ${section===s.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="p-3 border-t border-slate-100">
            <button onClick={()=>{ if(onLogout) onLogout(); else logout() }} className="w-full px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm hover:bg-slate-50">Выйти</button>
          </div>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-6">
        {section==='overview' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              {/* увеличен отступ: h-20 и -mt-8 + pb-2 + pt-2 чтобы синий не прилипал к почте */}
              <div className="h-20 bg-gradient-to-br from-blue-600 to-indigo-600" />
              <div className="px-6 pb-6 pt-2">
                <div className="flex items-end gap-4 -mt-8">
                  <div className="w-20 h-20 rounded-full border-4 border-white shadow-lg flex items-center justify-center text-white text-2xl font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
                  <div className="flex-1 min-w-0 pb-2 pt-1">
                    <div className="font-semibold text-slate-900 text-lg truncate">{user.email}</div>
                    <div className="text-xs text-slate-500 truncate">{user.full_name || 'Пользователь snippy.llm'}</div>
                  </div>
                </div>
                <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                    <div className="text-xs text-slate-500">Email</div>
                    <div className="font-medium text-slate-900 mt-1.5 break-all">{user.email}</div>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                    <div className="text-xs text-slate-500">Ваш API-ключ</div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <div className="flex-1 font-mono text-sm bg-white border border-slate-200 rounded-xl px-3 py-2 break-all">{apiKeyLoading ? 'Загрузка…' : (showApiKey ? (apiKey || '—') : maskKey(apiKey))}</div>
                      {apiKey && (
                        <button onClick={()=>setShowApiKey(v=>!v)} className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-slate-100 border border-slate-200 hover:bg-slate-50">{showApiKey ? 'Скрыть' : 'Показать'}</button>
                      )}
                      <CopyIcon onClick={()=> apiKey && handleCopy(apiKey)} />
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1.5">Bearer-токен для API • эндпоинт {DISPLAY_API}/api • snippy.llm</div>
                  </div>
                  <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 md:col-span-2">
                    <div className="text-xs text-slate-500">Библиотека</div>
                    <div className="font-medium text-slate-900 mt-1.5">{stats ? `${stats.total_documents} док. • ${stats.active_documents} действ. • ${stats.total_chunks ?? '—'} чанков` : '—'}</div>
                    <div className="text-[11px] text-slate-400 mt-1">Личная программа • только ваши доки • snippy.llm</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {section==='usage' && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-semibold text-slate-900">Использование</h3>
              <p className="text-xs text-slate-500 mt-1">Квота и ИИ • snippy.llm</p>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200"><div className="text-xs text-slate-500">Документы</div><div className="text-xl font-bold text-slate-900 mt-1">{stats?.total_documents ?? '—'}</div><div className="text-xs text-slate-400 mt-1">всего</div></div>
                <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-200"><div className="text-xs text-emerald-700">Фрагменты</div><div className="text-xl font-bold text-emerald-700 mt-1">{stats?.total_chunks ?? '—'}</div><div className="text-xs text-emerald-600 mt-1">чанков</div></div>
                <div className="bg-blue-50 rounded-xl p-4 border border-blue-200"><div className="text-xs text-blue-700">ИИ</div><div className="text-sm font-bold text-blue-700 mt-1">Gemini 768d • Hybrid RRF K=60</div><div className="text-xs text-blue-600 mt-1">Groq LLM с дословной цитатой</div></div>
                <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-200"><div className="text-xs text-emerald-800">Поиск</div><div className="text-sm font-bold text-emerald-800 mt-1">Бесплатный</div><div className="text-xs text-emerald-700 mt-1">работает в браузере • No source → No claim</div></div>
              </div>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                  <div className="text-xs font-semibold text-slate-700">Модель</div>
                  <div className="text-sm text-slate-900 mt-1">Embeddings 384 • Hybrid RRF K=60</div>
                  <div className="text-[11px] text-slate-500 mt-1">BM25 (russian) + pgvector cosine • триграмма для опечаток</div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                  <div className="text-xs font-semibold text-slate-700">ИИ-кредиты</div>
                  <div className="text-sm text-slate-900 mt-1">{user ? '5 ответов/день' : '3 ответа/день'} • 10 кредитов = 1 ИИ-ответ</div>
                  <div className="text-[11px] text-slate-500 mt-1">Сброс каждый день в 00:00 • поиск безлимитный</div>
                </div>
              </div>
              {stats?.last_collector && (
                <div className="mt-4 p-3 rounded-xl bg-white border border-slate-200 text-xs">
                  <div className="font-medium text-slate-900">Последний collector</div>
                  <div className="text-slate-600 mt-1">{stats.last_collector.status} • {stats.last_collector.details || '—'} • {stats.last_collector.created_at ? new Date(stats.last_collector.created_at).toLocaleString('ru-RU') : '—'}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {section==='keys' && (
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-6">
              <h3 className="font-semibold text-slate-900">API ключи</h3>
              <p className="text-xs text-slate-500 mt-1">Ваш API-ключ (sk-…) аутентифицирует запросы к {DISPLAY_API}/api</p>
              <div className="mt-4 space-y-4">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-slate-700">Ваш API-ключ</div>
                    <button onClick={regenerateApiKey} className="text-[11px] px-2.5 py-1 rounded-full bg-slate-900 text-white hover:bg-slate-700 transition">Сгенерировать заново</button>
                  </div>
                  {apiKeyError && <div className="text-[11px] text-red-600 mt-2">{apiKeyError}</div>}
                  <div className="flex items-center gap-2 mt-2">
                    <div className="flex-1 font-mono text-sm bg-white border border-slate-200 rounded-xl px-3 py-2.5 break-all flex items-center gap-2">
                      <span className="truncate flex-1">{apiKeyLoading ? 'Загрузка…' : (showApiKey ? (apiKey || '—') : maskKey(apiKey))}</span>
                      {apiKey && (
                        <button onClick={()=>setShowApiKey(v=>!v)} className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-slate-100 border border-slate-200 hover:bg-slate-50">{showApiKey ? 'Скрыть' : 'Показать'}</button>
                      )}
                    </div>
                    <CopyIcon onClick={()=> apiKey && handleCopy(apiKey)} />
                  </div>
                  <div className="text-[11px] text-slate-400 mt-2">Реальный ключ • формат sk-… • используйте как <code className="font-mono">Authorization: Bearer $SNIPPY_API_KEY</code> • фактический хост {API_BASE}/api</div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-slate-200">
                  <div className="text-xs font-semibold text-slate-700">Пример запроса</div>
                  <div className="mt-2 p-3 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-auto">
                    <div>curl -H "Authorization: Bearer $SNIPPY_API_KEY" \</div>
                    <div className="ml-2 break-all">{DISPLAY_API}/api/search -d &#123;&quot;query&quot;:&quot;ширина коридора&quot;&#125;</div>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-2">$SNIPPY_API_KEY — ваш API-ключ выше • Content-Type: application/json</div>
                </div>
                <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
                  <div className="text-xs font-semibold text-amber-800">JWT токен (сессия)</div>
                  <div className="text-[11px] text-amber-700 mt-1">JSON Web Token • 3 части header.payload.signature • HS256 • ~180 символов — легитимен, выдаётся при входе. Хранится в localStorage `snip_token`. Это не API-ключ: он живёт пока вы в сессии.</div>
                  <div className="flex items-center gap-2 mt-3">
                    <div className="flex-1 font-mono text-xs bg-white border border-amber-200 rounded-xl px-3 py-2.5 break-all flex items-center gap-2">
                      <span className="truncate flex-1">{showToken ? shortenToken(token) : maskToken(token)}</span>
                      <button onClick={()=>setShowToken(v=>!v)} className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-slate-100 border border-slate-200 hover:bg-slate-50">{showToken ? 'Скрыть' : 'Показать'}</button>
                    </div>
                    <CopyIcon onClick={()=> token && handleCopy(token)} />
                  </div>
                  {showToken && jwtPayload && (
                    <div className="text-[11px] text-slate-500 mt-2">выдан для: {jwtPayload.sub || jwtPayload.email || '—'} • действителен до: {jwtExp || '—'}</div>
                  )}
                  <div className="text-[11px] text-slate-500 mt-2">Токен длинный т.к. подписан и содержит exp • не делитесь • snippy.llm JWT</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {section==='members' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <h3 className="font-semibold text-slate-900">Члены</h3>
            <p className="text-xs text-slate-500 mt-1">Команда проекта • доступно владельцу (superuser)</p>
            {membersLoading ? <div className="mt-4 text-sm text-slate-500">Загрузка…</div> : membersError ? (
              <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">{membersError}</div>
            ) : (
              <div className="mt-4 space-y-2">
                {members.map((m:any)=> (
                  <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-white">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: stringToColor(m.email) }}>{(m.email[0]||'?').toUpperCase()}</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{m.email}</div>
                      <div className="text-xs text-slate-500 truncate">{m.full_name || '—'} • {new Date(m.created_at).toLocaleDateString('ru-RU')}</div>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {m.is_superuser && <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700">★ владелец</span>}
                      {m.is_verified ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">verified</span> : <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">не верифицирован</span>}
                    </div>
                  </div>
                ))}
                {members.length===0 && <div className="text-sm text-slate-400 p-3 border border-dashed rounded-xl text-center">Участников нет</div>}
              </div>
            )}
          </div>
        )}

        {section==='billing' && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6">
            <h3 className="font-semibold text-slate-900">Оплата</h3>
            <p className="text-xs text-slate-500 mt-1">Тариф snippy.llm • бесплатно для 10+ пользователей</p>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-2xl border-2 border-slate-900 p-5 bg-white">
                <div className="text-sm font-bold text-slate-900">Free</div>
                <div className="text-2xl font-bold text-slate-900 mt-1">0 ₸ <span className="text-xs font-normal text-slate-500">/ мес</span></div>
                <ul className="text-xs text-slate-600 mt-3 space-y-1 list-disc ml-4">
                  <li>До 10 пользователей</li>
                  <li>Личные документы и корзины</li>
                  <li>AI поиск (BM25+vector)</li>
                  <li>JWT защита</li>
                </ul>
                <div className="mt-4 px-3 py-2 rounded-xl bg-slate-900 text-white text-xs text-center">Текущий тариф</div>
              </div>
              <div className="rounded-2xl border border-slate-200 p-5 bg-slate-50 opacity-60">
                <div className="text-sm font-bold text-slate-900">Pro <span className="text-xs font-normal text-slate-500">скоро</span></div>
                <div className="text-2xl font-bold text-slate-900 mt-1">—</div>
                <ul className="text-xs text-slate-600 mt-3 space-y-1 list-disc ml-4">
                  <li>Неограниченно пользователей</li>
                  <li>Командные корзины</li>
                  <li>API ключи + вебхуки</li>
                  <li>Приоритетная поддержка</li>
                </ul>
                <div className="mt-4 px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs text-center">Скоро</div>
              </div>
            </div>
            <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-800">Оплата пока не требуется • snippy.llm личная программа</div>
          </div>
        )}

        {section==='settings' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900">Подсветка совпадений</h3>
              <p className="text-xs text-slate-500 mt-1">Готовые пресеты убраны: оставлен дефолт и режим моно, а также ваши кастомные палитры (максимум 5 с дефолтом). Каждое слово запроса подсвечивается своим цветом.</p>
              {highlightPalette && setHighlightPalette && monoHex !== undefined && setMonoHex && (
                <HighlightPaletteSettings
                  highlightPalette={highlightPalette}
                  setHighlightPalette={setHighlightPalette}
                  monoHex={monoHex}
                  setMonoHex={setMonoHex}
                />
              )}
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900">Быстрые подсказки под поиском</h3>
              <p className="text-xs text-slate-500 mt-1">Кнопки-подсказки под строкой поиска. Редактируйте текст, добавляйте или удаляйте — применяется сразу и сохраняется локально.</p>
              <div className="mt-3 space-y-2">
                {quickExamples.map((ex, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={ex}
                      onChange={e => updateQuickExample(i, e.target.value)}
                      placeholder="Текст подсказки…"
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white"
                    />
                    <button onClick={() => removeQuickExample(i)} title="Удалить" className="shrink-0 w-9 h-9 rounded-xl bg-white border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200 flex items-center justify-center text-lg">×</button>
                  </div>
                ))}
                {quickExamples.length === 0 && <div className="text-xs text-slate-400 p-3 border border-dashed rounded-xl text-center">Подсказок нет — добавьте ниже</div>}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={addQuickExample}
                  disabled={quickExamples.length >= QUICK_EXAMPLES_MAX}
                  className="px-3 py-2 text-xs rounded-xl bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 transition"
                >+ Добавить подсказку</button>
                <span className="text-[11px] text-slate-400">{quickExamples.length} / {QUICK_EXAMPLES_MAX}</span>
                <button
                  onClick={() => setQuickExamples(resetQuickExamples())}
                  className="ml-auto text-[11px] px-2.5 py-1.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50"
                >Сбросить к умолчанию</button>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5">
              <h3 className="font-semibold text-slate-900">Кредиты</h3>
              <p className="text-xs text-slate-500 mt-1">10 кредитов = 1 ИИ-ответ с дословной цитатой. Поиск по нормам — бесплатный и безлимитный.</p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl border border-slate-200 bg-slate-50"><div className="text-slate-500">Гость</div><div className="font-semibold text-slate-900 mt-0.5">30 кредитов / день</div></div>
                <div className="p-3 rounded-xl border border-blue-200 bg-blue-50"><div className="text-blue-700">Зарегистрирован</div><div className="font-semibold text-blue-900 mt-0.5">50 кредитов / день</div></div>
              </div>
              <div className="mt-3 p-3 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-800">
                Подписка с увеличенным лимитом — скоро.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
