/**
 * Сессии истории поиска: полный слепок результата на каждый запрос,
 * чтобы повторное открытие НЕ тратило квоту/токены (чисто localStorage).
 *
 * - SESSION_KEY: query -> { resp, mode, filterType, filterStatus, savedAt }
 * - PIN_KEY: закреплённые запросы (живут сверху, переживают очистку и вытеснение)
 */

export type SessionEntry = {
  resp: any
  mode: string
  filterType: string
  filterStatus: string
  savedAt: number
}

const SESSION_KEY = 'snip_session_resp_v1'
const PIN_KEY = 'snip_history_pinned_v1'

export const SESSIONS_EVENT = 'snip-sessions'
export const PINS_EVENT = 'snip-pins'

export const MAX_SESSIONS = 15
/** Незакреплённые сессии старше — протухают и чистятся. */
export const SESSION_TTL = 7 * 24 * 3600 * 1000

function notify(name: string) {
  try { window.dispatchEvent(new Event(name)) } catch {}
}

function readPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

function writePins(pins: string[]) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pins)) } catch {}
  notify(PINS_EVENT)
}

function readSessions(): Record<string, SessionEntry> {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    const v = raw ? JSON.parse(raw) : {}
    if (!v || typeof v !== 'object') return {}
    // Чистим протухшие незакреплённые на чтении (пины бессрочны).
    const pins = new Set(readPinsRaw())
    let dirty = false
    const now = Date.now()
    for (const k of Object.keys(v)) {
      const e = v[k] as SessionEntry
      if (!e || !e.resp) { delete v[k]; dirty = true; continue }
      if (!pins.has(k) && e.savedAt && now - e.savedAt > SESSION_TTL) {
        delete v[k]
        dirty = true
      }
    }
    if (dirty) {
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(v)) } catch {}
    }
    return v as Record<string, SessionEntry>
  } catch { return {} }
}

/** Чтение пинов без сайд-эффектов (для внутренней чистки). */
function readPinsRaw(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

export function loadPins(): string[] {
  return readPins()
}

export function isPinned(query: string): boolean {
  return readPins().includes(query)
}

export function togglePin(query: string): string[] {
  const pins = readPins()
  const next = pins.includes(query) ? pins.filter((p) => p !== query) : [query, ...pins]
  writePins(next)
  return next
}

export function unpin(query: string): string[] {
  const next = readPins().filter((p) => p !== query)
  writePins(next)
  return next
}

export function loadSessions(): Record<string, SessionEntry> {
  return readSessions()
}

export function getSession(query: string): SessionEntry | null {
  const all = readSessions()
  const e = all[query]
  if (!e || !e.resp) return null
  // Протухший незакреплённый — не отдаём
  if (!readPinsRaw().includes(query) && e.savedAt && Date.now() - e.savedAt > SESSION_TTL) return null
  return e
}

function persistSessions(all: Record<string, SessionEntry>) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(all))
  } catch {
    // Переполнение квоты localStorage: вытесняем самые старые незакреплённые и пробуем ещё раз.
    const pins = new Set(readPinsRaw())
    const keys = Object.keys(all)
      .filter((k) => !pins.has(k))
      .sort((a, b) => (all[a]?.savedAt || 0) - (all[b]?.savedAt || 0))
    while (keys.length) {
      delete all[keys.shift()!]
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(all))
        break
      } catch {}
    }
  }
  notify(SESSIONS_EVENT)
}

/** Сохранить слепок результата. Пины никогда не вытесняются. */
export function saveSession(
  query: string,
  resp: any,
  meta: { mode: string; filterType: string; filterStatus: string },
) {
  const q = (query || '').trim()
  if (!q || !resp) return
  const all = readSessions()
  all[q] = {
    resp,
    mode: meta.mode,
    filterType: meta.filterType || '',
    filterStatus: meta.filterStatus || '',
    savedAt: Date.now(),
  }
  // Лимит: сверх — удаляем старые незакреплённые
  const pins = new Set(readPinsRaw())
  const keys = Object.keys(all)
  if (keys.length > MAX_SESSIONS) {
    const evictable = keys
      .filter((k) => !pins.has(k) && k !== q)
      .sort((a, b) => (all[a]?.savedAt || 0) - (all[b]?.savedAt || 0))
    while (Object.keys(all).length > MAX_SESSIONS && evictable.length) {
      delete all[evictable.shift()!]
    }
  }
  persistSessions(all)
}

export function removeSession(query: string) {
  const all = readSessions()
  if (all[query]) {
    delete all[query]
    persistSessions(all)
  } else {
    notify(SESSIONS_EVENT)
  }
  unpin(query)
}

/** «Очистить историю»: пины сохраняются, их сессии не удаляются. */
export function clearUnpinnedSessions(keepQueries: string[]) {
  const keep = new Set(keepQueries)
  const all = readSessions()
  let dirty = false
  for (const k of Object.keys(all)) {
    if (!keep.has(k)) { delete all[k]; dirty = true }
  }
  if (dirty) persistSessions(all)
  else notify(SESSIONS_EVENT)
}

/**
 * Порядок для отображения: закреплённые (в порядке пинов) сверху,
 * затем остальные в исходном порядке истории.
 */
export function orderHistory(history: string[], pins: string[]): { pinned: string[]; rest: string[] } {
  const set = new Set(history)
  const pinned = pins.filter((p) => set.has(p))
  const pinnedSet = new Set(pinned)
  const rest = history.filter((h) => !pinnedSet.has(h))
  return { pinned, rest }
}
