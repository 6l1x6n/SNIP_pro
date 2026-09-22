// tabs.ts — единый источник правды о доступности табов.
// Роутера нет: «навигация» — это state таба в App.tsx. Если сессия/роль
// изменилась (logout, 401, logout в соседней вкладке, demotion из админов),
// текущий таб может стать недоступным — без фолбэка контент-область
// остаётся пустой (белый экран при живом header/footer).
import { isAdminEmail } from './admin'

export type Tab = 'search' | 'docs' | 'favorites' | 'profile' | 'admin'

interface TabUser {
  email?: string | null
}

/** Доступен ли таб текущему пользователю (null — гость). */
export function canAccessTab(tab: Tab, user: TabUser | null | undefined): boolean {
  if (tab === 'admin') return !!(user && isAdminEmail(user.email))
  // search/docs/profile/favorites всегда рендерятся: у profile и favorites
  // есть гостевые карточки (ProfileView, fallback в App).
  return true
}

/** Таб, который нужно реально показать: при недоступности — профиль. */
export function resolveActiveTab(tab: Tab, user: TabUser | null | undefined): Tab {
  return canAccessTab(tab, user) ? tab : 'profile'
}
