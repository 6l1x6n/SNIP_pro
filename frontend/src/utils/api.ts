/**
 * Shared API configuration, device ID, and authFetch wrapper.
 */

export const API_BASE = import.meta.env.VITE_API_BASE || (import.meta.env.PROD ? '' : 'http://localhost:8001')

// ── Device ID (for anonymous quota tracking) ──
const DEVICE_ID_KEY = 'snip_device_id'

function getOrCreateDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY)
    if (id) return id
    id = crypto.randomUUID ? crypto.randomUUID() : "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
    localStorage.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return "dev-fallback"
  }
}

export const DEVICE_ID = getOrCreateDeviceId()

/**
 * Authenticated fetch wrapper. Sends X-Device-Id for quota tracking.
 */
export async function authFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
  const t = localStorage.getItem('snip_token')
  if (t) headers['Authorization'] = `Bearer ${t}`
  headers['X-Device-Id'] = DEVICE_ID
  return fetch(input, { ...init, headers })
}