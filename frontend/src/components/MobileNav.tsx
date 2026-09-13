// MobileNav — нижняя таб-навигация ТОЛЬКО для телефонов.
// Рендерится с `md:hidden`, на ПК отсутствует в layout и никак не влияет на десктоп.
// Тап-таргеты ≥ 56px, иконки + подписи, safe-area снизу.
import { Icon, type IconName } from './Icon'

export type MobileTab = 'search' | 'docs' | 'favorites' | 'profile' | 'admin'

const ICONS: Record<string, IconName> = {
  search: 'search',
  docs: 'file',
  profile: 'user',
  admin: 'shield',
}

export function MobileNav({ tab, favCount, isAdmin, onGo }: {
  tab: string
  favCount: number
  isAdmin: boolean
  onGo: (t: MobileTab) => void
}) {
  const items: { id: MobileTab; label: string }[] = [
    { id: 'search', label: 'Поиск' },
    { id: 'docs', label: 'Документы' },
    { id: 'favorites', label: 'Избранное' },
  ]
  if (isAdmin) items.push({ id: 'admin', label: 'Админка' })
  items.push({ id: 'profile', label: 'Профиль' })

  const go = (t: MobileTab) => {
    onGo(t)
    try { window.scrollTo({ top: 0 }) } catch {}
  }

  return (
    <nav
      aria-label="Основная навигация"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-t border-slate-200 dark:border-slate-800"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="grid gap-1 px-2 py-1.5" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
        {items.map((it) => {
          const active = tab === it.id
          return (
            <button
              key={it.id}
              onClick={() => go(it.id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center justify-center gap-1 min-h-[52px] py-1.5 rounded-xl text-[10px] font-medium transition active:scale-95 ${
                active
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <span className="relative">
                <Icon
                  name={it.id === 'favorites' ? 'star' : ICONS[it.id]}
                  size={21}
                  strokeWidth={1.8}
                  fill={it.id === 'favorites' && active ? 'currentColor' : 'none'}
                />
                {it.id === 'favorites' && favCount > 0 && (
                  <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-0.5 rounded-full bg-slate-900 text-white dark:bg-white dark:text-slate-900 text-[9px] font-bold flex items-center justify-center">
                    {favCount > 99 ? '99+' : favCount}
                  </span>
                )}
              </span>
              {it.label}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
