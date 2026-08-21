import type { PinnedItem } from '../context/PinnedContext'
import { useToast } from './Toast'
import { openPdf } from '../utils/pdf'

export function ChunkDetailModal({ item, onClose, onRemove }: { item: PinnedItem, onClose: () => void, onRemove?: () => void }) {
  const { showToast } = useToast()

  if (!item) return null
  const isChunk = (item.kind || 'doc') === 'chunk'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {isChunk
                ? <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-amber-100 border border-amber-200 text-amber-700"><span className="w-2 h-2 rounded-full bg-amber-500" />Фрагмент</span>
                : <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full bg-blue-100 border border-blue-200 text-blue-700"><span className="w-2 h-2 rounded-full bg-blue-500" />Документ</span>}
              <span className="font-semibold text-sm text-slate-900 truncate">{item.number}</span>
              {item.paragraph && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200">п. {item.paragraph}</span>}
              {item.page && <span className="text-xs text-slate-500">стр. {item.page}</span>}
            </div>
            <div className="text-sm font-medium text-slate-900 mt-1 line-clamp-2">{item.title}</div>
            {isChunk && item.query && <div className="text-xs text-slate-500 mt-1">Запрос: <span className="font-medium text-slate-700">«{item.query}»</span></div>}
          </div>
          <button onClick={onClose} className="shrink-0 w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {isChunk && item.text && (
            <div className="bg-amber-50/50 border border-amber-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-amber-800 tracking-widest uppercase mb-2">Содержание фрагмента</div>
              <div className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap">{item.text}</div>
            </div>
          )}
          {!isChunk && (
            <div className="bg-blue-50/50 border border-blue-200 rounded-xl p-4 text-sm text-slate-700">
              Документ добавлен в избранное целиком. Откройте PDF или перейдите к чанкам.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200"><div className="text-slate-500">Документ</div><div className="font-medium text-slate-900 mt-0.5">{item.number} — {item.title.slice(0, 60)}</div></div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-200"><div className="text-slate-500">Пункт • Страница</div><div className="font-medium text-slate-900 mt-0.5">{item.paragraph || '—'} • стр. {item.page ?? '—'}</div></div>
          </div>
          {isChunk && <div className="text-xs text-slate-500">Тип: фрагмент ответа — избран только этот отрывок, а не весь документ. Весь док не отмечается как избранный.</div>}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {!item.document_id.startsWith('local:') ? (
              <button onClick={() => openPdf(item.document_id, item.page, msg => showToast(msg, 'error'))} className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">Открыть PDF {item.page ? `стр. ${item.page}` : ''}</button>
            ) : (
              <span className="text-xs text-slate-400 px-2 border border-slate-200 rounded-full bg-slate-50 py-1">стр. {item.page ?? '—'} • локально • нет PDF</span>
            )}
            {item.text && <button onClick={() => { navigator.clipboard?.writeText(item.text!); showToast('Скопировано', 'success') }} className="px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm hover:bg-slate-50">Копировать</button>}
          </div>
          <div className="flex items-center gap-2">
            {onRemove && <button onClick={() => { onRemove(); onClose() }} className="px-3 py-2 rounded-xl bg-white border border-red-200 text-red-600 text-sm hover:bg-red-50">Убрать</button>}
            <button onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-sm hover:bg-black">Закрыть</button>
          </div>
        </div>
      </div>
    </div>
  )
}
