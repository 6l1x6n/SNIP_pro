import { useState, useRef, useCallback, useEffect } from 'react'

interface UseVoiceSearchOptions {
  onTranscript: (text: string) => void
  onError?: (error: string) => void
  language?: string
}

type VoiceState = 'idle' | 'listening' | 'processing' | 'error'

/**
 * Voice search hook using Web Speech API (browser-native, no backend needed).
 * Falls back gracefully when unsupported.
 */
export function useVoiceSearch({ onTranscript, onError, language = 'ru-RU' }: UseVoiceSearchOptions) {
  const [state, setState] = useState<VoiceState>('idle')
  const [isSupported, setIsSupported] = useState(false)
  const recognitionRef = useRef<any>(null)
  const finalTranscriptRef = useRef('')

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    setIsSupported(!!SR)
  }, [])

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch {}
      recognitionRef.current = null
    }
    setState('idle')
  }, [])

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      onError?.('Распознавание речи не поддерживается в этом браузере')
      setState('error')
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
        onTranscript(finalText.trim())
      }
    }

    recognition.onerror = (event: any) => {
      const msg: Record<string, string> = {
        'no-speech': 'Речь не обнаружена. Попробуйте ещё раз.',
        'audio-capture': 'Не удалось захватить аудио. Проверьте микрофон.',
        'not-allowed': 'Доступ к микрофону запрещён. Разрешите в настройках браузера.',
      }
      onError?.(msg[event.error] || `Ошибка: ${event.error}`)
      setState('error')
    }

    recognition.onend = () => setState('idle')

    recognitionRef.current = recognition
    try {
      recognition.start()
    } catch (e: any) {
      onError?.(`Не удалось начать: ${e.message}`)
      setState('error')
    }
  }, [language, onTranscript, onError])

  const toggleListening = useCallback(() => {
    state === 'listening' ? stopListening() : startListening()
  }, [state, startListening, stopListening])

  useEffect(() => () => { if (recognitionRef.current) try { recognitionRef.current.stop() } catch {} }, [])

  return { state, isSupported, startListening, stopListening, toggleListening }
}
