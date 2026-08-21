// @ts-nocheck
import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from './context/AuthContext'
import { LoginForm, RegisterForm } from './components/AuthForms'
import { API_BASE } from './utils/api'
import { usePinned } from './context/PinnedContext'
import { useBaskets } from './context/BasketContext'
import { PinnedDropdown } from './components/PinnedDropdown'
import { FlyAnimation } from './components/FlyAnimation'
import { GlobalFileDrop } from './components/GlobalFileDrop'
import { TrashBar } from './components/TrashBar'
import { useToast } from './components/Toast'
import { stringToColor } from './utils/badges'
import { openPdf as _openPdf } from './utils/pdf'
import { useSearch } from './hooks/useSearch'
import { useUpload } from './hooks/useUpload'
import { useDocuments } from './hooks/useDocuments'
import { SearchView } from './views/SearchView'
import { DocsView } from './views/DocsView'
import { ProfileView } from './views/ProfileView'
import { ProfileMenu } from './components/ProfileMenu'
import type { PaletteId } from './utils/highlight'
import { listPaletteOptions } from './utils/highlight'
// --- NEW FEATURES ---
import { useTheme } from './context/ThemeContext'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { ShortcutsModal } from './components/ShortcutsModal'
import { QuickSearch } from './components/QuickSearch'
import { trackSearch } from './utils/analytics'
import { resultsToMarkdown, downloadAsFile, copyToClipboard } from './utils/exportUtils'

export default function App() {
  const { user, logout, authFetch } = useAuth()
  const { items: pinnedItems, isPinned, isPinnedChunk, setDocsTabRef } = usePinned() as any
  const { baskets, activeBasketId, setActiveBasketId, assignments, localDocs, addLocalFiles, setIsDragging: setBasketDragging, setDraggedDocId } = useBaskets() as any
  const { showToast } = useToast()

  const [tab, setTab] = useState<'search' | 'docs' | 'settings' | 'profile'>('search')
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
  const docsTabRef = useRef<HTMLButtonElement>(null)
  const [showPinnedOnly, setShowPinnedOnly] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [showAuth, setShowAuth] = useState(false)

  // --- NEW FEATURE STATE ---
  const { resolvedTheme, setTheme } = useTheme()
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showQuickSearch, setShowQuickSearch] = useState(false)
  const [profileSection, setProfileSection] = useState<string | null>(null)
  const goToProfile = (section?: string) => { setProfileSection(section ?? null); setTab('profile') }
  const searchInputRef = useRef<HTMLInputElement>(null)

  // --- Custom hooks ---
  const search = useSearch({ user, setShowAuth, setAuthMode })
  const docs = useDocuments({ user, filterStatus: search.filterStatus })

  const upload = useUpload({
    user, activeBasketId, addLocalFiles, showToast,
    loadDocs: docs.loadDocs, loadCollector: docs.loadCollector,
  })

  // Track analytics on search
  const doSearchTracked = useCallback((q?: string) => {
    const queryStr = q || search.query
    if (queryStr?.trim()) trackSearch(queryStr.trim())
    search.doSearch(q)
  }, [search])

  // --- Keyboard shortcuts (after all state/hooks are defined) ---
  useKeyboardShortcuts({
    onSearchFocus: () => { setTab('search'); setTimeout(() => searchInputRef.current?.focus(), 100) },
    onEscape: () => {
      if (showShortcuts) { setShowShortcuts(false); return }
      if (showQuickSearch) { setShowQuickSearch(false); return }
      if (showAuth) { setShowAuth(false); return }
    },
    onQuickSearch: () => setShowQuickSearch(true),
    onToggleShortcuts: () => setShowShortcuts(v => !v),
  })

  // --- Effects ---
  useEffect(() => { try { localStorage.setItem('snip_highlight_palette', highlightPalette) } catch {} }, [highlightPalette])
  useEffect(() => { try { localStorage.setItem('snip_highlight_mono_hex', monoHex) } catch {} }, [monoHex])
  useEffect(() => {
    // @ts-ignore
    setDocsTabRef(docsTabRef as any)
  }, [])
  useEffect(() => {
    if (tab === 'docs') docs.loadDocs()
    if (tab === 'settings' || tab === 'profile') docs.loadCollector()
  }, [tab, search.filterStatus, user])

  // --- Handlers ---
  const openPdf = useCallback((docId: string, page?: number | null) => {
    _openPdf(docId, page, (msg) => showToast(msg, 'error'))
  }, [showToast])

  const triggerCollector = useCallback(async () => {
    await authFetch(`${API_BASE}/api/admin/collector/run`, { method: 'POST' })
    setTimeout(docs.loadCollector, 1500)
  }, [authFetch, docs.loadCollector])

  // Listen for basket files event
  useEffect(() => {
    const onBasketFiles = (e: Event) => {
      const d = (e as CustomEvent).detail as { files: File[], basketId: string | null }
      if (d?.files?.length) upload.handleBasketFiles(d.files, d.basketId ?? activeBasketId)
    }
    window.addEventListener('snip:basket-files' as any, onBasketFiles as any)
    return () => window.removeEventListener('snip:basket-files' as any, onBasketFiles as any)
  }, [upload.handleBasketFiles, activeBasketId])

  // --- Auth gate ---
  const AuthGate = () => (
    <div className="max-w-md mx-auto mt-8 bg-white rounded-2xl border border-slate-200 p-6 shadow-lg">
      <div className="text-center mb-4">
        <img src="/logo-64.png" alt="snippy.llm" className="w-12 h-12 mx-auto rounded-xl object-cover border border-slate-200 bg-white" />
        <h3 className="font-semibold text-slate-900 mt-3">Войдите чтобы продолжить</h3>
        <p className="text-xs text-slate-500 mt-1">Бесплатно для 10+ пользователей. Данные на snippy.llm, защищено JWT.</p>
      </div>
      {authMode === 'login' ? <LoginForm onSwitch={() => setAuthMode('register')} onSuccess={() => setShowAuth(false)} /> : <RegisterForm onSwitch={() => setAuthMode('login')} onSuccess={() => setShowAuth(false)} />}
    </div>
  )

  // --- Render ---
  return (
    <div className="min-h-screen flex flex-col">
      <GlobalFileDrop />
      <TrashBar />

      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-2 flex-nowrap overflow-visible">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <img src="/logo-64.png" srcSet="/logo-64.png 1x, /logo-192.png 2x" alt="snippy.llm" className="w-9 h-9 rounded-xl object-cover shrink-0 border border-slate-200 bg-white" />
            <div className="min-w-0 hidden sm:block">
              <div className="font-semibold text-slate-900 leading-none truncate">snippy.llm</div>
              <div className="text-xs text-slate-500 truncate">snippy.llm • личная</div>
            </div>
            <div className="sm:hidden font-semibold text-slate-900 text-sm truncate">snippy.llm</div>
          </div>
          <nav className="flex items-center gap-1 shrink-0">
            {(['search', 'docs', 'profile'] as const).map(t => (
              <button key={t} onClick={() => t === 'profile' ? goToProfile('overview') : setTab(t)} className={`px-3 md:px-4 py-2 text-sm font-medium rounded-xl transition whitespace-nowrap ${tab === t ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                {t === 'search' ? 'Поиск' : t === 'docs' ? 'Документы' : 'Профиль'}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            {/* Dark mode toggle */}
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              title={resolvedTheme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
              className="w-9 h-9 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 transition shrink-0"
            >
              {resolvedTheme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            {/* Shortcuts help */}
            <button
              onClick={() => setShowShortcuts(true)}
              title="Горячие клавиши (?)"
              className="hidden md:flex w-9 h-9 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 transition shrink-0 text-sm font-mono"
            >
              ?
            </button>
            <PinnedDropdown />
            {user ? (
              <ProfileMenu user={user} onNavigate={(s) => goToProfile(s)} onLogout={logout} />
            ) : (
              <button onClick={() => setShowAuth(!showAuth)} className="px-4 py-2 text-sm font-medium rounded-xl bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0">Войти</button>
            )}
          </div>
        </div>
      </header>

      {/* Auth modal — только по клику Войти, не на всех вкладках */}
      {showAuth && !user && (
        <div className="bg-slate-50 border-b border-slate-200">
          <div className="max-w-6xl mx-auto px-4 py-6"><AuthGate /></div>
        </div>
      )}

      {/* Tab content */}
      {tab === 'search' && (
        <SearchView
          query={search.query} setQuery={search.setQuery}
          mode={search.mode} setMode={search.setMode}
          loading={search.loading} resp={search.resp} error={search.error}
          searchHistory={search.searchHistory} clearHistory={search.clearHistory} removeHistoryItem={search.removeHistoryItem}
          showHistory={search.showHistory} setShowHistory={search.setShowHistory}
          filterType={search.filterType} setFilterType={search.setFilterType}
          filterStatus={search.filterStatus} setFilterStatus={search.setFilterStatus}
          showFilters={search.showFilters} setShowFilters={search.setShowFilters}
          searchPinnedOnly={search.searchPinnedOnly} setSearchPinnedOnly={search.setSearchPinnedOnly}
          quotaExceeded={search.quotaExceeded} setQuotaExceeded={search.setQuotaExceeded}
          doSearch={search.doSearch}
          highlightPalette={highlightPalette} setHighlightPalette={setHighlightPalette}
          monoHex={monoHex} setMonoHex={setMonoHex}
          user={user} setShowAuth={setShowAuth} setAuthMode={setAuthMode}
          openPdf={openPdf}
          handleBasketFiles={upload.handleBasketFiles}
          activeBasketId={activeBasketId} baskets={baskets}
          pinnedItems={pinnedItems} isPinned={isPinned}
          assignments={assignments}
          setBasketDragging={setBasketDragging} setDraggedDocId={setDraggedDocId}
          searchInputRef={searchInputRef}
        />
      )}

      {tab === 'docs' && (
        <DocsView
          docs={docs.docs} docsLoading={docs.docsLoading}
          filterStatus={search.filterStatus} setFilterStatus={search.setFilterStatus}
          loadDocs={docs.loadDocs}
          pinnedItems={pinnedItems} showPinnedOnly={showPinnedOnly} setShowPinnedOnly={setShowPinnedOnly}
          openPdf={openPdf}
          handleBasketFiles={upload.handleBasketFiles}
          selectedFile={upload.selectedFile} setSelectedFile={upload.setSelectedFile}
          uploading={upload.uploading} uploadMsg={upload.uploadMsg}
          handleUpload={upload.handleUpload} onDropFile={upload.onDropFile}
          fileInputRef={upload.fileInputRef}
          user={user}
          activeBasketId={activeBasketId} baskets={baskets}
          assignments={assignments} localDocs={localDocs}
          setBasketDragging={setBasketDragging} setDraggedDocId={setDraggedDocId}
          collectorLogs={docs.collectorLogs} triggerCollector={triggerCollector}
          authMode={authMode} setAuthMode={setAuthMode} setShowAuth={setShowAuth}
          addLocalFiles={addLocalFiles}
        />
      )}

      {tab === 'profile' && (
        <ProfileView
          stats={docs.stats} onLogout={logout}
          highlightPalette={highlightPalette} setHighlightPalette={setHighlightPalette}
          monoHex={monoHex} setMonoHex={setMonoHex}
          user={user}
          initialSection={profileSection}
        />
      )}

      <FlyAnimation />
      {/* --- NEW FEATURE MODALS --- */}
      <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <QuickSearch open={showQuickSearch} onClose={() => setShowQuickSearch(false)} onSearch={(q) => { setTab('search'); search.setQuery(q); doSearchTracked(q) }} />
      <footer className="mt-8 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-col md:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>snippy.llm • Только онлайн • JWT • Rate limit 30/мин • No source → No claim</span>
          <span>⌨️ <button onClick={() => setShowShortcuts(true)} className="underline hover:text-slate-700 dark:hover:text-slate-200">Горячие клавиши</button> • {resolvedTheme === 'dark' ? '🌙' : '☀️'} <button onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} className="underline hover:text-slate-700 dark:hover:text-slate-200">Тема</button></span>
        </div>
      </footer>
    </div>
  )
}
