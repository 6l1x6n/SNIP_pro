import React, { createContext, useContext, useEffect, useState } from 'react'
import { WORKER_BASE, DEVICE_ID } from '../utils/api'

type User = {
  id: string
  email: string
  full_name?: string
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
      if (!r.ok) throw new Error('me failed')
      const d = await r.json()
      setUser({ id: d.uid, email: d.email, is_superuser: false, is_active: true, is_verified: true })
    } catch (e) {
      // сеть недоступна — не разлогиниваем, просто оставляем токен, пользователь попробует позже
      if (e instanceof TypeError) {
        console.warn('fetchMe network error', e)
        setUser(null)
      } else {
        setToken(null)
        setUser(null)
        localStorage.removeItem('snip_token')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (token) fetchMe(token)
    else setLoading(false)
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
    setUser({ id: data.uid, email: data.email, is_superuser: false, is_active: true, is_verified: true })
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
    setUser({ id: data.uid, email: data.email, is_superuser: false, is_active: true, is_verified: true })
  }

  const logout = () => {
    localStorage.removeItem('snip_token')
    setToken(null)
    setUser(null)
  }

  // keep authFetch up to date when token changes
  const ctxAuthFetch = async (input: RequestInfo, init: RequestInit = {}) => {
    const headers: any = { ...(init?.headers || {}) }
    const t = localStorage.getItem('snip_token')
    if (t) headers['Authorization'] = `Bearer ${t}`
    headers['X-Device-Id'] = DEVICE_ID
    return fetch(input, { ...init, headers })
  }

  return (
    <Ctx.Provider value={{ user, token, loading, login, register, logout, authFetch: ctxAuthFetch }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth() {
  return useContext(Ctx)
}
