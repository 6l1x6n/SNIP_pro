import React, { createContext, useContext, useEffect, useState } from 'react'
import { WORKER_BASE, DEVICE_ID, AUTH_EXPIRED_EVENT, authFetch as sharedAuthFetch } from '../utils/api'
import { invalidateCreditsCache } from '../utils/credits'

type User = {
  id: string
  email: string
  full_name?: string | null
  name_can_change_at?: string | null
  created_at?: string | null
  is_admin?: boolean
  is_superuser: boolean
  is_active: boolean
  is_verified: boolean
}

type AuthState = {
  user: User | null
  token: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, full_name?: string) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  updateName: (fullName: string) => Promise<{ name_can_change_at?: string | null }>
  authFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
}

const Ctx = createContext<AuthState>(null as any)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('snip_token'))
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(!!token)

  const fetchMe = async (tok: string) => {
    try {
      const r = await fetch(`${WORKER_BASE}/api/me`, { headers: { Authorization: `Bearer ${tok}`, 'X-Device-Id': DEVICE_ID } })
      if (r.status === 401) {
        // Протухший/битый токен — единственный случай чистого разлогина.
        const d = await r.json().catch(() => ({}) as any)
        console.warn('fetchMe 401:', (d as any)?.error || 'invalid_token')
        setToken(null)
        setUser(null)
        localStorage.removeItem('snip_token')
        invalidateCreditsCache()
        return
      }
      if (!r.ok) {
        // CORS / 5xx / D1-down / Pages-мок: токен НЕ трогаем, сессию держим,
        // пользователь остаётся залогиненным и повторит проверку позже.
        console.warn('fetchMe not ok (token kept):', r.status)
        setUser((u) => u)
        return
      }
      const d = await r.json()
      setUser({
        id: d.uid,
        email: d.email,
        full_name: d.full_name ?? null,
        name_can_change_at: d.name_can_change_at ?? null,
        created_at: d.created_at ?? null,
        is_admin: !!d.is_admin,
        is_superuser: !!d.is_admin,
        is_active: true,
        is_verified: true,
      })
    } catch (e) {
      // Любая сетевая/парсинг-ошибка — токен НЕ трогаем, пользователя НЕ затираем:
      // это не invalid-токен, а недоступность проверки. Сессия переживёт всплеск.
      console.warn('fetchMe error (token kept)', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (token) fetchMe(token)
    else setLoading(false)
  }, [])

  // Мультитаб-синхронизация сессии: logout/login в одной вкладке — везде.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'snip_token') return
      const t = e.newValue
      // Сессия сменилась в другой вкладке — чужой баланс показывать нельзя.
      invalidateCreditsCache()
      if (!t) {
        setToken(null)
        setUser(null)
      } else {
        setToken((prev) => {
          if (prev !== t) fetchMe(t)
          return t
        })
      }
    }
    // Протухший токен заметил фоновый запрос: чистим сессию централизованно.
    const onExpired = () => {
      invalidateCreditsCache()
      setToken(null)
      setUser(null)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
    }
  }, [])

  const login = async (email: string, password: string) => {
    let r: Response
    try {
      r = await fetch(`${WORKER_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify({ email, password }),
      })
    } catch (e) {
      if (e instanceof TypeError) throw new Error('Не удалось соединиться с сервером: ' + WORKER_BASE)
      throw e
    }
    const data = await r.json().catch(() => ({}) as any)
    if (!r.ok) throw new Error(data.error || 'Login failed')
    localStorage.setItem('snip_token', data.token)
    setToken(data.token)
    invalidateCreditsCache()
    // полные данные (имя/кулдаун/админ) догружаем с /api/me
    try {
      const me = await fetch(`${WORKER_BASE}/api/me`, { headers: { Authorization: `Bearer ${data.token}`, 'X-Device-Id': DEVICE_ID } })
      if (me.ok) {
        const d = await me.json()
        setUser({
          id: d.uid, email: d.email, full_name: d.full_name ?? data.full_name ?? null,
          name_can_change_at: d.name_can_change_at ?? null, created_at: d.created_at ?? null,
          is_admin: !!d.is_admin, is_superuser: !!d.is_admin, is_active: true, is_verified: true,
        })
        return
      }
    } catch {}
    setUser({ id: data.uid, email: data.email, full_name: data.full_name ?? null, is_superuser: false, is_active: true, is_verified: true })
  }

  const register = async (email: string, password: string, full_name?: string) => {
    let r: Response
    try {
      r = await fetch(`${WORKER_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify({ email, password, full_name }),
      })
    } catch (e) {
      if (e instanceof TypeError) throw new Error('Не удалось соединиться с сервером: ' + WORKER_BASE)
      throw e
    }
    const data = await r.json().catch(() => ({}) as any)
    if (!r.ok) throw new Error(data.error || 'Register failed')
    localStorage.setItem('snip_token', data.token)
    setToken(data.token)
    invalidateCreditsCache()
    setUser({ id: data.uid, email: data.email, full_name: data.full_name ?? full_name ?? null, is_superuser: false, is_active: true, is_verified: true })
  }

  const logout = () => {
    localStorage.removeItem('snip_token')
    invalidateCreditsCache()
    setToken(null)
    setUser(null)
  }

  const refresh = async () => {
    const t = localStorage.getItem('snip_token')
    if (t) await fetchMe(t)
  }

  const updateName = async (fullName: string) => {
    const t = localStorage.getItem('snip_token')
    if (!t) throw new Error('Войдите, чтобы сменить имя')
    const r = await fetch(`${WORKER_BASE}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Device-Id': DEVICE_ID },
      body: JSON.stringify({ full_name: fullName }),
    })
    const d = await r.json().catch(() => ({}) as any)
    if (!r.ok) throw new Error(d.detail || d.error || 'Не удалось сменить имя')
    setUser((u) => (u ? { ...u, full_name: d.full_name, name_can_change_at: d.name_can_change_at ?? null } : u))
    return { name_can_change_at: d.name_can_change_at ?? null }
  }

  // keep authFetch up to date when token changes
  // Делегирует общему authFetch из utils/api (единая 401-логика + AUTH_EXPIRED_EVENT).
  const ctxAuthFetch = async (input: RequestInfo, init: RequestInit = {}) => sharedAuthFetch(input, init)

  return (
    <Ctx.Provider value={{ user, token, loading, login, register, logout, refresh, updateName, authFetch: ctxAuthFetch }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
