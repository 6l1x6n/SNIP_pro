// @ts-nocheck — TODO: fix TypeScript errors incrementally
import React, { useState, useEffect } from 'react'
import {
  loadFavorites, removeFavorite, updateFavoriteNote, clearFavorites,
  favoritesToMarkdown, FAVORITES_EVENT, type Favorite,
} from '../utils/favorites'
import { downloadAsFile, sanitizeQuote, truncateSmart, formatParagraph } from '../utils/exportUtils'
import { Icon, type IconName } from './Icon'

const KIND_ICON: Record<string, IconName> = { answer: 'lightbulb', fragment: 'file', page: 'list' }

export function FavoritesSection({ onOpenPdf, user }: {
  onOpenPdf: (docId: string, page?: number, quote?: string | null) => void
  user?: any
}) {
  const [list, setList] = useState<Favorite[]>(() => loadFavorites())
  const [filter, setFilter] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editNote, setEditNote] = useState('')

  useEffect(() => {
    const onUpdate = () => setList(loadFavorites())
    window.addEventListener(FAVORITES_EVENT, onUpdate)
    return () => window.removeEventListener(FAVORITES_EVENT, onUpdate)
  }, [])

  const shown = filter.trim()
    ? list.filter((f) =>
        `${f.query || ''} ${f.answer || ''} ${f.text || ''} ${f.quote || ''} ${f.note || ''} ${f.documentNumber || ''}`.toLowerCase().includes(filter.trim().toLowerCase())
      )
    : list

  const startEdit = (f: Favorite) => { setEditingId(f.id); setEditNote(f.note || '') }
  const saveEdit = () => {
    if (!editingId) return
    setList(updateFavoriteNote(editingId, editNote.trim()))
    setEditingId(null)
    setEditNote('')
  }

  const basis = (f: Favorite) => {
    const p = formatParagraph(f.paragraph)
    return [f.documentNumber, p !== '—' ? p : '', f.page != null ? `стр. ${f.page}` : ''].filter(Boolean).join(', ')
  }

  return (
    <div className="space-y-4">
      {!user && (
        <div className="rounded-2xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-4 text-xs text-blue-800 dark:text-blue-300">
          Избранное хранится в этом браузере. Войдите, чтобы не потерять подборку при смене устройства.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-md:basis-full">
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"><Icon name="search" size={14} /></div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Поиск по избранному…" className="input pl-9 py-2 max-md:py-2.5 max-md:text-base" />
        </div>
        {list.length > 0 && (
          <>
            <button onClick={() => downloadAsFile(favoritesToMarkdown(list), 'snippy_favorites.md', 'text/markdown')} className="btn btn-sm btn-secondary py-2 max-md:flex-1"><Icon name="download" size={13} /> Markdown</button>
            <button onClick={() => { if (window.confirm('Удалить всё избранное?')) { clearFavorites(); setList([]) } }} className="btn btn-sm btn-ghost py-2 text-slate-400 hover:text-red-500">Очистить</button>
          </>
        )}
      </div>

      {list.length === 0 && (
        <div className="text-center py-12 card border-dashed">
          <div className="w-11 h-11 mx-auto mb-3 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center"><Icon name="star" size={20} /></div>
          <div className="font-semibold text-slate-900 dark:text-white text-sm">Пока пусто</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">Нажимайте «В избранное» на ответах, фрагментах и страницах PDF — всё сохранится здесь с вашими заметками.</div>
        </div>
      )}

      {list.length > 0 && shown.length === 0 && (
        <div className="text-center py-8 text-sm text-slate-400">Ничего не найдено по «{filter}»</div>
      )}

      {shown.map((f) => (
        <div key={f.id} className="card p-4">
          <div className="flex items-start gap-2">
            <span className="w-8 h-8 shrink-0 mt-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 inline-flex items-center justify-center"><Icon name={KIND_ICON[f.kind] || 'file'} size={15} /></span>
            <div className="flex-1 min-w-0">
              {f.kind === 'answer' && (
                <>
                  <div className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={f.query || 'Ответ'}>{f.query || 'Ответ'}</div>
                  {f.answer && <p className="text-[13px] text-slate-700 dark:text-slate-200 mt-1.5 whitespace-pre-wrap line-clamp-4">{f.answer}</p>}
                  <div className="text-[11px] text-slate-400 mt-1.5 truncate" title={basis(f) || undefined}>{basis(f) || '—'}</div>
                </>
              )}
              {f.kind === 'fragment' && (
                <>
                  <div className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={`${f.documentNumber || 'Фрагмент'}${(() => { const p = formatParagraph(f.paragraph); return p !== '—' ? ` · ${p}` : '' })()}${f.page != null ? ` · стр. ${f.page}` : ''}`}>{f.documentNumber || 'Фрагмент'} {(() => { const p = formatParagraph(f.paragraph); return p !== '—' ? <span className="font-normal text-slate-500">· {p}</span> : null })()} {f.page != null ? <span className="font-normal text-slate-500">· стр. {f.page}</span> : null}</div>
                  {f.query && <div className="text-[11px] text-slate-400 mt-0.5 truncate" title={f.query}>По запросу: {f.query}</div>}
                  {f.text && <p className="text-[13px] text-slate-700 dark:text-slate-200 mt-1.5 line-clamp-4 overflow-hidden max-w-full [overflow-wrap:anywhere]">{truncateSmart(sanitizeQuote(f.text), 500)}</p>}
                </>
              )}
              {f.kind === 'page' && (
                <>
                  <div className="font-semibold text-slate-900 dark:text-white text-sm truncate" title={`${f.documentNumber || 'Страница'}${f.page != null ? ` · стр. ${f.page}` : ''}`}>{f.documentNumber || 'Страница'} {f.page != null ? <span className="font-normal text-slate-500">· стр. {f.page}</span> : null}</div>
                  {f.documentTitle && <div className="text-[11px] text-slate-400 mt-0.5 truncate" title={f.documentTitle}>{f.documentTitle}</div>}
                </>
              )}

              {editingId === f.id ? (
                <div className="mt-2.5 flex items-center gap-2">
                  <input value={editNote} onChange={(e) => setEditNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveEdit()} placeholder="Заметка…" maxLength={200} className="input flex-1 min-w-0 py-1.5 text-sm" autoFocus />
                  <button onClick={saveEdit} className="btn btn-sm btn-primary py-1.5">ОК</button>
                  <button onClick={() => setEditingId(null)} className="icon-btn w-8 h-8"><Icon name="close" size={14} /></button>
                </div>
              ) : f.note ? (
                <button onClick={() => startEdit(f)} title="Редактировать заметку" className="mt-2 flex items-center gap-1.5 text-left text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl px-3 py-1.5 w-full min-w-0"><Icon name="edit" size={12} className="shrink-0" /> <span className="min-w-0 line-clamp-2 break-words">{f.note}</span></button>
              ) : null}

              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs">
                {f.documentId && (
                  <button onClick={() => onOpenPdf(f.documentId, f.page ?? 1, f.kind === 'fragment' ? (f.text || f.quote || null) : (f.quote || null))} className="btn btn-sm btn-secondary py-1.5 max-md:py-2 max-md:order-first max-md:w-full"><Icon name="file" size={13} /> Открыть PDF{f.page != null ? ` · стр. ${f.page}` : ''}</button>
                )}
                {editingId !== f.id && (
                  <button onClick={() => startEdit(f)} className="btn btn-sm btn-ghost py-1.5 max-md:py-1 text-slate-400">{f.note ? <><Icon name="edit" size={12} /> Заметка</> : <><Icon name="plus" size={12} /> Заметка</>}</button>
                )}
                <button onClick={() => setList(removeFavorite(f.id))} className="ml-auto max-md:ml-0 inline-flex items-center gap-1 py-1.5 max-md:py-1 text-slate-400 hover:text-red-500 transition"><Icon name="trash" size={12} /> Удалить</button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
