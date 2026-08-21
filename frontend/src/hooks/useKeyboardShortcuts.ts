import { useEffect, useCallback } from 'react'

interface ShortcutHandlers {
  onSearchFocus?: () => void
  onEscape?: () => void
  onQuickSearch?: () => void
  onToggleShortcuts?: () => void
}

/**
 * Global keyboard shortcuts for the app.
 * - `/` → focus search
 * - `Esc` → close modals/dropdowns
 * - `Ctrl+K` / `Cmd+K` → quick search overlay
 * - `?` → show shortcuts help (when not in input)
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

    if (e.key === 'Escape') { handlers.onEscape?.(); return }
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); handlers.onQuickSearch?.(); return }
    if (isInput) return
    if (e.key === '/') { e.preventDefault(); handlers.onSearchFocus?.(); return }
    if (e.key === '?') { handlers.onToggleShortcuts?.(); return }
  }, [handlers])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

export const SHORTCUT_LIST = [
  { key: '/', label: 'Фокус на поиск', description: 'Быстрый переход к поисковой строке' },
  { key: 'Esc', label: 'Закрыть', description: 'Закрыть модальное окно, выпадающий список или подсказки' },
  { key: '⌘K / Ctrl+K', label: 'Быстрый поиск', description: 'Открыть поисковую панель из любой точки' },
  { key: '?', label: 'Справка', description: 'Показать список горячих клавиш' },
]
