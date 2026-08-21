import { useState, useRef, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { stringToColor } from '../utils/badges'

type Section = 'overview' | 'settings' | 'keys' | 'billing'

function Icon({ path, fill = 'none' }: { path: string; fill?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="1.9" className="shrink-0 text-slate-500">
      <path d={path} />
    </svg>
  )
}

const ICONS = {
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  billing: 'M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
}

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
  const first = (user.email ? user.email[0] : '?').toUpperCase()
  const bg = stringToColor(user.email)
  const item = 'w-full text-left px-3 py-2 text-sm rounded-xl transition flex items-center gap-2.5 text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700'

  const go = (s: Section) => { setOpen(false); onNavigate(s) }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={user.email}
        className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 border-2 border-white shadow-sm hover:scale-105 transition"
        style={{ backgroundColor: bg }}
      >
        {first}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden z-50">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ backgroundColor: bg }}>{first}</div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{user.email}</div>
              <div className="text-xs text-slate-500 truncate">{user.is_superuser ? '★ владелец' : 'snippy.llm'}</div>
            </div>
          </div>
          <div className="p-2 space-y-1">
            <button className={item} onClick={() => go('overview')}><Icon path={ICONS.user} />Профиль / Обзор</button>
            <button className={item} onClick={() => go('settings')}><Icon path={ICONS.settings} />Настройки</button>
            <button className={item} onClick={() => go('keys')}><Icon path={ICONS.key} />API ключи</button>
            <button className={item} onClick={() => go('billing')}><Icon path={ICONS.billing} />Оплата</button>
          </div>
          <div className="p-2 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs text-slate-500 px-2">Тема</span>
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs text-slate-600 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 transition"
            >
              {resolvedTheme === 'dark' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              )}
              {resolvedTheme === 'dark' ? 'Светлая' : 'Тёмная'}
            </button>
          </div>
          <div className="p-2 border-t border-slate-100 dark:border-slate-700">
            <button onClick={() => { setOpen(false); onLogout() }} className={item + ' text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30'}>
              <Icon path={ICONS.logout} />Выйти
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
