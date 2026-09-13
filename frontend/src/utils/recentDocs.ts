// Недавние документы: последние открытые PDF (для быстрого возврата).
// Пишет PdfViewerModal при открытии (единая воронка), читает SearchView (empty-state).

export interface RecentDoc {
  docId: string
  number: string
  title: string
  page: number
  at: number
}

export const RECENT_DOCS_KEY = 'snip_recent_docs'
export const RECENT_DOCS_EVENT = 'snip:recent-docs'
export const RECENT_DOCS_MAX = 8

function notify() {
  try { window.dispatchEvent(new Event(RECENT_DOCS_EVENT)) } catch {}
}

export function loadRecentDocs(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(RECENT_DOCS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((x) => x && typeof x.docId === 'string')
      .map((x) => ({
        docId: x.docId,
        // trim: старые записи могли сохраниться с ведущими пробелами из метаданных
        number: typeof x.number === 'string' ? x.number.trim() : x.docId,
        title: typeof x.title === 'string' ? x.title.trim() : '',
        page: Number(x.page) > 0 ? Number(x.page) : 1,
        at: Number(x.at) || 0,
      }))
      .slice(0, RECENT_DOCS_MAX)
  } catch {
    return []
  }
}

function save(list: RecentDoc[]) {
  try {
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(list.slice(0, RECENT_DOCS_MAX)))
  } catch {}
  notify()
}

/** Добавить/обновить запись (дедуп по docId, свежие сверху). */
export function pushRecentDoc(entry: Omit<RecentDoc, 'at'>): RecentDoc[] {
  const clean = {
    ...entry,
    number: (entry.number || '').trim() || entry.docId,
    title: (entry.title || '').trim(),
  }
  const next: RecentDoc[] = [
    { ...clean, at: Date.now() },
    ...loadRecentDocs().filter((x) => x.docId !== entry.docId),
  ].slice(0, RECENT_DOCS_MAX)
  save(next)
  return next
}

export function removeRecentDoc(docId: string): RecentDoc[] {
  const next = loadRecentDocs().filter((x) => x.docId !== docId)
  save(next)
  return next
}

export function clearRecentDocs() {
  try { localStorage.removeItem(RECENT_DOCS_KEY) } catch {}
  notify()
}
