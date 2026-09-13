import { useState } from 'react'
import { listPaletteOptions, getPalette, type PaletteId, type ContextMarkMode } from '../utils/highlight'
import { Icon } from './Icon'
import {
  loadCustomPalettes,
  saveCustomPalettes,
  createCustomPalette,
  updateCustomPalette,
  MAX_CUSTOM_PRESETS,
  type CustomPalette,
} from '../utils/highlightPresets'

function isLightHex(hex: string): boolean {
  const h = hex.replace('#', '')
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16)
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16)
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62
}

const DEFAULT_NEW_COLORS = ['#fde68a', '#bae6fd', '#bbf7d0', '#ddd6fe', '#fecaca', '#a5f3fc']

export function HighlightPaletteSettings({ highlightPalette, setHighlightPalette, monoHex, setMonoHex, contextMarkMode, setContextMarkMode }: {
  highlightPalette: PaletteId
  setHighlightPalette: (v: PaletteId) => void
  monoHex: string
  setMonoHex: (v: string) => void
  contextMarkMode?: ContextMarkMode
  setContextMarkMode?: (v: ContextMarkMode) => void
}) {
  const [custom, setCustom] = useState<CustomPalette[]>(() => loadCustomPalettes())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColors, setNewColors] = useState<string[]>(DEFAULT_NEW_COLORS)
  const [editName, setEditName] = useState('')
  const [editColors, setEditColors] = useState<string[]>([])

  const refresh = (list: CustomPalette[]) => { setCustom(list); saveCustomPalettes(list) }

  const atCap = custom.length >= MAX_CUSTOM_PRESETS

  const onDelete = (id: string) => {
    if (highlightPalette === id) setHighlightPalette('default')
    refresh(custom.filter((c) => c.id !== id))
    setEditingId(null)
  }

  const onSaveEdit = (id: string, name: string, colors: string[]) => {
    updateCustomPalette(id, { name, colors })
    refresh(custom.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name, colors } : c)))
    setEditingId(null)
  }

  const onCreate = () => {
    const palette = createCustomPalette(newName || 'Моя палитра', newColors)
    const list = loadCustomPalettes()
    setCustom(list)
    setCreating(false)
    setNewName('')
    setNewColors(DEFAULT_NEW_COLORS)
    setHighlightPalette(palette.id)
  }

  // ---- preview ----
  // Мотивационная фраза вместо безликих «слово1, слово2…» — каждое слово своим цветом
  const PREVIEW_WORDS = ['Сотни', 'страниц.', 'Один', 'очень', 'любопытный', 'Snippy...']

  const renderPreview = () => {
    if (highlightPalette === 'mono') {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {PREVIEW_WORDS.map((w, i) => (
            <span key={i} className="px-2.5 py-1 rounded-full border text-xs font-medium" style={{ backgroundColor: monoHex, borderColor: monoHex, color: isLightHex(monoHex) ? '#1e293b' : 'white' }}>{w}</span>
          ))}
        </div>
      )
    }
    if (highlightPalette === 'default') {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {PREVIEW_WORDS.map((w, i) => {
            const colors = getPalette('default')
            const c = colors[i % colors.length]
            return <span key={i} className={'px-2.5 py-1 rounded-full border text-xs font-medium ' + c.bg + ' ' + c.text + ' ' + c.border}>{w}</span>
          })}
        </div>
      )
    }
    const cust = custom.find((c) => c.id === highlightPalette)
    if (cust) {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {PREVIEW_WORDS.map((w, i) => (
            <span key={i} className="px-2.5 py-1 rounded-full border text-xs font-medium" style={{ backgroundColor: cust.colors[i % cust.colors.length], borderColor: cust.colors[i % cust.colors.length], color: isLightHex(cust.colors[i % cust.colors.length]) ? '#1e293b' : 'white' }}>{w}</span>
          ))}
        </div>
      )
    }
    return null
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={highlightPalette}
          onChange={(e) => setHighlightPalette(e.target.value as PaletteId)}
          className="input w-auto px-3 py-2 dark:bg-slate-900 dark:text-white"
        >
          {listPaletteOptions(custom).map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        {highlightPalette === 'mono' && (
          <span className="inline-flex items-center gap-2">
            <input type="color" value={monoHex} onChange={(e) => setMonoHex(e.target.value)} className="w-8 h-8 p-0 rounded-full border border-slate-200 cursor-pointer" title="Цвет моно" />
            <input value={monoHex} onChange={(e) => { const v = e.target.value; if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setMonoHex(v) }} className="w-28 px-2 py-1.5 rounded-xl border border-slate-200 text-sm font-mono" />
            <span className="w-6 h-6 rounded-full border border-slate-200" style={{ backgroundColor: monoHex }} />
          </span>
        )}
      </div>

      <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs">
        <div className="text-slate-600 dark:text-slate-300 mb-2">Превью ({highlightPalette === 'mono' ? 'моно ' + monoHex : highlightPalette === 'default' ? 'по умолчанию' : 'кастомная палитра'}):</div>
        {renderPreview()}
        <div className="text-[11px] text-slate-400 mt-2">{highlightPalette === 'mono' ? 'Все совпадения одним выбранным цветом' : 'Каждое слово запроса — своим цветом из палитры'}</div>
      </div>

      {contextMarkMode && setContextMarkMode && (
        <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs">
          <div className="text-slate-600 dark:text-slate-300 mb-2">Акцент контекста в PDF:</div>
          <div className="flex rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1 gap-1" role="radiogroup" aria-label="Режим акцента контекста в PDF">
            {([
              { id: 'fill', label: 'Заливка', hint: 'Однотонная подсветка зоны' },
              { id: 'sticker', label: 'Стикер', hint: 'Заметка сбоку со стрелкой' },
            ] as { id: ContextMarkMode; label: string; hint: string }[]).map((o) => (
              <button
                key={o.id}
                role="radio"
                aria-checked={contextMarkMode === o.id}
                title={o.hint}
                onClick={() => setContextMarkMode(o.id)}
                className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition ${contextMarkMode === o.id ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-slate-400 mt-2">
            {contextMarkMode === 'sticker'
              ? 'Бумага чистая: сбоку от страницы висит стикер со стрелкой на зону контекста'
              : 'Зона контекста подсвечена одним тоном прямо на бумаге'}
          </div>
        </div>
      )}

      {/* Custom presets */}
      <div className="pt-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Кастомные палитры</span>
          <span className="text-[11px] text-slate-400">{custom.length} / {MAX_CUSTOM_PRESETS} (макс. 5 с дефолтом)</span>
        </div>

        <div className="space-y-2">
          {custom.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="flex gap-1">
                {c.colors.slice(0, 6).map((hex, i) => (
                  <span key={i} className="w-4 h-4 rounded-full border border-slate-200 dark:border-slate-700" style={{ backgroundColor: hex }} />
                ))}
              </div>
              <span className="text-sm font-medium text-slate-800 dark:text-slate-100 flex-1 min-w-0 truncate">{c.name}</span>
              <button onClick={() => { if (editingId === c.id) { setEditingId(null) } else { setEditingId(c.id); setEditName(c.name); setEditColors(c.colors) } }} title="Изменить" className="icon-btn w-7 h-7 border border-slate-200 dark:border-slate-700"><Icon name="edit" size={12} /></button>
              <button onClick={() => onDelete(c.id)} title="Удалить" className="icon-btn w-7 h-7 border border-slate-200 dark:border-slate-700 hover:text-red-500 hover:border-red-200"><Icon name="close" size={12} /></button>
            </div>
          ))}
          {custom.length === 0 && !creating && (
            <div className="text-xs text-slate-400 p-3 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-center">Нет кастомных палитр — создайте ниже</div>
          )}
        </div>

        {editingId && (
          <EditRow
            title="Изменить палитру"
            name={editName} setName={setEditName}
            colors={editColors} setColors={setEditColors}
            onCancel={() => setEditingId(null)}
            onSave={() => onSaveEdit(editingId, editName, editColors)}
            onDelete={() => onDelete(editingId)}
          />
        )}

        {creating ? (
          <EditRow
            title="Новая палитра"
            name={newName} setName={setNewName}
            colors={newColors} setColors={setNewColors}
            onCancel={() => { setCreating(false); setNewName(''); setNewColors(DEFAULT_NEW_COLORS) }}
            onSave={onCreate}
          />
        ) : (
          <button
            onClick={() => setCreating(true)}
            disabled={atCap}
            className="btn btn-sm bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-700 dark:hover:bg-slate-200 mt-2 py-2 w-full"
          ><Icon name="plus" size={12} /> Создать палитру</button>
        )}
      </div>
    </div>
  )
}

function EditRow({ title, name, setName, colors, setColors, onCancel, onSave, onDelete }: {
  title: string
  name: string
  setName: (v: string) => void
  colors: string[]
  setColors: (v: string[]) => void
  onCancel: () => void
  onSave: () => void
  onDelete?: () => void
}) {
  const setColorAt = (i: number, v: string) => {
    const next = colors.slice()
    next[i] = v
    setColors(next)
  }
  const addColor = () => { if (colors.length < 8) setColors([...colors, '#fde68a']) }
  const removeColor = (i: number) => { if (colors.length > 1) setColors(colors.filter((_, idx) => idx !== i)) }

  return (
    <div className="mt-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 space-y-2">
      <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название палитры" className="input py-1.5" maxLength={24} />
      <div className="flex flex-wrap items-center gap-2">
        {colors.map((hex, i) => (
          <div key={i} className="flex items-center gap-1">
            <input type="color" value={hex} onChange={(e) => setColorAt(i, e.target.value)} className="w-8 h-8 p-0 rounded border border-slate-200 dark:border-slate-700" />
            <button onClick={() => removeColor(i)} title="Удалить цвет" className="text-slate-400 hover:text-red-500"><Icon name="close" size={12} /></button>
          </div>
        ))}
        {colors.length < 8 && (
          <button onClick={addColor} title="Добавить цвет" className="w-8 h-8 rounded border border-dashed border-slate-300 dark:border-slate-600 text-slate-400 hover:text-blue-600 hover:border-blue-300 flex items-center justify-center"><Icon name="plus" size={13} /></button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={onSave} className="btn btn-sm btn-primary">Сохранить</button>
        <button onClick={onCancel} className="btn btn-sm btn-secondary">Отмена</button>
        {onDelete && <button onClick={onDelete} className="btn btn-sm border border-slate-200 dark:border-slate-700 text-slate-500 hover:border-red-200 hover:text-red-500 ml-auto">Удалить</button>}
      </div>
    </div>
  )
}
