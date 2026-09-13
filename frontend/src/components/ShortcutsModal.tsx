import { useEffect, useRef } from 'react'
import { SHORTCUT_LIST } from '../hooks/useKeyboardShortcuts'
import { Icon } from './Icon'

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
      <div className="relative w-full max-w-md card shadow-xl overflow-hidden animate-[popIn_.18s_ease-out]">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 id="shortcuts-title" className="font-semibold text-slate-900 dark:text-white text-sm flex items-center gap-2"><Icon name="keyboard" size={15} className="text-slate-400" /> Горячие клавиши</h3>
          <button ref={closeRef} onClick={onClose} className="icon-btn w-8 h-8"><Icon name="close" size={15} /></button>
        </div>
        <div className="p-5 space-y-3">
          {SHORTCUT_LIST.map(s => (
            <div key={s.key} className="flex items-start gap-3">
              <kbd className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono font-semibold text-slate-700 dark:text-slate-200 min-w-[80px] text-center">{s.key}</kbd>
              <div>
                <div className="text-sm font-medium text-slate-900 dark:text-white">{s.label}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{s.description}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 text-center">
          <button onClick={onClose} className="btn btn-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200">Закрыть</button>
        </div>
      </div>
    </div>
  )
}
