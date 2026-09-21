import { Icon } from './Icon'
import type { ReactNode } from 'react'

export interface DeletedNotice {
  full_name: string | null
  reason_title: string
  reason_text: string
  deleted_by: string
  deleted_at: string
  purge_after: string
}

const ruDate = (iso: string) => {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso ?? '')
}

/** Имя пользователя внутри строки — градиентом. */
const GradientName = ({ children }: { children: string }) => (
  <span className="font-semibold bg-gradient-to-r from-blue-500 via-violet-500 to-fuchsia-500 bg-clip-text text-transparent">
    {children}
  </span>
)

/** Разбивает текст письма на приветствие («Уважаемый Max!») и основную часть. */
function splitGreeting(text: string, name: string | null): { greeting: ReactNode; body: string } {
  const who = String(name ?? '').trim()
  const m = /^(Уважаем[а-яё]+\s+[^!]+!)\s*([\s\S]*)$/.exec(text.trim())
  if (m) {
    const greetingLine = m[1]
    const greeting = who && greetingLine.includes(who)
      ? (
        <>
          {greetingLine.slice(0, greetingLine.indexOf(who))}
          <GradientName>{who}</GradientName>
          {greetingLine.slice(greetingLine.indexOf(who) + who.length)}
        </>
      )
      : greetingLine
    return { greeting, body: m[2].trim() }
  }
  return { greeting: null, body: text }
}

/** Основной текст с градиентным именем (если встречается ещё раз). */
function bodyWithNames(body: string, name: string | null): ReactNode {
  const who = String(name ?? '').trim()
  if (!who || !body.includes(who)) return body
  const parts = body.split(who)
  return parts.flatMap((part, i) =>
    i === 0 ? [part] : [<GradientName key={i}>{who}</GradientName>, part]
  )
}

/**
 * «Письмо» владельцу удалённого аккаунта: градиентная шапка, отправитель —
 * администратор, персональное обращение, причина-чип и описание.
 */
export function DeletedAccountLetter({ notice, onClose }: { notice: DeletedNotice; onClose: () => void }) {
  const { greeting, body } = splitGreeting(notice.reason_text, notice.full_name)
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-blue-500 via-violet-500 to-fuchsia-500" />
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Icon name="shield" size={13} className="shrink-0" />
          <span className="truncate">От: {notice.deleted_by}</span>
          <span className="ml-auto shrink-0 tabular-nums">{ruDate(notice.deleted_at)}</span>
        </div>
        <div className="px-5 py-5 space-y-4">
          {greeting && <p className="text-[15px] text-slate-700 dark:text-slate-200">{greeting}</p>}
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900 text-[11px] font-medium text-red-600 dark:text-red-300">
            <Icon name="alertCircle" size={12} /> {notice.reason_title}
          </span>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{bodyWithNames(body, notice.full_name)}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 pt-4 border-t border-slate-100 dark:border-slate-800 leading-relaxed">
            Аккаунт находится в архиве до <span className="text-slate-500 dark:text-slate-400 font-medium">{ruDate(notice.purge_after)}</span>.
            По вопросам восстановления пишите на адрес выше.
          </p>
        </div>
      </div>
      <button onClick={onClose} className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
        ← Назад ко входу
      </button>
    </div>
  )
}
