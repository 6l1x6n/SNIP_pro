import { useState, useCallback, useRef, useEffect } from 'react'
import { API_BASE, authFetch } from '../utils/api'
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

function parseUploadError(raw: string): string {
  try {
    const j = JSON.parse(raw)
    if (j.detail) {
      if (String(j.detail).includes('Only PDF')) return 'Можно только PDF — перетащите .pdf файл'
      return String(j.detail)
    }
  } catch {}
  if (raw.includes('Only PDF')) return 'Можно только PDF'
  return raw.slice(0, 200)
}

export function useUpload({ user, activeBasketId, addLocalFiles, showToast, loadDocs, loadCollector }: UseUploadOptions) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
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

  const handleUpload = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    if (selectedFile && !fd.get('file')) fd.set('file', selectedFile)
    if (!fd.get('file')) {
      setUploadMsg('Ошибка: выберите PDF файл')
      setDropStatus('error'); setDropMessage('Выберите PDF — до 100 МБ')
      clearDrop(2500)
      return
    }
    setUploading(true); setDropStatus('uploading'); setDropMessage(null); setUploadMsg(null)
    try {
      const r = await authFetch(`${API_BASE}/api/admin/documents/upload`, { method: 'POST', body: fd })
      if (!r.ok) throw new Error(parseUploadError(await r.text()))
      const data = await r.json()
      setUploadMsg(`Успешно загружен: ${data.number} (${data.document_id})`)
      setDropStatus('success'); setDropMessage(`${data.number} — проиндексирован`)
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      form.reset()
      loadDocs()
      loadCollector()
      clearDrop(2500)
    } catch (err: any) {
      const msg = parseUploadError(err.message || 'Ошибка')
      setUploadMsg(`Ошибка: ${msg}`)
      setDropStatus('error'); setDropMessage(msg)
      clearDrop(3000)
    } finally { setUploading(false) }
  }, [selectedFile, authFetch, loadDocs, loadCollector, clearDrop])

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

    if (!user) {
      const ids = addLocalFiles(pdfs, targetBasketId)
      setUploadMsg(`Локально добавлено ${ids.length} PDF`)
      setDropStatus('success'); setDropMessage(`Локально ${ids.length} файл(ов)`)
      showToast(`Локально ${ids.length} PDF до перезагрузки — войдите чтобы сохранить`, 'warning')
      clearDrop(3000)
      return
    }

    for (let i = 0; i < pdfs.length; i++) {
      const f = pdfs[i]
      if (f.size > 100 * 1024 * 1024) {
        setUploadMsg(`Пропущен >100 МБ: ${f.name}`)
        setDropStatus('error'); setDropMessage('Файл >100 МБ')
        continue
      }
      setUploading(true); setDropStatus('uploading'); setDropMessage(`Загружаю ${i + 1}/${pdfs.length}: ${f.name.slice(0, 30)}`)
      try {
        const fd = new FormData()
        fd.set('file', f)
        const r = await authFetch(`${API_BASE}/api/admin/documents/upload`, { method: 'POST', body: fd })
        if (!r.ok) throw new Error(parseUploadError(await r.text()))
        const data = await r.json()
        window.dispatchEvent(new CustomEvent('snip:basket-move', { detail: { docId: data.document_id, basketId: targetBasketId ?? activeBasketId } }))
        setDropStatus('success'); setDropMessage(`Загружен ${i + 1}/${pdfs.length}: ${data.number}`)
        showToast(`Загружен ${i + 1}/${pdfs.length}: ${data.number}`, 'success')
        window.dispatchEvent(new Event('snip:reload-docs'))
      } catch (e: any) {
        addLocalFiles([f], targetBasketId)
        const em = parseUploadError(e.message)
        setDropStatus('error'); setDropMessage(`«${f.name}» локально — ${em}`)
        showToast(`Локально: ${f.name} — ${em}`, 'warning')
      } finally { setUploading(false) }
      await new Promise(r => setTimeout(r, 300))
    }
    clearDrop(2500)
    loadDocs()
  }, [user, authFetch, activeBasketId, addLocalFiles, showToast, loadDocs, clearDrop])

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
