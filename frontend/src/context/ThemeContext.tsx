import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'

type Theme = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (t: Theme) => void
}

const Ctx = createContext<ThemeContextValue>({ theme: 'system', resolvedTheme: 'light', setTheme: () => {} })

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try { return (localStorage.getItem('snip_theme') as Theme) || 'system' } catch { return 'system' }
  })

  const [resolvedTheme, setResolved] = useState<'light' | 'dark'>(() => {
    if (theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    return theme
  })

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if (theme === 'system') setResolved(mql.matches ? 'dark' : 'light') }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    const root = document.documentElement
    if (resolvedTheme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [resolvedTheme])

  useEffect(() => {
    if (theme === 'system') setResolved(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    else setResolved(theme)
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try { localStorage.setItem('snip_theme', t) } catch {}
  }, [])

  return <Ctx.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() { return useContext(Ctx) }
