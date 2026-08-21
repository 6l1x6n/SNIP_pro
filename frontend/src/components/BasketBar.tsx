import { useState } from 'react'
import { useBaskets } from '../context/BasketContext'
import { getFilesFromDataTransfer } from '../utils/fileType'

// ── Basket glyph (recognizable "real basket" icon, tinted with the basket color) ──
function BasketGlyph({ color, active }: { color: string; active?: boolean }) {
  const stroke = active ? '#ffffff' : 'rgba(15,23,42,0.55)'
  const bodyFill = active ? 'rgba(255,255,255,0.28)' : color
  const weave = active ? 'rgba(255,255,255,0.75)' : 'rgba(15,23,42,0.18)'
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" className="shrink-0" aria-hidden>
      <path d="M8.4 8.4 V6.8 a3.6 3.6 0 0 1 7.2 0 V8.4" fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M4.4 9 H19.6 L17.3 20 H6.7 Z" fill={bodyFill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6 12.8 H18 M6.4 16.4 H17.6" stroke={weave} strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

// ── "All" glyph (stacked layers) ──
function AllGlyph({ active }: { active?: boolean }) {
  const c = active ? '#ffffff' : 'rgba(15,23,42,0.5)'
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" className="shrink-0" aria-hidden>
      <path d="M12 3 21 7.5 12 12 3 7.5 12 3 Z" fill={active ? 'rgba(255,255,255,0.28)' : '#cbd5e1'} stroke={c} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M3 12 12 16.5 21 12 M3 16.5 12 21 21 16.5" fill="none" stroke={c} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

export function BasketBar({ allowCreate = false }: { allowCreate?: boolean }) {
  const { baskets, activeBasketId, setActiveBasketId, createBasket, deleteBasket, updateBasket, moveToBasket, assignments } = useBaskets()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#3b82f6')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#3b82f6')
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const handleCreate = () => {
    if (!newName.trim()) return
    createBasket(newName.trim(), newColor)
    setNewName(''); setNewColor('#3b82f6'); setShowCreate(false)
  }

  const startEdit = (b: any) => {
    setEditingId(b.id); setEditName(b.name); setEditColor(b.color)
  }
  const saveEdit = () => {
    if (!editingId) return
    if (editName.trim()) updateBasket(editingId, { name: editName.trim(), color: editColor })
    setEditingId(null)
  }

  const countFor = (basketId: string) => Object.values(assignments).filter(v => v === basketId).length
  const totalCount = Object.keys(assignments).length

  const dragTypesOk = (dt: DataTransfer) =>
    dt.types.includes('application/x-snip-doc') || dt.types.includes('text/plain') || dt.types.includes('Files')

  const handleDrop = (e: React.DragEvent, basketId: string | null) => {
    e.preventDefault(); setDragOverId(null)
    const files = getFilesFromDataTransfer(e.dataTransfer)
    if (files.length) {
      window.dispatchEvent(new CustomEvent('snip:basket-files', { detail: { files, basketId } }))
      return
    }
    const rawDoc = e.dataTransfer.getData('application/x-snip-doc')
    let docId = e.dataTransfer.getData('text/plain')
    if (!docId && rawDoc) { try { docId = JSON.parse(rawDoc).document_id } catch {} }
    if (docId) moveToBasket(docId, basketId)
  }

  const pillBase = 'relative inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1.5 rounded-full text-xs font-medium border transition select-none'
  const allActive = activeBasketId === null

  const allCls = pillBase + ' shrink-0 ' + (allActive ? 'bg-slate-900 text-white border-slate-900' : dragOverId === 'all' ? 'bg-slate-900 text-white border-slate-900 scale-105' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin flex-nowrap">
        {/* All */}
        <button
          data-basket-chip
          title="Все документы"
          onClick={() => setActiveBasketId(null)}
          onDragOver={e => { if (dragTypesOk(e.dataTransfer)) { e.preventDefault(); setDragOverId('all') } }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={e => handleDrop(e, null)}
          className={allCls}
        >
          <AllGlyph active={allActive || dragOverId === 'all'} />
          <span>Все</span>
          {totalCount > 0 && <span className={'ml-0.5 text-[10px] ' + (allActive ? 'text-white/70' : 'text-slate-400')}>{totalCount}</span>}
        </button>

        {baskets.map(b => {
          const cnt = countFor(b.id)
          const isActive = activeBasketId === b.id
          const isOver = dragOverId === b.id
          const editing = editingId === b.id
          const cls = pillBase + ' shrink-0 group ' + (isActive ? 'text-white shadow-sm border-transparent' : isOver ? 'text-white shadow-md scale-105 border-transparent' : 'bg-white text-slate-700 border-slate-200 hover:shadow-sm')
          return (
            <div
              key={b.id}
              data-basket-chip
              title={b.name}
              onDragOver={e => { if (dragTypesOk(e.dataTransfer)) { e.preventDefault(); setDragOverId(b.id) } }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={e => handleDrop(e, b.id)}
              className={cls}
              style={isActive || isOver ? { backgroundColor: b.color, borderColor: b.color } : undefined}
            >
              {editing ? (
                <span className="flex items-center gap-1">
                  <input value={editName} onChange={e => setEditName(e.target.value)} className="w-20 px-1.5 py-0.5 rounded text-xs text-slate-900 border" autoFocus onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditingId(null) }} />
                  <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} className="w-6 h-6 p-0 rounded border-0" />
                  <button onClick={saveEdit} className="p-1 rounded hover:bg-black/10 text-xs">✓</button>
                  <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-black/10 text-xs">✕</button>
                </span>
              ) : (
                <>
                  <BasketGlyph color={b.color} active={isActive || isOver} />
                  <button onClick={() => setActiveBasketId(b.id)} className="font-medium max-w-[110px] truncate">{b.name}</button>
                  {cnt > 0 && <span className={'text-[10px] ' + (isActive || isOver ? 'text-white/80' : 'text-slate-400')}>{cnt}</span>}
                  {allowCreate && (
                    <span className="flex items-center gap-0.5 ml-0.5 opacity-50 group-hover:opacity-100">
                      <button onClick={() => startEdit(b)} className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/10" title="Переименовать/цвет">✎</button>
                      <button onClick={() => { if (confirm('Удалить корзину "' + b.name + '"? Файлы вернутся в "Все"')) deleteBasket(b.id) }} className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/10 text-xs" title="Удалить">×</button>
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}

        {allowCreate && (
          <button onClick={() => setShowCreate(v => !v)} className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-white border border-dashed border-slate-300 text-slate-600 hover:border-blue-300 hover:text-blue-600">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            Корзина
          </button>
        )}
      </div>

      {allowCreate && showCreate && (
        <div className="flex flex-wrap items-center gap-2 bg-white rounded-xl border border-slate-200 p-3">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Название корзины" className="flex-1 min-w-[140px] px-3 py-1.5 rounded-lg border border-slate-200 text-sm" maxLength={30} />
          <label className="flex items-center gap-2 text-xs">
            Цвет <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} className="w-8 h-8 p-0 rounded border border-slate-200" />
            <span className="w-6 h-6 rounded-full border border-slate-200" style={{ backgroundColor: newColor }} />
            <input type="text" value={newColor} onChange={e => setNewColor(e.target.value)} placeholder="#3b82f6" className="w-24 px-2 py-1 rounded border border-slate-200 text-xs font-mono" />
          </label>
          <button onClick={handleCreate} className="px-4 py-1.5 rounded-full bg-blue-600 text-white text-xs font-medium hover:bg-blue-700">Создать</button>
          <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded-full bg-white border border-slate-200 text-xs">Отмена</button>
        </div>
      )}

      <div className="text-[11px] text-slate-400">
        {activeBasketId ? 'Показана корзина: ' + (baskets.find(b => b.id === activeBasketId)?.name || '') + ' • перетащите карточку на другую корзину чтобы переместить' : 'Перетащите карточку на корзину • схватите файл — снизу появится мусорка для удаления дока'}
      </div>
    </div>
  )
}
