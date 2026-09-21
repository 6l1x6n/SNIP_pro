/**
 * Shared API configuration, device ID, and authFetch wrapper.
 */

// CF Worker: auth + токены + /ask + /embed
export const WORKER_BASE = import.meta.env.VITE_WORKER_BASE || import.meta.env.VITE_API_BASE || ''
export const API_BASE = WORKER_BASE

// ── Device ID (for anonymous credits tracking) ──
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

/** Событие «сессия протухла»: AuthProvider слушает и чистит user/token. */
export const AUTH_EXPIRED_EVENT = 'snip:auth-expired'

/** Коды 401, при которых токен мёртв и его надо удалить (а не держать «фантомную» сессию). */
const DEAD_TOKEN_ERRORS = new Set(['token_expired', 'invalid_token', 'unauthorized'])

function notifyAuthExpired() {
  try {
    localStorage.removeItem('snip_token')
  } catch {}
  try {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  } catch {}
}

/**
 * Authenticated fetch to the Worker. Sends JWT + X-Device-Id.
 * При 401 с мёртвым токеном — чистит токен и шлёт AUTH_EXPIRED_EVENT,
 * ответ при этом возвращается вызывающему как есть (без скрытых ретраев).
 */
export async function authFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
  const t = localStorage.getItem('snip_token')
  if (t) headers['Authorization'] = `Bearer ${t}`
  headers['X-Device-Id'] = DEVICE_ID
  const r = await fetch(input, { ...init, headers })
  if (r.status === 401) {
    try {
      const clone = r.clone()
      const d = (await clone.json().catch(() => ({}))) as any
      if (DEAD_TOKEN_ERRORS.has(String(d?.error || 'unauthorized'))) notifyAuthExpired()
    } catch {
      /* тело не прочиталось — токен не трогаем */
    }
  }
  return r
}