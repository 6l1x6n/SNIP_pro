/**
 * pdf.ts — поиск документа и резолвинг URL PDF.
 * Приоритет: R2 через воркер (/api/norms/:file) → статика Pages (/norms/:file).
 */
import { WORKER_BASE } from './api'

export interface DocInfoLite {
  id: string
  number: string
  title: string
  pages: number
  file: string
}

let docsCache: DocInfoLite[] | null = null
const headCache = new Map<string, boolean>()

export async function findDoc(docId: string): Promise<DocInfoLite | null> {
  try {
    if (!docsCache) {
      const r = await fetch('/index/docs.json')
      docsCache = (await r.json()) as DocInfoLite[]
    }
    return docsCache.find((d) => d.id === String(docId)) ?? null
  } catch {
    return null
  }
}

async function exists(url: string): Promise<boolean> {
  const cached = headCache.get(url)
  if (cached !== undefined) return cached
  try {
    const r = await fetch(url, { method: 'HEAD' })
    headCache.set(url, r.ok)
    return r.ok
  } catch {
    headCache.set(url, false)
    return false
  }
}

/** Статика Pages сначала (бесплатно, без расхода кредитов воркера); R2 через воркер — только фолбэк. */
export async function resolvePdfUrl(file: string): Promise<string> {
  if (!/\.pdf$/i.test(file)) {
    throw new Error(`«${file}» — не PDF, доступен только текст в поиске`)
  }
  const enc = encodeURIComponent(file)
  const staticUrl = encodeURI(`/norms/${file}`)
  if (await exists(staticUrl)) return staticUrl
  if (WORKER_BASE && (await exists(`${WORKER_BASE}/api/norms/${enc}`))) {
    return `${WORKER_BASE}/api/norms/${enc}`
  }
  throw new Error(`PDF «${file}» не найден ни в облаке, ни в пакете`)
}
