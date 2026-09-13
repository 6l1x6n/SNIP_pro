import { useState, useCallback, useEffect } from 'react'
import { fetchCredits } from '../utils/credits'

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
  if (up.startsWith('ТР')) return 'ТР'
  if (up.startsWith('ГОСТ')) return 'ГОСТ'
  return 'СНиП'
}

// Кэш числа чанков на документ: шарды чанков тяжёлые (~30МБ), грузим один раз за сессию.
// HTTP-кэш Pages всё равно вернёт их из disk-cache при повторном визите.
let countsCache: Map<number, number> | null = null
let countsPromise: Promise<Map<number, number>> | null = null

async function loadChunkCounts(): Promise<Map<number, number>> {
  if (countsCache) return countsCache
  if (!countsPromise) {
    countsPromise = (async () => {
      const counts = new Map<number, number>()
      try {
        // сначала пробуем классический одиночный файл (обратная совместимость)
        const r = await fetch('/index/chunks.json')
        if (r.ok) {
          const chunks: any[] = await r.json()
          for (const c of chunks) counts.set(c.d, (counts.get(c.d) ?? 0) + 1)
          countsCache = counts
          return counts
        }
      } catch {}
      // иначе — шарды по manifest.shards.chunks
      try {
        const m = await (await fetch('/index/manifest.json')).json()
        const n = m?.shards?.chunks ?? 1
        const parts = await Promise.all(
          Array.from({ length: n }, (_, k) =>
            fetch(`/index/chunks_${k}.json`).then((r) => (r.ok ? r.json() : []))
          )
        )
        for (const arr of parts) {
          for (const c of arr as any[]) counts.set(c.d, (counts.get(c.d) ?? 0) + 1)
        }
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
      const [docsRes, manifestRes] = await Promise.all([
        fetch('/index/docs.json'),
        fetch('/index/manifest.json').catch(() => null),
      ])
      const raw: StaticDoc[] = await docsRes.json()
      let manifest: any = null
      try { manifest = manifestRes ? await manifestRes.json() : null } catch {}
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
        created_at: manifest?.builtAt ?? null,
        last_checked_at: manifest?.builtAt ?? null,
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
      const [docsRes, manifestRes] = await Promise.all([fetch('/index/docs.json'), fetch('/index/manifest.json').catch(() => null)])
      const raw: StaticDoc[] = await docsRes.json()
      let builtAt: string | null = null
      try { const m = manifestRes ? await manifestRes.json() : null; builtAt = m?.builtAt ?? m?.built_at ?? null } catch {}
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
