import { useState, useRef, useEffect } from 'react'
import { usePinned } from '../context/PinnedContext'
import { ChunkDetailModal } from './ChunkDetailModal'
import { useToast } from './Toast'
import { useConfirm, ConfirmDialog } from './ConfirmDialog'
import { statusBadge } from '../utils/badges'
import { openPdf } from '../utils/pdf'

export function PinnedDropdown() {
  const { items, remove, removeChunk, clear, count, reorder, add, setPinnedButtonRef } = usePinned() as any
  const { showToast } = useToast()
  const { confirm, handleConfirm, handleCancel, dialogState } = useConfirm()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<any | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dragIdx = useRef<number | null>(null)

  useEffect(() => {
    if (buttonRef.current) setPinnedButtonRef(buttonRef as any)
  }, [setPinnedButtonRef])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])

  const [dragOver, setDragOver] = useState(false)

  const handleClearAll = async () => {
    const ok = await confirm(`Удалить все ${count} закрепов?`, 'Это действие необратимо. Все закреплённые документы будут удалены из избранного.', true)
    if (ok) clear()
  }

  return (
    <>
      <ConfirmDialog
        open={dialogState.open}
        title={dialogState.title}
        message={dialogState.message}
        danger={dialogState.danger}
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
      <div ref={wrapRef} className="relative" data-pinned-drop>
        <button
          ref={buttonRef}
          data-pinned-drop
          onClick={() => setOpen(v => !v)}
          onDragOver={e => { if (e.dataTransfer.types.includes('application/x-snip-doc')) { e.preventDefault(); setDragOver(true) } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            const raw = e.dataTransfer.getData('application/x-snip-doc')
            if (raw) {
              e.preventDefault(); e.stopPropagation(); setDragOver(false); setOpen(true)
              try {
                const obj = JSON.parse(raw)
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                add(obj, rect as unknown as DOMRect)
              } catch {}
            }
          }}
          aria-label="Закреплённые документы"
          aria-expanded={open}
          className={`relative flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition ${dragOver ? 'bg-amber-400 text-white border-amber-400 scale-105' : open ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300'}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={open ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" className={open ? 'text-white' : 'text-slate-600'}>
            <path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z" strokeLinejoin="round" />
          </svg>
          <span className="hidden sm:inline">Закрепы</span>
          <span className="sm:hidden">📌</span>
          {count > 0 && (
            <span className={`ml-0.5 min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full text-[11px] font-bold leading-none ${open ? 'bg-white text-slate-900' : 'bg-blue-600 text-white'} pin-badge`}>
              {count}
            </span>
          )}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`ml-1 transition-transform ${open ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-[360px] max-w-[92vw] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden z-40 animate-dropdown">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div className="font-semibold text-sm text-slate-900">Закреплённые документы</div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">{count}/50</span>
                {count > 0 && <button onClick={handleClearAll} className="text-xs text-slate-500 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50">Очистить</button>}
              </div>
            </div>

            {items.length === 0 ? (
              <div
                onDragOver={e => { if (e.dataTransfer.types.includes('application/x-snip-doc') || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.currentTarget.classList.add('bg-amber-50') } }}
                onDragLeave={e => e.currentTarget.classList.remove('bg-amber-50')}
                onDrop={e => {
                  const raw = e.dataTransfer.getData('application/x-snip-doc')
                  if (raw) {
                    e.preventDefault(); e.stopPropagation();
                    try { const obj = JSON.parse(raw); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); add(obj, rect as unknown as DOMRect) } catch {}
                  } else if (e.dataTransfer.files.length) {
                    e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('snip:file-drop', { detail: { files: Array.from(e.dataTransfer.files) } }))
                  }
                }}
                className="p-6 text-center border-2 border-dashed border-slate-200 rounded-xl m-3"
              >
                <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-400">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z" /></svg>
                </div>
                <div className="text-sm font-medium text-slate-900 mt-3">Пока пусто</div>
                <div className="text-xs text-slate-500 mt-1 leading-relaxed">Нажмите ⭐ на любом документе, перетащите карточку сюда или сбросьте PDF с рабочего стола.</div>
                <div className="text-[11px] text-slate-400 mt-2">Поддерживает drag карточек и файлов. Синхронизируется при входе.</div>
              </div>
            ) : (
              <div className="max-h-[420px] overflow-auto divide-y divide-slate-100">
                {items.map((it: any, idx: number) => {
                  const badge = statusBadge(it.status)
                  const isLocal = it.document_id.startsWith('local:')
                  const isChunk = it.kind === 'chunk'
                  return (
                    <div
                      key={`${it.kind || 'doc'}-${it.chunk_id || it.document_id}`}
                      draggable
                      onDragStart={e => {
                        dragIdx.current = idx
                        e.dataTransfer.effectAllowed = 'move'
                        e.dataTransfer.setData('text/plain', isChunk ? it.chunk_id : it.document_id)
                      }}
                      onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add(isChunk ? 'bg-amber-50' : 'bg-blue-50') }}
                      onDragLeave={e => e.currentTarget.classList.remove('bg-amber-50', 'bg-blue-50')}
                      onDrop={e => {
                        e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('bg-amber-50', 'bg-blue-50')
                        const raw = e.dataTransfer.getData('application/x-snip-doc')
                        if (raw && dragIdx.current === null) {
                          try { const obj = JSON.parse(raw); const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); add(obj, rect as unknown as DOMRect) } catch {}
                        }
                        if (dragIdx.current !== null && dragIdx.current !== idx) {
                          reorder(dragIdx.current, idx)
                          dragIdx.current = null
                        }
                      }}
                      onDragEnd={() => { dragIdx.current = null }}
                      onClick={() => { if (isChunk) setSelected(it) }}
                      className={`px-4 py-3 hover:bg-slate-50 transition flex gap-3 group cursor-pointer ${isChunk ? 'border-l-4 border-l-amber-400' : 'border-l-4 border-l-blue-400'}`}
                    >
                      <div className="flex flex-col items-center gap-1 pt-1 opacity-40 group-hover:opacity-100">
                        <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs ${isChunk ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{isChunk ? '📑' : '📄'}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${isChunk ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-blue-100 text-blue-700 border-blue-200'}`}>{isChunk ? 'Фрагмент' : 'Документ'}</span>
                          <span className="font-semibold text-sm text-slate-900 truncate">{it.number}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                          {it.type && !isChunk && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 border border-slate-200">{it.type}</span>}
                          {isLocal && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-amber-700">локально</span>}
                          {isChunk && it.paragraph && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 border border-slate-200">п. {it.paragraph}</span>}
                          {isChunk && it.page && <span className="text-[10px] text-slate-500">стр. {it.page}</span>}
                        </div>
                        {isChunk && it.query && <div className="text-[11px] text-slate-500 mt-1 line-clamp-1">Запрос: <span className="font-medium text-slate-700">«{it.query}»</span></div>}
                        <div className="text-xs text-slate-900 mt-1 font-medium line-clamp-1">{it.title}</div>
                        {isChunk && it.text ? (
                          <div className="text-xs text-slate-600 mt-1 line-clamp-2 leading-relaxed bg-amber-50/60 border border-amber-100 rounded-lg p-2">"{it.text.slice(0, 180)}{it.text.length > 180 ? '…' : ''}"</div>
                        ) : (
                          <div className="text-xs text-slate-500 mt-1 line-clamp-1">{it.title}</div>
                        )}
                        {!isChunk && (
                          <div className="flex items-center gap-1.5 mt-2">
                            <button onClick={(e) => { e.stopPropagation(); setSelected(it) }} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-blue-600 text-white hover:bg-blue-700 transition">Показать</button>
                            {!isLocal ? <button onClick={(e) => { e.stopPropagation(); openPdf(it.document_id, null, msg => showToast(msg, 'error')) }} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50">PDF →</button> : <span className="text-[11px] text-slate-400">PDF нет</span>}
                            <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(`${it.number} — ${it.title}`); showToast('Скопировано', 'success') }} className="text-xs px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50">Копировать</button>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); isChunk ? removeChunk(it.chunk_id) : remove(it.document_id) }}
                        title={isChunk ? 'Убрать фрагмент' : 'Убрать документ'}
                        className="self-start shrink-0 w-8 h-8 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {items.length > 0 && (
              <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
                <button onClick={() => {
                  const txt = items.map((it: any, i: number) => `${i + 1}. ${it.number} — ${it.title} (${it.status})${it.kind === 'chunk' ? ` [фрагмент п.${it.paragraph || '—'}]` : ''}`).join('\n')
                  navigator.clipboard?.writeText(txt).then(() => showToast(`Скопировано ${items.length} элементов`, 'success')).catch(() => {})
                }} className="text-xs px-2.5 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50">Копировать список</button>
                <button onClick={() => setOpen(false)} className="px-3 py-1 rounded-full bg-white border border-slate-200 hover:bg-slate-50 text-xs text-slate-700">Закрыть</button>
              </div>
            )}
          </div>
        )}
        {selected && <ChunkDetailModal item={selected} onClose={() => setSelected(null)} onRemove={() => selected.kind === 'chunk' ? removeChunk(selected.chunk_id) : remove(selected.document_id)} />}
      </div>
    </>
  )
}
