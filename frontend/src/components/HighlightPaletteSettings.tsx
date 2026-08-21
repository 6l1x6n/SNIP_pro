import { useState } from 'react'
import { listPaletteOptions, getPalette, type PaletteId } from '../utils/highlight'
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

export function HighlightPaletteSettings({ highlightPalette, setHighlightPalette, monoHex, setMonoHex }: {
  highlightPalette: PaletteId
  setHighlightPalette: (v: PaletteId) => void
  monoHex: string
  setMonoHex: (v: string) => void
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
  const renderPreview = () => {
    if (highlightPalette === 'mono') {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {[0, 1, 2].map((i) => (
            <span key={i} className="px-2.5 py-1 rounded-full border text-xs font-medium" style={{ backgroundColor: monoHex, borderColor: monoHex, color: isLightHex(monoHex) ? '#1e293b' : 'white' }}>слово{i + 1}</span>
          ))}
        </div>
      )
    }
    if (highlightPalette === 'default') {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {getPalette('default').map((c, i) => (
            <span key={i} className={'px-2.5 py-1 rounded-full border text-xs font-medium ' + c.bg + ' ' + c.text + ' ' + c.border}>слово{i + 1}</span>
          ))}
        </div>
      )
    }
    const cust = custom.find((c) => c.id === highlightPalette)
    if (cust) {
      return (
        <div className="flex gap-1.5 flex-wrap">
          {cust.colors.map((hex, i) => (
            <span key={i} className="px-2.5 py-1 rounded-full border text-xs font-medium" style={{ backgroundColor: hex, borderColor: hex, color: isLightHex(hex) ? '#1e293b' : 'white' }}>слово{i + 1}</span>
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
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white"
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

      <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs">
        <div className="text-slate-600 mb-2">Превью ({highlightPalette === 'mono' ? 'моно ' + monoHex : highlightPalette === 'default' ? 'по умолчанию' : 'кастомная палитра'}):</div>
        {renderPreview()}
        <div className="text-[11px] text-slate-400 mt-2">{highlightPalette === 'mono' ? 'Все совпадения одним выбранным цветом' : 'Каждое слово запроса — своим цветом из палитры'}</div>
      </div>

      {/* Custom presets */}
      <div className="pt-1">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-700">Кастомные палитры</span>
          <span className="text-[11px] text-slate-400">{custom.length} / {MAX_CUSTOM_PRESETS} (макс. 5 с дефолтом)</span>
        </div>

        <div className="space-y-2">
          {custom.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2 rounded-xl border border-slate-200 bg-white">
              <div className="flex gap-1">
                {c.colors.slice(0, 6).map((hex, i) => (
                  <span key={i} className="w-4 h-4 rounded-full border border-slate-200" style={{ backgroundColor: hex }} />
                ))}
              </div>
              <span className="text-sm font-medium text-slate-800 flex-1 min-w-0 truncate">{c.name}</span>
              <button onClick={() => { if (editingId === c.id) { setEditingId(null) } else { setEditingId(c.id); setEditName(c.name); setEditColors(c.colors) } }} className="text-[11px] px-2 py-1 rounded-full bg-slate-100 border border-slate-200 hover:bg-slate-50">✎</button>
              <button onClick={() => onDelete(c.id)} className="text-[11px] px-2 py-1 rounded-full bg-white border border-slate-200 hover:border-red-200 hover:text-red-500">×</button>
            </div>
          ))}
          {custom.length === 0 && !creating && (
            <div className="text-xs text-slate-400 p-3 border border-dashed rounded-xl text-center">Нет кастомных палитр — создайте ниже</div>
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
            className="mt-2 px-3 py-2 text-xs rounded-xl bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-40 transition w-full"
          >+ Создать палитру</button>
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
    <div className="mt-3 p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
      <div className="text-xs font-semibold text-slate-700">{title}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название палитры" className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm bg-white" maxLength={24} />
      <div className="flex flex-wrap items-center gap-2">
        {colors.map((hex, i) => (
          <div key={i} className="flex items-center gap-1">
            <input type="color" value={hex} onChange={(e) => setColorAt(i, e.target.value)} className="w-8 h-8 p-0 rounded border border-slate-200" />
            <button onClick={() => removeColor(i)} className="text-slate-400 hover:text-red-500 text-xs">×</button>
          </div>
        ))}
        {colors.length < 8 && (
          <button onClick={addColor} className="w-8 h-8 rounded border border-dashed border-slate-300 text-slate-400 hover:text-blue-600 hover:border-blue-300 flex items-center justify-center">+</button>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={onSave} className="px-3 py-1.5 text-xs rounded-xl bg-blue-600 text-white hover:bg-blue-700">Сохранить</button>
        <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded-xl bg-white border border-slate-200 hover:bg-slate-50">Отмена</button>
        {onDelete && <button onClick={onDelete} className="ml-auto px-3 py-1.5 text-xs rounded-xl bg-white border border-slate-200 hover:border-red-200 hover:text-red-500">Удалить</button>}
      </div>
    </div>
  )
}
