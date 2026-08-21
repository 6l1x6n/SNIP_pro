import { usePinned } from '../context/PinnedContext'

type Props = {
  documentId: string
  number: string
  title: string
  type?: string | null
  status: string
  pages?: number | null
  source_url?: string | null
  size?: 'sm' | 'md'
  // chunk mode
  chunkId?: string | null
  query?: string | null
  chunkText?: string | null
  paragraph?: string | null
  page?: number | null
}

export function PinButton({ documentId, number, title, type, status, pages, source_url, size = 'sm', chunkId, query, chunkText, paragraph, page }: Props) {
  const { isPinned, isPinnedChunk, toggle, toggleChunk, count } = usePinned() as any
  const isChunk = !!chunkId
  const pinned = isChunk ? isPinnedChunk(chunkId!) : isPinned(documentId)
  const limitReached = !pinned && count >= 50

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (limitReached) {
      alert('Достигнут лимит 50 закреплений. Удалите часть из «Закрепы».')
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (isChunk) {
      toggleChunk({ document_id: documentId, number, title, type: type ?? null, status, pages: pages ?? null, source_url: source_url ?? null, kind: 'chunk', chunk_id: chunkId, query: query || null, text: chunkText || null, paragraph: paragraph || null, page: page ?? null } as any, pinned ? null : rect)
    } else {
      toggle({ document_id: documentId, number, title, type: type ?? null, status, pages: pages ?? null, source_url: source_url ?? null, kind: 'doc' } as any, pinned ? null : rect)
    }
  }

  const cls = size === 'sm'
    ? 'w-8 h-8 text-xs'
    : 'w-9 h-9 text-sm'

  const isChunkPin = !!chunkId
  return (
    <button
      onClick={onClick}
      disabled={limitReached}
      title={pinned ? (isChunkPin ? 'Убрать ответ из избранного' : 'Убрать документ из избранного') : limitReached ? 'Лимит 50' : isChunkPin ? 'Сохранить ответ в избранное' : 'Закрепить документ'}
      aria-pressed={pinned}
      className={`shrink-0 inline-flex items-center justify-center rounded-xl border transition ${cls} ${pinned ? 'bg-amber-400 border-amber-400 text-white shadow-md hover:bg-amber-500' : limitReached ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed' : isChunkPin ? 'bg-white border-amber-200 text-amber-600 hover:border-amber-300 hover:bg-amber-50' : 'bg-white border-slate-200 text-slate-500 hover:border-amber-300 hover:text-amber-600 hover:bg-amber-50'}`}
    >
      <svg width={size === 'sm' ? 14 : 16} height={size === 'sm' ? 14 : 16} viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={pinned ? 1.6 : 1.8}>
        <path d="M12 2l2.2 6.5H21l-5.5 4 2.1 6.5L12 15l-5.6 4 2.1-6.5L3 8.5h6.8z" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
