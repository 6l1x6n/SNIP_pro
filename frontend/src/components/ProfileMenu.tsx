import { useState, useRef, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { stringToColor } from '../utils/badges'
import { Icon, type IconName } from './Icon'

type Section = 'overview' | 'usage' | 'help' | 'settings' | 'billing'

const ITEMS: { section: Section; label: string; icon: IconName }[] = [
  { section: 'overview', label: 'Профиль', icon: 'user' },
  { section: 'usage', label: 'Использование', icon: 'bolt' },
  { section: 'help', label: 'Помощь', icon: 'help' },
  { section: 'settings', label: 'Настройки', icon: 'settings' },
  { section: 'billing', label: 'Оплата', icon: 'card' },
]

export function ProfileMenu({ user, onNavigate, onLogout }: {
  user: any
  onNavigate: (s: Section) => void
  onLogout: () => void
}) {
  const { resolvedTheme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!user) return null
  const displayName = user.full_name || user.email
  const first = (displayName ? displayName[0] : '?').toUpperCase()
  const bg = stringToColor(user.email)
  const item = 'w-full text-left px-3 py-2 text-sm rounded-xl transition flex items-center gap-2.5 text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'

  const go = (s: Section) => { setOpen(false); onNavigate(s) }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={user.email}
        className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 ring-2 ring-white dark:ring-slate-900 hover:opacity-90 transition"
        style={{ backgroundColor: bg }}
      >
        {first}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden z-50 animate-dropdown">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate" title={displayName}>{displayName}</div>
              <div className="text-xs text-slate-500 truncate" title={user.is_superuser || user.is_admin ? `${user.email} • администратор` : user.email}>
                {user.email}
                {(user.is_superuser || user.is_admin) && <span className="text-violet-600 dark:text-violet-400 font-medium"> • администратор</span>}
              </div>
            </div>
          </div>
          <div className="p-2 space-y-0.5">
            {ITEMS.map((it) => (
              <button key={it.section} className={item} onClick={() => go(it.section)}>
                <Icon name={it.icon} className="text-slate-400 dark:text-slate-500" />
                {it.label}
              </button>
            ))}
          </div>
          <div className="p-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs text-slate-500 px-2">Тема</span>
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
            >
              <Icon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} size={14} strokeWidth={2} />
              {resolvedTheme === 'dark' ? 'Светлая' : 'Тёмная'}
            </button>
          </div>
          <div className="p-2 border-t border-slate-100 dark:border-slate-800">
            <button onClick={() => { setOpen(false); onLogout() }} className={item + ' text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30'}>
              <Icon name="logout" className="text-red-400" />Выйти
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
