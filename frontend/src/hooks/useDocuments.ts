import { useState, useCallback, useEffect } from 'react'
import { authFetch, WORKER_BASE } from '../utils/api'

interface UseDocumentsOptions {
  user: any
  filterStatus: string
}

interface StaticDoc {
  id: string
  number: string
  title: string
  status: string
  pages: number
  file: string
}

function docType(number_: string): string {
  const up = number_.toUpperCase()
  if (up.startsWith('СН РК') || up.startsWith('СНиП') || up.startsWith('СНИП')) return 'СН РК'
  if (up.startsWith('СП')) return 'СП РК'
  if (up.startsWith('СТ')) return 'СТ РК'
  return 'СНиП'
}

export function useDocuments({ filterStatus }: UseDocumentsOptions) {
  const [docs, setDocs] = useState<any[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [collectorLogs] = useState<any[]>([])

  const loadDocs = useCallback(async () => {
    setDocsLoading(true)
    try {
      const [docsRes, chunksRes, manifestRes] = await Promise.all([
        fetch('/index/docs.json'),
        fetch('/index/chunks.json'),
        fetch('/index/manifest.json'),
      ])
      const raw: StaticDoc[] = await docsRes.json()
      const chunks: any[] = await chunksRes.json()
      const manifest = await manifestRes.json()

      const counts = new Map<number, number>()
      for (const c of chunks) counts.set(c.d, (counts.get(c.d) ?? 0) + 1)

      let mapped = raw.map((d) => ({
        id: d.id,
        number: d.number,
        title: d.title,
        type: docType(d.number),
        status: d.status,
        pages: d.pages,
        source_url: d.file ? null : null,
        pdf_path: d.file || null,
        chunks_count: counts.get(Number(d.id)) ?? 0,
        created_at: manifest.builtAt,
        last_checked_at: manifest.builtAt,
        effective_date: null,
        publication_date: null,
      }))
      // фильтр статуса на клиенте (как было на сервере)
      if (filterStatus && filterStatus !== 'all') {
        mapped = mapped.filter((d) => d.status === filterStatus)
      }
      setDocs(mapped)
    } catch (e) { console.error(e) }
    finally { setDocsLoading(false) }
  }, [filterStatus])

  const loadStats = useCallback(async () => {
    try {
      const [docsRes, chunksRes] = await Promise.all([fetch('/index/docs.json'), fetch('/index/chunks.json')])
      const raw: StaticDoc[] = await docsRes.json()
      const chunks: any[] = await chunksRes.json()
      setStats({
        total_documents: raw.length,
        active_documents: raw.filter((d) => d.status === 'active').length,
        total_chunks: chunks.length,
        mode: 'static',
      })
    } catch {}
    try { await authFetch(`${WORKER_BASE}/api/credits`) } catch {}
  }, [])

  useEffect(() => { loadStats() }, [loadStats])

  // Listen for reload events
  useEffect(() => {
    const onReloadDocs = () => loadDocs()
    window.addEventListener('snip:reload-docs', onReloadDocs as any)
    return () => window.removeEventListener('snip:reload-docs', onReloadDocs as any)
  }, [loadDocs])

  return {
    docs, setDocs,
    docsLoading,
    stats, setStats,
    collectorLogs,
    loadDocs,
    loadStats,
    loadCollector: () => {},
  }
}
