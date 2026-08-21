import React, { createContext, useContext, useEffect, useState } from 'react'
import { API_BASE, DEVICE_ID } from '../utils/api'

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
      const r = await fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}`, 'X-Device-Id': DEVICE_ID } })
      if (!r.ok) throw new Error('me failed')
      const u = await r.json()
      setUser(u)
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
    const form = new URLSearchParams()
    form.set('username', email)
    form.set('password', password)
    let r: Response
    try {
      r = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Device-Id': DEVICE_ID },
        body: form.toString(),
      })
    } catch (e) {
      if (e instanceof TypeError) throw new Error('Не удалось соединиться с сервером. Проверьте интернет и что бэкенд доступен: ' + API_BASE)
      throw e
    }
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(txt || 'Login failed')
    }
    const data = await r.json()
    const tok = data.access_token as string
    localStorage.setItem('snip_token', tok)
    setToken(tok)
    setUser(data.user)
  }

  const register = async (email: string, password: string, full_name?: string) => {
    let r: Response
    try {
      r = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE_ID },
        body: JSON.stringify({ email, password, full_name }),
      })
    } catch (e) {
      if (e instanceof TypeError) throw new Error('Не удалось соединиться с сервером. Проверьте интернет и что бэкенд доступен: ' + API_BASE)
      throw e
    }
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(txt || 'Register failed')
    }
    // auto login
    await login(email, password)
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
