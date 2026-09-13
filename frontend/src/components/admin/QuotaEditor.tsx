// @ts-nocheck — как и остальные views, типы правим инкрементально
import { useState } from 'react'
import { saveAdminSetting } from '../../hooks/useAdmin'
import { Icon } from '../Icon'

export const QUOTA_FIELDS: { key: string; label: string; hint: string; unit: string }[] = [
  { key: 'quota_anon', label: 'Гостям в день', hint: 'Бесплатный лимит без входа, сброс в 00:00 UTC', unit: 'кредитов/день' },
  { key: 'quota_user', label: 'Пользователям в час', hint: 'Акция: каждый час заново', unit: 'кредитов/час' },
  { key: 'cost_fast', label: 'Быстрый поиск', hint: '3 результата', unit: 'кредитов' },
  { key: 'cost_deep', label: 'Глубокий поиск', hint: 'До 30 результатов + ответ', unit: 'кредитов' },
  { key: 'cost_followup', label: 'Уточняющий вопрос', hint: 'Follow-up к ответу, без нового поиска', unit: 'кредитов' },
  { key: 'explain_cap', label: 'Объяснения фрагментов', hint: 'В день, только подписчикам PRO/Бизнес', unit: '/день' },
]

export const CAP_FIELDS: { key: string; label: string; hint: string; unit: string }[] = [
  { key: 'cap_groq_rpd', label: 'Потолок Groq', hint: 'N для карточек ответов и объяснятора (free RPD)', unit: '/день' },
  { key: 'cap_embed_rpd', label: 'Потолок эмбеддингов', hint: 'N для карточки Gemini — сверьте с AI Studio', unit: '/день' },
]
/** Карточка лимита с редактированием по клику (сохранение через /api/admin/settings). */
export function QuotaCard({
  field,
  value,
  meta,
  onSaved,
}: {
  field: { key: string; label: string; hint: string; unit: string }
  value: number
  meta?: { custom: boolean; updated_at: string | null; min: number; max: number }
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setErr(null)
    const v = Math.floor(Number(draft))
    if (!Number.isFinite(v)) {
      setErr('Введите число')
      return
    }
    setSaving(true)
    try {
      await saveAdminSetting(field.key, v)
      setEditing(false)
      onSaved()
    } catch (e: any) {
      setErr(e?.message || 'Не сохранилось')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
      <div className="flex items-center gap-2">
        <div className="text-xs text-slate-500 dark:text-slate-400">{field.label}</div>
        <button
          onClick={() => {
            setDraft(String(value))
            setErr(null)
            setEditing((v) => !v)
          }}
          title="Изменить"
          className="ml-auto icon-btn w-7 h-7"
        >
          <Icon name="edit" size={13} />
        </button>
      </div>
      {editing ? (
        <div className="mt-2">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
              className="input py-1.5 text-lg font-semibold tabular-nums"
            />
            <button onClick={save} disabled={saving} className="btn btn-sm btn-primary shrink-0">
              {saving ? '…' : 'ОК'}
            </button>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            {meta ? `от ${meta.min} до ${meta.max.toLocaleString('ru-RU')}` : ''} • вступит в силу в течение ~5 мин
          </div>
          {err && <div className="text-xs text-red-500 mt-1">{err}</div>}
        </div>
      ) : (
        <>
          <div className="text-xl font-semibold text-slate-900 dark:text-white mt-1 tabular-nums">
            {Number(value).toLocaleString('ru-RU')}
            <span className="text-sm font-normal text-slate-400"> {field.unit}</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            {field.hint}
            {meta?.custom && meta.updated_at && (
              <span className="block text-violet-500">изменено админом • {new Date(meta.updated_at).toLocaleString('ru-RU')}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
