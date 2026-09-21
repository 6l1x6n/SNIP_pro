/**
 * useAdmin.ts — клиент Админки (только ADMIN_EMAILS, сервер проверяет JWT).
 * Все запросы — через authFetch (Bearer + X-Device-Id), пагинация обязательна (экономия D1-reads).
 */
import { WORKER_BASE, authFetch } from '../utils/api'

export type Segment = 'guest' | 'free' | 'pro' | 'business'

export interface SegmentSlice {
  seg: Segment
  n: number
  s: number
}

export interface ModelUsage {
  x?: number
  x_est?: number
  n: number
  refunds?: number
  by_segment: SegmentSlice[]
  fb?: Record<string, number>
  shared_pool?: boolean
  estimate?: boolean
  note?: string
}

export interface EmbedFallback {
  id: string
  key_set: boolean
  active: boolean
}

export interface ProvidersInfo {
  active_embed: { provider: string; model: string; dim: number | null; count: number | null; builtAt: string | null }
  llm: { provider: string; model: string; fallback: boolean }
  llm_fallbacks?: { id: string; key_set: boolean }[]
  embed_fallbacks: EmbedFallback[]
}

export interface AdminHealth {
  now: string
  index: { ok: boolean; provider: string; model: string; dim: number | null; count: number | null; builtAt: string | null; base_url: string }
  r2_norms: boolean
  tables: Record<string, number>
  billing: { plans: Record<string, { label: string; price: number; dailyLimit: number; days: number }>; packs: Record<string, { label: string; price: number; credits: number }> }
}

export interface AdminStats {
  days: number
  users: { total: number; fresh: number }
  ledger_by_kind: { kind: string; n: number; s: number }[]
  usage_by_day: { d: string; n: number; s: number }[]
  explain: { used: number; cached: number; cap: number }
  limits: { anon: number; user: number; fast: number; deep: number; groq_model: string; embed_model: string }
  settings_meta?: Record<string, { custom: boolean; updated_at: string | null }>
  model_usage?: { ask: ModelUsage; explain: ModelUsage; embed: ModelUsage }
  providers?: ProvidersInfo
}

export interface AdminUser {
  id: string
  email: string
  plan: string
  full_name: string | null
  created_at: string
  balance: number
  spent: number
  sub: string
}

export interface AdminActivityItem {
  id: number
  subject: string
  email: string
  delta: number
  kind: string
  meta: string | null
  created_at: string
}

export interface AdminFeedbackItem {
  id: number
  created_at: string
  subject: string
  is_user: number
  email: string
  query: string
  mode: string | null
  provider: string | null
  paragraph: string | null
  rating: number
  reason: string | null
  comment: string | null
}

export interface AdminFeedbackAgg {
  pos: number
  neg: number
  total: number
}

export interface AdminSettings {
  values: Record<string, number>
  meta: Record<string, { custom: boolean; updated_at: string | null; min: number; max: number }>
}

export const SEGMENT_LABEL: Record<Segment, string> = {
  guest: 'Гости',
  free: 'Бесплатные',
  pro: 'PRO',
  business: 'Бизнес',
}

export const SEGMENT_COLOR: Record<Segment, string> = {
  guest: '#94a3b8',
  free: '#38bdf8',
  pro: '#8b5cf6',
  business: '#10b981',
}

/** Красивое имя субъекта: email пользователя или «Гость · xxxx». */
export function displaySubject(email: string | null | undefined, subject: string): string {
  if (email) return email
  if (subject.startsWith('anon:')) return `Гость · ${subject.slice(5, 13) || '???'}`
  return subject
}

async function get<T>(path: string): Promise<T> {
  const r = await authFetch(`${WORKER_BASE}${path}`)
  const d = await r.json().catch(() => ({}))
  if (r.status === 403) throw new Error('not_admin')
  if (!r.ok) throw new Error((d as any)?.error || `admin ${r.status}`)
  return d as T
}

export const fetchAdminStats = (days = 7) => get<AdminStats>(`/api/admin/stats?days=${days}`)

export const fetchAdminUsers = (q = '', limit = 50, offset = 0) =>
  get<{ items: AdminUser[]; total: number }>(`/api/admin/users?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`)

export const fetchAdminActivity = (kinds: string[] = [], limit = 50, offset = 0) =>
  get<{ items: AdminActivityItem[]; total: number }>(
    `/api/admin/activity?kinds=${encodeURIComponent(kinds.join(','))}&limit=${limit}&offset=${offset}`
  )

export const fetchAdminFeedback = (rating: 'all' | '1' | '-1' = 'all', limit = 50, offset = 0) =>
  get<{ items: AdminFeedbackItem[]; total: number; agg: AdminFeedbackAgg }>(
    `/api/admin/feedback?rating=${rating}&limit=${limit}&offset=${offset}`
  )

export const fetchAdminSettings = () => get<AdminSettings>('/api/admin/settings')

export const fetchAdminHealth = () => get<AdminHealth>('/api/admin/health')

export async function saveAdminSetting(key: string, value: number): Promise<{ ok: boolean; key: string; value: number }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `save ${r.status}`)
  return d
}

export async function freezeUser(uid: string, reason = ''): Promise<{ ok: boolean; frozen: number }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, reason }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.error || `freeze ${r.status}`)
  return d
}

// ---------- Удаление аккаунтов в архив (30 дней) ----------

export interface DeletionReason { id: string; title: string; template: string }

export const fetchDeletionReasons = () => get<{ reasons: DeletionReason[] }>('/api/admin/deletion-reasons')

export interface ArchivedUser {
  email: string; uid: string; full_name: string | null; reason_title: string; reason_text: string
  deleted_by: string; deleted_at: string; purge_after: string; days_left: number
}

export const fetchArchivedUsers = () => get<{ archived: ArchivedUser[] }>('/api/admin/archived')

export async function deleteUserToArchive(uid: string, reason: string, reason_text?: string): Promise<{ ok: boolean; purge_after: string }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/delete-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, reason, reason_text }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `delete ${r.status}`)
  return d
}

export async function restoreUserFromArchive(email: string): Promise<{ ok: boolean }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/restore-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `restore ${r.status}`)
  return d
}

export async function saveDeletionTemplate(reasonId: string, text: string): Promise<{ ok: boolean }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: `del_tpl_${reasonId}`, value: text }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `save tpl ${r.status}`)
  return d
}

// ---------- Сброс пароля: заявки пользователей, ручная выдача кода ----------

export interface ResetRequest {
  email: string; created_at: string; expires_at: string; state: 'pending' | 'coded';
}

export const fetchResetRequests = () => get<{ requests: ResetRequest[] }>('/api/admin/reset-requests')

export async function approveReset(email: string): Promise<{ ok: boolean; code: string; expires_in_minutes: number }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/reset-approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `approve ${r.status}`)
  return d
}

export async function rejectReset(email: string): Promise<{ ok: boolean }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/reset-reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `reject ${r.status}`)
  return d
}

export async function setAdminPassword(uid: string, password: string): Promise<{ ok: boolean; email: string }> {
  const r = await authFetch(`${WORKER_BASE}/api/admin/set-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, password }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d?.detail || d?.error || `set-password ${r.status}`)
  return d
}

/** Случайный читаемый пароль: 3 слова-число — легко диктовать. */
export function generatePassword(): string {
  const words = ['норма', 'снип', 'кодекс', 'балка', 'ферма', 'бетон', 'арматура', 'фундамент', 'уклон', 'маяк']
  const pick = () => words[Math.floor(Math.random() * words.length)]
  const n = Math.floor(10 + Math.random() * 90)
  return `${pick()}-${pick()}-${n}`
}
