import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import { API_BASE } from '../utils/api'

const LS_KEY = 'snip_pinned_v1'

export type PinnedItem = {
  document_id: string
  number: string
  title: string
  type?: string | null
  status: string
  pages?: number | null
  source_url?: string | null
  pinned_at: string // ISO
  kind?: 'doc' | 'chunk' // визуально отличимо
  chunk_id?: string | null
  query?: string | null
  text?: string | null
  paragraph?: string | null
  page?: number | null
}

type PinnedState = {
  items: PinnedItem[]
  isPinned: (docId: string) => boolean // doc-level
  isPinnedChunk: (chunkId: string) => boolean
  toggle: (item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => void
  toggleChunk: (item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => void
  add: (item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => void
  addLocalFile: (file: File, anchorRect?: DOMRect | null) => void
  remove: (docId: string) => void
  removeChunk: (chunkId: string) => void
  clear: () => void
  reorder: (from: number, to: number) => void
  count: number
  docsTabRef: React.RefObject<HTMLButtonElement | null> | null
  setDocsTabRef: (r: React.RefObject<HTMLButtonElement | null>) => void
  pinnedButtonRef: React.RefObject<HTMLButtonElement | null> | null
  setPinnedButtonRef: (r: React.RefObject<HTMLButtonElement | null>) => void
  flyTrigger: number
  lastFlyFrom: DOMRect | null
  lastFlyTarget: 'pins' | 'docs'
}

const Ctx = createContext<PinnedState>(null as any)

function loadLS(): PinnedItem[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      return arr.map((it:any)=> ({ kind: it.kind || 'doc', ...it }))
    }
    return []
  } catch { return [] }
}
function saveLS(items: PinnedItem[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)) } catch {}
}

export function PinnedProvider({ children }: { children: React.ReactNode }) {
  const { user, authFetch } = useAuth()
  const [items, setItems] = useState<PinnedItem[]>(() => loadLS())
  const [docsTabRef, setDocsTabRefState] = useState<React.RefObject<HTMLButtonElement | null> | null>(null)
  const [pinnedButtonRef, setPinnedButtonRefState] = useState<React.RefObject<HTMLButtonElement | null> | null>(null)
  const [flyTrigger, setFlyTrigger] = useState(0)
  const [lastFlyFrom, setLastFlyFrom] = useState<DOMRect | null>(null)
  const [lastFlyTarget, setLastFlyTarget] = useState<'pins'|'docs'>('pins')
  const syncedRef = useRef(false)

  const setDocsTabRef = useCallback((r: React.RefObject<HTMLButtonElement | null>) => {
    setDocsTabRefState(r as any)
  }, [])
  const setPinnedButtonRef = useCallback((r: React.RefObject<HTMLButtonElement | null>) => {
    setPinnedButtonRefState(r as any)
  }, [])

  // persist to LS on change
  useEffect(() => { saveLS(items) }, [items])

  // fetch from backend when user logs in
  useEffect(() => {
    if (!user) {
      syncedRef.current = false
      return
    }
    if (syncedRef.current) return
    let cancelled = false
    const sync = async () => {
      try {
        const r = await authFetch(`${API_BASE}/api/pins`)
        if (!r.ok) return
        const data = await r.json() as any[]
        if (cancelled) return
        const remote: PinnedItem[] = data.map((d: any) => ({
          document_id: d.document_id,
          number: d.number,
          title: d.title,
          type: d.type,
          status: d.status,
          pages: d.pages,
          source_url: d.source_url,
          pinned_at: d.pinned_at,
        }))
        // merge: remote wins, keep local-only that not in remote (chunk pins always local)
        setItems(prev => {
          const remoteIds = new Set(remote.map(x => x.document_id))
          const localOnly = prev.filter(p => {
            if ((p.kind||'doc')==='chunk') return true
            return !remoteIds.has(p.document_id)
          })
          if (localOnly.length) {
            localOnly.filter(lo=> (lo.kind||'doc')==='doc' && !lo.document_id.startsWith('local:')).forEach(async lo => {
              try { await authFetch(`${API_BASE}/api/pins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_id: lo.document_id }) }) } catch {}
            })
          }
          const merged = [...remote, ...localOnly]
          // sort by pinned_at desc
          merged.sort((a, b) => new Date(b.pinned_at).getTime() - new Date(a.pinned_at).getTime())
          return merged.slice(0, 50)
        })
        syncedRef.current = true
      } catch {}
    }
    sync()
    return () => { cancelled = true }
  }, [user, authFetch])

  const isPinned = useCallback((docId: string) => items.some(i => (i.kind||'doc')==='doc' && i.document_id === docId), [items])
  const isPinnedChunk = useCallback((chunkId: string) => items.some(i => i.kind==='chunk' && i.chunk_id === chunkId), [items])

  const triggerFly = useCallback((rect?: DOMRect | null, target: 'pins'|'docs' = 'pins') => {
    if (rect) setLastFlyFrom(rect)
    setLastFlyTarget(target)
    setFlyTrigger(v => v + 1)
    const targetEl = target === 'pins' ? pinnedButtonRef?.current : docsTabRef?.current
    if (targetEl) {
      targetEl.classList.remove('pin-pulse')
      void targetEl.offsetWidth
      targetEl.classList.add('pin-pulse')
      setTimeout(() => targetEl.classList.remove('pin-pulse'), 700)
    }
  }, [docsTabRef, pinnedButtonRef])

  const add = useCallback((item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => {
    const kind = (item.kind as string) || 'doc'
    setItems(prev => {
      if (kind==='chunk') {
        if (item.chunk_id && prev.some(p=>p.kind==='chunk' && p.chunk_id===item.chunk_id)) return prev
      } else {
        if (prev.some(p=> (p.kind||'doc')==='doc' && p.document_id===item.document_id)) return prev
      }
      if (prev.length >= 50) return prev
      const next: PinnedItem = { ...item, kind: kind as any, pinned_at: new Date().toISOString() }
      return [next, ...prev]
    })
    triggerFly(anchorRect || null, 'pins')
    if (kind!=='chunk') {
      const isLocal = item.document_id.startsWith('local:')
      if (user && !isLocal) {
        authFetch(`${API_BASE}/api/pins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_id: item.document_id }) }).catch(() => {})
      }
    }
  }, [user, authFetch, triggerFly])

  const toggleChunk = useCallback((item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => {
    const chunkId = item.chunk_id
    if (!chunkId) return
    setItems(prev => {
      const exists = prev.some(p=>p.kind==='chunk' && p.chunk_id===chunkId)
      if (exists) return prev.filter(p=> !(p.kind==='chunk' && p.chunk_id===chunkId))
      if (prev.length>=50) return prev
      triggerFly(anchorRect || null, 'pins')
      const next: PinnedItem = { ...item, kind: 'chunk', pinned_at: new Date().toISOString() }
      return [next, ...prev]
    })
  }, [triggerFly])

  const removeChunk = useCallback((chunkId: string) => {
    setItems(prev => prev.filter(p=> !(p.kind==='chunk' && p.chunk_id===chunkId)))
  }, [])

  const addLocalFile = useCallback((file: File, anchorRect?: DOMRect | null) => {
    const id = `local:${Date.now()}:${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`
    const item: PinnedItem = {
      document_id: id,
      number: file.name.replace(/\.pdf$/i,''),
      title: `Локальный файл: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB) — не загружен на сервер`,
      type: 'PDF',
      status: 'draft',
      pages: null,
      source_url: null,
      pinned_at: new Date().toISOString(),
    }
    setItems(prev => {
      if (prev.length >= 50) return prev
      return [item, ...prev]
    })
    triggerFly(anchorRect || null, 'pins')
  }, [triggerFly])

  const remove = useCallback((docId: string) => {
    setItems(prev => prev.filter(p => !((p.kind||'doc')==='doc' && p.document_id === docId)))
    const isLocal = docId.startsWith('local:')
    if (user && !isLocal) {
      authFetch(`${API_BASE}/api/pins/${docId}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [user, authFetch])

  const toggle = useCallback((item: Omit<PinnedItem, 'pinned_at'>, anchorRect?: DOMRect | null) => {
    const kind = (item.kind as string) || 'doc'
    if (kind==='chunk') { toggleChunk(item as any, anchorRect); return }
    setItems(prev => {
      const exists = prev.some(p => (p.kind||'doc')==='doc' && p.document_id === item.document_id)
      if (exists) {
        const isLocal = item.document_id.startsWith('local:')
        if (user && !isLocal) authFetch(`${API_BASE}/api/pins/${item.document_id}`, { method: 'DELETE' }).catch(() => {})
        return prev.filter(p => !((p.kind||'doc')==='doc' && p.document_id === item.document_id))
      } else {
        if (prev.length >= 50) return prev
        triggerFly(anchorRect || null, 'pins')
        const isLocal = item.document_id.startsWith('local:')
        if (user && !isLocal) authFetch(`${API_BASE}/api/pins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document_id: item.document_id }) }).catch(() => {})
        const next: PinnedItem = { ...item, kind: 'doc' as any, pinned_at: new Date().toISOString() }
        return [next, ...prev]
      }
    })
  }, [user, authFetch, triggerFly, toggleChunk] as any)

  const reorder = useCallback((from: number, to: number) => {
    setItems(prev => {
      if (from === to) return prev
      const arr = [...prev]
      const [moved] = arr.splice(from, 1)
      arr.splice(to, 0, moved)
      return arr
    })
  }, [])

  const clear = useCallback(() => {
    setItems([])
    if (user) authFetch(`${API_BASE}/api/pins`, { method: 'DELETE' }).catch(() => {})
  }, [user, authFetch])

  return (
    <Ctx.Provider value={{ items, isPinned, isPinnedChunk, toggle, toggleChunk, add, addLocalFile, remove, removeChunk, clear, reorder, count: items.length, docsTabRef, setDocsTabRef, pinnedButtonRef, setPinnedButtonRef, flyTrigger, lastFlyFrom, lastFlyTarget } as any}>
      {children}
    </Ctx.Provider>
  )
}

export function usePinned() {
  return useContext(Ctx)
}
