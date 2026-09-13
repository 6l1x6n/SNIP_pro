import { useState } from 'react'
import { formatValue, formatLabel, groupValueCards, type ValueCard, type ValueGroup } from '../search/values'
import { formatCitation } from '../utils/exportUtils'
import { statusBadge } from '../utils/badges'
import { addFavorite, removeFavorite, isFavorite, favoriteId } from '../utils/favorites'
import { Icon } from './Icon'

const INITIAL_GROUPS = 3

/** «п. 4.7.1.7 · стр. 131» / «Таблица 1 · стр. 22» — для таблиц без префикса «п.». */
function sourceRef(group: ValueGroup): string {
  const parts: string[] = []
  if (group.p) parts.push(/^таблиц/i.test(group.p) ? group.p : `п. ${group.p}`)
  if (group.pg != null) parts.push(`стр. ${group.pg}`)
  return parts.join(' · ')
}

function ValueRow({ card, onOpen }: { card: ValueCard; onOpen: () => void }) {
  const f = card.fact
  const tags = [f.cls, f.scope].filter(Boolean).join(' · ')
  return (
    <button
      onClick={onOpen}
      title="Открыть фрагмент целиком"
      className="w-full text-left flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 -mx-2 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
    >
      <span className="text-lg font-bold text-slate-900 dark:text-white tabular-nums">{formatValue(f)}</span>
      <span className="text-xs text-slate-500 dark:text-slate-400">{formatLabel(f.k)}{tags ? ` · ${tags}` : ''}</span>
    </button>
  )
}

function GroupCard({ group, query, openPdf, onOpenCard, copiedKey, onCopy }: {
  group: ValueGroup
  query: string
  openPdf: (documentId: string, page?: number, quote?: string | null) => void
  onOpenCard: (card: ValueCard) => void
  copiedKey?: string | null
  onCopy?: (key: string, text: string) => void
}) {
  const [expandedQuote, setExpandedQuote] = useState(false)
  const first = group.cards[0]
  const badge = group.docStatus && group.docStatus !== 'active' ? statusBadge(group.docStatus) : null
  const ref = sourceRef(group)
  const fid = favoriteId({ kind: 'answer', query, documentNumber: group.docNumber, page: group.pg ?? undefined })
  const saved = isFavorite(fid)
  const citeKey = `cite-g-${first.fact.i}`
  const quote = first.fact.s || ''
  const canExpand = quote.length > 120

  const toggleFav = () => {
    if (saved) removeFavorite(fid)
    else addFavorite({
      kind: 'answer', query,
      answer: `${formatValue(first.fact)} — ${formatLabel(first.fact.k)}`,
      quote: first.fact.s,
      documentId: String(first.fact.d),
      documentNumber: group.docNumber,
      documentTitle: group.docTitle,
      paragraph: group.p,
      page: group.pg ?? undefined,
    })
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-slate-900 dark:text-white">{group.docNumber || 'Нормативный документ'}</span>
        {badge && <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${badge.cls}`} title="Статус документа — уточните действующую редакцию">{badge.label}</span>}
        {group.docTitle && <span className="text-[11px] text-slate-400 truncate max-w-full">{group.docTitle}</span>}
        {ref && <span className="ml-auto text-[11px] text-slate-400 tabular-nums shrink-0">{ref}</span>}
      </div>

      <div className="mt-1.5 divide-y divide-slate-100 dark:divide-slate-800">
        {group.cards.map((c) => (
          <ValueRow key={`${c.fact.i}-${c.fact.k}-${c.fact.op}-${c.fact.v}`} card={c} onOpen={() => onOpenCard(c)} />
        ))}
      </div>

      {quote && (
        <div className="mt-1.5">
          <div className={`font-mono text-[12px] leading-relaxed text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 border border-slate-100 dark:border-slate-800 [overflow-wrap:anywhere] ${expandedQuote ? '' : 'line-clamp-2'}`}>«{quote}»</div>
          {canExpand && (
            <button onClick={() => setExpandedQuote(v => !v)} className="mt-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
              {expandedQuote ? 'свернуть' : 'показать'}
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button onClick={() => openPdf(String(group.docId), group.pg ?? 1, first.fact.s)} className="btn btn-sm btn-primary py-1">
          <Icon name="file" size={12} /> PDF{group.pg != null ? ` · стр. ${group.pg}` : ''}
        </button>
        <button
          onClick={() => onCopy?.(citeKey, formatCitation({ document_number: group.docNumber, paragraph: group.p, page: group.pg }))}
          title="Скопировать сноску на норму"
          className="btn btn-sm btn-secondary py-1"
        >
          {copiedKey === citeKey ? <><Icon name="check" size={12} /> Скопировано</> : <><Icon name="copy" size={12} /> Сноска</>}
        </button>
        <button
          onClick={toggleFav}
          title={saved ? 'Убрать из избранного' : 'Сохранить в избранное'}
          className={`btn btn-sm py-1 border px-2 ${saved ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white' : 'btn-secondary'}`}
        >
          <Icon name="star" size={13} fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  )
}

/**
 * Субкарточки ответа: одна карточка на источник (документ + пункт + страница),
 * значения — строками внутри. Клик по значению открывает полный фрагмент (ValueCardModal).
 */
export function ValueSourceCards({ cards, query, openPdf, onOpenCard, copiedKey, onCopy }: {
  cards: ValueCard[]
  query: string
  openPdf: (documentId: string, page?: number, quote?: string | null) => void
  onOpenCard: (card: ValueCard) => void
  copiedKey?: string | null
  onCopy?: (key: string, text: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const groups = groupValueCards(cards)
  if (!groups.length) return null
  const visible = expanded ? groups : groups.slice(0, INITIAL_GROUPS)
  const hidden = groups.length - visible.length
  return (
    <div className="space-y-2.5">
      {visible.map((g, i) => (
        <GroupCard
          key={`${g.docNumber}|${g.p}|${g.pg}|${i}`}
          group={g}
          query={query}
          openPdf={openPdf}
          onOpenCard={onOpenCard}
          copiedKey={copiedKey}
          onCopy={onCopy}
        />
      ))}
      {hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="w-full py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition">
          Показать ещё {hidden}
        </button>
      )}
      {expanded && groups.length > INITIAL_GROUPS && (
        <button onClick={() => setExpanded(false)} className="w-full py-2 rounded-xl text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition">Свернуть</button>
      )}
    </div>
  )
}
