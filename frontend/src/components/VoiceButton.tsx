// @ts-nocheck
import { useVoiceSearch } from '../hooks/useVoiceSearch'
import { useToast } from './Toast'
import { Icon } from './Icon'

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
  const isProcessing = (state as string) === 'processing'

  return (
    <button
      type="button"
      onClick={toggleListening}
      disabled={isProcessing}
      title={isListening ? 'Остановить запись' : isProcessing ? 'Распознаём через резерв…' : 'Голосовой поиск'}
      aria-label={isListening ? 'Остановить запись' : 'Голосовой поиск'}
      className={`relative w-10 h-10 max-md:w-9 max-md:h-9 rounded-xl flex items-center justify-center transition shrink-0 ${
        isListening
          ? 'bg-red-500 text-white animate-pulse'
          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200'
      } ${className}`}
    >
      <Icon name="mic" size={19} strokeWidth={2} />
      {isListening && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white animate-ping" />
      )}
    </button>
  )
}
