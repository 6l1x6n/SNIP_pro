import { useState, useRef, useCallback, useEffect } from 'react'
import { WORKER_BASE } from '../utils/api'

interface UseVoiceSearchOptions {
  onTranscript: (text: string) => void
  onError?: (error: string) => void
  language?: string
}

type VoiceState = 'idle' | 'listening' | 'processing' | 'error'

const FALLBACK_MAX_SEC = 30

/**
 * Voice search: Web Speech API first; on `network` error (Chrome↔Google unreachable —
 * mic permission is irrelevant) falls back to MediaRecorder → POST /api/voice (Groq Whisper).
 * Fallback costs no site credits and writes nothing to D1 (20/day per device, server-side).
 */
export function useVoiceSearch({ onTranscript, onError, language = 'ru-RU' }: UseVoiceSearchOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [isSupported, setIsSupported] = useState(false)
  const recognitionRef = useRef<any>(null)
  const finalTranscriptRef = useRef('')
  const fallbackTriedRef = useRef(false)
  // MediaRecorder fallback refs
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const fallbackTimerRef = useRef<any>(null)
  const onTranscriptRef = useRef(onTranscript)
  const onErrorRef = useRef(onError)
  onTranscriptRef.current = onTranscript
  onErrorRef.current = onError

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const canRecord = !!((navigator as any).mediaDevices?.getUserMedia && (window as any).MediaRecorder)
    setIsSupported(!!SR || canRecord)
  }, [])

  const cleanupFallback = useCallback(() => {
    if (fallbackTimerRef.current) { clearTimeout(fallbackTimerRef.current); fallbackTimerRef.current = null }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch {}
    }
    recorderRef.current = null
    chunksRef.current = []
    if (mediaStreamRef.current) {
      try { mediaStreamRef.current.getTracks().forEach((t) => t.stop()) } catch {}
      mediaStreamRef.current = null
    }
  }, [])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
      recognitionRef.current = null
    }
    // Если идёт резервная запись — останавливаем: onstop сам отправит аудио
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch {}
    } else {
      cleanupFallback()
      setState('idle')
    }
  }, [cleanupFallback])

  const sendFallbackAudio = useCallback(async (blob: Blob) => {
    setState('processing')
    try {
      const form = new FormData()
      form.append('audio', blob, 'voice.webm')
      const r = await fetch(`${WORKER_BASE}/api/voice`, {
        method: 'POST',
        headers: { 'X-Device-Id': localStorage.getItem('snip_device_id') || '' },
        body: form,
      })
      const d = await r.json().catch(() => ({}) as any)
      if (r.ok && d.text) {
        onTranscriptRef.current(String(d.text).trim())
        setState('idle')
      } else {
        const msg =
          r.status === 429 ? 'Лимит голосовых (20/день) исчерпан — обновится в 00:00 UTC.' :
          r.status === 413 ? 'Запись слишком длинная — говорите короче 30 сек.' :
          d.detail || 'Резервное распознавание недоступно, попробуйте позже.'
        onErrorRef.current?.(msg)
        setState('error')
      }
    } catch {
      onErrorRef.current?.('Нет соединения с сервером распознавания.')
      setState('error')
    } finally {
      cleanupFallback()
    }
  }, [cleanupFallback])

  const startFallbackRecording = useCallback(async () => {
    if (!(navigator as any).mediaDevices?.getUserMedia || !(window as any).MediaRecorder) {
      onErrorRef.current?.('Ошибка: network — нет связи с сервисом распознавания, а запись в этом браузере недоступна.')
      setState('error')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      const rec = new (window as any).MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e: any) => { if (e.data?.size) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (blob.size) sendFallbackAudio(blob)
        else {
          onErrorRef.current?.('Пустая запись — попробуйте ещё раз.')
          setState('error')
          cleanupFallback()
        }
      }
      recorderRef.current = rec
      rec.start()
      setState('listening')
      fallbackTimerRef.current = setTimeout(() => {
        try { rec.stop() } catch {}
      }, FALLBACK_MAX_SEC * 1000)
    } catch {
      onErrorRef.current?.('Доступ к микрофону запрещён. Разрешите в настройках браузера.')
      setState('error')
    }
  }, [sendFallbackAudio, cleanupFallback])

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    fallbackTriedRef.current = false
    if (!SR) {
      // Web Speech нет вообще — сразу резерв
      startFallbackRecording()
      return
    }

    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
    }

    const recognition = new SR()
    recognition.lang = language
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    finalTranscriptRef.current = ''

    recognition.onstart = () => setState('listening')

    recognition.onresult = (event: any) => {
      let finalText = finalTranscriptRef.current
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalText += transcript
          finalTranscriptRef.current = finalText
        }
      }
      if (finalText.trim()) {
        onTranscriptRef.current(finalText.trim())
      }
    }

    recognition.onerror = (event: any) => {
      // network = обрыв Chrome↔Google (микро ни при чём) → бесшовный фолбэк на Whisper
      if (event.error === 'network' && !fallbackTriedRef.current) {
        fallbackTriedRef.current = true
        recognitionRef.current = null
        startFallbackRecording()
        return
      }
      const msg: Record<string, string> = {
        'no-speech': 'Речь не обнаружена. Попробуйте ещё раз.',
        'audio-capture': 'Не удалось захватить аудио. Проверьте микрофон.',
        'not-allowed': 'Доступ к микрофону запрещён. Разрешите в настройках браузера.',
      }
      onErrorRef.current?.(msg[event.error] || `Ошибка: ${event.error}`)
      setState('error')
    }

    recognition.onend = () => {
      // onend после network-ошибки игнорируем — уже идёт/шёл фолбэк
      if (fallbackTriedRef.current) return
      setState('idle')
    }

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (e: any) {
      onErrorRef.current?.(`Не удалось начать: ${e.message}`)
      setState('error')
    }
  }, [language, startFallbackRecording])

  const toggleListening = useCallback(() => {
    state === 'listening' ? stopListening() : startListening()
  }, [state, startListening, stopListening])

  useEffect(() => () => {
    if (recognitionRef.current) try { recognitionRef.current.stop() } catch {}
    cleanupFallback()
  }, [cleanupFallback])

  return { state, isSupported, startListening, stopListening, toggleListening }
}
