import { useState, useEffect, useCallback, createContext, useContext, useRef } from 'react'

type ToastVariant = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: number
  message: string
  variant: ToastVariant
  duration: number
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant, durationMs?: number) => void
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} })

let toastId = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const removeToast = useCallback((id: number) => {
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
    setToasts(prev => prev.filter(x => x.id !== id))
  }, [])

  const showToast = useCallback((message: string, variant: ToastVariant = 'info', durationMs = 3000) => {
    const id = ++toastId
    setToasts(prev => [...prev, { id, message, variant, duration: durationMs }])
    const timer = setTimeout(() => removeToast(id), durationMs)
    timers.current.set(id, timer)
  }, [removeToast])

  useEffect(() => {
    return () => {
      timers.current.forEach(t => clearTimeout(t))
      timers.current.clear()
    }
  }, [])

  const variantStyles: Record<ToastVariant, string> = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-slate-900 text-white',
    warning: 'bg-amber-500 text-white',
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none" role="status" aria-live="polite">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto px-4 py-3 rounded-2xl shadow-xl text-sm flex items-center gap-3 max-w-[92vw] animate-dropdown ${variantStyles[t.variant]}`}
          >
            <span className="truncate">{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="text-white/60 hover:text-white shrink-0"
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
