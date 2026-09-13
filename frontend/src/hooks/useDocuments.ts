import { useState, useCallback, useEffect } from 'react'
import { fetchCredits } from '../utils/credits'
import { loadIndex } from '../search/engine'

interface UseDocumentsOptions {
  user: any
  filterStatus: string
}

function docType(number_: string): string {
  const up = number_.toUpperCase()
  if (up.startsWith('СН РК') || up.startsWith('СНиП') || up.startsWith('СНИП')) return 'СН РК'
  if (up.startsWith('СП')) return 'СП РК'
  if (up.startsWith('СТ')) return 'СТ РК'
  if (up.startsWith('ТР')) return 'ТР'
  if (up.startsWith('ГОСТ')) return 'ГОСТ'
  return 'СНиП'
}

// Кэш числа чанков на документ: считаем из уже загруженного движком индекса
// (loadIndex сам тянет шарды один раз за сессию и кэш-бастит по builtAt).
let countsCache: Map<number, number> | null = null
let countsPromise: Promise<Map<number, number>> | null = null

async function loadChunkCounts(): Promise<Map<number, number>> {
  if (countsCache) return countsCache
  if (!countsPromise) {
    countsPromise = (async () => {
      const counts = new Map<number, number>()
      try {
        const bundle = await loadIndex()
        for (const c of bundle.chunks) counts.set(c.d, (counts.get(c.d) ?? 0) + 1)
      } catch (e) { console.error('chunk counts', e) }
      countsCache = counts
      return counts
    })()
  }
  return countsPromise
}

export function useDocuments({ filterStatus }: UseDocumentsOptions) {
  const [docs, setDocs] = useState<any[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [collectorLogs] = useState<any[]>([])

  const loadDocs = useCallback(async () => {
    setDocsLoading(true)
    try {
      const bundle = await loadIndex()
      const raw = bundle.docs
      const builtAt = bundle.manifest.builtAt ?? null
      const counts = await loadChunkCounts()

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
        created_at: builtAt,
        last_checked_at: builtAt,
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
      const bundle = await loadIndex()
      const raw = bundle.docs
      const builtAt = bundle.manifest.builtAt ?? null
      const counts = await loadChunkCounts()
      let totalChunks = 0
      counts.forEach((v) => { totalChunks += v })
      setStats({
        total_documents: raw.length,
        active_documents: raw.filter((d) => d.status === 'active').length,
        total_chunks: totalChunks || raw.length,
        builtAt,
        mode: 'static',
      })
    } catch {}
    try { await fetchCredits() } catch {}
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
