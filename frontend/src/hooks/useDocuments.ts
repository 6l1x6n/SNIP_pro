import { useState, useCallback, useEffect } from 'react'
import { API_BASE, authFetch } from '../utils/api'

interface UseDocumentsOptions {
  user: any
  filterStatus: string
}

export function useDocuments({ user, filterStatus }: UseDocumentsOptions) {
  const [docs, setDocs] = useState<any[]>([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [collectorLogs, setCollectorLogs] = useState<any[]>([])

  const loadDocs = useCallback(async () => {
    setDocsLoading(true)
    try {
      const q = new URLSearchParams()
      if (filterStatus) q.set('status', filterStatus)
      const r = await authFetch(`${API_BASE}/api/documents?${q.toString()}`)
      const data = await r.json()
      setDocs(data)
    } catch (e) { console.error(e) }
    finally { setDocsLoading(false) }
  }, [filterStatus])

  const loadStats = useCallback(async () => {
    try {
      const r = await authFetch(`${API_BASE}/api/stats`)
      setStats(await r.json())
    } catch {
      try {
        const r = await fetch(`${API_BASE}/api/stats`)
        setStats(await r.json())
      } catch {}
    }
  }, [])

  const loadCollector = useCallback(async () => {
    try {
      const r = await authFetch(`${API_BASE}/api/admin/collector/logs`)
      if (r.status === 401 || r.status === 403) { setCollectorLogs([]); return }
      setCollectorLogs(await r.json())
      const s = await authFetch(`${API_BASE}/api/stats`).then(r => r.json())
      setStats(s)
    } catch {}
  }, [])

  // Load stats on user change
  useEffect(() => { loadStats() }, [user, loadStats])

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
    loadCollector,
  }
}
