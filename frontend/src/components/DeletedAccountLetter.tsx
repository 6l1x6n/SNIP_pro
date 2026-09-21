import { Icon } from './Icon'

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

/**
 * Минималистичное «письмо» владельцу удалённого аккаунта: видно, кто отправил
 * (почта администратора, выполнившего удаление), персональное обращение с именем
 * градиентом, причина и описание. Показывается после проверки пароля при входе.
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
          <p className="text-sm text-slate-700 dark:text-slate-200">
            Уважаемый{' '}
            <span className="font-semibold bg-gradient-to-r from-blue-500 via-violet-500 to-fuchsia-500 bg-clip-text text-transparent">
              {notice.full_name || 'пользователь'}
            </span>
            !
          </p>
          <h3 className="font-semibold text-slate-900 dark:text-white">{notice.reason_title}</h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{notice.reason_text}</p>
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
