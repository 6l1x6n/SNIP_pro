import { useState, useCallback, useRef, useEffect } from 'react'
import { isPdf } from '../utils/fileType'
import type { DropStatus } from '../components/SnakeState'

interface UseUploadOptions {
  user: any
  activeBasketId: string | null
  addLocalFiles: (files: File[], basketId?: string | null) => string[]
  showToast: (msg: string, variant?: string, duration?: number) => void
  loadDocs: () => void
  loadCollector: () => void
}

export function useUpload({ addLocalFiles, showToast }: UseUploadOptions) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [dropStatus, setDropStatus] = useState<DropStatus>('idle')
  const [dropMessage, setDropMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timers.current.forEach(t => clearTimeout(t))
      timers.current.clear()
    }
  }, [])

  const clearDrop = useCallback((delay = 2500) => {
    const t = setTimeout(() => { setDropStatus('idle'); setDropMessage(null) }, delay)
    timers.current.add(t)
    setTimeout(() => timers.current.delete(t), delay + 100)
  }, [])

  const handleUpload = useCallback(async (_e: React.FormEvent<HTMLFormElement>) => {
    // Загрузка документов отключена: SNiP — фиксированный пакет, обновление через пересборку индекса
    setUploadMsg('Загрузка отключена: справочник обновляется вместе с пакетом норм')
    setDropStatus('error'); setDropMessage('Функция загрузки PDF отключена')
    clearDrop(3000)
  }, [clearDrop])

  const onDropFile = useCallback((f: File) => {
    if (!isPdf(f)) {
      setUploadMsg('Ошибка: только PDF')
      setDropStatus('error'); setDropMessage(`«${f.name}» — не PDF`)
      clearDrop(3000)
      return
    }
    if (f.size > 100 * 1024 * 1024) {
      setDropStatus('error'); setDropMessage('Файл >100 МБ')
      setUploadMsg('Ошибка: файл больше 100 МБ')
      clearDrop(3000)
      return
    }
    setSelectedFile(f)
    setUploadMsg(`Выбран файл: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`)
    setDropStatus('idle'); setDropMessage(null)
  }, [clearDrop])

  const handleBasketFiles = useCallback(async (files: File[], targetBasketId: string | null) => {
    const pdfs = files.filter(f => isPdf(f))
    const bad = files.filter(f => !isPdf(f))
    if (bad.length) {
      setDropStatus('error'); setDropMessage(`Пропущены ${bad.length} не-PDF`)
      setUploadMsg(`Ошибка: только PDF — ${bad[0].name}`)
      showToast(`Только PDF: пропущены ${bad.map(f => f.name).join(', ').slice(0, 60)}`, 'error')
      clearDrop(3000)
    }
    if (!pdfs.length) return

    // Загрузка на сервер отключена — PDF из корзины остаются локальными
    const ids = addLocalFiles(pdfs, targetBasketId)
    setUploadMsg(`Локально добавлено ${ids.length} PDF`)
    setDropStatus('success'); setDropMessage(`Локально ${ids.length} файл(ов)`)
    showToast(`Загрузка на сервер отключена: ${ids.length} PDF добавлены локально`, 'warning')
    clearDrop(3000)
  }, [addLocalFiles, showToast, clearDrop])

  return {
    selectedFile, setSelectedFile,
    uploading,
    uploadMsg, setUploadMsg,
    dropStatus, setDropStatus,
    dropMessage, setDropMessage,
    fileInputRef,
    handleUpload,
    onDropFile,
    handleBasketFiles,
  }
}
