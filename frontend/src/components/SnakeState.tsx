type Variant = 'thinking' | 'searching' | 'success' | 'failed'

const srcMap: Record<Variant, string> = {
  thinking: '/snakes/snippy_snake_thinking.png',
  searching: '/snakes/snippy_snake_searching.png',
  success: '/snakes/snippy_snake_success.png',
  failed: '/snakes/snippy_snake_failed.png',
}

export function SnakeState({ variant, title, subtitle, action, size = 160 }: {
  variant: Variant,
  title?: string,
  subtitle?: string,
  action?: React.ReactNode,
  size?: number
}) {
  return (
    <div className="text-center">
      <img
        src={srcMap[variant]}
        alt={`Snippy ${variant}`}
        width={size}
        height={size}
        className="mx-auto object-contain drop-shadow-md"
        style={{ animation: variant==='searching' ? 'float 3s ease-in-out infinite' : undefined }}
        loading="lazy"
      />
      {title && <div className="font-semibold text-slate-900 mt-3">{title}</div>}
      {subtitle && <div className="text-sm text-slate-500 mt-1 max-w-md mx-auto">{subtitle}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

import { getFilesFromDataTransfer } from '../utils/fileType'

export type DropStatus = 'idle' | 'dragOver' | 'uploading' | 'success' | 'error'

export function SnakeDropZone({ onFile, onFiles, status = 'idle', message, onDragOverState }: { onFile: (f: File) => void, onFiles?: (files: File[])=>void, status?: DropStatus, message?: string | null, onDragOverState?: (over: boolean)=>void }) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    onDragOverState?.(false)
    const files = getFilesFromDataTransfer(e.dataTransfer)
    if (onFiles && files.length>1) onFiles(files)
    else {
      const f = files[0]
      if (f) onFile(f)
    }
  }
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    onDragOverState?.(true)
  }
  const handleDragLeave = () => onDragOverState?.(false)

  const variant: Variant = status === 'uploading' || status === 'dragOver' ? 'searching' : status === 'success' ? 'success' : status === 'error' ? 'failed' : 'thinking'
  const borderCls =
    status === 'error' ? 'border-red-300 bg-red-50/70' :
    status === 'success' ? 'border-emerald-300 bg-emerald-50/70' :
    status === 'uploading' ? 'border-blue-300 bg-blue-50/60' :
    status === 'dragOver' ? 'border-blue-400 bg-blue-50' :
    'border-slate-300 hover:border-blue-400 bg-slate-50/50 hover:bg-white'

  const title =
    status === 'uploading' ? 'Snippy разбирает PDF…' :
    status === 'dragOver' ? 'Отпустите PDF здесь' :
    status === 'success' ? 'Готово!' :
    status === 'error' ? 'Ой, не получилось' :
    'Сбросьте PDF — я разберу его по пунктам'

  const subtitle =
    status === 'error' ? (message || 'Можно только PDF (до 100 МБ)')
    : status === 'success' ? (message || 'Документ загружен и проиндексирован')
    : status === 'dragOver' ? 'Змейка уже ждёт — отпустите файл'
    : 'Перетащите СНиП/СП PDF сюда или нажмите • до 100 МБ • поддерживаем сканы с OCR'

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative rounded-2xl border-2 border-dashed p-6 text-center transition ${borderCls}`}
    >
      <img src={srcMap[variant]} alt={`Snippy ${variant}`} width={140} height={140} className="mx-auto object-contain drop-shadow-md" style={{ animation: variant==='searching' ? 'float 3s ease-in-out infinite' : undefined }} />
      <div className="font-medium text-slate-900 mt-2">{title}</div>
      <div className={`text-xs mt-1 ${status==='error' ? 'text-red-600 font-medium' : status==='success' ? 'text-emerald-700 font-medium' : 'text-slate-500'}`}>{subtitle}</div>
      <div className="mt-3 text-xs text-slate-400">Змейка Сниппи — амбассадор проекта {status==='error' && '• попробуйте другой PDF'}</div>
    </div>
  )
}
