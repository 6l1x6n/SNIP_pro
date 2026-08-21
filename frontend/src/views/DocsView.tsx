// @ts-nocheck
import { useRef } from 'react'
import { LoginForm, RegisterForm } from '../components/AuthForms'
import { BasketBar } from '../components/BasketBar'
import { PinButton } from '../components/PinButton'
import { SnakeState } from '../components/SnakeState'
import { TrashBar } from '../components/TrashBar'
import { statusBadge } from '../utils/badges'
import { getFilesFromDataTransfer } from '../utils/fileType'

type DocsViewProps = {
  docs: any[]
  docsLoading: boolean
  filterStatus: string
  setFilterStatus: (v: string) => void
  loadDocs: () => void
  pinnedItems: any[]
  showPinnedOnly: boolean
  setShowPinnedOnly: (v: boolean | ((v: boolean) => boolean)) => void
  openPdf: (docId: string, page?: number | null) => void
  handleBasketFiles: (files: File[], basketId: string | null) => void
  selectedFile: File | null
  setSelectedFile: (f: File | null) => void
  uploading: boolean
  uploadMsg: string | null
  handleUpload: (e: React.FormEvent<HTMLFormElement>) => void
  onDropFile: (f: File) => void
  fileInputRef: React.RefObject<HTMLInputElement>
  user: any
  activeBasketId: string | null
  baskets: any[]
  assignments: Record<string, string>
  localDocs: any[]
  setBasketDragging: (v: boolean) => void
  setDraggedDocId: (id: string | null) => void
  collectorLogs: any[]
  triggerCollector: () => void
  authMode: 'login' | 'register'
  setAuthMode: (v: 'login' | 'register') => void
  setShowAuth: (v: boolean) => void
}

/**
 * AuthGate — shown for unauthenticated users
 */
function AuthGate({ authMode, setAuthMode, setShowAuth }: {
  authMode: 'login' | 'register'
  setAuthMode: (v: 'login' | 'register') => void
  setShowAuth: (v: boolean) => void
}) {
  return (
    <div className="max-w-md mx-auto mt-8 bg-white rounded-2xl border border-slate-200 p-6 shadow-lg">
      <div className="text-center mb-4">
        <img src="/logo-64.png" alt="snippy.llm" className="w-12 h-12 mx-auto rounded-xl object-cover border border-slate-200 bg-white" />
        <h3 className="font-semibold text-slate-900 mt-3">Войдите чтобы продолжить</h3>
        <p className="text-xs text-slate-500 mt-1">Бесплатно для 10+ пользователей. Данные хранятся на snippy.llm, защищено JWT.</p>
      </div>
      {authMode === 'login'
        ? <LoginForm onSwitch={() => setAuthMode('register')} onSuccess={() => setShowAuth(false)} />
        : <RegisterForm onSwitch={() => setAuthMode('login')} onSuccess={() => setShowAuth(false)} />}
    </div>
  )
}

export function DocsView({
  docs,
  docsLoading,
  filterStatus,
  setFilterStatus,
  loadDocs,
  pinnedItems,
  showPinnedOnly,
  setShowPinnedOnly,
  openPdf,
  handleBasketFiles,
  selectedFile,
  setSelectedFile,
  uploading,
  uploadMsg,
  handleUpload,
  onDropFile,
  fileInputRef,
  user,
  activeBasketId,
  baskets,
  assignments,
  localDocs,
  setBasketDragging,
  setDraggedDocId,
  collectorLogs,
  triggerCollector,
  authMode,
  setAuthMode,
  setShowAuth,
}: DocsViewProps) {
  // Helpers
  const isPinned = (id: string) => pinnedItems.some((p: any) => p.document_id === id)

  const basketName = activeBasketId
    ? (baskets.find(b => b.id === activeBasketId)?.name || 'Корзина')
    : 'Все'

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
      {/* Open access — доки доступны без входа, логин опционально */}
      {!user && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-sm text-blue-900">Документы доступны без входа. <span className="text-blue-700">Войдите</span> чтобы загружать в облако и сохранять между устройствами.</div>
          <button onClick={() => setShowAuth(true)} className="px-4 py-1.5 bg-blue-600 text-white rounded-full text-xs font-medium hover:bg-blue-700 shrink-0">Войти</button>
        </div>
      )}
      {true && (
        <>
          <div className="flex flex-col gap-3 mb-4">
            {/* Header row: title + filters */}
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Нормативные документы</h2>
              <div className="flex items-center gap-2">
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="active">Действующие</option>
                  <option value="">Все</option>
                  <option value="replaced">Заменённые</option>
                  <option value="expired">Утратившие силу</option>
                </select>
                <button
                  onClick={loadDocs}
                  className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm hover:bg-slate-50"
                >
                  Обновить
                </button>
              </div>
            </div>

            {/* Basket bar */}
            <BasketBar />

            {/* Upload row */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-dashed border-slate-300 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <path d="M14 2v6h6" />
                  <path d="M12 18v-6" />
                  <path d="M9 15l3 3 3-3" />
                </svg>
                Загрузить PDF в «{basketName}»
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={e => {
                    const files = Array.from((e.target as HTMLInputElement).files || [])
                    if (files.length) handleBasketFiles(files, activeBasketId)
                    ;(e.target as HTMLInputElement).value = ''
                  }}
                />
              </label>
              <span className="text-[11px] text-slate-400">
                до 100 МБ, очередь • перетащите на корзину в любом окне
              </span>
            </div>

            {/* Pinned filter toggle */}
            {pinnedItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setShowPinnedOnly(v => !v)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                    showPinnedOnly
                      ? 'bg-amber-400 text-white border-amber-400'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-amber-300 hover:text-amber-700'
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill={showPinnedOnly ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z" />
                  </svg>
                  {showPinnedOnly
                    ? `Показаны закрепы • ${pinnedItems.length}`
                    : `Закреплённые • ${pinnedItems.length}`}
                </button>
                {showPinnedOnly && (
                  <button onClick={() => setShowPinnedOnly(false)} className="text-xs text-blue-600 hover:underline">
                    Показать все
                  </button>
                )}
                <span className="text-[11px] text-slate-400">
                  Доступны во всех вкладках • кликните ⭐ чтобы открепить • перетащите на корзину
                </span>
              </div>
            )}
          </div>

          {/* ═══════════════════════════════════════════════════════════
              Pinned section — separate docs and chunks, filtered by basket
              ═══════════════════════════════════════════════════════════ */}
          {(() => {
            const pinnedDocs = pinnedItems.filter((p: any) => (p.kind || 'doc') === 'doc')
            const pinnedChunks = pinnedItems.filter((p: any) => p.kind === 'chunk')
            const filterByBasket = (arr: any[]) =>
              activeBasketId ? arr.filter(p => assignments[p.document_id] === activeBasketId) : arr
            const filteredDocs = filterByBasket(pinnedDocs)
            const filteredChunks = filterByBasket(pinnedChunks)
            const totalPinned = filteredDocs.length + filteredChunks.length
            if (!(totalPinned > 0 && !docsLoading && !showPinnedOnly)) return null
            return (
              <div className="mb-6 space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold tracking-widest uppercase text-slate-500">
                    Закреплённые {activeBasketId ? `• ${baskets.find(b => b.id === activeBasketId)?.name}` : ''}
                  </span>
                  <span className="h-px flex-1 bg-slate-200" />
                  <span className="text-[11px] text-slate-400">
                    {filteredDocs.length} док. {filteredChunks.length > 0 && `• ${filteredChunks.length} фрагм.`} • {totalPinned}
                  </span>
                </div>

                {/* ── Pinned Documents ── */}
                {filteredDocs.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 tracking-widest uppercase mb-2 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-500" /> Документы • {filteredDocs.length}
                    </div>
                    <div
                      data-docs-grid
                      className="grid gap-3"
                      onDragOver={e => {
                        if (
                          e.dataTransfer.types.includes('Files') ||
                          e.dataTransfer.types.includes('application/x-snip-doc') ||
                          Array.from(e.dataTransfer.types || []).includes('Files')
                        )
                          e.preventDefault()
                      }}
                      onDrop={e => {
                        const raw = e.dataTransfer.getData('application/x-snip-doc')
                        if (raw) {
                          e.preventDefault()
                          try {
                            const obj = JSON.parse(raw)
                            window.dispatchEvent(new CustomEvent('snip:pin-drop', { detail: obj }))
                          } catch {}
                          return
                        }
                        const files = getFilesFromDataTransfer(e.dataTransfer)
                        if (files.length) {
                          e.preventDefault()
                          window.dispatchEvent(
                            new CustomEvent('snip:basket-files', { detail: { files, basketId: activeBasketId } })
                          )
                        }
                      }}
                    >
                      {filteredDocs.map((p: any) => {
                        const b = statusBadge(p.status)
                        const isLocal = p.document_id.startsWith('local:')
                        const basket = assignments[p.document_id]
                          ? baskets.find((x: any) => x.id === assignments[p.document_id])
                          : null
                        return (
                          <div
                            key={`doc-${p.document_id}`}
                            draggable
                            onDragStart={e => {
                              const payload = {
                                document_id: p.document_id,
                                number: p.number,
                                title: p.title,
                                type: p.type,
                                status: p.status,
                                pages: p.pages,
                                source_url: p.source_url,
                                kind: 'doc',
                              }
                              e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                              e.dataTransfer.setData('text/plain', p.document_id)
                              e.dataTransfer.effectAllowed = 'move'
                              setBasketDragging(true)
                              setDraggedDocId(p.document_id)
                            }}
                            onDragEnd={() => {
                              setBasketDragging(false)
                              setDraggedDocId(null)
                            }}
                            className="bg-white rounded-2xl border border-blue-200 border-l-4 border-l-blue-500 p-4 flex items-center gap-4 group hover:shadow-sm transition cursor-grab active:cursor-grabbing"
                          >
                            <div className="hidden sm:flex flex-col items-center gap-1 opacity-30 group-hover:opacity-60">
                              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" className="text-slate-500">
                                <circle cx="2" cy="2" r="1.4" /><circle cx="8" cy="2" r="1.4" />
                                <circle cx="2" cy="7" r="1.4" /><circle cx="8" cy="7" r="1.4" />
                                <circle cx="2" cy="12" r="1.4" /><circle cx="8" cy="12" r="1.4" />
                              </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 border border-blue-200 text-blue-700 font-medium">Документ</span>
                                <span className="font-semibold text-sm text-slate-900">{p.number}</span>
                                <span className={`text-[11px] px-2 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
                                {p.type && <span className="text-xs px-2 py-0.5 rounded-full bg-white border border-slate-200">{p.type}</span>}
                                {isLocal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">локально</span>}
                                {basket && (
                                  <span
                                    className="text-[10px] px-1.5 py-0.5 rounded-full text-white border"
                                    style={{ backgroundColor: (basket as any).color, borderColor: (basket as any).color }}
                                  >
                                    {(basket as any).name}
                                  </span>
                                )}
                              </div>
                              <div className="text-sm text-slate-700 mt-1 truncate">{p.title}</div>
                              <div className="text-xs text-slate-500 mt-1">
                                {p.pages ? `${p.pages} стр. • ` : ''}закреплён {new Date(p.pinned_at).toLocaleDateString('ru-RU')}
                                {isLocal && ' • локально'}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <PinButton
                                documentId={p.document_id}
                                number={p.number}
                                title={p.title}
                                type={p.type as any}
                                status={p.status}
                                pages={p.pages}
                                source_url={p.source_url}
                              />
                              {!isLocal ? (
                                <button
                                  onClick={() => openPdf(p.document_id, null)}
                                  className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                                >
                                  PDF
                                </button>
                              ) : (
                                <span className="text-[11px] text-slate-400 px-2 border border-slate-200 rounded-full bg-slate-50 py-1">нет PDF</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ── Pinned Chunks ── */}
                {filteredChunks.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold text-amber-700 tracking-widest uppercase mb-2 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500" /> Фрагменты • {filteredChunks.length}
                    </div>
                    <div className="grid gap-3">
                      {filteredChunks.map((p: any) => {
                        const b = statusBadge(p.status)
                        const isLocal = p.document_id.startsWith('local:')
                        const basket = assignments[p.document_id]
                          ? baskets.find((x: any) => x.id === assignments[p.document_id])
                          : null
                        return (
                          <div
                            key={`chunk-${p.chunk_id}`}
                            draggable
                            onDragStart={e => {
                              const payload = {
                                document_id: p.document_id,
                                number: p.number,
                                title: p.title,
                                type: p.type,
                                status: p.status,
                                source_url: p.source_url,
                                kind: 'chunk',
                                chunk_id: p.chunk_id,
                                query: p.query,
                                text: p.text,
                                paragraph: p.paragraph,
                                page: p.page,
                              }
                              e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                              e.dataTransfer.setData('text/plain', p.chunk_id)
                              e.dataTransfer.effectAllowed = 'move'
                              setBasketDragging(true)
                              setDraggedDocId(p.document_id)
                            }}
                            onDragEnd={() => {
                              setBasketDragging(false)
                              setDraggedDocId(null)
                            }}
                            className="bg-amber-50/60 rounded-2xl border border-amber-200 border-l-4 border-l-amber-500 p-4 flex gap-3 group hover:shadow-sm transition cursor-grab active:cursor-grabbing"
                          >
                            <div className="hidden sm:flex flex-col items-center gap-1 pt-1 opacity-40 group-hover:opacity-100">
                              <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs bg-amber-100 text-amber-700">📑</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700 font-medium">Фрагмент</span>
                                <span className="font-semibold text-sm text-slate-900 truncate">{p.number}</span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
                                {p.paragraph && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white border border-slate-200">п. {p.paragraph}</span>}
                                {p.page && <span className="text-[10px] text-slate-500">стр. {p.page}</span>}
                                {isLocal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">локально</span>}
                                {basket && (
                                  <span
                                    className="text-[10px] px-1.5 py-0.5 rounded-full text-white border"
                                    style={{ backgroundColor: (basket as any).color, borderColor: (basket as any).color }}
                                  >
                                    {(basket as any).name}
                                  </span>
                                )}
                              </div>
                              {p.query && (
                                <div className="text-[11px] text-slate-500 mt-1 line-clamp-1">
                                  Запрос: <span className="font-medium text-slate-700">«{p.query}»</span>
                                </div>
                              )}
                              <div className="text-xs text-slate-900 mt-1 font-medium line-clamp-1">{p.title}</div>
                              {p.text && (
                                <div className="text-xs text-slate-600 mt-1.5 line-clamp-2 leading-relaxed bg-white border border-amber-100 rounded-lg p-2">
                                  &ldquo;{p.text.slice(0, 180)}{p.text.length > 180 ? '…' : ''}&rdquo;
                                </div>
                              )}
                              <div className="text-[11px] text-slate-400 mt-1.5">
                                закреплён {new Date(p.pinned_at).toLocaleDateString('ru-RU')}
                                {p.page ? ` • стр. ${p.page}` : ''}
                              </div>
                            </div>
                            <div className="flex flex-col items-center gap-2 shrink-0 justify-center">
                              <PinButton
                                documentId={p.document_id}
                                number={p.number}
                                title={p.title}
                                status={p.status}
                                chunkId={p.chunk_id}
                                query={p.query}
                                chunkText={p.text}
                                paragraph={p.paragraph}
                                page={p.page}
                              />
                              {!isLocal ? (
                                <button
                                  onClick={() => openPdf(p.document_id, p.page)}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full bg-white border border-slate-200 hover:bg-slate-50"
                                >
                                  PDF{p.page ? ` стр.${p.page}` : ''} →
                                </button>
                              ) : (
                                <span className="text-[11px] text-slate-400">нет PDF</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* ═══════════════════════════════════════════════════════════
              Main content: loading / pinned-only / regular docs grid
              ═══════════════════════════════════════════════════════════ */}
          {docsLoading ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-8">
              <SnakeState variant="searching" title="Загружаю документы…" size={120} />
            </div>
          ) : showPinnedOnly ? (
            /* ── Pinned-only view ── */
            <div className="grid gap-3">
              {(() => {
                const pinnedDocs = pinnedItems.filter((p: any) => (p.kind || 'doc') === 'doc')
                const pinnedChunks = pinnedItems.filter((p: any) => p.kind === 'chunk')
                const filterByBasket = (arr: any[]) =>
                  activeBasketId ? arr.filter(p => assignments[p.document_id] === activeBasketId) : arr
                const filteredDocs = filterByBasket(pinnedDocs)
                const filteredChunks = filterByBasket(pinnedChunks)

                if (filteredDocs.length === 0 && filteredChunks.length === 0) {
                  return (
                    <div className="bg-white rounded-2xl border border-slate-200 p-6">
                      <SnakeState
                        variant="thinking"
                        title={activeBasketId
                          ? `В корзине "${baskets.find(b => b.id === activeBasketId)?.name}" нет закрепов`
                          : 'Нет закрепов'}
                        subtitle="Нажмите ⭐ на документе или перетащите карточку"
                        size={120}
                        action={
                          <button onClick={() => setShowPinnedOnly(false)} className="px-4 py-2 rounded-full bg-amber-400 text-white text-xs">
                            Показать все
                          </button>
                        }
                      />
                    </div>
                  )
                }

                return (
                  <>
                    {/* Pinned docs in pinned-only view */}
                    {filteredDocs.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold text-slate-500 tracking-widest uppercase flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-blue-500" /> Документы • {filteredDocs.length}
                        </div>
                        {filteredDocs.map((p: any) => {
                          const b = statusBadge(p.status)
                          const isLocal = p.document_id.startsWith('local:')
                          return (
                            <div
                              key={`pinned-only-doc-${p.document_id}`}
                              draggable
                              onDragStart={e => {
                                const payload = {
                                  document_id: p.document_id,
                                  number: p.number,
                                  title: p.title,
                                  type: p.type,
                                  status: p.status,
                                  pages: p.pages,
                                  source_url: p.source_url,
                                  kind: 'doc',
                                }
                                e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                                e.dataTransfer.setData('text/plain', p.document_id)
                                e.dataTransfer.effectAllowed = 'move'
                                setBasketDragging(true)
                                setDraggedDocId(p.document_id)
                              }}
                              onDragEnd={() => {
                                setBasketDragging(false)
                                setDraggedDocId(null)
                              }}
                              className="bg-white rounded-2xl border border-blue-200 border-l-4 border-l-blue-500 p-4 flex items-center gap-4 hover:shadow-sm transition cursor-grab active:cursor-grabbing"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 border border-blue-200 text-blue-700 font-medium">Документ</span>
                                  <span className="font-semibold text-sm text-slate-900">{p.number}</span>
                                  <span className={`text-[11px] px-2 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
                                  {p.type && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">{p.type}</span>}
                                  {isLocal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">локально</span>}
                                </div>
                                <div className="text-sm text-slate-700 mt-1 truncate">{p.title}</div>
                                <div className="text-xs text-slate-400 mt-1">закреплён {new Date(p.pinned_at).toLocaleDateString('ru-RU')}</div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <PinButton
                                  documentId={p.document_id}
                                  number={p.number}
                                  title={p.title}
                                  type={p.type as any}
                                  status={p.status}
                                  pages={p.pages}
                                  source_url={p.source_url}
                                />
                                {!isLocal ? (
                                  <button
                                    onClick={() => openPdf(p.document_id, null)}
                                    className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                                  >
                                    PDF
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-slate-400 px-2 border border-slate-200 rounded-full bg-slate-50 py-1">нет PDF</span>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Pinned chunks in pinned-only view */}
                    {filteredChunks.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-semibold text-amber-700 tracking-widest uppercase flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-amber-500" /> Фрагменты • {filteredChunks.length}
                        </div>
                        {filteredChunks.map((p: any) => {
                          const b = statusBadge(p.status)
                          const isLocal = p.document_id.startsWith('local:')
                          return (
                            <div
                              key={`pinned-only-chunk-${p.chunk_id}`}
                              draggable
                              onDragStart={e => {
                                const payload = {
                                  document_id: p.document_id,
                                  number: p.number,
                                  title: p.title,
                                  type: p.type,
                                  status: p.status,
                                  source_url: p.source_url,
                                  kind: 'chunk',
                                  chunk_id: p.chunk_id,
                                  query: p.query,
                                  text: p.text,
                                  paragraph: p.paragraph,
                                  page: p.page,
                                }
                                e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                                e.dataTransfer.setData('text/plain', p.chunk_id)
                                e.dataTransfer.effectAllowed = 'move'
                                setBasketDragging(true)
                                setDraggedDocId(p.document_id)
                              }}
                              onDragEnd={() => {
                                setBasketDragging(false)
                                setDraggedDocId(null)
                              }}
                              className="bg-amber-50/60 rounded-2xl border border-amber-200 border-l-4 border-l-amber-500 p-4 flex gap-3 hover:shadow-sm transition cursor-grab active:cursor-grabbing"
                            >
                              <div className="hidden sm:flex flex-col items-center gap-1 pt-1 opacity-40">
                                <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs bg-amber-100 text-amber-700">📑</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700 font-medium">Фрагмент</span>
                                  <span className="font-semibold text-sm text-slate-900">{p.number}</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>
                                  {p.paragraph && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white border border-slate-200">п. {p.paragraph}</span>}
                                  {p.page && <span className="text-[10px] text-slate-500">стр. {p.page}</span>}
                                  {isLocal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">локально</span>}
                                </div>
                                {p.query && (
                                  <div className="text-[11px] text-slate-500 mt-1 line-clamp-1">
                                    Запрос: <span className="font-medium text-slate-700">«{p.query}»</span>
                                  </div>
                                )}
                                <div className="text-xs text-slate-900 mt-1 font-medium line-clamp-1">{p.title}</div>
                                {p.text && (
                                  <div className="text-xs text-slate-600 mt-1.5 line-clamp-2 leading-relaxed bg-white border border-amber-100 rounded-lg p-2">
                                    &ldquo;{p.text.slice(0, 180)}{p.text.length > 180 ? '…' : ''}&rdquo;
                                  </div>
                                )}
                                <div className="text-[11px] text-slate-400 mt-1.5">
                                  закреплён {new Date(p.pinned_at).toLocaleDateString('ru-RU')}
                                  {p.page ? ` • стр. ${p.page}` : ''}
                                </div>
                              </div>
                              <div className="flex flex-col items-center gap-2 shrink-0 justify-center">
                                <PinButton
                                  documentId={p.document_id}
                                  number={p.number}
                                  title={p.title}
                                  status={p.status}
                                  chunkId={p.chunk_id}
                                  query={p.query}
                                  chunkText={p.text}
                                  paragraph={p.paragraph}
                                  page={p.page}
                                />
                                {!isLocal ? (
                                  <button
                                    onClick={() => openPdf(p.document_id, p.page)}
                                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full bg-white border border-slate-200 hover:bg-slate-50"
                                  >
                                    PDF{p.page ? ` стр.${p.page}` : ''} →
                                  </button>
                                ) : (
                                  <span className="text-[11px] text-slate-400">нет PDF</span>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          ) : (
            /* ── Regular docs grid ── */
            <div
              data-docs-grid
              className="grid gap-3"
              onDragOver={e => {
                if (
                  e.dataTransfer.types.includes('Files') ||
                  e.dataTransfer.types.includes('application/x-snip-doc') ||
                  Array.from(e.dataTransfer.types || []).includes('Files')
                )
                  e.preventDefault()
              }}
              onDrop={e => {
                const raw = e.dataTransfer.getData('application/x-snip-doc')
                if (raw) {
                  e.preventDefault()
                  try {
                    const obj = JSON.parse(raw)
                    // doc dropped on docs grid → move to active basket, not pinned
                    window.dispatchEvent(
                      new CustomEvent('snip:basket-move', {
                        detail: { docId: obj.document_id, basketId: activeBasketId },
                      })
                    )
                  } catch {}
                  return
                }
                const files = getFilesFromDataTransfer(e.dataTransfer)
                if (files.length) {
                  e.preventDefault()
                  window.dispatchEvent(
                    new CustomEvent('snip:basket-files', { detail: { files, basketId: activeBasketId } })
                  )
                }
              }}
            >
              {(() => {
                // Build combined list: local docs + backend docs, excluding pinned
                const localAsDocs = localDocs.map((ld: any) => ({
                  id: ld.id,
                  number: ld.name.replace(/\.pdf$/i, ''),
                  title: `Локальный: ${ld.name} (${(ld.size / 1024 / 1024).toFixed(2)} MB) — до перезагрузки`,
                  type: 'PDF',
                  status: 'draft',
                  pages: null,
                  chunks_count: 0,
                  last_checked_at: ld.created_at,
                  source_url: ld.url,
                  url: ld.url,
                  isLocal: true,
                }))
                const baseBackend = docs.filter((d: any) => !isPinned(d.id))
                const base = [...localAsDocs.filter((d: any) => !isPinned(d.id)), ...baseBackend]
                const filteredRaw = activeBasketId
                  ? base.filter((d: any) => assignments[d.id] === activeBasketId)
                  : base
                const seenIds = new Set<string>()
                const filtered = filteredRaw.filter((d: any) => {
                  if (seenIds.has(d.id)) return false
                  seenIds.add(d.id)
                  return true
                })

                if (filtered.length === 0) {
                  const total = docs.length + localDocs.length
                  return (
                    <div className="bg-white rounded-2xl border border-slate-200 p-6">
                      {total === 0 ? (
                        <SnakeState
                          variant="failed"
                          title="Нет документов по фильтру"
                          subtitle="Загрузите первый PDF — перетащите на корзину или в Админе"
                          size={140}
                        />
                      ) : activeBasketId ? (
                        <div className="text-center py-6">
                          <div className="text-sm font-medium text-slate-700">
                            В корзине «{baskets.find(b => b.id === activeBasketId)?.name}» нет документов
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            Перетащите карточки сюда чтобы наполнить корзину • «Все» чтобы видеть всё
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-6">
                          <div className="text-sm font-medium text-slate-700">Все документы этого фильтра закреплены</div>
                          <div className="text-xs text-slate-500 mt-1">
                            Смотрите секцию «Закреплённые» выше или нажмите «Закреплённые • {pinnedItems.length}» чтобы видеть только их
                          </div>
                        </div>
                      )}
                    </div>
                  )
                }

                return filtered.map((d: any) => {
                  const basket = assignments[d.id] ? baskets.find(b => b.id === assignments[d.id]) : null
                  const isLocal = !!d.isLocal || String(d.id).startsWith('local:')
                  return (
                    <div
                      key={d.id}
                      draggable
                      onDragStart={e => {
                        const payload = {
                          document_id: d.id,
                          number: d.number,
                          title: d.title,
                          type: d.type,
                          status: d.status,
                          pages: d.pages,
                          source_url: d.source_url,
                        }
                        e.dataTransfer.setData('application/x-snip-doc', JSON.stringify(payload))
                        e.dataTransfer.setData('text/plain', d.id)
                        e.dataTransfer.effectAllowed = 'copy'
                        setBasketDragging(true)
                        setDraggedDocId(d.id)
                      }}
                      onDragEnd={() => {
                        setBasketDragging(false)
                        setDraggedDocId(null)
                      }}
                      className={`rounded-2xl border p-4 flex items-center gap-4 transition hover:shadow-sm cursor-grab active:cursor-grabbing ${
                        isLocal ? 'bg-amber-50/40 border-amber-200' : 'bg-white border-slate-200'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-slate-900">{d.number}</span>
                          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${statusBadge(d.status).cls}`}>
                            {statusBadge(d.status).label}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">{d.type}</span>
                          {isLocal && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">
                              локально • до перезагрузки
                            </span>
                          )}
                          {basket && (
                            <span
                              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border text-white"
                              style={{ backgroundColor: basket.color, borderColor: basket.color }}
                            >
                              <span className="w-2 h-2 rounded-full bg-white/80" />
                              {basket.name}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-slate-700 mt-1 truncate">{d.title}</div>
                        <div className="text-xs text-slate-400 mt-1">
                          {isLocal
                            ? 'Локальный файл • до перезагрузки • перетащите в мусорку чтобы убрать'
                            : `${d.chunks_count} фрагментов • ${d.pages ? `${d.pages} стр.` : ''} • обновлён ${
                                d.last_checked_at
                                  ? new Date(d.last_checked_at).toLocaleDateString('ru-RU')
                                  : '—'
                              }`}
                          {d.source_url && !isLocal && (
                            <a href={d.source_url} target="_blank" className="underline ml-2">
                              adilet
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <PinButton
                          documentId={d.id}
                          number={d.number}
                          title={d.title}
                          type={d.type}
                          status={d.status}
                          pages={d.pages}
                          source_url={d.source_url}
                        />
                        {isLocal ? (
                          <a
                            href={(d as any).url || d.source_url}
                            target="_blank"
                            className="px-3 py-1.5 rounded-xl bg-amber-500 text-white text-xs font-medium hover:bg-amber-600"
                          >
                            Открыть
                          </a>
                        ) : (
                          <button
                            onClick={() => openPdf(d.id, null)}
                            className="px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
                          >
                            PDF
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </>
      )}
    </main>
  )
}
