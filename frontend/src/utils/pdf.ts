/**
 * Shared PDF opening utility.
 * Opens a document PDF in a new tab, optionally at a specific page.
 */
import { API_BASE, authFetch } from './api'

export async function openPdf(
  docId: string,
  page?: number | null,
  onError?: (msg: string) => void,
): Promise<void> {
  if (docId.startsWith('local:')) {
    onError?.('Локальный PDF недоступен')
    return
  }
  try {
    const r = await authFetch(`${API_BASE}/api/documents/${docId}/pdf`)
    if (!r.ok) {
      const txt = await r.text()
      let msg = txt.slice(0, 160)
      try {
        const j = JSON.parse(txt)
        if (j.detail) msg = j.detail
      } catch {}
      onError?.(`Не удалось открыть PDF: ${msg}`)
      return
    }
    const blob = await r.blob()
    const url = URL.createObjectURL(blob)
    const win = window.open(`${url}${page ? `#page=${page}` : ''}`, '_blank')
    if (!win) {
      // fallback: download
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    setTimeout(() => {
      try { URL.revokeObjectURL(url) } catch {}
    }, 60_000)
  } catch (e: any) {
    onError?.(`Ошибка PDF: ${e.message || e}`)
  }
}
