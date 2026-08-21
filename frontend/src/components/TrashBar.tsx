import { useState } from 'react'
import { useBaskets } from '../context/BasketContext'
import { usePinned } from '../context/PinnedContext'
import { useAuth } from '../context/AuthContext'
import { useToast } from './Toast'
import { useConfirm, ConfirmDialog } from './ConfirmDialog'
import { API_BASE } from '../utils/api'

export function TrashBar() {
  const { isDragging, draggedDocId, setIsDragging, setDraggedDocId, removeLocalDoc } = useBaskets()
  const { remove } = usePinned()
  const { authFetch } = useAuth()
  const { showToast } = useToast()
  const { confirm, handleConfirm, handleCancel, dialogState } = useConfirm()
  const [dragOver, setDragOver] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (!isDragging) return null

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    // надёжное извлечение document_id: draggedDocId → JSON document_id → text/plain (UUID дока)
    let docId: string | null = draggedDocId || null
    if (!docId) {
      const raw = e.dataTransfer.getData('application/x-snip-doc')
      if (raw) {
        try { const j = JSON.parse(raw); if (j?.document_id) docId = j.document_id } catch {}
      }
    }
    if (!docId) {
      const txt = e.dataTransfer.getData('text/plain')?.trim()
      if (txt && /^[0-9a-f-]{36}$/i.test(txt)) docId = txt
      else if (txt && txt.startsWith('local:')) docId = txt
    }
    if (!docId) return

    const confirmed = await confirm(
      'Удалить документ?',
      `Удалить документ ${docId.slice(0, 8)}… навсегда? Это удалит PDF и все фрагменты из базы.`,
      true,
    )
    if (!confirmed) {
      setIsDragging(false); setDraggedDocId(null); return
    }

    // local file — just remove from basket/pinned (в памяти, до перезагрузки)
    if (docId.startsWith('local:')) {
      remove(docId)
      removeLocalDoc(docId)
      window.dispatchEvent(new CustomEvent('snip:basket-move', { detail: { docId, basketId: null } }))
      setIsDragging(false); setDraggedDocId(null)
      return
    }
    setDeleting(true)
    try {
      const r = await authFetch(`${API_BASE}/api/admin/documents/${docId}`, { method: 'DELETE' })
      if (!r.ok) {
        const txt = await r.text()
        let msg = txt
        try { const j = JSON.parse(txt); if (j.detail) msg = j.detail } catch {}
        if (msg.includes('Not found') && /^[0-9a-f-]{36}$/i.test(docId)) msg = 'Не найден документ (возможно, перетащили фрагмент, а не документ). Попробуйте перетащить карточку документа целиком.'
        throw new Error(msg)
      }
      remove(docId)
      window.dispatchEvent(new CustomEvent('snip:basket-move', { detail: { docId, basketId: null } }))
      window.dispatchEvent(new Event('snip:reload-docs'))
      showToast('Документ удалён', 'success')
    } catch (e: any) {
      let msg = e.message || 'Ошибка'
      if (msg.includes('Чужой документ')) msg = 'Это чужой личный документ — удалить может только владелец.'
      if (msg.includes('Общий документ')) msg = 'Общий эталон — удалять может только владелец сайта (superuser). Уберите из корзины вместо удаления.'
      showToast(`Не удалось удалить: ${msg}`, 'error', 5000)
    } finally {
      setDeleting(false)
      setIsDragging(false); setDraggedDocId(null)
    }
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
      <div
        data-trash
        onDragOver={e => { e.preventDefault(); setDragOver(true); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`fixed bottom-0 left-0 right-0 z-50 flex items-center justify-center p-3 transition ${dragOver ? 'bg-red-600' : 'bg-slate-900'}`}
        style={{ boxShadow: '0 -8px 32px rgba(0,0,0,0.18)' }}
      >
        <div className={`flex items-center gap-3 px-6 py-3 rounded-2xl border-2 border-dashed transition ${dragOver ? 'bg-white border-white scale-105' : 'bg-slate-800 border-slate-600 text-white'} ${deleting ? 'opacity-60' : ''}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${dragOver ? 'bg-red-50' : 'bg-red-500'}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={dragOver ? '#dc2626' : 'white'} strokeWidth="1.8"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
          </div>
          <div>
            <div className={`font-semibold text-sm ${dragOver ? 'text-red-700' : 'text-white'}`}>{deleting ? 'Удаляю…' : dragOver ? 'Отпустите чтобы удалить' : 'Перетащите сюда чтобы удалить'}</div>
            <div className={`text-xs ${dragOver ? 'text-red-600' : 'text-slate-400'}`}>{dragOver ? 'Документ будет удалён навсегда' : 'Работает для любых документов • корзина удаляет док'}</div>
          </div>
          {dragOver && <span className="ml-2 text-red-500 font-bold">×</span>}
        </div>
      </div>
    </>
  )
}
