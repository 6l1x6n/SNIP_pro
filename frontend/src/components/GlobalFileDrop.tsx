import { useEffect, useState, useRef } from 'react'
import { usePinned } from '../context/PinnedContext'
import { getFilesFromDataTransfer } from '../utils/fileType'

export function GlobalFileDrop() {
  const { add } = usePinned()
  const [isDraggingDoc, setIsDraggingDoc] = useState(false)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const dragCounter = useRef(0)
  const dragCounterFiles = useRef(0)
  const [msg, setMsg] = useState<string | null>(null)

  // listen for card pin drops via custom event (from basket chips etc)
  useEffect(() => {
    const onPinDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.document_id) {
        const rect = document.querySelector('[data-pinned-drop]')?.getBoundingClientRect() || new DOMRect(window.innerWidth - 120, 12, 80, 36)
        add(detail, rect as any)
        setMsg(`Закреплён: ${detail.number}`)
        setTimeout(()=>setMsg(null), 2000)
      }
    }
    window.addEventListener('snip:pin-drop', onPinDrop as any)
    return () => {
      window.removeEventListener('snip:pin-drop', onPinDrop as any)
    }
  }, [add])

  useEffect(() => {
    const hasType = (dt: DataTransfer | null, t: string) => {
      if (!dt?.types) return false
      return Array.from(dt.types as any).includes(t)
    }
    const onDragEnter = (e: DragEvent) => {
      if (hasType(e.dataTransfer, 'application/x-snip-doc')) {
        dragCounter.current++
        setIsDraggingDoc(true)
      }
      if (hasType(e.dataTransfer, 'Files')) {
        dragCounterFiles.current++
        setIsDraggingFiles(true)
      }
    }
    const onDragLeave = (_e: DragEvent) => {
      if (dragCounter.current > 0) {
        dragCounter.current--
        if (dragCounter.current <= 0) {
          dragCounter.current = 0
          setIsDraggingDoc(false)
        }
      }
      if (dragCounterFiles.current > 0) {
        dragCounterFiles.current--
        if (dragCounterFiles.current <= 0) {
          dragCounterFiles.current = 0
          setIsDraggingFiles(false)
        }
      }
    }
    const onDragOver = (e: DragEvent) => {
      if (hasType(e.dataTransfer, 'application/x-snip-doc') || hasType(e.dataTransfer, 'Files')) {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      dragCounter.current = 0
      dragCounterFiles.current = 0
      setIsDraggingDoc(false)
      setIsDraggingFiles(false)
      const hasDoc = e.dataTransfer?.getData('application/x-snip-doc')
      if (hasDoc) {
        const target = e.target as HTMLElement
        const handled = target.closest('[data-basket-chip]') || target.closest('[data-trash]') || target.closest('[data-pinned-drop]') || target.closest('[data-docs-grid]')
        if (handled) return
        // FIX: не пинить автоматически при drop в пустую область — только на явные цели (корзина/мусорка/закреп). Иначе мусорка не срабатывала.
        if (e.defaultPrevented) return
        e.preventDefault()
        setMsg('Перетащите карточку на ⭐ Закрепы, корзину сверху или в мусорку снизу — в пустую область не закрепляю')
        setTimeout(()=>setMsg(null), 2500)
        return
      }
      const files = getFilesFromDataTransfer(e.dataTransfer as any)
      if (files.length) {
        const target = e.target as HTMLElement
        const handledChip = target.closest('[data-basket-chip]') || target.closest('[data-trash]') || target.closest('[data-pinned-drop]') || target.closest('[data-docs-grid]')
        if (handledChip) return // already handled by chip/grid
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('snip:basket-files', { detail: { files, basketId: null }}))
        return
      }
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [add])

  if (!isDraggingDoc && !isDraggingFiles && !msg) return null

  return (
    <>
      {(isDraggingDoc || isDraggingFiles) && (
        <div className="fixed inset-0 z-40 pointer-events-none flex flex-col items-center justify-center p-4">
          {isDraggingFiles && (
            <div className="pointer-events-auto bg-white rounded-[20px] shadow-2xl border-2 border-dashed border-blue-400 p-6 text-center max-w-md">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/></svg>
              </div>
              <div className="font-semibold text-slate-900 mt-3">Отпустите PDF в любом окне</div>
              <div className="text-xs text-slate-500 mt-1">Файл попадёт в активную корзину • до 100 МБ • работает на любой вкладке</div>
            </div>
          )}
          {isDraggingDoc && !isDraggingFiles && (
            <div className="pointer-events-auto bg-white/90 backdrop-blur border border-amber-200 shadow-lg rounded-2xl px-4 py-2 text-xs text-slate-600 flex items-center gap-2 mt-3">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              Перетащите на корзину сверху или в мусорку снизу
            </div>
          )}
        </div>
      )}
      {msg && !isDraggingDoc && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-slate-900 text-white px-4 py-3 rounded-2xl shadow-xl text-sm max-w-[90vw]">
          <span className="truncate">{msg}</span>
          <button onClick={()=>setMsg(null)} className="ml-2 text-white/60 hover:text-white">✕</button>
        </div>
      )}
    </>
  )
}
