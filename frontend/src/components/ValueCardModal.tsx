import { useState, useEffect } from 'react'
import { formatValue, formatLabel, type ValueCard } from '../search/values'
import { loadIndex } from '../search/engine'
import { highlightText } from '../utils/highlight'
import { statusBadge } from '../utils/badges'
import { formatCitation, cleanParagraph, copyToClipboard } from '../utils/exportUtils'
import { addFavorite, removeFavorite, isFavorite, favoriteId } from '../utils/favorites'
import { Icon } from './Icon'

interface Props {
  card: ValueCard | null
  query: string
  highlightPalette: string
  monoHex?: string
  openPdf: (documentId: string, page?: number, quote?: string | null) => void
  onClose: () => void
}

/**
 * Детальный просмотр карточки значения: крупное значение, полный текст
 * фрагмента из индекса (по fact.i) с подсветкой, действия. Закрытие:
 * клик вне окна, Escape, ×. Всё локально, 0⚡.
 */
export function ValueCardModal({ card, query, highlightPalette, monoHex, openPdf, onClose }: Props) {
  const [fullText, setFullText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [, setFavTick] = useState(0)

  useEffect(() => {
    setFullText(null)
    setCopied(false)
    if (!card) return
    let cancelled = false
    ;(async () => {
      try {
        const bundle = await loadIndex()
        const t = bundle.chunks[card.fact.i]?.t
        if (!cancelled && t) setFullText(t)
      } catch {}
    })()
    return () => { cancelled = true }
  }, [card])

  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [card, onClose])

  if (!card) return null
  const f = card.fact
  const fid = favoriteId({ kind: 'answer', query, documentNumber: card.docNumber, page: f.pg ?? undefined })
  const saved = isFavorite(fid)
  const body = fullText || `«${f.s}»`

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 max-md:p-3"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-emerald-200 dark:border-emerald-900 shadow-xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-5 max-md:p-4 animate-[slideUp_.2s_ease-out]">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <div className="text-3xl font-bold text-emerald-700 dark:text-emerald-300">{formatValue(f)}</div>
            <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{formatLabel(f.k)}</div>
          </div>
          <button onClick={onClose} title="Закрыть" className="ml-auto shrink-0 icon-btn border border-slate-200 dark:border-slate-700"><Icon name="close" size={15} /></button>
        </div>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 truncate" title={`${card.docNumber} • п. ${f.p || '—'} • стр. ${f.pg ?? '—'}`}>
          {card.docNumber || '—'} • п. {f.p || '—'} • стр. {f.pg ?? '—'}
          {card.docStatus && card.docStatus !== 'active' && (() => { const b = statusBadge(card.docStatus); return <span title="Статус документа — уточните действующую редакцию" className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span> })()}
        </div>
        <div className="mt-3 font-mono text-[13px] leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 border border-slate-200 dark:border-slate-700 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {highlightText(body, query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => openPdf(String(f.d), f.pg ?? 1, f.s)} className="btn btn-sm bg-emerald-600 text-white hover:bg-emerald-700 py-2 px-4"><Icon name="file" size={13} /> Открыть PDF • стр. {f.pg ?? '—'}</button>
          <button
            onClick={() => { copyToClipboard(formatCitation({ document_number: card.docNumber, paragraph: cleanParagraph(f.p), page: f.pg })); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
            title="Скопировать сноску на норму"
            className="btn btn-sm btn-secondary py-2"
          >{copied ? <><Icon name="check" size={12} /> Скопировано</> : <><Icon name="copy" size={12} /> Сноска</>}</button>
          <button
            onClick={() => {
              if (saved) removeFavorite(fid)
              else addFavorite({
                kind: 'answer', query,
                answer: `${formatValue(f)} — ${formatLabel(f.k)}`,
                quote: f.s,
                documentId: String(f.d),
                documentNumber: card.docNumber,
                documentTitle: card.docTitle,
                paragraph: cleanParagraph(f.p),
                page: f.pg ?? undefined,
              })
              setFavTick((t) => t + 1)
            }}
            title={saved ? 'Убрать из избранного' : 'Сохранить в избранное'}
            className={`btn btn-sm py-2 border ${saved ? 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300' : 'btn-secondary hover:border-amber-300 hover:text-amber-700 dark:hover:text-amber-400'}`}
          ><Icon name="star" size={13} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Сохранено' : 'В избранное'}</button>
        </div>
      </div>
    </div>
  )
}
