/**
 * Shared PDF opening utility.
 * PDF пакета раздаются статикой из /norms/ (frontend/public/norms).
 */
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
    const r = await fetch('/index/docs.json')
    const docs: Array<{ id: string; file: string; number: string }> = await r.json()
    const doc = docs.find((d) => d.id === String(docId))
    if (!doc?.file) {
      onError?.(`PDF для ${doc?.number ?? docId} не найден в пакете`)
      return
    }
    const url = encodeURI(`/norms/${doc.file}`) + (page ? `#page=${page}` : '')
    const win = window.open(url, '_blank')
    if (!win) {
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noreferrer'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  } catch (e: any) {
    onError?.(`Ошибка PDF: ${e.message || e}`)
  }
}
