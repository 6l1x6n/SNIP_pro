/**
 * Shared API configuration and authFetch wrapper.
 * Single source of truth for API_BASE across the app.
 */
export const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8001'

/**
 * Authenticated fetch wrapper — reads token from localStorage and attaches it.
 */
export async function authFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
  const t = localStorage.getItem('snip_token')
  if (t) headers['Authorization'] = `Bearer ${t}`
  return fetch(input, { ...init, headers })
}
