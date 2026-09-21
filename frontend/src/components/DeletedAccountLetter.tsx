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

/** Текст с именем пользователя, выделенным градиентом («Уважаемый Max!» — имя цветом). */
function withGradientName(text: string, name: string | null): ReactNode {
  const who = String(name ?? '').trim()
  if (!who) return text
  const i = text.indexOf(who)
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold bg-gradient-to-r from-blue-500 via-violet-500 to-fuchsia-500 bg-clip-text text-transparent">
        {who}
      </span>
      {text.slice(i + who.length)}
    </>
  )
}

/**
 * Минималистичное «письмо» владельцу удалённого аккаунта: от администратора,
 * который выполнил удаление, заголовок-причина и описание с именем в градиенте.
 * Показывается после проверки пароля при попытке входа.
 */
export function DeletedAccountLetter({ notice, onClose }: { notice: DeletedNotice; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Icon name="shield" size={13} className="shrink-0" />
          <span className="truncate">От: {notice.deleted_by}</span>
        </div>
        <div className="px-5 py-5 space-y-3">
          <h3 className="font-semibold text-slate-900 dark:text-white">{notice.reason_title}</h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {withGradientName(notice.reason_text, notice.full_name)}
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500 pt-3 border-t border-slate-100 dark:border-slate-800">
            Аккаунт находится в архиве до {ruDate(notice.purge_after)}. По вопросам восстановления пишите на адрес выше.
          </p>
        </div>
      </div>
      <button onClick={onClose} className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
        ← Назад ко входу
      </button>
    </div>
  )
}
