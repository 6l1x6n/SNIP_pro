// Избранное: сохранённые ответы, фрагменты норм и страницы PDF.
// Первая итерация — локально (localStorage), гостям тоже работает.

import { formatParagraph } from './exportUtils'

export type FavoriteKind = 'answer' | 'fragment' | 'page'

export interface Favorite {
  id: string
  kind: FavoriteKind
  createdAt: number
  note: string
  query?: string
  answer?: string
  quote?: string
  text?: string
  chunkId?: string
  documentId?: string
  documentNumber?: string
  documentTitle?: string
  paragraph?: string
  page?: number
}

export const FAVORITES_KEY = 'snip_favorites'
export const FAVORITES_EVENT = 'snip:favorites'
export const FAVORITES_MAX = 50

function notify() {
  try { window.dispatchEvent(new Event(FAVORITES_EVENT)) } catch {}
}

export function favoriteId(f: Omit<Favorite, 'id' | 'createdAt' | 'note'> & { note?: string }): string {
  if (f.kind === 'answer') return `a:${f.query || ''}|${f.documentNumber || ''}|${f.page ?? ''}`
  if (f.kind === 'fragment') return `f:${f.chunkId || ''}|${f.query || ''}`
  return `p:${f.documentId || ''}|${f.page ?? ''}`
}

export function loadFavorites(): Favorite[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x.id === 'string' && (x.kind === 'answer' || x.kind === 'fragment' || x.kind === 'page'))
      .map((x) => ({
        id: x.id,
        kind: x.kind,
        createdAt: Number(x.createdAt) || 0,
        note: typeof x.note === 'string' ? x.note : '',
        query: typeof x.query === 'string' ? x.query : undefined,
        answer: typeof x.answer === 'string' ? x.answer : undefined,
        quote: typeof x.quote === 'string' ? x.quote : undefined,
        text: typeof x.text === 'string' ? x.text : undefined,
        chunkId: typeof x.chunkId === 'string' ? x.chunkId : undefined,
        documentId: typeof x.documentId === 'string' ? x.documentId : undefined,
        documentNumber: typeof x.documentNumber === 'string' ? x.documentNumber : undefined,
        documentTitle: typeof x.documentTitle === 'string' ? x.documentTitle : undefined,
        paragraph: x.paragraph != null ? String(x.paragraph) : undefined,
        page: x.page != null ? Number(x.page) : undefined,
      }))
      .slice(0, FAVORITES_MAX)
  } catch {
    return []
  }
}

function save(list: Favorite[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list.slice(0, FAVORITES_MAX)))
  } catch {}
  notify()
}

export function isFavorite(id: string): boolean {
  return loadFavorites().some((f) => f.id === id)
}

/** Добавить (дедуп по id, свежие сверху). Возвращает новый список. */
export function addFavorite(entry: Omit<Favorite, 'id' | 'createdAt' | 'note'> & { note?: string }): Favorite[] {
  const id = favoriteId(entry)
  const next: Favorite[] = [
    { ...entry, id, createdAt: Date.now(), note: entry.note || '' },
    ...loadFavorites().filter((x) => x.id !== id),
  ].slice(0, FAVORITES_MAX)
  save(next)
  return next
}

export function removeFavorite(id: string): Favorite[] {
  const next = loadFavorites().filter((x) => x.id !== id)
  save(next)
  return next
}

export function updateFavoriteNote(id: string, note: string): Favorite[] {
  const next = loadFavorites().map((x) => (x.id === id ? { ...x, note } : x))
  save(next)
  return next
}

export function clearFavorites() {
  try { localStorage.removeItem(FAVORITES_KEY) } catch {}
  notify()
}

export function favoritesToMarkdown(list: Favorite[]): string {
  const lines: string[] = ['# Избранное — snippy.llm', '']
  for (const f of list) {
    if (f.kind === 'answer') {
      lines.push(`## 💡 ${f.query || 'Ответ'}`)
      if (f.answer) lines.push('', f.answer)
      if (f.quote) lines.push('', `> ${f.quote}`)
      const _fp = formatParagraph(f.paragraph)
      lines.push('', `Основание: ${[f.documentNumber, _fp !== '—' ? _fp : '', f.page != null ? `стр. ${f.page}` : ''].filter(Boolean).join(', ') || '—'}`)
    } else if (f.kind === 'fragment') {
      const _qp = formatParagraph(f.paragraph)
      lines.push(`## 📄 ${f.documentNumber || 'Фрагмент'}${_qp !== '—' ? `, ${_qp}` : ''}${f.page != null ? `, стр. ${f.page}` : ''}`)
      if (f.query) lines.push(`По запросу: ${f.query}`)
      if (f.text) lines.push('', f.text.length > 800 ? f.text.slice(0, 800) + '…' : f.text)
    } else {
      lines.push(`## 📑 ${f.documentNumber || f.documentId || 'Страница'}${f.page != null ? `, стр. ${f.page}` : ''}`)
      if (f.documentTitle) lines.push(f.documentTitle)
    }
    if (f.note) lines.push('', `Заметка: ${f.note}`)
    lines.push('', '---', '')
  }
  lines.push('*Экспортировано из snippy.llm*')
  return lines.join('\n')
}
