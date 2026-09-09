// @ts-nocheck — TODO: fix TypeScript errors incrementally
import React, { useState, useEffect } from 'react'
import { statusBadge, relevanceColor } from '../utils/badges'
import { highlightText, HighlightLegend } from '../utils/highlight'
import { SnakeState } from '../components/SnakeState'
import { VoiceButton } from '../components/VoiceButton'
import { resultsToMarkdown, downloadAsFile, copyToClipboard, formatCitation, cleanParagraph, sanitizeQuote, truncateSmart, formatParagraph } from '../utils/exportUtils'
import type { SearchResponse } from '../hooks/useSearch'
import { loadQuickExamples, QUICK_EXAMPLES_EVENT } from '../utils/examples'
import { loadRecentDocs, removeRecentDoc, clearRecentDocs, RECENT_DOCS_EVENT, type RecentDoc } from '../utils/recentDocs'
import { addFavorite, removeFavorite, isFavorite, favoriteId, FAVORITES_EVENT } from '../utils/favorites'
import { FAST_COST, DEEP_COST, FOLLOWUP_COST } from '../utils/credits'
import { askFollowUp } from '../search/searchClient'
import { isSemanticMode } from '../search/engine'
import { FeedbackBar } from '../components/FeedbackBar'

/** Короткие подписи провайдера ИИ-ответа (приходит из /ask, бейдж — только для не-Groq звеньев). */
export const PROVIDER_LABEL: Record<string, string> = {
  groq: 'Groq',
  'groq-alt': 'Groq · запасная',
  gemini: 'Gemini',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  'mistral-chat': 'Mistral',
  'cohere-chat': 'Cohere',
  custom: 'Резервный',
  cache: 'кэш',
  'workers-ai': 'Workers AI',
  zen: 'Zen · MiMo',
  pollinations: 'Pollinations',
}

export function cleanAnswerText(s: string) {
  if (!s) return s
  // Наследие старого сбоя парсинга (больше не приходит с сервера) — человеческий текст
  if (s.trim() === 'Не удалось разобрать ответ модели.') {
    return 'Сервис ответов временно недоступен — смотрите подходящие варианты ниже.'
  }
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (t.startsWith('{') && t.includes('"answer"')) {
    try {
      const m = t.match(/\{[\s\S]*\}/)
      if (m) {
        let raw = m[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
        const j = JSON.parse(raw)
        if (j.answer && typeof j.answer === 'string') return j.answer.trim()
        if (j.ответ) return String(j.ответ).trim()
      }
    } catch {}
  }
  t = t.replace(/^\{\s*"answer"\s*:\s*"/, '').replace(/"\s*,\s*"normative_basis".*$/s, '').trim()
  return t
}

const FOLLOWUP_CHIPS = ['А для жилых зданий?', 'А пункт и страница точнее?', 'А исключения есть?']

/** Компактный выбор режима поиска: ghost-кнопка + меню (ввод в баре — максимально широкий). */
function ModeSelect({ mode, setMode }: {
  mode: 'fast' | 'deep'
  setMode: (v: 'fast' | 'deep') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open ])
  const opts = [
    { v: 'fast' as const, label: 'Быстрый', cost: FAST_COST, hint: '3 результата', title: `Быстрый поиск: 3 результата • ${FAST_COST} кредитов` },
    { v: 'deep' as const, label: 'Глубокий', cost: DEEP_COST, hint: 'до 30 + цитата', title: `Глубокий поиск: до 30 результатов + ответ с цитатой • ${DEEP_COST} кредитов` },
  ]
  const cur = opts.find((o) => o.v === mode) ?? opts[0]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Режим поиска"
        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition"
      >
        {cur.label} • ⚡{cur.cost}
        <span className={`text-[10px] text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 min-w-[190px] bg-white dark:bg-slate-900 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden z-30 py-1">
          {opts.map((o) => (
            <button
              key={o.v}
              type="button"
              role="menuitemradio"
              aria-checked={mode === o.v}
              title={o.title}
              onClick={() => { setMode(o.v); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition ${mode === o.v ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              <span className="font-semibold whitespace-nowrap">{o.label} • ⚡{o.cost}</span>
              <span className="text-slate-400 truncate">{o.hint}</span>
              {mode === o.v && <span className="ml-auto shrink-0">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Тред уточняющих вопросов под ответом: поиск не повторяется, контекст chunkIds + история (до 2 витков). */
function FollowUpThread({ query, baseAnswer, chunkIds, onNeedCredits }: {
  query: string
  baseAnswer: string
  chunkIds: string[]
  onNeedCredits: () => void
}) {
  const [turns, setTurns] = useState<{ q: string; a: string; quote?: string; grounded: boolean; extractive?: boolean }[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const history = [{ q: query, a: baseAnswer }, ...turns.map((t) => ({ q: t.q, a: t.a }))].slice(-3)
      const res = await askFollowUp(text, chunkIds, history)
      setTurns((prev) => [...prev, {
        q: text,
        a: cleanAnswerText(res.answer.answer),
        quote: res.answer.quote,
        grounded: res.answer.is_grounded,
        extractive: res.answer.extractive,
      }])
      setInput('')
    } catch (e: any) {
      if (e?.insufficientCredits) { onNeedCredits(); return }
      setError('Не удалось получить уточнение — попробуйте новый поиск')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase mb-2">Уточнить у Сниппи</div>
      {turns.map((t, i) => (
        <div key={i} className="mb-3 animate-[slideUp_.2s_ease-out]">
          <div className="flex justify-end"><div className="max-w-[90%] px-3 py-2 rounded-2xl rounded-br-md bg-blue-600 text-white text-[13px]">{t.q}</div></div>
          <div className="mt-1.5 px-3 py-2.5 rounded-2xl rounded-tl-md bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{t.a}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            {t.grounded
              ? <span className="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300">✓ По источнику из норм</span>
              : <span className="px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300">Точного требования не найдено</span>}
            {t.extractive && <span className="text-slate-400">цитаты из норм · резерв</span>}
          </div>
          {t.quote && <div className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400 border-l-2 border-blue-300 dark:border-blue-800 pl-2 overflow-hidden max-w-full [overflow-wrap:anywhere]">«{(() => { const q = sanitizeQuote(t.quote); return q.length > 300 ? q.slice(0, 300) + '…' : q })()}»</div>}
        </div>
      ))}
      {error && <div className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {FOLLOWUP_CHIPS.map((c) => (
          <button key={c} onClick={() => send(c)} disabled={sending} className="text-[11px] px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition disabled:opacity-40">{c}</button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="flex max-md:flex-col max-md:items-stretch items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите вдогонку…"
          maxLength={300}
          className="flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 max-md:py-2.5 max-md:text-base text-sm bg-white dark:bg-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <button type="submit" disabled={sending || !input.trim()} title={`Уточнение без нового поиска • ${FOLLOWUP_COST} кредитов`} className="shrink-0 px-4 py-2 max-md:py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition disabled:opacity-50 max-md:w-full">
          {sending ? '…' : `Уточнить ⚡${FOLLOWUP_COST}`}
        </button>
      </form>
    </div>
  )
}

type SearchViewProps = {
  query: string
  setQuery: (v: string) => void
  mode: 'fast' | 'deep'
  setMode: (v: 'fast' | 'deep') => void
  loading: boolean
  resp: any | null
  error: string | null
  searchHistory: string[]
  clearHistory: () => void
  removeHistoryItem?: (item: string) => void
  showHistory: boolean
  setShowHistory: (v: boolean) => void
  filterType: string
  setFilterType: (v: string) => void
  filterStatus: string
  setFilterStatus: (v: string) => void
  showFilters: boolean
  setShowFilters: (v: boolean) => void
  doSearch: (q?: string) => void
  highlightPalette: string
  setHighlightPalette?: (v: string) => void
  monoHex: string
  setMonoHex?: (v: string) => void
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
  openPdf: (documentId: string, page?: number, quote?: string | null) => void
  searchInputRef?: React.RefObject<HTMLInputElement>
  insufficientCredits?: boolean
  setInsufficientCredits?: (v: boolean) => void
  onTopUp?: () => void
}

export function SearchView(props: SearchViewProps) {
  const {
    query, setQuery, mode, setMode, loading, resp, error,
    searchHistory, clearHistory, removeHistoryItem, showHistory, setShowHistory,
    filterType, setFilterType, filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    doSearch, highlightPalette, monoHex,
    user, setShowAuth, setAuthMode, openPdf, searchInputRef, insufficientCredits, setInsufficientCredits, onTopUp,
  } = props

  const [examples, setExamples] = useState<string[]>(() =>
    loadQuickExamples().length ? loadQuickExamples() : ['ширина коридора', 'высота подоконника', 'ширина лестничного марша']
  )
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyTimer = React.useRef<number | null>(null)
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>(() => loadRecentDocs())
  const [, setFavTick] = useState(0)
  useEffect(() => {
    const onRecent = () => setRecentDocs(loadRecentDocs())
    window.addEventListener(RECENT_DOCS_EVENT, onRecent)
    return () => window.removeEventListener(RECENT_DOCS_EVENT, onRecent)
  }, [])
  useEffect(() => {
    const onFav = () => setFavTick((t) => t + 1)
    window.addEventListener(FAVORITES_EVENT, onFav)
    return () => window.removeEventListener(FAVORITES_EVENT, onFav)
  }, [])
  const copyWithHint = (key: string, text: string) => {
    copyToClipboard(text)
    setCopiedKey(key)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1500)
  }
  useEffect(() => {
    const onUpdate = () => setExamples(loadQuickExamples())
    window.addEventListener(QUICK_EXAMPLES_EVENT, onUpdate)
    return () => window.removeEventListener(QUICK_EXAMPLES_EVENT, onUpdate)
  }, [])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    doSearch()
  }

  const snakeVariant: 'thinking' | 'searching' | 'success' | 'failed' =
    loading ? 'searching' : error ? 'failed' : resp ? 'success' : 'thinking'

  return (
    <>
      {/* ── Hero / Search Bar ── */}
      <div className="bg-gradient-to-b from-white to-slate-50 dark:from-slate-900 dark:to-slate-950 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-5xl mx-auto px-4 py-6 md:py-12 max-md:py-4 max-md:pb-2 flex flex-col md:flex-row md:items-center gap-4 md:gap-10">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl md:text-4xl max-md:text-[22px] font-bold text-slate-900 dark:text-white text-center md:text-left leading-tight">
              Что вы хотите найти?
            </h1>
            <p className="text-center md:text-left text-slate-500 dark:text-slate-400 mt-2 mb-6 max-md:mb-4 max-md:text-sm">
              Поиск по действующим строительным нормам Казахстана • <span className="text-blue-600 dark:text-blue-400 font-medium">быстрый ⚡{FAST_COST} • глубокий ⚡{DEEP_COST}</span>
            </p>

          <form onSubmit={onSubmit} className="relative">
            <div className="flex items-center gap-2 max-md:gap-1 bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-slate-200/60 dark:shadow-black/20 border border-slate-200 dark:border-slate-700 p-2 max-md:p-1 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 transition">
              <div className="pl-3 text-slate-400 shrink-0 max-md:hidden">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              </div>
              <input
                ref={searchInputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                placeholder="Например: ширина коридора"
                // max-md:text-base: 16px на телефоне — iOS не зумит при фокусе
                className="flex-1 min-w-0 w-full outline-none text-[15px] max-md:text-base py-2.5 max-md:py-2 max-md:pl-2 placeholder:text-slate-400 dark:text-white dark:bg-transparent"
              />
              <VoiceButton onTranscript={(text) => { setQuery(text); searchInputRef?.current?.focus() }} className="max-md:w-9 max-md:h-9" />
              <button type="submit" disabled={loading} title={mode === 'fast' ? `Быстрый поиск: 3 результата` : `Глубокий поиск: до 30 результатов + ответ с цитатой`} className="flex items-center gap-1.5 px-5 max-md:px-2.5 max-md:gap-1 py-2.5 max-md:py-2 max-md:min-h-[40px] bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition disabled:opacity-50 shadow-sm shadow-blue-600/25 shrink-0">
                <span className="max-md:hidden">{loading ? 'Поиск…' : 'Найти'}</span>
                {/* Мобайл: компактная лупа вместо слова «Найти» — поле ввода шире */}
                <span className="md:hidden flex items-center">
                  {loading ? (
                    <span className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                  )}
                </span>
                {!loading && (
                  <span className={`flex items-center gap-0.5 px-1.5 max-md:px-1 py-0.5 rounded-lg text-[11px] max-md:text-[10px] font-bold ${mode === 'deep' ? 'bg-indigo-500/40' : 'bg-blue-500/40'}`}>⚡{mode === 'deep' ? DEEP_COST : FAST_COST}</span>
                )}
              </button>
            </div>

            {/* ── Search History Dropdown ── */}
            {showHistory && searchHistory.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-2 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden z-30 max-h-[280px] overflow-y-auto">
                <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                  <span className="text-xs font-semibold text-slate-500 tracking-widest uppercase">История поиска</span>
                  <button type="button" onMouseDown={e => { e.preventDefault(); clearHistory() }} className="text-xs text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                {searchHistory.filter(h => !query || h.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(h => (
                  <button key={h} type="button" title="Вставить в поиск" onMouseDown={e => { e.preventDefault(); setQuery(h); setShowHistory(false); setTimeout(() => searchInputRef?.current?.focus(), 0) }} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-3 text-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v4l2 2" /></svg>
                    <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{h}</span>
                    <span role="button" tabIndex={0} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); if (removeHistoryItem) removeHistoryItem(h)}} className="text-slate-300 hover:text-red-400 px-2 cursor-pointer">×</span>
                  </button>
                ))}
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400">синонимы • опечатки • семантика</div>
              </div>
            )}

            {/* ── Mode + Filters Row: одна слим-строка по центру ── */}
            <div className="mt-3 flex items-center justify-center gap-2">
              <ModeSelect mode={mode} setMode={setMode} />
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <button type="button" onClick={() => setShowFilters(!showFilters)} className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
                Фильтры {filterType || filterStatus !== 'active' ? '• активны' : ''}
              </button>
              {(filterType || filterStatus !== 'active') && <button type="button" onClick={() => { setFilterType(''); setFilterStatus('active') }} className="text-xs text-blue-600">Сбросить</button>}
            </div>

            {/* ── Filters Panel ── */}
            {showFilters && (
              <div className="mt-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                <label className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Тип документа</span>
                  <select value={filterType} onChange={e => setFilterType(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white px-2 py-1.5 text-sm">
                    <option value="">Все типы</option>
                    <option value="СНиП">СНиП</option>
                    <option value="СН РК">СН РК</option>
                    <option value="СП РК">СП РК</option>
                    <option value="ГОСТ">ГОСТ</option>
                    <option value="НТД">НТД</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Статус</span>
                  <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white px-2 py-1.5 text-sm">
                    <option value="active">Только действующие</option>
                    <option value="">Все</option>
                    <option value="expired">Утратил силу</option>
                    <option value="replaced">Заменён</option>
                  </select>
                </label>
                <div className="text-[11px] text-slate-400 flex items-end pb-1">По умолчанию — только действующие</div>
              </div>
            )}
          </form>

          {/* ── Example Queries: на мобайле — скролл в одну строку, на десктопе — wrap по центру ── */}
          <div className="flex gap-2 mt-5 max-md:mt-4 flex-wrap justify-center max-md:flex-nowrap max-md:justify-start max-md:overflow-x-auto max-md:pb-1 max-md:-mx-4 max-md:px-4 no-scrollbar">
            {examples.map(ex => (
              <button key={ex} onClick={() => { setQuery(ex); searchInputRef?.current?.focus() }} title="Вставить в поиск" className="shrink-0 text-xs px-3 py-1.5 max-md:py-2 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition">{ex}</button>
            ))}
          </div>

          <div className="max-md:hidden text-center text-[11px] text-slate-400 mt-4">Коридор = проход = эвакуационный путь • Лестница = марш = клетка • Понимает опечатки</div>
          </div>
          {/* Змейка — только десктоп: на мобилке съедает экран */}
          <div className="hidden md:flex md:shrink-0 items-center justify-center order-first md:order-none">
            <SnakeState variant={snakeVariant} size={170} />
          </div>
        </div>
      </div>

      {/* ── Results Area ── */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6 max-md:py-3">

        {!user && !loading && !resp && !insufficientCredits && (
          <div className="text-center py-2 mb-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs">
              Гостям — 30⚡ в день. <button onClick={() => { setAuthMode('register'); setShowAuth(true) }} className="underline font-medium">Зарегистрируйтесь</button> для 300⚡ каждый час + накопительный баланс
            </div>
          </div>
        )}

        {error && !insufficientCredits && <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-4 text-sm">{error}</div>}

        {insufficientCredits && (
          <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20 p-6 text-center animate-[slideUp_.2s_ease-out]">
            <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center text-2xl mb-3">⚡</div>
            <div className="font-semibold text-slate-900 dark:text-white text-lg">Недостаточно кредитов</div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mt-2 max-w-md mx-auto">
              {mode === 'fast'
                ? `Для быстрого поиска нужно ${FAST_COST}⚡. Бесплатный лимит исчерпан — пополните баланс или зарегистрируйтесь (300⚡ каждый час).`
                : `Для глубокого поиска нужно ${DEEP_COST}⚡. Пополните баланс или дождитесь обновления лимита (у зарегистрированных — каждый час).`}
            </div>
            <div className="mt-4 flex items-center justify-center gap-3 flex-wrap max-md:flex-col max-md:items-stretch">
              <button onClick={() => { if (onTopUp) onTopUp() }} className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition shadow-sm shadow-blue-600/25 max-md:w-full">Пополнить баланс →</button>
              {!user && (
                <>
                  <button onClick={() => { setAuthMode('register'); setShowAuth(true) }} className="px-6 py-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition max-md:w-full">Регистрация: 300⚡/час бесплатно</button>
                  <button onClick={() => setInsufficientCredits?.(false)} className="text-xs text-slate-500 underline">Закрыть</button>
                </>
              )}
            </div>
            <div className="text-[11px] text-slate-400 mt-3">Лимит зарегистрированных обновляется каждый час • купленные кредиты не сгорают</div>
          </div>
        )}

        {/* ── Empty State ── */}
        {!resp && !loading && !error && !insufficientCredits && (
          <div className="text-center py-10">
            {recentDocs.length > 0 && (
              <div className="mb-8 text-left bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">Недавние документы</div>
                  <button onClick={() => { clearRecentDocs(); setRecentDocs([]) }} className="text-[11px] text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                <div className="space-y-1.5">
                  {recentDocs.map((d) => (
                    <div key={d.docId} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition text-left">
                      <button onClick={() => openPdf(d.docId, d.page)} className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-base shrink-0">📄</span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{d.number}</span>
                          {d.title && <span className="block text-[11px] text-slate-400 truncate">{d.title} • стр. {d.page}</span>}
                          {!d.title && <span className="block text-[11px] text-slate-400">стр. {d.page}</span>}
                        </span>
                      </button>
                      <button onClick={() => { removeRecentDoc(d.docId); setRecentDocs(loadRecentDocs()) }} title="Убрать" className="shrink-0 text-slate-300 hover:text-red-400 px-1.5">×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-400 dark:text-slate-500">
              <span>🎤 Голосовой поиск</span>
              <span>⌨️ <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">/</kbd> фокус на поиск</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">⌘K</kbd> быстрый поиск</span>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-6 max-w-md mx-auto">Быстрый поиск — 3 результата за {FAST_COST}⚡. Глубокий — до 30 результатов + ответ с дословной цитатой за {DEEP_COST}⚡.</p>
          </div>
        )}

        {/* ── Loading State ── */}
        {loading && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center">
            <div className="flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400">
              <span className="w-5 h-5 border-2 border-slate-300 dark:border-slate-600 border-t-blue-600 rounded-full animate-spin" />
              <span className="text-sm">{mode === 'deep' ? 'Snippy глубоко анализирует нормы…' : 'Snippy листает нормы…'}</span>
            </div>
            <div className="mt-4 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden max-w-xs mx-auto"><div className="h-full bg-blue-600 animate-pulse" style={{ width: '60%' }} /></div>
          </div>
        )}

        {/* ── Results ── */}
        {resp && !loading && (
          <div className="space-y-5 max-md:space-y-3">
            {/* Meta bar: только десктоп — на мобайле скрыт ради минимализма */}
            <div className="hidden md:flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>Найдено {resp.total_found} за {resp.took_ms} мс • {resp.mode === 'deep' ? 'Глубокий режим' : 'Быстрый'} {mode === 'deep' && resp.mode === 'deep' && <span className="ml-1 px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900">расширенный</span>}{isSemanticMode() && <span title="Смысловой режим: векторный приоритет + расширенные синонимы (Настройки → Режим поиска)" className="ml-1 px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-900">смысловой 💡</span>}</span>
              <div className="flex flex-wrap max-md:flex-nowrap max-md:overflow-x-auto max-md:w-full max-md:pb-0.5 items-center gap-2 no-scrollbar">
                <button onClick={() => { const md = resultsToMarkdown(resp); downloadAsFile(md, `snippy_${resp.query.slice(0,30).replace(/\s+/g,'_')}.md`, 'text/markdown') }} className="px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-[11px]">📥 Markdown</button>
                <button onClick={() => { copyToClipboard(resultsToMarkdown(resp)) }} className="px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-[11px]">📋 Копировать</button>
                <button onClick={() => copyWithHint('share', `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(resp.query)}&mode=${resp.mode}`)} title="Ссылка на этот поиск" className="px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-[11px]">{copiedKey === 'share' ? '✓ Ссылка скопирована' : '🔗 Поделиться'}</button>
              </div>
            </div>

            {/* Highlight Legend: только десктоп — на мобайле скрыт ради минимализма */}
            {resp.query && (
              <div className="max-md:hidden bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5 tracking-widest uppercase">Подсветка совпадений</div>
                <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
              </div>
            )}

            {/* ── Answer Block ── */}
            {resp.answer && (
              <div className={`rounded-2xl border p-5 max-md:p-4 animate-[slideUp_.25s_ease-out] ${resp.answer.is_grounded ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm' : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs ${resp.answer.is_grounded ? 'bg-emerald-500' : 'bg-amber-500'}`}>{resp.answer.is_grounded ? '✓' : '!'}</span>
                  <span className="font-semibold text-slate-900 dark:text-white text-sm">{resp.answer.is_grounded ? 'Наиболее подходящий ответ' : 'Точного требования не найдено'}</span>
                  {resp.answer.is_grounded && !resp.answer.extractive && <span title="Ответ только при найденной норме; без источника — честно говорит «не найдено»" className="ml-auto hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300">✓ По источнику из норм</span>}
                  {resp.answer.is_grounded && !resp.answer.extractive && resp.answer.provider && resp.answer.provider !== 'groq' && <span title={`Ответ подготовил ${PROVIDER_LABEL[resp.answer.provider] || resp.answer.provider} (резервное звено)`} className="hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-950 border border-violet-200 dark:border-violet-900 text-violet-700 dark:text-violet-300">через {PROVIDER_LABEL[resp.answer.provider] || resp.answer.provider}</span>}
                  {resp.answer.extractive && <span className="ml-auto hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400" title="Ответ собран из цитат найденных норм: основные звенья были недоступны">цитаты из норм · резерв</span>}
                </div>
                <div className="text-[14px] max-md:text-[15px] leading-relaxed text-slate-700 dark:text-slate-200">
                  <div className="font-medium text-slate-900 dark:text-white mb-2">Ответ:</div>
                  <p className="m-0 whitespace-pre-wrap">{cleanAnswerText(resp.answer.answer)}</p>
                </div>
                {resp.answer.is_grounded && (
                  <div className="mt-4 max-md:mt-3 grid grid-cols-1 max-md:grid-cols-2 md:grid-cols-2 gap-3 max-md:gap-2 text-xs">
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 max-md:p-2 border border-slate-200 dark:border-slate-700 max-md:min-w-0"><div className="text-slate-500 dark:text-slate-400 max-md:text-[11px]">Нормативное основание</div><div className="font-medium text-slate-900 dark:text-white mt-0.5 max-md:truncate" title={resp.results[0]?.document_number || resp.answer.normative_basis || ''}>{resp.results[0]?.document_number || resp.answer.normative_basis || '—'}</div></div>
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 max-md:p-2 border border-slate-200 dark:border-slate-700 max-md:min-w-0"><div className="text-slate-500 dark:text-slate-400 max-md:text-[11px]">Пункт • Страница</div><div className="font-medium text-slate-900 dark:text-white mt-0.5 max-md:truncate">{formatParagraph(cleanParagraph(resp.answer.paragraph) || resp.results[0]?.paragraph || resp.answer.paragraph)} • стр. {resp.results[0]?.page ?? '—'}</div></div>
                    {resp.answer.quote && <div className="max-md:col-span-2 md:col-span-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl p-3 max-md:p-2.5"><div className="text-slate-500 dark:text-slate-400 mb-1">Цитата из нормы:</div><div className="font-mono text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 rounded-lg p-3 border border-blue-100 dark:border-blue-900 overflow-hidden max-w-full [overflow-wrap:anywhere]">"{highlightText(sanitizeQuote(resp.answer.quote.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}"</div></div>}
                    {resp.results[0] && (
                      <div className="max-md:col-span-2 md:col-span-2 flex flex-wrap max-md:flex-col max-md:items-stretch items-center gap-2">
                        <button onClick={() => openPdf(resp.results[0].document_id, resp.results[0].page ?? resp.answer.page ?? 1, resp.answer.quote || resp.results[0].text)} className="px-4 py-2 max-md:py-2.5 rounded-full bg-blue-600 text-white text-xs max-md:text-[13px] font-semibold hover:bg-blue-700 transition shadow-sm shadow-blue-600/25 max-md:w-full">
                          <span className="max-md:hidden">Открыть PDF → стр. {resp.results[0]?.page ?? '—'} + контекст ответа 💡</span>
                          <span className="md:hidden">📄 Открыть PDF • стр. {resp.results[0]?.page ?? '—'}</span>
                        </button>
                        <div className="flex flex-wrap max-md:grid max-md:grid-cols-2 items-center gap-2 max-md:w-full">
                        <button onClick={() => copyWithHint('cite-answer', formatCitation({ document_number: resp.results[0].document_number, paragraph: cleanParagraph(resp.answer.paragraph) || resp.results[0].paragraph, page: resp.results[0].page }))} title="Скопировать сноску на норму" className="px-3 py-2 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition text-xs max-md:text-center">{copiedKey === 'cite-answer' ? '✓ Скопировано' : '📋 Сноска'}</button>
                        {(() => {
                          const fid = favoriteId({ kind: 'answer', query: resp.query, documentNumber: resp.results[0].document_number, page: resp.results[0].page });
                          const saved = isFavorite(fid);
                          return (
                            <button
                              onClick={() => {
                                if (saved) removeFavorite(fid);
                                else addFavorite({
                                  kind: 'answer', query: resp.query,
                                  answer: cleanAnswerText(resp.answer.answer),
                                  quote: resp.answer.quote || resp.results[0].text,
                                  documentId: resp.results[0].document_id,
                                  documentNumber: resp.results[0].document_number,
                                  documentTitle: resp.results[0].document_title,
                                  paragraph: cleanParagraph(resp.answer.paragraph) || resp.results[0].paragraph,
                                  page: resp.results[0].page,
                                });
                              }}
                              title={saved ? 'Убрать из избранного' : 'Сохранить ответ в избранное'}
                              className={`px-3 py-2 rounded-full border text-xs max-md:text-center transition ${saved ? 'bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-amber-300 hover:text-amber-700 dark:hover:text-amber-400'}`}
                            >{saved ? '★ Сохранено' : '☆ В избранное'}</button>
                          );
                        })()}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {resp.answer.is_grounded && (
                  <FollowUpThread
                    key={`${resp.query}:${resp.took_ms}`}
                    query={resp.query || query}
                    baseAnswer={cleanAnswerText(resp.answer.answer)}
                    chunkIds={resp.results.slice(0, 5).map((r) => r.chunk_id)}
                    onNeedCredits={() => setInsufficientCredits?.(true)}
                  />
                )}
                {resp.answer.is_grounded && (
                  <FeedbackBar
                    key={`${resp.query}:${resp.took_ms}:fb`}
                    query={resp.query || query}
                    mode={resp.mode}
                    provider={resp.answer.provider}
                    chunkIds={resp.results.slice(0, 5).map((r) => r.chunk_id)}
                    paragraph={cleanParagraph(resp.answer.paragraph) || resp.results[0]?.paragraph}
                    answerExcerpt={cleanAnswerText(resp.answer.answer)}
                  />
                )}
              </div>
            )}

            {resp.message && (!resp.answer?.is_grounded || resp.degraded) && <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-3">{resp.message}</div>}

            {/* ── Result Cards ── */}
            {(() => {
              const displayResults = resp.answer?.is_grounded ? resp.results.slice(1) : resp.results
              const filtered = displayResults
              const hasMore = filtered.length > 0

              return (
                <>
                  {hasMore && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">{resp.answer?.is_grounded ? 'Другие подходящие варианты' : 'Подходящие варианты'} • {filtered.length}</div>
                      <span className="contents max-md:hidden"><HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} /></span>
                    </div>
                  )}
                  {filtered.map((r, idx) => {
                    const badge = statusBadge(r.status)
                    const isTopOther = idx === 0 && !resp.answer?.is_grounded
                    return (
                      <div
                        key={r.chunk_id}
                        className={`bg-white dark:bg-slate-900 rounded-2xl border p-4 md:p-5 hover:shadow-md hover:-translate-y-px transition-all animate-[slideUp_.25s_ease-out] ${isTopOther ? 'border-blue-300 dark:border-blue-800 ring-1 ring-blue-100 dark:ring-blue-950' : 'border-slate-200 dark:border-slate-800'}`}
                        style={{ animationDelay: `${Math.min(idx * 40, 240)}ms` }}
                      >
                        {isTopOther && <div className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 tracking-widest uppercase mb-2">Наиболее подходящее</div>}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900 dark:text-white text-sm">{r.document_number}</span>
                              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                              {r.paragraph && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">п. {r.paragraph}</span>}
                              {r.page && <span className="text-xs text-slate-500 dark:text-slate-400">стр. {r.page}</span>}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">{r.document_title}</div>
                          </div>
                          <div className="flex items-start gap-2 shrink-0">
                            <div className="text-right">
                              <div className={`inline-flex items-center gap-1.5 text-xs font-semibold text-white px-2.5 py-1 rounded-full ${relevanceColor(r.relevance_percent)}`}><span>{r.relevance_percent}%</span></div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 text-center">{r.relevance_label}</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border border-slate-200 dark:border-slate-700 overflow-hidden max-w-full [overflow-wrap:anywhere]">{highlightText(truncateSmart(r.text, 600), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}</div>
                        <div className="mt-3 flex flex-wrap max-md:flex-col max-md:items-stretch items-center gap-2 text-xs">
                          <button onClick={() => openPdf(r.document_id, r.page, r.text)} className="px-3 py-1.5 max-md:py-2.5 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition max-md:w-full max-md:text-[13px]">
                            <span className="max-md:hidden">Открыть PDF → стр. {r.page ?? '—'} + контекст 💡</span>
                            <span className="md:hidden">📄 PDF • стр. {r.page ?? '—'}</span>
                          </button>
                          <div className="flex flex-wrap max-md:grid max-md:grid-cols-2 items-center gap-2 max-md:w-full">
                          <button onClick={() => copyWithHint(`cite-${r.chunk_id}`, formatCitation({ document_number: r.document_number, paragraph: r.paragraph, page: r.page }))} title="Скопировать сноску на норму" className="px-3 py-1.5 max-md:py-2 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition max-md:text-center">{copiedKey === `cite-${r.chunk_id}` ? '✓' : '📋 Сноска'}</button>
                          {(() => {
                            const fid = favoriteId({ kind: 'fragment', chunkId: r.chunk_id, query: resp.query });
                            const saved = isFavorite(fid);
                            return (
                              <button
                                onClick={() => {
                                  if (saved) removeFavorite(fid);
                                  else addFavorite({
                                    kind: 'fragment', chunkId: r.chunk_id, query: resp.query, text: r.text,
                                    documentId: r.document_id, documentNumber: r.document_number,
                                    documentTitle: r.document_title, paragraph: r.paragraph, page: r.page,
                                  });
                                }}
                                title={saved ? 'Убрать из избранного' : 'Сохранить фрагмент в избранное'}
                                className={`px-3 py-1.5 max-md:py-2 rounded-full border transition max-md:text-center ${saved ? 'bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 hover:border-amber-300 hover:text-amber-700 dark:hover:text-amber-400'}`}
                              >{saved ? (<><span className="max-md:hidden">★</span><span className="md:hidden">★ Сохранить</span></>) : (<><span className="max-md:hidden">☆</span><span className="md:hidden">☆ Сохранить</span></>)}</button>
                            );
                          })()}
                          </div>
                          {r.source_url && r.source_url !== 'file://local' && <a href={r.source_url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-blue-600 underline max-md:text-center max-md:py-1">Первоисточник</a>}
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden"><div className={`h-full rounded-full ${relevanceColor(r.relevance_percent)}`} style={{ width: `${r.relevance_percent}%` }} /></div>
                      </div>
                    )
                  })}
                </>
              )
            })()}

            {resp.results.length === 0 && (
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
                <SnakeState variant="failed" title="Ничего не нашёл, но я старался" subtitle="Попробуйте синоним: коридор → проход / лестница → марш. Или снимите фильтры." size={140} action={<button onClick={() => { setFilterStatus(''); setFilterType(''); if (query) doSearch(query) }} className="px-4 py-2 rounded-full bg-blue-600 text-white text-xs">Сбросить фильтры</button>} />
              </div>
            )}
          </div>
        )}
      </main>
    </>
  )
}
