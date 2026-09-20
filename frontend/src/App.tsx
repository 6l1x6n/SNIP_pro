// @ts-nocheck
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { useAuth } from './context/AuthContext'
import { LoginForm, RegisterForm } from './components/AuthForms'
import { useToast } from './components/Toast'
import { useSearch, loadLastResp } from './hooks/useSearch'
import { useDocuments } from './hooks/useDocuments'
import { SearchView } from './views/SearchView'
import { DocsView } from './views/DocsView'
import { ProfileView } from './views/ProfileView'
import { FavoritesView } from './views/FavoritesView'
import { AdminView } from './views/AdminView'
import { loadFavorites, FAVORITES_EVENT } from './utils/favorites'
import { isAdminEmail } from './utils/admin'
import { ProfileMenu } from './components/ProfileMenu'
import { MobileNav, type MobileTab } from './components/MobileNav'
import { CreditsBadge } from './components/CreditsBadge'
import { Icon } from './components/Icon'
import type { PaletteId, ContextMarkMode } from './utils/highlight'
import { listPaletteOptions, loadContextMarkMode, saveContextMarkMode } from './utils/highlight'
// --- NEW FEATURES ---
import { useTheme } from './context/ThemeContext'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { ShortcutsModal } from './components/ShortcutsModal'
import { QuickSearch } from './components/QuickSearch'
import { ErrorBoundary } from './components/ErrorBoundary'
const PdfViewerModal = lazy(() => import('./components/PdfViewerModal').then(m => ({ default: m.PdfViewerModal })))
import { HistorySidebar } from './components/HistorySidebar'
import { HistorySearchModal } from './components/HistorySearchModal'
import { trackSearch } from './utils/analytics'

export default function App() {
  const { user, logout } = useAuth()
  const { showToast } = useToast()

  const [tab, setTab] = useState<'search' | 'docs' | 'favorites' | 'settings' | 'profile' | 'admin'>('search')
  const [highlightPalette, setHighlightPalette] = useState<PaletteId>(() => {
    try {
      const v = localStorage.getItem('snip_highlight_palette')
      if (v && listPaletteOptions().some((o) => o.id === v)) return v
    } catch {}
    return 'default'
  })
  const [monoHex, setMonoHex] = useState<string>(() => {
    try { const v = localStorage.getItem('snip_highlight_mono_hex'); if (v && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v; return '#fde68a' } catch { return '#fde68a' }
  })
  const [contextMarkMode, setContextMarkMode] = useState<ContextMarkMode>(() => loadContextMarkMode())
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [showAuth, setShowAuth] = useState(false)

  // --- NEW FEATURE STATE ---
  const { resolvedTheme, setTheme } = useTheme()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showQuickSearch, setShowQuickSearch] = useState(false)
  const [profileSection, setProfileSection] = useState<string | null>(null)
  const goToProfile = (section?: string) => { setProfileSection(section ?? null); setTab('profile') }
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [pdfViewer, setPdfViewer] = useState<{ docId: string; page?: number | null; quote?: string | null } | null>(null)
  // Сайдбар истории: клик фиксирует открытым (помним локально),
  // ховер по кнопке — временное превью. Квоту не трогает.
  const [sidebarPinned, setSidebarPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('snip_sidebar_open') === '1' } catch { return false }
  })
  const [sidebarHover, setSidebarHover] = useState(false)
  const sidebarOpen = sidebarPinned || sidebarHover
  const hoverTimer = useRef<number | null>(null)
  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null }
  }, [])
  useEffect(() => clearHoverTimer, [clearHoverTimer])
  const toggleSidebar = useCallback(() => {
    setSidebarPinned((v) => {
      try { localStorage.setItem('snip_sidebar_open', v ? '0' : '1') } catch {}
      return !v
    })
    setSidebarHover(false)
    clearHoverTimer()
  }, [clearHoverTimer])
  /** Ховер по кнопке: показать историю; курсор убран — скрыть (если не зафиксирована кликом). */
  const previewSidebar = useCallback(() => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => setSidebarHover(true), 150)
  }, [clearHoverTimer])
  const cancelPreview = useCallback(() => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => setSidebarHover(false), 250)
  }, [clearHoverTimer])
  const holdPreview = useCallback(() => {
    clearHoverTimer()
    setSidebarHover(true)
  }, [clearHoverTimer])
  const [btnPop, setBtnPop] = useState(false)
  const onSidebarBtnClick = useCallback(() => {
    toggleSidebar()
    setBtnPop(true)
    window.setTimeout(() => setBtnPop(false), 280)
  }, [toggleSidebar])
  const [historySearchOpen, setHistorySearchOpen] = useState(false)
  const [favCount, setFavCount] = useState<number>(() => { try { return loadFavorites().length } catch { return 0 } })
  useEffect(() => {
    const onFav = () => { try { setFavCount(loadFavorites().length) } catch {} }
    window.addEventListener(FAVORITES_EVENT, onFav)
    return () => window.removeEventListener(FAVORITES_EVENT, onFav)
  }, [])

  // --- Custom hooks ---
  const search = useSearch({ user, setShowAuth, setAuthMode })
  const docs = useDocuments({ user, filterStatus: search.filterStatus })

  const pickHistory = useCallback((h: string) => {
    // Прошлая сессия восстанавливается целиком БЕЗ сети и квоты.
    // Слепка нет (старая запись) — вставляем текст, поиск по Enter/«Найти».
    setTab('search')
    const restored = search.restoreSession(h)
    if (!restored) {
      search.setQuery(h)
      setTimeout(() => searchInputRef.current?.focus(), 60)
    }
  }, [search.restoreSession, search.setQuery])

  const startNewChat = useCallback(() => {
    // Новый чат: чистый экран, история и сессии сохраняются, квота не тратится.
    setTab('search')
    search.newChat()
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {}
    setTimeout(() => searchInputRef.current?.focus(), 60)
  }, [search.newChat])

  // Track analytics on search
  const doSearchTracked = useCallback((q?: string) => {
    const queryStr = q || search.query
    if (queryStr?.trim()) trackSearch(queryStr.trim())
    search.doSearch(q)
  }, [search])

  // --- Keyboard shortcuts ---
  useKeyboardShortcuts({
    onSearchFocus: () => { setTab('search'); setTimeout(() => searchInputRef.current?.focus(), 100) },
    onEscape: () => {
      if (showShortcuts) { setShowShortcuts(false); return }
      if (showQuickSearch) { setShowQuickSearch(false); return }
      if (historySearchOpen) { setHistorySearchOpen(false); return }
      if (showAuth) { setShowAuth(false); return }
      if (sidebarPinned) { setSidebarPinned(false); try { localStorage.setItem('snip_sidebar_open', '0') } catch {} return }
      setSidebarHover(false)
    },
    onQuickSearch: () => setShowQuickSearch(true),
    onToggleShortcuts: () => setShowShortcuts(v => !v),
  })

  // --- Effects ---
  useEffect(() => { try { localStorage.setItem('snip_highlight_palette', highlightPalette) } catch {} }, [highlightPalette])
  useEffect(() => { try { localStorage.setItem('snip_highlight_mono_hex', monoHex) } catch {} }, [monoHex])
  useEffect(() => { saveContextMarkMode(contextMarkMode) }, [contextMarkMode])
  useEffect(() => {
    if (tab === 'docs') docs.loadDocs()
  }, [tab, search.filterStatus])

  // --- Shared search link (?q=&mode=): автопоиск при открытии + URL всегда отражает текущие результаты ---
  const searchRef = useRef(search)
  searchRef.current = search
  const sharedAppliedRef = useRef(false)
  useEffect(() => {
    if (sharedAppliedRef.current) return
    sharedAppliedRef.current = true
    try {
      const sp = new URLSearchParams(window.location.search)
      const q = (sp.get('q') || '').trim()
      if (!q) return
      const m = sp.get('mode')
      setTab('search')
      const effMode = (m === 'fast' || m === 'deep') ? m : searchRef.current.mode
      if (m === 'fast' || m === 'deep') searchRef.current.setMode(m)
      searchRef.current.setQuery(q)
      // тик — чтобы setMode/setQuery успели примениться до doSearch
      setTimeout(() => {
        // Рефреш той же вкладки: ответ уже есть в sessionStorage — показываем
        // его БЕЗ повторного поиска, квота не тратится.
        const cached = loadLastResp(q, effMode, searchRef.current.filterType, searchRef.current.filterStatus)
        if (cached) {
          searchRef.current.setResp(cached)
          return
        }
        if (q.trim()) trackSearch(q.trim())
        searchRef.current.doSearch(q)
      }, 60)
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    try {
      const r = search.resp
      if (!r || search.loading) return
      const url = `${window.location.pathname}?q=${encodeURIComponent(r.query)}&mode=${r.mode}`
      window.history.replaceState(null, '', url)
    } catch {}
  }, [search.resp, search.loading])

  // --- Handlers ---
  const openPdf = useCallback((docId: string, page?: number | null, quote?: string | null) => {
    // Внутренний вьюер с объяснятором вместо новой вкладки.
    // quote — контекст из поиска: подсвечивается на странице + автоскролл (без ИИ-квот).
    if (!docId || docId.startsWith('local:')) {
      showToast('Локальный PDF недоступен', 'error')
      return
    }
    setPdfViewer({ docId, page: page ?? undefined, quote: quote ?? null })
  }, [showToast])

  // --- Render ---
  // Мобайл: нижний таб-бар (MobileNav, md:hidden), верхние табы скрыты (hidden md:flex) —
  // на десктопе layout не меняется.
  const isAdmin = !!(user && isAdminEmail(user.email))
  const goMobile = (t: MobileTab) => { t === 'profile' ? goToProfile('overview') : setTab(t) }
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 pb-[68px] md:pb-0">

      {/* Header */}
      <header className="bg-white/90 dark:bg-slate-900/90 backdrop-blur border-b border-slate-200 dark:border-slate-800 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 shrink-0">
            {/* Кнопка истории: статичная слева от лого. Ховер — превью, клик — фикс. Только десктоп. */}
            <button
              onClick={onSidebarBtnClick}
              onMouseEnter={previewSidebar}
              onMouseLeave={cancelPreview}
              title={sidebarOpen ? 'Скрыть историю поиска' : 'Показать историю поиска'}
              aria-label={sidebarOpen ? 'Скрыть историю поиска' : 'Показать историю поиска'}
              aria-expanded={sidebarOpen}
              aria-controls="search-history-sidebar"
              className={`history-btn hidden md:inline-flex w-8 h-8 shrink-0 items-center justify-center rounded-lg border transition ${
                sidebarOpen
                  ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:bg-slate-700'
              } ${btnPop ? 'history-btn--pop' : ''}`}
            >
              <Icon name="panelLeft" size={16} strokeWidth={2} />
            </button>
            <img
              src="/logo-64.png"
              srcSet="/logo-64.png 1x, /logo-192.png 2x"
              alt="snippy.llm"
              className="w-8 h-8 rounded-lg object-cover shrink-0 ring-1 ring-slate-200 dark:ring-slate-700 bg-white"
            />
            <div className="min-w-0 hidden lg:block">
              <div className="font-semibold text-slate-900 dark:text-white leading-none truncate">snippy.llm</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-1">СНиП РК • справочник по нормам</div>
            </div>
          </div>
          {/* Десктопные табы: на мобайле скрыты, вместо них нижний MobileNav */}
          <nav className="hidden md:flex items-center gap-0.5 shrink-0">
            {(['search', 'docs', 'favorites', 'profile'] as const).map(t => (
                <button key={t} onClick={() => t === 'profile' ? goToProfile('overview') : setTab(t)} aria-label={t === 'favorites' && favCount > 0 ? `Избранное, ${favCount}` : undefined} className={`inline-flex items-center px-3 lg:px-4 py-2 text-[13px] lg:text-sm font-medium rounded-xl transition whitespace-nowrap ${tab === t ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'}`}>
                <span className="truncate">{t === 'search' ? 'Поиск' : t === 'docs' ? 'Документы' : t === 'favorites' ? 'Избранное' : 'Профиль'}</span>
                {t === 'favorites' && favCount > 0 && <span className="ml-1.5 shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-slate-900 text-white dark:bg-white dark:text-slate-900 text-[10px] font-bold tabular-nums inline-flex items-center justify-center">{favCount > 99 ? '99+' : favCount}</span>}
              </button>
            ))}
            {isAdmin && (
                <button onClick={() => setTab('admin')} title="Только для администраторов" className={`flex items-center gap-1.5 px-3 lg:px-4 py-2 text-[13px] lg:text-sm font-medium rounded-xl transition whitespace-nowrap ${tab === 'admin' ? 'bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-300' : 'text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/40'}`}>
                <Icon name="shield" size={15} /> Админка
              </button>
            )}
          </nav>
          <div className="flex items-center gap-1.5 shrink-0">
            <CreditsBadge onOpenUsage={() => goToProfile('usage')} />
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              title={resolvedTheme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              className="icon-btn border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} size={17} strokeWidth={2} />
            </button>
            {user ? (
              <ProfileMenu user={user} onNavigate={(s) => goToProfile(s)} onLogout={logout} />
            ) : (
              <button onClick={() => { setAuthMode('login'); setShowAuth(true) }} className="btn btn-md btn-primary px-3 sm:px-4 whitespace-nowrap">Войти</button>
            )}
          </div>
        </div>
      </header>

      {/* Auth — настоящее модальное окно с заблюренным фоном */}
      {showAuth && !user && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-[fadeIn_.15s_ease-out]"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAuth(false) }}
        >
          <div className="w-full max-w-md card shadow-xl relative animate-[popIn_.18s_ease-out] max-h-[92vh] overflow-y-auto">
            <button
              onClick={() => setShowAuth(false)}
              title="Закрыть"
              className="absolute top-3 right-3 icon-btn"
            >
              <Icon name="close" size={16} />
            </button>
            <div className="p-6">
              <div className="text-center mb-4">
                <img src="/logo-64.png" alt="snippy.llm" className="w-14 h-14 mx-auto rounded-xl object-cover ring-1 ring-slate-200 dark:ring-slate-700 bg-white" />
                <h3 className="font-semibold text-slate-900 dark:text-white mt-3 text-lg">Войдите, чтобы продолжить</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">300 кредитов каждый час вместо 30 в день • бесплатно, без карты</p>
              </div>
              {authMode === 'login' ? <LoginForm onSwitch={() => setAuthMode('register')} onSuccess={() => setShowAuth(false)} /> : <RegisterForm onSwitch={() => setAuthMode('login')} onSuccess={() => setShowAuth(false)} />}
            </div>
          </div>
        </div>
      )}

      {/* Контент + десктопный сайдбар истории */}
      <div className="flex flex-1 items-stretch w-full min-h-0">
        <HistorySidebar
          open={sidebarOpen}
          history={search.searchHistory}
          pins={search.pins}
          activeQuery={search.query}
          onPick={pickHistory}
          onRemove={search.removeHistoryItem}
          onClear={search.clearHistory}
          onClose={() => { setSidebarPinned(false); setSidebarHover(false); clearHoverTimer(); try { localStorage.setItem('snip_sidebar_open', '0') } catch {} }}
          onNewChat={startNewChat}
          onTogglePin={search.togglePinHistory}
          onOpenSearch={() => setHistorySearchOpen(true)}
          onHoverEnter={holdPreview}
          onHoverLeave={cancelPreview}
          user={user}
          onProfile={() => goToProfile('overview')}
          onLogin={() => { setAuthMode('login'); setShowAuth(true) }}
        />
        <div className="flex-1 min-w-0 flex flex-col">
      {/* Tab content */}
      {tab === 'search' && (
        <ErrorBoundary label="поиск">
        <SearchView
          query={search.query} setQuery={search.setQuery}
          mode={search.mode} setMode={search.setMode}
          loading={search.loading} resp={search.resp} error={search.error}
          searchHistory={search.searchHistory} clearHistory={search.clearHistory} removeHistoryItem={search.removeHistoryItem}
          pins={search.pins}
          showHistory={search.showHistory} setShowHistory={search.setShowHistory}
          filterType={search.filterType} setFilterType={search.setFilterType}
          filterStatus={search.filterStatus} setFilterStatus={search.setFilterStatus}
          showFilters={search.showFilters} setShowFilters={search.setShowFilters}
          insufficientCredits={search.insufficientCredits} setInsufficientCredits={search.setInsufficientCredits}
          onTopUp={() => {
            if (user) goToProfile('billing')
            else { setAuthMode('register'); setShowAuth(true) }
          }}
          doSearch={search.doSearch}
          isUnchanged={search.isUnchanged}
          onPickSession={pickHistory}
          requestAnswer={search.requestAnswer} answering={search.answering}
          highlightPalette={highlightPalette} setHighlightPalette={setHighlightPalette}
          monoHex={monoHex} setMonoHex={setMonoHex}
          user={user} setShowAuth={setShowAuth} setAuthMode={setAuthMode}
          openPdf={openPdf}
          searchInputRef={searchInputRef}
        />
        </ErrorBoundary>
      )}

      {tab === 'docs' && (
        <DocsView
          docs={docs.docs} docsLoading={docs.docsLoading}
          filterStatus={search.filterStatus} setFilterStatus={search.setFilterStatus}
          loadDocs={docs.loadDocs}
          openPdf={openPdf}
          user={user}
          onLogin={() => { setAuthMode('register'); setShowAuth(true) }}
        />
      )}

      {tab === 'favorites' && (
        <FavoritesView onOpenPdf={openPdf} user={user} />
      )}

      {tab === 'profile' && (
        <ProfileView
          stats={docs.stats} docs={docs.docs} onLogout={logout}
          onAuthRequired={() => { setAuthMode('register'); setShowAuth(true) }}
          highlightPalette={highlightPalette} setHighlightPalette={setHighlightPalette}
          monoHex={monoHex} setMonoHex={setMonoHex}
          contextMarkMode={contextMarkMode} setContextMarkMode={setContextMarkMode}
          user={user}
          initialSection={profileSection}
        />
      )}

      {tab === 'admin' && user && isAdminEmail(user.email) && (
        <AdminView user={user} />
      )}
        </div>
      </div>

      {/* --- MODALS --- */}
      <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <QuickSearch open={showQuickSearch} onClose={() => setShowQuickSearch(false)} onSearch={(q) => { setTab('search'); search.setQuery(q); doSearchTracked(q) }} />
      <HistorySearchModal
        open={historySearchOpen}
        history={search.searchHistory}
        pins={search.pins}
        activeQuery={search.query}
        onPick={pickHistory}
        onClose={() => setHistorySearchOpen(false)}
      />
      {pdfViewer && (
        <ErrorBoundary label="PDF-просмотр" inline>
          <Suspense fallback={null}>
          <PdfViewerModal
          key={`${pdfViewer.docId}:${pdfViewer.page ?? 1}:${(pdfViewer.quote ?? '').length}:${(pdfViewer.quote ?? '').slice(0, 64)}`}
          docId={pdfViewer.docId}
          initialPage={pdfViewer.page ?? 1}
          initialQuote={pdfViewer.quote ?? null}
          markMode={contextMarkMode}
          onClose={() => setPdfViewer(null)}
          onTopUp={() => {
            setPdfViewer(null)
            if (user) goToProfile('billing')
            else { setAuthMode('register'); setShowAuth(true) }
          }}
          />
          </Suspense>
        </ErrorBoundary>
      )}
      <MobileNav tab={tab} favCount={favCount} isAdmin={isAdmin} onGo={goMobile} />
      <footer className="mt-auto border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 text-[11px] text-slate-400 dark:text-slate-500">
          <span className="truncate" title="Ответ только при найденной норме; без источника — честно говорит «не найдено»">snippy.llm<span className="max-md:hidden"> • быстрый поиск 5 кредитов • глубокий — 10 • нет источника → нет утверждения</span></span>
          <button onClick={() => setShowShortcuts(true)} className="inline-flex items-center gap-1.5 hover:text-slate-600 dark:hover:text-slate-300 transition shrink-0"><Icon name="keyboard" size={13} /> Горячие клавиши</button>
        </div>
      </footer>
    </div>
  )
}
