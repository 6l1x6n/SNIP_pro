// @ts-nocheck
import { useVoiceSearch } from '../hooks/useVoiceSearch'
import { useToast } from './Toast'

interface VoiceButtonProps {
  onTranscript: (text: string) => void
  className?: string
}

/**
 * Microphone button that activates browser speech recognition.
 * Shows a pulsing red indicator while recording.
 */
export function VoiceButton({ onTranscript, className = '' }: VoiceButtonProps) {
  const { showToast } = useToast()

  const { state, isSupported, toggleListening } = useVoiceSearch({
    onTranscript,
    onError: (msg) => showToast(msg, 'error', 4000),
    language: 'ru-RU',
  })

  if (!isSupported) return null

  const isListening = state === 'listening'

  return (
    <button
      type="button"
      onClick={toggleListening}
      title={isListening ? 'Остановить запись' : 'Голосовой поиск'}
      aria-label={isListening ? 'Остановить запись' : 'Голосовой поиск'}
      className={`relative w-10 h-10 rounded-xl flex items-center justify-center transition shrink-0 ${
        isListening
          ? 'bg-red-500 text-white animate-pulse shadow-lg shadow-red-500/30'
          : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700'
      } ${className}`}
    >
      {isListening ? (
        // Recording icon — waveform bars
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
          {/* Animated wave indicators */}
          <path d="M1 12c2-2 4-3 5-3" opacity="0.5" />
          <path d="M23 12c-2-2-4-3-5-3" opacity="0.5" />
        </svg>
      ) : (
        // Microphone icon
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      )}
      {isListening && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white animate-ping" />
      )}
    </button>
  )
}
