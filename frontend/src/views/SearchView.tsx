// @ts-nocheck — TODO: fix TypeScript errors incrementally
import React, { useState, useEffect } from 'react'
import { statusBadge, relevanceColor } from '../utils/badges'
import { highlightText, HighlightLegend, PALETTES, listPaletteOptions } from '../utils/highlight'
import type { PaletteId } from '../utils/highlight'
import { BasketBar } from '../components/BasketBar'
import { PinButton } from '../components/PinButton'
import { SnakeState } from '../components/SnakeState'
import { VoiceButton } from '../components/VoiceButton'
import { resultsToMarkdown, downloadAsFile, copyToClipboard } from '../utils/exportUtils'
import type { SearchResponse } from '../hooks/useSearch'
import { loadQuickExamples, QUICK_EXAMPLES_EVENT } from '../utils/examples'

export function cleanAnswerText(s: string) {
  if (!s) return s
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  // if still JSON wrapper with "answer": extract
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
  // strip leading { "answer": " prefix if remained
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
  searchPinnedOnly: boolean
  setSearchPinnedOnly: (v: boolean | ((v: boolean) => boolean)) => void
  doSearch: (q?: string) => void
  highlightPalette: PaletteId
  setHighlightPalette: (v: PaletteId) => void
  monoHex: string
  setMonoHex: (v: string) => void
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
  openPdf: (documentId: string, page?: number) => void
  handleBasketFiles: (files: File[], basketId: string | null) => void
  activeBasketId: string | null
  baskets: any[]
  pinnedItems: any[]
  isPinned: (documentId: string) => boolean
  assignments: Record<string, string>
  localDocs: any[]
  setBasketDragging: (v: boolean) => void
  setDraggedDocId: (v: string | null) => void
  searchInputRef?: React.RefObject<HTMLInputElement>
  quotaExceeded?: boolean
  setQuotaExceeded?: (v: boolean) => void
}

export function SearchView(props: SearchViewProps) {
  const {
    query, setQuery, mode, setMode, loading, resp, error,
    searchHistory, clearHistory, removeHistoryItem, showHistory, setShowHistory,
    filterType, setFilterType, filterStatus, setFilterStatus,
    showFilters, setShowFilters, searchPinnedOnly, setSearchPinnedOnly,
    doSearch, highlightPalette, setHighlightPalette, monoHex, setMonoHex,
    user, setShowAuth, setAuthMode, openPdf, handleBasketFiles,
    activeBasketId, baskets, pinnedItems, isPinned, assignments,
    localDocs, setBasketDragging, setDraggedDocId, searchInputRef, quotaExceeded, setQuotaExceeded,
  } = props

  const [examples, setExamples] = useState<string[]>(() => loadQuickExamples())
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
      <div className="bg-gradient-to-b from-white to-slate-50 border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-8 md:py-12 flex flex-col md:flex-row md:items-center gap-6 md:gap-10">
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 text-center md:text-left leading-tight">
              Что вы хотите найти?
            </h1>
            <p className="text-center md:text-left text-slate-500 mt-2 mb-6">
              Интеллектуальный поиск по действующим строительным нормам Казахстана
            </p>

          <form onSubmit={onSubmit} className="relative">
            <div className="flex items-center gap-2 bg-white rounded-2xl shadow-lg border border-slate-200 p-2 focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
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
                className="flex-1 outline-none text-[15px] py-2.5 placeholder:text-slate-400"
              />
              <div className="hidden md:flex items-center gap-1 border-l border-slate-200 pl-2">
                <button type="button" onClick={() => setMode('fast')} className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${mode === 'fast' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Быстрый</button>
                <button type="button" onClick={() => setMode('deep')} className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${mode === 'deep' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Глубокий</button>
              </div>
              <VoiceButton onTranscript={(text) => { setQuery(text); doSearch(text) }} />
              <button type="submit" disabled={loading} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition disabled:opacity-50">{loading ? 'Поиск…' : 'Найти'}</button>
            </div>

            {/* ── Search History Dropdown ── */}
            {showHistory && searchHistory.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-2 bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden z-30 max-h-[280px] overflow-y-auto">
                <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100">
                  <span className="text-xs font-semibold text-slate-500 tracking-widest uppercase">История поиска • бесплатно локально</span>
                  <button type="button" onMouseDown={e => { e.preventDefault(); clearHistory() }} className="text-xs text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                {searchHistory.filter(h => !query || h.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(h => (
                  <button key={h} type="button" onMouseDown={e => { e.preventDefault(); setQuery(h); setShowHistory(false); setTimeout(() => doSearch(h), 0) }} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-3 text-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v4l2 2" /></svg>
                    <span className="flex-1 truncate text-slate-700">{h}</span>
                    <span role="button" tabIndex={0} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); if (removeHistoryItem) removeHistoryItem(h); else { const n = searchHistory.filter(x => x !== h); try{ localStorage.setItem('snip_search_hist', JSON.stringify(n)); }catch{} } }} onClick={e => { e.preventDefault(); e.stopPropagation(); if (removeHistoryItem) removeHistoryItem(h)}} className="text-slate-300 hover:text-red-400 px-2 cursor-pointer">×</span>
                  </button>
                ))}
                <div className="px-3 py-2 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-400">OCR + гибрид (BM25+вектор+триграмма) • синонимы • опечатки • бесплатно</div>
              </div>
            )}

            {/* ── Mobile Mode Toggle ── */}
            <div className="md:hidden flex gap-1 mt-3 justify-center">
              <button type="button" onClick={() => setMode('fast')} className={`px-3 py-1 text-xs rounded-full ${mode === 'fast' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-200'}`}>Быстрый поиск</button>
              <button type="button" onClick={() => setMode('deep')} className={`px-3 py-1 text-xs rounded-full ${mode === 'deep' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200'}`}>Глубокий анализ</button>
            </div>

            {/* ── Filters Row ── */}
            <div className="mt-3 flex items-center justify-center gap-2">
              <button type="button" onClick={() => setShowFilters(!showFilters)} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
                Фильтры {filterType || filterStatus !== 'active' ? '• активны' : ''}
              </button>
              {(filterType || filterStatus !== 'active') && <button type="button" onClick={() => { setFilterType(''); setFilterStatus('active') }} className="text-xs text-blue-600">Сбросить</button>}
              {pinnedItems.length > 0 && (
                <button type="button" onClick={() => setSearchPinnedOnly(v => !v)} className={`text-xs px-3 py-1 rounded-full border transition flex items-center gap-1 ${searchPinnedOnly ? 'bg-amber-400 text-white border-amber-400' : 'bg-white text-slate-600 border-slate-200 hover:border-amber-300'}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill={searchPinnedOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"><path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z"/></svg>
                  {searchPinnedOnly ? `Только закрепы • ${pinnedItems.length}` : `Закрепы • ${pinnedItems.length}`}
                </button>
              )}
            </div>

            {/* ── Filters Panel ── */}
            {showFilters && (
              <div className="mt-3 bg-white rounded-xl border border-slate-200 p-3 grid grid-cols-2 md:grid-cols-3 gap-3">
                <label className="text-xs">
                  <span className="text-slate-500">Тип документа</span>
                  <select value={filterType} onChange={e => setFilterType(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
                    <option value="">Все типы</option>
                    <option value="СНиП">СНиП</option>
                    <option value="СН РК">СН РК</option>
                    <option value="СП РК">СП РК</option>
                    <option value="ГОСТ">ГОСТ</option>
                    <option value="НТД">НТД</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="text-slate-500">Статус</span>
                  <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
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
              <button key={ex} onClick={() => { setQuery(ex); doSearch(ex) }} className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600 hover:border-blue-300 hover:text-blue-700 transition">{ex}</button>
            ))}
            {examples.length === 0 && <span className="text-xs text-slate-400">Нет подсказок — добавьте в Профиль → Настройки</span>}
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
        <div className="mb-4"><BasketBar /></div>
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/></svg>
            Загрузить PDF в «{activeBasketId ? (baskets.find(b => b.id === activeBasketId)?.name || 'Корзина') : 'Все'}»
            <input type="file" accept=".pdf" multiple className="hidden" onChange={e => { const files = Array.from((e.target as HTMLInputElement).files || []); if (files.length) handleBasketFiles(files, activeBasketId); (e.target as HTMLInputElement).value = '' }} />
          </label>
          <span className="text-[11px] text-slate-400">до 100 МБ • перетащите на корзину</span>
        </div>

        {!user && !loading && !resp && (
          <div className="text-center py-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs">Поиск доступен без входа — <button onClick={() => setShowAuth(true)} className="underline font-medium">войдите</button> для истории и закладок</div>
          </div>
        )}

        {error && !quotaExceeded && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error}</div>}

        {quotaExceeded && (
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 flex items-center justify-center text-2xl mb-3">🔒</div>
            <div className="font-semibold text-slate-900 text-lg">Бесплатный лимит исчерпан</div>
            <div className="text-sm text-slate-600 mt-2 max-w-md mx-auto">Вы использовали все бесплатные запросы. Зарегистрируйтесь чтобы получить 200 запросов и полный доступ к базе строительных норм.</div>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button onClick={() => { if (setAuthMode) setAuthMode('register'); if (setShowAuth) setShowAuth(true) }} className="px-6 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition">Зарегистрироваться</button>
              <button onClick={() => { if (setAuthMode) setAuthMode('login'); if (setShowAuth) setShowAuth(true) }} className="px-6 py-2.5 rounded-xl bg-white border border-slate-200 text-sm text-slate-700 hover:bg-slate-50 transition">Войти</button>
            </div>
            <div className="text-[11px] text-slate-400 mt-3">Регистрация бесплатная • 200 запросов • без привязки карты</div>
          </div>
        )}

        {/* ── Empty State ── */}
        {!resp && !loading && !error && !quotaExceeded && (
          <div className="text-center py-10">
            <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-slate-400 dark:text-slate-500">
              <span>🎤 Голосовой поиск</span>
              <span>⌨️ <kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">/</kbd> фокус на поиск</span>
              <span><kbd className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 font-mono">⌘K</kbd> быстрый поиск</span>
            </div>
            <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-3 text-left">
              <div className="bg-white rounded-xl border border-slate-200 p-4"><div className="text-xs font-semibold text-slate-900">Full-text + BM25</div><div className="text-xs text-slate-500 mt-1">Точный поиск</div></div>
              <div className="bg-white rounded-xl border border-slate-200 p-4"><div className="text-xs font-semibold text-slate-900">Embeddings + Vector</div><div className="text-xs text-slate-500 mt-1">Семантика, синонимы</div></div>
              <div className="bg-white rounded-xl border border-slate-200 p-4"><div className="text-xs font-semibold text-slate-900">Rerank + LLM</div><div className="text-xs text-slate-500 mt-1">Ответ с цитатой • No source → No claim</div></div>
            </div>
          </div>
        )}

        {/* ── Loading State ── */}
        {loading && (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center">
            <div className="flex items-center justify-center gap-2 text-slate-500">
              <span className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
              <span className="text-sm">{mode === 'deep' ? 'Snippy глубоко анализирует 5 документов…' : 'Snippy листает нормы…'}</span>
            </div>
            <div className="mt-4 h-1.5 bg-slate-100 rounded-full overflow-hidden max-w-xs mx-auto"><div className="h-full bg-blue-600 animate-pulse" style={{ width: '60%' }} /></div>
          </div>
        )}

        {/* ── Results ── */}
        {resp && !loading && (
          <div className="space-y-5">
            {/* Meta bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
              <span>Найдено {resp.total_found} за {resp.took_ms} мс • {resp.mode === 'deep' ? 'Глубокий синтез (до 20 результатов, 5-7 источников)' : 'Быстрый (топ-10, 3 источника)'} {mode === 'deep' && resp.mode === 'deep' && <span className="ml-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">расширенный поиск + сравнение</span>}</span>
              <div className="flex flex-wrap items-center gap-2">
                {/* Export buttons */}
                <button onClick={() => { const md = resultsToMarkdown(resp); downloadAsFile(md, `snippy_${resp.query.slice(0,30).replace(/\s+/g,'_')}.md`, 'text/markdown') }} className="px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50 transition text-[11px]">📥 Markdown</button>
                <button onClick={() => { copyToClipboard(resultsToMarkdown(resp)); /* toast handled by parent */ }} className="px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50 transition text-[11px]">📋 Копировать</button>
                <span className="hidden sm:inline">Палитра:</span>
                <select value={highlightPalette} onChange={e => setHighlightPalette(e.target.value as PaletteId)} className="rounded-full border border-slate-200 px-2 py-1 text-xs bg-white">
                  {listPaletteOptions().map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {highlightPalette === 'mono' && (
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <input type="color" value={monoHex} onChange={e => setMonoHex(e.target.value)} className="w-7 h-7 p-0 rounded-full border border-slate-200 cursor-pointer" title="Цвет моно-подсветки" />
                    <input value={monoHex} onChange={e => { const v = e.target.value; if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setMonoHex(v) }} placeholder="#fde68a" className="w-24 px-2 py-1 rounded-full border border-slate-200 text-xs font-mono" />
                  </span>
                )}
              </div>
            </div>

            {/* Highlight Legend */}
            {resp.query && (
              <div className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="text-[11px] text-slate-500 mb-1.5 tracking-widest uppercase">Подсветка совпадений • {highlightPalette === 'mono' ? `один цвет ${monoHex}` : 'разные цвета для разных слов'}</div>
                <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
              </div>
            )}

            {/* ── Answer Block ── */}
            {resp.answer && (
              <div className={`rounded-2xl border p-5 ${resp.answer.is_grounded ? 'bg-white border-slate-200' : 'bg-amber-50 border-amber-200'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-xs ${resp.answer.is_grounded ? 'bg-emerald-500' : 'bg-amber-500'}`}>{resp.answer.is_grounded ? '✓' : '!'}</span>
                  <span className="font-semibold text-slate-900 text-sm">{resp.answer.is_grounded ? 'ИИ нашёл наиболее подходящее требование' : 'Точного требования не найдено'}</span>
                  {resp.answer.is_grounded && resp.results[0] && (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="hidden sm:inline text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">No source → No claim</span>
                      <PinButton documentId={resp.results[0].document_id} number={resp.results[0].document_number} title={resp.results[0].document_title} status={resp.results[0].status} chunkId={resp.results[0].chunk_id} query={resp.query || query} chunkText={resp.results[0].text} paragraph={resp.results[0].paragraph || resp.answer.paragraph || null} page={resp.results[0].page ?? resp.answer.page ?? null} />
                    </div>
                  )}
                  {resp.answer.is_grounded && !resp.results[0] && <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">No source → No claim</span>}
                </div>
                <div className="text-[14px] leading-relaxed text-slate-700">
                  <div className="font-medium text-slate-900 mb-2">Ответ:</div>
                  <p className="m-0 whitespace-pre-wrap">{cleanAnswerText(resp.answer.answer)}</p>
                </div>
                {resp.answer.is_grounded && (
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="bg-slate-50 rounded-xl p-3 border border-slate-200"><div className="text-slate-500">Нормативное основание</div><div className="font-medium text-slate-900 mt-0.5">{resp.answer.normative_basis || '—'}</div></div>
                    <div className="bg-slate-50 rounded-xl p-3 border border-slate-200"><div className="text-slate-500">Пункт • Страница • Статус</div><div className="font-medium text-slate-900 mt-0.5">{(resp.answer.paragraph && resp.answer.paragraph !== '—' && resp.answer.paragraph !== '-') ? `п. ${resp.answer.paragraph}` : (resp.results[0]?.paragraph ? `п. ${resp.results[0].paragraph}` : '—')} • стр. {resp.answer.page ?? resp.results[0]?.page ?? '—'} • <span className={`px-1.5 py-0.5 rounded-full border text-[11px] ${statusBadge(resp.answer.status || 'active').cls}`}>{statusBadge(resp.answer.status || 'active').label}</span></div></div>
                    {resp.answer.quote && <div className="md:col-span-2 bg-blue-50 border border-blue-200 rounded-xl p-3"><div className="text-slate-500 mb-1">Цитата: <span className="text-[11px] text-slate-400">подсветка {highlightPalette === 'mono' ? 'одним цветом' : 'разными цветами'}</span></div><div className="font-mono text-[13px] leading-relaxed text-slate-800 bg-white rounded-lg p-3 border border-blue-100">"{highlightText(resp.answer.quote.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}"</div></div>}
                    <div className="md:col-span-2 flex items-center justify-between text-[11px] text-slate-400"><span>Дата актуальности: {resp.answer.date_actual || '—'}</span><span>snippy.llm • Только онлайн • Защищено JWT</span></div>
                  </div>
                )}
              </div>
            )}

            {resp.message && !resp.answer?.is_grounded && <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">{resp.message}</div>}

            {/* ── Result Cards ── */}
            {(() => {
              const displayResults = resp.answer?.is_grounded ? resp.results.slice(1) : resp.results
              let filtered = displayResults
              if (searchPinnedOnly) filtered = filtered.filter(r => isPinned(r.document_id))
              if (activeBasketId) filtered = filtered.filter(r => assignments[r.document_id] === activeBasketId)
              const hasMore = filtered.length > 0

              if (filtered.length === 0 && (searchPinnedOnly || activeBasketId)) {
                return (
                  <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center">
                    <div className="text-sm font-medium text-slate-700">Нет результатов в этой корзине/фильтре</div>
                    <div className="text-xs text-slate-500 mt-1">Снимите корзину «{activeBasketId ? baskets.find(b => b.id === activeBasketId)?.name : ''}» или фильтр</div>
                    <div className="flex gap-2 justify-center mt-3">
                      {activeBasketId && <button onClick={() => setActiveBasketId(null)} className="px-3 py-1.5 rounded-full bg-white border border-slate-200 text-xs">Все корзины</button>}
                      <button onClick={() => setSearchPinnedOnly(false)} className="px-4 py-1.5 rounded-full bg-amber-400 text-white text-xs">Сбросить «только закрепы»</button>
                    </div>
                  </div>
                )
              }

              return (
                <>
                  {resp.answer?.is_grounded && hasMore && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-500 tracking-widest uppercase">Другие подходящие варианты • {filtered.length} {searchPinnedOnly && '• только закрепы'}</div>
                      <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
                    </div>
                  )}
                  {!resp.answer?.is_grounded && filtered.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-500 tracking-widest uppercase">Подходящие варианты • {filtered.length}</div>
                      <HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} />
                    </div>
                  )}
                  {filtered.map((r, idx) => {
                    const badge = statusBadge(r.status)
                    const isTopOther = idx === 0 && !resp.answer?.is_grounded
                    return (
                      <div
                        key={r.chunk_id}
                        draggable
                        onDragStart={e => {
                          const payload = { document_id: r.document_id, number: r.document_number, title: r.document_title, type: (r as any).document_type || null, status: r.status, source_url: r.source_url, kind: 'chunk', chunk_id: r.chunk_id, query: resp.query || query, text: r.text, paragraph: r.paragraph, page: r.page }
                          e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                          e.dataTransfer.setData('text/plain', r.chunk_id)
                          e.dataTransfer.effectAllowed = 'copy'
                          setBasketDragging(true); setDraggedDocId(r.document_id)
                          const img = document.createElement('div')
                          img.textContent = `📑 ${r.document_number}`
                          img.style.position = 'absolute'; img.style.top = '-1000px'
                          document.body.appendChild(img)
                          e.dataTransfer.setDragImage(img, 0, 0)
                          setTimeout(() => img.remove(), 0)
                        }}
                        onDragEnd={() => { setBasketDragging(false); setDraggedDocId(null) }}
                        className={`bg-white rounded-2xl border p-4 md:p-5 hover:shadow-md transition cursor-grab active:cursor-grabbing ${isTopOther ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-200'}`}
                      >
                        {isTopOther && <div className="text-[11px] font-semibold text-blue-600 tracking-widest uppercase mb-2">Наиболее подходящее • {r.relevance_percent}%</div>}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900 text-sm">{r.document_number}</span>
                              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                              {r.paragraph && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">п. {r.paragraph}</span>}
                              {r.page && <span className="text-xs text-slate-500">стр. {r.page}</span>}
                              {assignments[r.document_id] && baskets.find(b => b.id === assignments[r.document_id]) && (
                                <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white border" style={{ backgroundColor: baskets.find(b => b.id === assignments[r.document_id])!.color, borderColor: baskets.find(b => b.id === assignments[r.document_id])!.color }}>
                                  {baskets.find(b => b.id === assignments[r.document_id])!.name}
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 mt-1 line-clamp-1">{r.document_title}</div>
                          </div>
                          <div className="flex items-start gap-2 shrink-0">
                            <PinButton documentId={r.document_id} number={r.document_number} title={r.document_title} status={r.status} chunkId={r.chunk_id} query={resp.query || query} chunkText={r.text} paragraph={r.paragraph} page={r.page} />
                            <div className="text-right">
                              <div className={`inline-flex items-center gap-1.5 text-xs font-semibold text-white px-2.5 py-1 rounded-full ${relevanceColor(r.relevance_percent)}`}><span>{r.relevance_percent}%</span></div>
                              <div className="text-[11px] text-slate-500 mt-1 text-center">{r.relevance_label}</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 text-[13px] leading-relaxed text-slate-700 bg-slate-50 rounded-xl p-3 border border-slate-200">{highlightText(r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text, resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}</div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                          {r.document_id.startsWith('local:') ? (
                            <span className="px-3 py-1.5 rounded-full bg-slate-50 border border-slate-200 text-slate-500">стр. {r.page ?? '—'} • локально</span>
                          ) : (
                            <button onClick={() => openPdf(r.document_id, r.page)} className="px-3 py-1.5 rounded-full bg-white border border-slate-200 hover:border-blue-300 hover:text-blue-700 transition">Открыть PDF → стр. {r.page ?? '—'}</button>
                          )}
                          {r.source_url && r.source_url !== 'file://local' && <a href={r.source_url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-blue-600 underline">Первоисточник</a>}
                        </div>
                        <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${relevanceColor(r.relevance_percent)}`} style={{ width: `${r.relevance_percent}%` }} /></div>
                      </div>
                    )
                  })}
                </>
              )
            })()}

            {resp.results.length === 0 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-6">
                <SnakeState variant="failed" title="Ничего не нашёл, но я старался" subtitle="Попробуйте синоним: коридор → проход / лестница → марш. Или снимите фильтры." size={140} action={<button onClick={() => { setFilterStatus(''); setFilterType(''); if (query) doSearch(query) }} className="px-4 py-2 rounded-full bg-blue-600 text-white text-xs">Сбросить фильтры</button>} />
              </div>
            )}
          </div>
        )}
      </main>
    </>
  )
}
