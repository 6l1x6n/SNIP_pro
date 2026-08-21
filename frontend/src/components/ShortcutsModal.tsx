import { useEffect, useRef } from 'react'
import { SHORTCUT_LIST } from '../hooks/useKeyboardShortcuts'

interface ShortcutsModalProps {
  open: boolean
  onClose: () => void
}

export function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) closeRef.current?.focus() }, [open])
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden dark:bg-slate-800 dark:border-slate-700">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
          <h3 id="shortcuts-title" className="font-semibold text-slate-900 dark:text-white text-sm">⌨️ Горячие клавиши</h3>
          <button ref={closeRef} onClick={onClose} className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 flex items-center justify-center text-slate-500">✕</button>
        </div>
        <div className="p-5 space-y-3">
          {SHORTCUT_LIST.map(s => (
            <div key={s.key} className="flex items-start gap-3">
              <kbd className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 min-w-[80px] text-center">{s.key}</kbd>
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-white">{s.label}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{s.description}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-700 border-t border-slate-100 dark:border-slate-600 text-center">
          <button onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-sm font-medium hover:bg-black">Закрыть</button>
        </div>
      </div>
    </div>
  )
}
