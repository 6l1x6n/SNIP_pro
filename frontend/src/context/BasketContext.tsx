import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { isPdf } from '../utils/fileType'

export type Basket = {
  id: string
  name: string
  color: string // hex
  created_at: string
  order: number
}

export type LocalDoc = {
  id: string // local:...
  name: string
  size: number
  url: string // objectURL
  basketId: string | null
  created_at: string
}

type BasketState = {
  baskets: Basket[]
  assignments: Record<string, string> // document_id -> basketId
  assignmentAt: Record<string, string> // document_id -> ISO date
  activeBasketId: string | null // null = all
  setActiveBasketId: (id: string | null) => void
  createBasket: (name: string, color: string) => void
  deleteBasket: (id: string) => void
  updateBasket: (id: string, patch: Partial<Pick<Basket,'name'|'color'>>) => void
  moveToBasket: (docId: string, basketId: string | null) => void
  getBasketForDoc: (docId: string) => Basket | null
  isDragging: boolean
  setIsDragging: (v: boolean) => void
  draggedDocId: string | null
  setDraggedDocId: (id: string | null) => void
  localDocs: LocalDoc[]
  addLocalFiles: (files: File[], basketId?: string | null) => string[] // returns ids
  removeLocalDoc: (id: string) => void
  retentionDays: number
  setRetentionDays: (n: number) => void
}

const Ctx = createContext<BasketState>(null as any)

const LS_BASKETS = 'snip_baskets_v2'
const LS_ASSIGN = 'snip_basket_assign_v2'
const LS_ASSIGN_AT = 'snip_basket_assign_at_v2'
const LS_RETENTION = 'snip_retention_days'

function loadBaskets(): Basket[] {
  try {
    const raw = localStorage.getItem(LS_BASKETS)
    if (!raw) return [
      { id: 'inbox', name: 'Входящие', color: '#3b82f6', created_at: new Date().toISOString(), order: 0 },
      { id: 'fav', name: 'Избранное', color: '#f59e0b', created_at: new Date().toISOString(), order: 1 },
    ]
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length) return arr
    return [
      { id: 'inbox', name: 'Входящие', color: '#3b82f6', created_at: new Date().toISOString(), order: 0 },
    ]
  } catch {
    return [
      { id: 'inbox', name: 'Входящие', color: '#3b82f6', created_at: new Date().toISOString(), order: 0 },
    ]
  }
}
function loadAssign(): Record<string,string> {
  try {
    const raw = localStorage.getItem(LS_ASSIGN)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    // migrate old string -> object with assignedAt
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      // if values are strings, keep as is (new format also strings)
      return obj
    }
    return {}
  } catch { return {} }
}
function loadAssignAt(): Record<string,string> {
  try {
    const raw = localStorage.getItem(LS_ASSIGN_AT)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch { return {} }
}
function loadRetention(): number {
  try {
    const v = localStorage.getItem(LS_RETENTION)
    if (!v) return 30
    const n = parseInt(v,10)
    return Number.isFinite(n) && n>=1 && n<=365 ? n : 30
  } catch { return 30 }
}

export function BasketProvider({ children }: { children: React.ReactNode }) {
  const [baskets, setBaskets] = useState<Basket[]>(() => loadBaskets())
  const [assignments, setAssignments] = useState<Record<string,string>>(() => loadAssign())
  const [assignmentAt, setAssignmentAt] = useState<Record<string,string>>(() => loadAssignAt())
  const [activeBasketId, setActiveBasketId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [draggedDocId, setDraggedDocId] = useState<string | null>(null)
  const [localDocs, setLocalDocs] = useState<LocalDoc[]>([])
  const [retentionDays, setRetentionDaysRaw] = useState<number>(() => loadRetention())

  useEffect(() => {
    try { localStorage.setItem(LS_BASKETS, JSON.stringify(baskets)) } catch {}
  }, [baskets])
  useEffect(() => {
    try { localStorage.setItem(LS_ASSIGN, JSON.stringify(assignments)) } catch {}
  }, [assignments])
  useEffect(() => {
    try { localStorage.setItem(LS_ASSIGN_AT, JSON.stringify(assignmentAt)) } catch {}
  }, [assignmentAt])
  useEffect(() => {
    try { localStorage.setItem(LS_RETENTION, String(retentionDays)) } catch {}
  }, [retentionDays])

  // migrate old assignments without assignedAt
  useEffect(() => {
    const missing = Object.keys(assignments).filter(id=>!assignmentAt[id])
    if (missing.length) {
      const now = new Date().toISOString()
      setAssignmentAt(prev=>{
        const n={...prev}
        missing.forEach(id=>{ if(!n[id]) n[id]=now })
        return n
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const createBasket = useCallback((name: string, color: string) => {
    const id = `b-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
    const b: Basket = { id, name: name.trim() || 'Новая корзина', color: color || '#64748b', created_at: new Date().toISOString(), order: baskets.length }
    setBaskets(prev => [...prev, b])
  }, [baskets.length])

  const deleteBasket = useCallback((id: string) => {
    const toRemove = Object.entries(assignments).filter(([,bid])=>bid===id).map(([docId])=>docId)
    setBaskets(prev => prev.filter(b => b.id !== id))
    setAssignments(prev => {
      const next: Record<string,string> = {}
      for (const [docId, bid] of Object.entries(prev)) {
        if (bid !== id) next[docId] = bid
      }
      return next
    })
    setAssignmentAt(prev => {
      const next = { ...prev }
      toRemove.forEach(docId=>delete next[docId])
      return next
    })
    setActiveBasketId(prev => prev === id ? null : prev)
  }, [assignments])

  const updateBasket = useCallback((id: string, patch: Partial<Pick<Basket,'name'|'color'>>) => {
    setBaskets(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b))
  }, [])

  const setRetentionDays = useCallback((n: number) => {
    const v = Math.max(1, Math.min(365, Math.round(n) || 30))
    setRetentionDaysRaw(v)
  }, [])

  const moveToBasket = useCallback((docId: string, basketId: string | null) => {
    const now = new Date().toISOString()
    setAssignments(prev => {
      const next = { ...prev }
      if (basketId === null) delete next[docId]
      else next[docId] = basketId
      return next
    })
    setAssignmentAt(prev => {
      const next = { ...prev }
      if (basketId === null) delete next[docId]
      else next[docId] = now
      return next
    })
  }, [])

  const getBasketForDoc = useCallback((docId: string) => {
    const bid = assignments[docId]
    if (!bid) return null
    return baskets.find(b => b.id === bid) || null
  }, [assignments, baskets])

  const addLocalFiles = useCallback((files: File[], basketId: string | null = null) => {
    const ids: string[] = []
    const targetBasket = basketId ?? activeBasketId
    const now = new Date().toISOString()
    const newDocs: LocalDoc[] = []
    for (const f of files) {
      if (!isPdf(f)) continue
      const id = `local:${Date.now()}-${Math.random().toString(36).slice(2,6)}:${f.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`
      const url = URL.createObjectURL(f)
      const ld: LocalDoc = { id, name: f.name, size: f.size, url, basketId: targetBasket, created_at: now }
      newDocs.push(ld)
      ids.push(id)
    }
    if (newDocs.length) {
      setLocalDocs(prev => [...newDocs, ...prev])
      setAssignments(prev => {
        const next = { ...prev }
        for (const d of newDocs) if (d.basketId) next[d.id] = d.basketId
        return next
      })
      setAssignmentAt(prev => {
        const next = { ...prev }
        for (const d of newDocs) if (d.basketId) next[d.id] = now
        return next
      })
    }
    return ids
  }, [activeBasketId])

  const removeLocalDoc = useCallback((id: string) => {
    setLocalDocs(prev => {
      const found = prev.find(d=>d.id===id)
      if (found) try { URL.revokeObjectURL(found.url) } catch {}
      return prev.filter(d=>d.id!==id)
    })
    setAssignments(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setAssignmentAt(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // revoke on unload
  useEffect(() => {
    const onBefore = () => {
      localDocs.forEach(d=>{ try{ URL.revokeObjectURL(d.url)}catch{} })
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [localDocs])

  // listen for external basket-move events (from TrashBar etc)
  useEffect(() => {
    const onMove = (e: Event) => {
      const detail = (e as CustomEvent).detail as { docId: string, basketId: string | null }
      if (detail?.docId !== undefined) {
        moveToBasket(detail.docId, detail.basketId ?? null)
        if (detail.docId.startsWith('local:')) {
          setLocalDocs(prev => prev.map(d=> d.id===detail.docId ? { ...d, basketId: detail.basketId } : d))
        }
      }
    }
    window.addEventListener('snip:basket-move' as any, onMove as any)
    return () => window.removeEventListener('snip:basket-move' as any, onMove as any)
  }, [moveToBasket])

  // retention cleanup: глобально X дней в корзине → безвозвратно удалять док из БД (local — просто убрать)
  useEffect(() => {
    const check = () => {
      const now = Date.now()
      const ms = retentionDays * 24*60*60*1000
      for (const [docId, at] of Object.entries(assignmentAt)) {
        if (!at) continue
        const age = now - new Date(at).getTime()
        if (age > ms) {
          if (docId.startsWith('local:')) {
            removeLocalDoc(docId)
          } else {
            window.dispatchEvent(new CustomEvent('snip:retention-expired', { detail: { docId } }))
            // сразу скрыть из корзины
            setAssignments(prev=>{ const n={...prev}; delete n[docId]; return n})
            setAssignmentAt(prev=>{ const n={...prev}; delete n[docId]; return n})
          }
        }
      }
    }
    check()
    const id = setInterval(check, 60*60*1000)
    return ()=>clearInterval(id)
  }, [assignmentAt, retentionDays, removeLocalDoc])

  return (
    <Ctx.Provider value={{ baskets, assignments, assignmentAt, activeBasketId, setActiveBasketId, createBasket, deleteBasket, updateBasket, moveToBasket, getBasketForDoc, isDragging, setIsDragging, draggedDocId, setDraggedDocId, localDocs, addLocalFiles, removeLocalDoc, retentionDays, setRetentionDays }}>
      {children}
    </Ctx.Provider>
  )
}

export function useBaskets() {
  return useContext(Ctx)
}
