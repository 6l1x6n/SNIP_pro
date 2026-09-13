/**
 * credits.ts — типы и клиент кредитной системы (гибрид: дневной лимит + накопительный баланс).
 * Списание: сначала бесплатные дневные, затем купленный баланс.
 */
import { WORKER_BASE, authFetch, DEVICE_ID } from './api'

export interface CreditsState {
  daily: { used: number; limit: number; remaining: number }
  balance: number
  plan: string | null
  /** hourly = акция 300⚡/час для зарегистрированных, daily = гости 30⚡/день */
  reset?: 'hourly' | 'daily'
}

export const FAST_COST = 5
export const DEEP_COST = 10
export const FOLLOWUP_COST = 5

export function availableTotal(c: CreditsState | null): number {
  if (!c) return 0
  return c.daily.remaining + c.balance
}

const CREDITS_TTL_MS = 25000
let creditsCache: { at: number; state: CreditsState; key: string } | null = null
let creditsInflight: { key: string; promise: Promise<CreditsState | null> } | null = null

/**
 * Ключ субъекта кэша: токен юзера либо гость+девайс.
 * Без него после logout/login отдавался бы чужой баланс до истечения TTL.
 */
function creditsKey(): string {
  try {
    return localStorage.getItem('snip_token') || `guest:${DEVICE_ID}`
  } catch {
    return 'guest'
  }
}

/** Сбросить кэш кредитов: вызывать при входе/выходе/смене пользователя. */
export function invalidateCreditsCache(): void {
  creditsCache = null
  creditsInflight = null
}

export async function fetchCredits(force = false): Promise<CreditsState | null> {
  const key = creditsKey()
  if (!force && creditsCache && creditsCache.key === key && Date.now() - creditsCache.at < CREDITS_TTL_MS)
    return creditsCache.state
  if (!force && creditsInflight && creditsInflight.key === key) return creditsInflight.promise
  const reqKey = key
  const promise: Promise<CreditsState | null> = (async () => {
    try {
      const r = await authFetch(`${WORKER_BASE}/api/credits`)
      if (!r.ok) return creditsCache?.key === reqKey ? creditsCache?.state ?? null : null
      const state = (await r.json()) as CreditsState
      // Пока летел запрос, пользователь мог смениться — чужое состояние не кэшируем,
      // а честно перезапрашиваем под новым ключом.
      if (creditsKey() !== reqKey) {
        return fetchCredits(true)
      }
      creditsCache = { at: Date.now(), state, key: reqKey }
      return state
    } catch {
      return creditsCache?.key === reqKey ? creditsCache?.state ?? null : null
    }
  })()
  creditsInflight = { key: reqKey, promise }
  void promise.finally(() => {
    if (creditsInflight && creditsInflight.promise === promise) creditsInflight = null
  })
  return promise
}

export class InsufficientCreditsError extends Error {
  need: number
  constructor(need: number) {
    super('Недостаточно кредитов')
    this.need = need
  }
}

/** Списать кредиты за поиск (fast списывается upfront, deep — внутри /ask). */
export async function spendForSearch(mode: 'fast' | 'deep'): Promise<CreditsState> {
  const r = await authFetch(`${WORKER_BASE}/api/credits/spend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  const d = await r.json().catch(() => ({}) as any)
  if (r.status === 402) throw new InsufficientCreditsError(Number(d?.need) || 0)
  if (!r.ok) throw new Error(`spend failed: ${r.status}`)
  return d as CreditsState
}

export interface LedgerItem {
  id: number
  delta: number
  kind: string
  meta: string | null
  created_at: string
}

export async function fetchCreditHistory(limit = 30): Promise<LedgerItem[]> {
  try {
    const r = await authFetch(`${WORKER_BASE}/api/credits/history?limit=${limit}`)
    if (!r.ok) return []
    const d = await r.json()
    return d.items ?? []
  } catch {
    return []
  }
}

export const CATALOG = {
  plans: [
    { sku: 'free', label: 'Free', price: 0, dailyLimit: 300, perks: ['300⚡ каждый час (акция)', 'Поиск и ответы с цитатами', 'Общая нормативная база'] },
    { sku: 'sub_pro', label: 'Pro', price: 2990, dailyLimit: 200, perks: ['200⚡ каждый день', 'Приоритетный глубокий поиск', 'Поддержка'] },
    { sku: 'sub_business', label: 'Business', price: 7990, dailyLimit: 500, perks: ['500⚡ каждый день', 'Командный доступ (скоро)', 'API (скоро)'] },
  ],
  packs: [
    { sku: 'pack_starter', label: 'Старт', price: 990, credits: 100 },
    { sku: 'pack_optimum', label: 'Оптимум', price: 3490, credits: 400 },
    { sku: 'pack_max', label: 'Максимум', price: 9990, credits: 1300 },
  ],
} as const

/** ДЕМО-покупка: активирует пакет или подписку без реальной оплаты. */
export async function purchaseDemo(sku: string): Promise<{ ok: boolean; detail?: string }> {
  const r = await authFetch(`${WORKER_BASE}/api/billing/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku }),
  })
  const d = await r.json().catch(() => ({}) as any)
  if (!r.ok) {
    const detail =
      d?.detail ||
      (d?.error === 'unknown_sku' ? 'Неизвестный тариф' :
       d?.error === 'billing_disabled' ? 'Оплата временно недоступна' :
       d?.error || 'Не удалось активировать')
    return { ok: false, detail }
  }
  dispatchCredits(d as CreditsState)
  return { ok: true }
}

/** Диспетчер обновления бейджа кредитов (после /ask, spend, purchase или вручную). */
export function dispatchCredits(state?: CreditsState | null): void {
  if (state?.daily) creditsCache = { at: Date.now(), state, key: creditsKey() }
  window.dispatchEvent(new CustomEvent('snip:credits', { detail: state }))
}

/** Подпись периода обновления лимита: акция для юзеров — каждый час, гости — раз в сутки. */
export function resetLabel(c: CreditsState | null, isUser: boolean): string {
  if (c?.reset === 'hourly' || (isUser && !c)) return 'Обновляется каждый час (акция: 300⚡/час)'
  if (c?.reset === 'daily' || !isUser) return 'Обновляется каждый день в 00:00 UTC'
  return isUser ? 'Обновляется каждый час (акция: 300⚡/час)' : 'Обновляется каждый день в 00:00 UTC'
}

/** Смена отображаемого имени (кулдаун 30 дней на сервере, первая установка свободна). */
export async function updateProfileName(fullName: string): Promise<{ ok: boolean; detail?: string; full_name?: string; name_can_change_at?: string | null }> {
  const r = await authFetch(`${WORKER_BASE}/api/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: fullName }),
  })
  const d = await r.json().catch(() => ({}) as any)
  if (!r.ok) return { ok: false, detail: d?.detail || d?.error || 'Не удалось сменить имя' }
  return { ok: true, full_name: d.full_name, name_can_change_at: d.name_can_change_at ?? null }
}
