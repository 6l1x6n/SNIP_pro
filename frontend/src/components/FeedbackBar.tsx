// FeedbackBar — минималистичный фидбек под главным ИИ-ответом: 👍/👎 + причина + коммент.
// Без списания токенов. Повторный голос блокируется через localStorage.

import { useState } from 'react'
import { WORKER_BASE, authFetch } from '../utils/api'
import { Icon } from './Icon'

export const FEEDBACK_REASONS: { key: string; label: string }[] = [
  { key: 'wrong_paragraph', label: 'Неверный пункт' },
  { key: 'no_quote', label: 'Нет цитаты' },
  { key: 'off_topic', label: 'Не по теме' },
  { key: 'outdated', label: 'Устарело' },
]

interface FeedbackBarProps {
  query: string
  mode?: string
  provider?: string
  chunkIds?: (string | number)[]
  paragraph?: string
  answerExcerpt?: string
}

function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

async function sendFeedback(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await authFetch(`${WORKER_BASE}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return r.ok
  } catch {
    return false
  }
}

export function FeedbackBar({ query, mode, provider, chunkIds, paragraph, answerExcerpt }: FeedbackBarProps) {
  const storeKey = `snip_fb_${hashKey(query + '|' + (answerExcerpt || '').slice(0, 200))}`
  const [voted, setVoted] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(storeKey)
      return v === '1' ? 1 : v === '-1' ? -1 : null
    } catch {
      return null
    }
  })
  const [reason, setReason] = useState('')
  const [comment, setComment] = useState('')
  const [reportSent, setReportSent] = useState(false)
  const [sending, setSending] = useState(false)

  const base = {
    query: query.slice(0, 500),
    mode: mode || '',
    provider: provider || '',
    chunkIds: (chunkIds || []).slice(0, 5),
    paragraph: paragraph || '',
    answerExcerpt: (answerExcerpt || '').slice(0, 500),
  }

  const vote = async (rating: 1 | -1) => {
    if (voted !== null || sending) return
    setSending(true)
    setVoted(rating)
    try {
      localStorage.setItem(storeKey, String(rating))
    } catch {}
    // 👍 уходит сразу; 👎 — сначала выбор причины (отправим вместе с репортом)
    if (rating === 1) {
      await sendFeedback({ ...base, rating })
    }
    setSending(false)
  }

  const sendReport = async () => {
    if (sending) return
    setSending(true)
    const ok = await sendFeedback({ ...base, rating: -1, reason, comment: comment.trim() })
    if (ok) setReportSent(true)
    setSending(false)
  }

  if (voted === 1) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="badge border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
          <Icon name="check" size={11} /> Спасибо, учтём
        </span>
      </div>
    )
  }

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-400">Ответ помог?</span>
        <button
          onClick={() => vote(1)}
          disabled={voted !== null && voted === 1}
          title="Ответ помог"
          className="icon-btn w-8 h-8 border border-slate-200 dark:border-slate-700 hover:text-emerald-600 hover:border-emerald-300"
        >
          <Icon name="thumbUp" size={14} />
        </button>
        <button
          onClick={() => vote(-1)}
          disabled={voted !== null}
          title="Ответ не помог"
          className={`icon-btn w-8 h-8 border transition ${
            voted === -1
              ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-600'
              : 'border-slate-200 dark:border-slate-700 hover:border-red-300 hover:text-red-500'
          }`}
        >
          <Icon name="thumbDown" size={14} />
        </button>
        {voted === -1 && !reportSent && <span className="text-slate-400">что именно не так?</span>}
        {reportSent && (
          <span className="badge border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
            <Icon name="check" size={11} /> Спасибо, учтём
          </span>
        )}
      </div>

      {voted === -1 && !reportSent && (
        <div className="mt-2 animate-[slideUp_.2s_ease-out]">
          <div className="flex flex-wrap gap-1.5">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r.key}
                onClick={() => setReason(reason === r.key ? '' : r.key)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition ${
                  reason === r.key
                    ? 'bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-red-200'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex max-md:flex-col gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Комментарий (необязательно)…"
              maxLength={1000}
              className="input flex-1 min-w-0 py-1.5 text-xs"
            />
            <button
              onClick={sendReport}
              disabled={sending}
              className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200 shrink-0 max-md:w-full"
            >
              {sending ? '…' : 'Сообщить'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
