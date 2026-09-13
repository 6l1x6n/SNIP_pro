/**
 * admin.ts — whitelist администраторов, у которых работает демо-оплата.
 * Остальным кнопка «Пополнить баланс» показывается неактивной.
 */

export const ADMIN_EMAILS = ["postalarchive@gmail.com", "aidos77_77@mail.ru"];

export function isAdminEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export const BILLING_DISABLED_HINT = "Демо-оплата сейчас доступна только администраторам. Приём платежей (Kaspi/карты) — скоро.";
