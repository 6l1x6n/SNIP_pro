// @ts-nocheck — TODO: fix TypeScript errors incrementally
import React, { useState, useEffect } from 'react'
import { statusBadge, relevanceColor } from '../utils/badges'
import { highlightText, HighlightLegend, listPaletteOptions } from '../utils/highlight'
import type { PaletteId } from '../utils/highlight'
import { SnakeState } from '../components/SnakeState'
import { VoiceButton } from '../components/VoiceButton'
import { resultsToMarkdown, downloadAsFile, copyToClipboard } from '../utils/exportUtils'
import type { SearchResponse } from '../hooks/useSearch'
import { loadQuickExamples, QUICK_EXAMPLES_EVENT } from '../utils/examples'

export function cleanAnswerText(s: string) {
  if (!s) return s
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
  highlightPalette: PaletteId
  setHighlightPalette: (v: PaletteId) => void
  monoHex: string
  setMonoHex: (v: string) => void
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
  openPdf: (documentId: string, page?: number) => void
  searchInputRef?: React.RefObject<HTMLInputElement>
  quotaExceeded?: boolean
  setQuotaExceeded?: (v: boolean) => void
}

export function SearchView(props: SearchViewProps) {
  const {
    query, setQuery, mode, setMode, loading, resp, error,
    searchHistory, clearHistory, removeHistoryItem, showHistory, setShowHistory,
    filterType, setFilterType, filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    doSearch, highlightPalette, setHighlightPalette, monoHex, setMonoHex,
    setShowAuth, setAuthMode, openPdf, searchInputRef, quotaExceeded, setQuotaExceeded,
  } = props

  const [examples, setExamples] = useState<string[]>(() =>
    loadQuickExamples().length ? loadQuickExamples() : ['ширина коридора', 'высота подоконника', 'ширина лестничного марша']
  )
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
        <div className="max-w-5xl mx-auto px-4 py-8 md:py-12 flex flex-col md:flex-row md:items-center gap-6 md:gap-10">
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white text-center md:text-left leading-tight">
              Что вы хотите найти?
            </h1>
            <p className="text-center md:text-left text-slate-500 dark:text-slate-400 mt-2 mb-6">
              ИИ-поиск по действующим строительным нормам Казахстана • <span className="text-emerald-600 dark:text-emerald-400 font-medium">поиск бесплатный</span>
            </p>

          <form onSubmit={onSubmit} className="relative">
            <div className="flex items-center gap-2 bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-slate-200/60 dark:shadow-black/20 border border-slate-200 dark:border-slate-700 p-2 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500 transition">
              <div className="pl-3 text-slate-400">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              </div>
              <input
                ref={searchInputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                placeholder="Например: минимальная ширина коридора"
                className="flex-1 outline-none text-[15px] py-2.5 placeholder:text-slate-400 dark:text-white dark:bg-transparent"
              />
              <div className="hidden md:flex items-center gap-1 border-l border-slate-200 dark:border-slate-700 pl-2">
                <button type="button" onClick={() => setMode('fast')} title="Топ-10 результатов" className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${mode === 'fast' ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>Быстрый</button>
                <button type="button" onClick={() => setMode('deep')} title="До 20 результатов, глубже синтез" className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${mode === 'deep' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>Глубокий</button>
              </div>
              <VoiceButton onTranscript={(text) => { setQuery(text); doSearch(text) }} />
              <button type="submit" disabled={loading} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition disabled:opacity-50 shadow-sm shadow-blue-600/25">{loading ? 'Поиск…' : 'Найти'}</button>
            </div>

            {/* ── Search History Dropdown ── */}
            {showHistory && searchHistory.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-2 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden z-30 max-h-[280px] overflow-y-auto">
                <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                  <span className="text-xs font-semibold text-slate-500 tracking-widest uppercase">История поиска</span>
                  <button type="button" onMouseDown={e => { e.preventDefault(); clearHistory() }} className="text-xs text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                {searchHistory.filter(h => !query || h.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(h => (
                  <button key={h} type="button" onMouseDown={e => { e.preventDefault(); setQuery(h); setShowHistory(false); setTimeout(() => doSearch(h), 0) }} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-3 text-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v4l2 2" /></svg>
                    <span className="flex-1 truncate text-slate-700 dark:text-slate-200">{h}</span>
                    <span role="button" tabIndex={0} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); if (removeHistoryItem) removeHistoryItem(h)}} className="text-slate-300 hover:text-red-400 px-2 cursor-pointer">×</span>
                  </button>
                ))}
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400">синонимы • опечатки • семантика • бесплатно</div>
              </div>
            )}

            {/* ── Mobile Mode Toggle ── */}
            <div className="md:hidden flex gap-1 mt-3 justify-center">
              <button type="button" onClick={() => setMode('fast')} className={`px-3 py-1 text-xs rounded-full ${mode === 'fast' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>Быстрый поиск</button>
              <button type="button" onClick={() => setMode('deep')} className={`px-3 py-1 text-xs rounded-full ${mode === 'deep' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>Глубокий анализ</button>
            </div>

            {/* ── Filters Row ── */}
            <div className="mt-3 flex items-center justify-center gap-2">
              <button type="button" onClick={() => setShowFilters(!showFilters)} className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
                Фильтры {filterType || filterStatus !== 'active' ? '• активны' : ''}
              </button>
              {(filterType || filterStatus !== 'active') && <button type="button" onClick={() => { setFilterType(''); setFilterStatus('active') }} className="text-xs text-blue-600">Сбросить</button>}
            </div>

            {/* ── Filters Panel ── */}
            {showFilters && (
              <div className="mt-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-3 grid grid-cols-2 md:grid-cols-3 gap-3">
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

          {/* ── Example Queries ── */}
          <div className="flex flex-wrap gap-2 mt-5 justify-center">
            {examples.map(ex => (
              <button key={ex} onClick={() => { setQuery(ex); doSearch(ex) }} className="text-xs px-3 py-1.5 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition">{ex}</button>
            ))}
          </div>

          <div className="text-center text-[11px] text-slate-400 mt-4">Коридор = проход = эвакуационный путь • Лестница = марш = клетка • Понимает опечатки</div>
          </div>
          <div className="flex md:shrink-0 items-center justify-center order-first md:order-none">
            <SnakeState variant={snakeVariant} size={130} />
          </div>
        </div>
      </div>

      {/* ── Results Area ── */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6">

        {!user && !loading && !resp && !quotaExceeded && (
          <div className="text-center py-2 mb-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300 text-xs">
              Поиск доступен без входа — <button onClick={() => { setAuthMode('login'); setShowAuth(true) }} className="underline font-medium">войдите</button> для 5 ИИ-ответов в день вместо 3
            </div>
          </div>
        )}

        {error && !quotaExceeded && <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-4 text-sm">{error}</div>}

        {quotaExceeded && (
          <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20 p-6 text-center animate-[slideUp_.2s_ease-out]">
            <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center text-2xl mb-3">🔒</div>
            <div className="font-semibold text-slate-900 dark:text-white text-lg">ИИ-кредиты на сегодня исчерпаны</div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mt-2 max-w-md mx-auto">
              Гостям — 3 ИИ-ответа в день, после регистрации — 5. Поиск по нормам остаётся бесплатным и безлимитным.
            </div>
            {!user && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <button onClick={() => { setAuthMode('register'); setShowAuth(true) }} className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition shadow-sm shadow-blue-600/25">Зарегистрироваться</button>
                <button onClick={() => { setAuthMode('login'); setShowAuth(true) }} className="px-6 py-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition">Войти</button>
              </div>
            )}
            <div className="text-[11px] text-slate-400 mt-3">Регистрация бесплатная • лимит обновляется каждый день в 00:00 • без привязки карты</div>
          </div>
        )}

        {/* ── Empty State ── */}
        {!resp && !loading && !error && !quotaExceeded && (
          <div className="text-center py-10">
            <div className="mt-4 flex flex-wrap items-center justify-center gap-4 text-[11px] text-slate-400 dark:text-slate-500">
              <span>🎤 Голосовой поиск</span>
              <span>⌨️ <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">/</kbd> фокус на поиск</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">⌘K</kbd> быстрый поиск</span>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-6 max-w-md mx-auto">Поиск мгновенный и бесплатный. ИИ-ответ с дословной цитатой из нормы — 10 кредитов (гостям 3 ответа в день, зарегистрированным 5).</p>
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
          <div className="space-y-5">
            {/* Meta bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>Найдено {resp.total_found} за {resp.took_ms} мс • {resp.mode === 'deep' ? 'Глубокий режим' : 'Быстрый'} {mode === 'deep' && resp.mode === 'deep' && <span className="ml-1 px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-900">расширенный</span>}</span>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => { const md = resultsToMarkdown(resp); downloadAsFile(md, `snippy_${resp.query.slice(0,30).replace(/\s+/g,'_')}.md`, 'text/markdown') }} className="px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-[11px]">📥 Markdown</button>
                <button onClick={() => { copyToClipboard(resultsToMarkdown(resp)) }} className="px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-[11px]">📋 Копировать</button>
                <span className="hidden sm:inline">Палитра:</span>
                <select value={highlightPalette} onChange={e => setHighlightPalette(e.target.value as PaletteId)} className="rounded-full border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs bg-white dark:bg-slate-900 dark:text-white">
                  {listPaletteOptions().map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {highlightPalette === 'mono' && (
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <input type="color" value={monoHex} onChange={e => setMonoHex(e.target.value)} className="w-7 h-7 p-0 rounded-full border border-slate-200 dark:border-slate-700 cursor-pointer" title="Цвет моно-подсветки" />
                    <input value={monoHex} onChange={e => { const v = e.target.value; if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setMonoHex(v) }} placeholder="#fde68a" className="w-24 px-2 py-1 rounded-full border border-slate-200 dark:border-slate-700 text-xs font-mono dark:bg-slate-900 dark:text-white" />
                  </span>
                )}
              </div>
            </div>

            {/* Highlight Legend */}
            {resp.query && (
              <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5 tracking-widest uppercase">Подсветка совпадений</div>
                <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
              </div>
            )}

            {/* ── Answer Block ── */}
            {resp.answer && (
              <div className={`rounded-2xl border p-5 animate-[slideUp_.25s_ease-out] ${resp.answer.is_grounded ? 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm' : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs ${resp.answer.is_grounded ? 'bg-emerald-500' : 'bg-amber-500'}`}>{resp.answer.is_grounded ? '✓' : '!'}</span>
                  <span className="font-semibold text-slate-900 dark:text-white text-sm">{resp.answer.is_grounded ? 'ИИ нашёл наиболее подходящее требование' : 'Точного требования не найдено'}</span>
                  {resp.answer.is_grounded && <span className="ml-auto hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300">No source → No claim</span>}
                </div>
                <div className="text-[14px] leading-relaxed text-slate-700 dark:text-slate-200">
                  <div className="font-medium text-slate-900 dark:text-white mb-2">Ответ:</div>
                  <p className="m-0 whitespace-pre-wrap">{cleanAnswerText(resp.answer.answer)}</p>
                </div>
                {resp.answer.is_grounded && (
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-200 dark:border-slate-700"><div className="text-slate-500 dark:text-slate-400">Нормативное основание</div><div className="font-medium text-slate-900 dark:text-white mt-0.5">{resp.results[0]?.document_number || resp.answer.normative_basis || '—'}</div></div>
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-200 dark:border-slate-700"><div className="text-slate-500 dark:text-slate-400">Пункт • Страница</div><div className="font-medium text-slate-900 dark:text-white mt-0.5">{(resp.answer.paragraph && resp.answer.paragraph !== '—') ? `п. ${resp.answer.paragraph}` : (resp.results[0]?.paragraph ? `п. ${resp.results[0].paragraph}` : '—')} • стр. {resp.results[0]?.page ?? '—'}</div></div>
                    {resp.answer.quote && <div className="md:col-span-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl p-3"><div className="text-slate-500 dark:text-slate-400 mb-1">Цитата из нормы:</div><div className="font-mono text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 rounded-lg p-3 border border-blue-100 dark:border-blue-900">"{highlightText(resp.answer.quote.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}"</div></div>}
                  </div>
                )}
              </div>
            )}

            {resp.message && !resp.answer?.is_grounded && <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-3">{resp.message}</div>}

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
                      <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
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
                        <div className="mt-3 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border border-slate-200 dark:border-slate-700">{highlightText(r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text, resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}</div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          <button onClick={() => openPdf(r.document_id, r.page)} className="px-3 py-1.5 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-300 hover:text-blue-700 dark:hover:text-blue-400 transition">Открыть PDF → стр. {r.page ?? '—'}</button>
                          {r.source_url && r.source_url !== 'file://local' && <a href={r.source_url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-blue-600 underline">Первоисточник</a>}
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
