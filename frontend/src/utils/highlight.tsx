import React from 'react'
import { loadCustomPalettes, type CustomPalette } from './highlightPresets'
import { SEMANTIC_SYNONYMS } from './semanticSynonyms'
import { isSemanticMode } from '../search/engine'

export type PaletteId = string

/** Режим акцента контекста в PDF: заливка зоны или стикер со стрелкой сбоку. */
export type ContextMarkMode = 'fill' | 'sticker'

const CONTEXT_MARK_MODE_KEY = 'snip_context_mark_mode'

export function loadContextMarkMode(): ContextMarkMode {
  try {
    const v = localStorage.getItem(CONTEXT_MARK_MODE_KEY)
    if (v === 'sticker' || v === 'fill') return v
  } catch {}
  return 'fill'
}

export function saveContextMarkMode(v: ContextMarkMode) {
  try { localStorage.setItem(CONTEXT_MARK_MODE_KEY, v) } catch {}
}

export type PaletteColor = {
  bg: string
  text: string
  border: string
  // for inline style fallback when custom hex provided
  bgHex?: string
  textHex?: string
}

// Built-in palettes: only "default" (the previous pastel) and "mono" (single color mode) remain.
// All other color combinations are user-defined custom presets (see highlightPresets.ts).
export const PALETTES: Record<string, PaletteColor[]> = {
  default: [
    { bg: 'bg-amber-200', text: 'text-amber-900', border: 'border-amber-300' },
    { bg: 'bg-sky-200', text: 'text-sky-900', border: 'border-sky-300' },
    { bg: 'bg-emerald-200', text: 'text-emerald-900', border: 'border-emerald-300' },
    { bg: 'bg-violet-200', text: 'text-violet-900', border: 'border-violet-300' },
    { bg: 'bg-rose-200', text: 'text-rose-900', border: 'border-rose-300' },
    { bg: 'bg-cyan-200', text: 'text-cyan-900', border: 'border-cyan-300' },
  ],
  mono: [
    { bg: 'bg-amber-200', text: 'text-amber-950', border: 'border-amber-300' },
    { bg: 'bg-amber-300', text: 'text-amber-950', border: 'border-amber-400' },
    { bg: 'bg-yellow-200', text: 'text-yellow-950', border: 'border-yellow-300' },
    { bg: 'bg-orange-200', text: 'text-orange-950', border: 'border-orange-300' },
  ],
}

// Labels for the always-available built-ins. Custom presets provide their own names.
export const PALETTE_LABELS: Record<string, string> = {
  default: 'По умолчанию',
  mono: 'Моно (один цвет)',
}

/** List the selectable highlight options: built-ins + custom presets. */
export function listPaletteOptions(custom?: CustomPalette[]): { id: string; label: string }[] {
  const cust = custom ?? loadCustomPalettes()
  return [
    { id: 'default', label: PALETTE_LABELS.default },
    { id: 'mono', label: PALETTE_LABELS.mono },
    ...cust.map((c) => ({ id: c.id, label: c.name })),
  ]
}

export function getPalette(id: string): PaletteColor[] {
  if (id === 'mono') return PALETTES.mono
  if (id === 'default' || !id) return PALETTES.default
  // custom preset → build colors from stored hex list
  const cust = loadCustomPalettes().find((c) => c.id === id)
  if (cust && cust.colors.length) return cust.colors.map((hex) => monoColorToPalette(hex))
  return PALETTES.default
}

function hexToRgb(hex: string): {r:number,g:number,b:number}|null {
  const h = hex.replace('#','').trim()
  if (h.length===3) {
    const r = parseInt(h[0]+h[0],16), g=parseInt(h[1]+h[1],16), b=parseInt(h[2]+h[2],16)
    return {r,g,b}
  }
  if (h.length===6) {
    const r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16)
    return {r,g,b}
  }
  return null
}
function isLightHex(hex: string): boolean {
  const rgb = hexToRgb(hex)
  if (!rgb) return true
  // luminance
  const lum = (0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b)/255
  return lum > 0.62
}
export function monoColorToPalette(hex: string): PaletteColor {
  const light = isLightHex(hex)
  return { bg: `bg-[${hex}]`, text: light ? 'text-slate-900' : 'text-white', border: `border-[${hex}]` }
}

function escapeReg(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Make ё ↔ е interchangeable in both query and text highlighting
function yoVariants(s: string): string {
  // replace each е/ё with [её] for regex, after escaping
  // Use single regex to avoid double-replacement of inserted brackets
  const esc = escapeReg(s)
  return esc.replace(/[её]/g, '[её]')
}

function normalizeQuery(q: string): string {
  // kz-буквы сохраняем: иначе казахские слова в подсветке разваливаются
  return q.toLowerCase().replace(/ё/g, 'е').replace(/[^\w\s\-а-яёәғқңөұүһі]/gi, ' ').replace(/\s+/g, ' ').trim()
}

export type TokenInfo = { token: string; index: number; color: PaletteColor }

/** Extract tokens from query, preserving order, dedup, filter len>=2 */
export function extractTokens(query: string): string[] {
  const norm = normalizeQuery(query)
  if (!norm) return []
  const raw = norm.split(/\s+/).filter(w => w.length >= 2)
  // also split hyphen compounds?
  const expanded: string[] = []
  for (const w of raw) {
    // keep original and also split hyphen parts if length
    if (w.includes('-')) {
      const parts = w.split('-').filter(p => p.length >= 2)
      expanded.push(w, ...parts)
    } else {
      expanded.push(w)
    }
  }
  // dedup preserving order, sort by length desc for regex priority but keep color index by original order
  const seen = new Set<string>()
  const dedup: string[] = []
  for (const t of expanded) {
    const low = t.toLowerCase()
    if (!seen.has(low)) {
      seen.add(low)
      dedup.push(t)
    }
  }
  // sort for regex longest first to avoid partial overlap, but we need to keep color mapping by dedup order
  // Instead sort copy for regex, but color mapping should still be by dedup index.
  return dedup
}

export function buildTokenMap(query: string, paletteId: string = 'default', monoHex?: string): { tokens: string[]; tokenMap: Map<string, TokenInfo>; regex: RegExp | null; synRules: { re: RegExp; info: TokenInfo }[] } {
  const tokens = extractTokens(query)
  if (tokens.length === 0) return { tokens: [], tokenMap: new Map(), regex: null, synRules: [] }
  let palette = getPalette(paletteId)
  // моно: один цвет для всех токенов, если выбран monoHex — используем его
  if (paletteId==='mono' && monoHex) {
    const single = monoColorToPalette(monoHex)
    palette = [single]
  }
  const tokenMap = new Map<string, TokenInfo>()
  tokens.forEach((t, i) => {
    // для mono — все один цвет (palette[0]), для остальных — разные
    const col = paletteId==='mono' && monoHex ? palette[0] : palette[i % palette.length]
    tokenMap.set(t.toLowerCase(), { token: t, index: i, color: col })
  })
  // Смысловой режим: варианты синонимов красятся цветом исходного токена
  // («элементами ограждения» — тем же цветом, что «перилами»).
  // Точная форма + префикс с допуском окончания: покрывает склонения
  // («поручни», «поручня») и букву ё. Класс [а-яё] — ё вне диапазона а-я.
  const synFrags: string[] = []
  const synInfos: TokenInfo[] = []
  const seenFrag = new Set<string>()
  if (isSemanticMode()) {
    for (const t of tokens) {
      const info = tokenMap.get(t.toLowerCase())
      if (!info) continue
      for (const [rawKey, syns] of Object.entries(SEMANTIC_SYNONYMS)) {
        // Ключ нормализуем как запрос (ё→е): токены уже нормализованы,
        // иначе «проём» не совпадёт с токеном «проем».
        const key = rawKey.toLowerCase().replace(/ё/g, 'е')
        if (!t.toLowerCase().includes(key)) continue
        for (const s of syns) {
          const words = s.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)
          if (!words.length) continue
          const frag = words
            .map((w) => `(?:${yoVariants(w)}|${yoVariants(w.slice(0, Math.min(5, w.length)))}[а-яё]{0,6})`)
            .join('\\s+')
          if (seenFrag.has(frag)) continue
          seenFrag.add(frag)
          synFrags.push(frag)
          synInfos.push(info)
        }
      }
    }
  }
  // Build regex longest first — with ё/е variants
  const sorted = [...tokens].sort((a, b) => b.length - a.length)
  const pattern = [...sorted.map(t => yoVariants(t)), ...synFrags.map((f) => `(?:${f})`)].join('|')
  const synRules: { re: RegExp; info: TokenInfo }[] = []
  synFrags.forEach((f, k) => {
    try {
      synRules.push({ re: new RegExp(`^(?:${f})$`, 'i'), info: synInfos[k] })
    } catch {}
  })
  try {
    const regex = new RegExp(`(${pattern})`, 'gi')
    return { tokens, tokenMap, regex, synRules }
  } catch {
    return { tokens, tokenMap, regex: null, synRules: [] }
  }
}

export function highlightText(text: string, query: string, paletteId: string = 'default', monoHex?: string): React.ReactNode {
  if (!text || !query) return text
  const { tokenMap, regex, synRules } = buildTokenMap(query, paletteId, monoHex)
  if (!regex || tokenMap.size === 0) return text
  const parts = text.split(regex)
  if (parts.length === 1) return text

  // Сегменты: совпадение (с цветом) либо обычный текст.
  // Синонимы смыслового режима маппятся на цвет исходного токена.
  const segs: { text: string; info: TokenInfo | null }[] = []
  for (const part of parts) {
    if (!part) continue
    // normalize ё→е for map lookup (query normalized, but text may have ё)
    const key = part.toLowerCase().replace(/ё/g, 'е')
    const info = tokenMap.get(key) ?? synRules.find((r) => r.re.test(part))?.info ?? null
    segs.push({ text: part, info })
  }
  if (!segs.some((s) => s.info)) return text

  // Стык между двумя совпадениями, который можно склеить в одну заливку:
  // короткий разделитель (пробел/пунктуация до 3 символов), без слов между ними.
  const isJoiner = (s: string) => /^[\s.,;:!?«»""''()\-–—]{1,3}$/.test(s)

  const renderMark = (joined: string, c: PaletteColor, key: string | number): React.ReactNode => {
    const useHex = c.bg.startsWith('bg-[#')
    if (useHex) {
      const hex = c.bg.slice(4, -1) // extract #...
      const dark = c.text === 'text-white'
      return (
        <mark
          key={key}
          className="px-1 rounded-md font-semibold"
          style={{ backgroundColor: hex, color: dark ? '#fff' : '#1e293b' }}
        >
          {joined}
        </mark>
      )
    }
    // Однотонная заливка без рамок: тёмный текст поверх — читаемо, стыков нет
    return (
      <mark key={key} className={`px-1 rounded-md font-semibold text-slate-900 ${c.bg}`}>
        {joined}
      </mark>
    )
  }

  const out: React.ReactNode[] = []
  let i = 0
  while (i < segs.length) {
    const cur = segs[i]
    if (!cur.info) {
      out.push(<React.Fragment key={`t${i}`}>{cur.text}</React.Fragment>)
      i++
      continue
    }
    // Группа: совпадение (+ разделитель + совпадение)* — один тон по первому токену
    const chunks: string[] = [cur.text]
    const firstColor = cur.info.color
    let k = i + 1
    while (
      k + 1 < segs.length &&
      !segs[k].info &&
      isJoiner(segs[k].text) &&
      segs[k + 1].info
    ) {
      chunks.push(segs[k].text, segs[k + 1].text)
      k += 2
    }
    out.push(renderMark(chunks.join(''), firstColor, `m${i}`))
    i = k
  }
  return out
}

export function HighlightLegend({ query, paletteId = 'default', monoHex }: { query: string; paletteId?: string, monoHex?: string }) {
  const { tokens, tokenMap } = buildTokenMap(query, paletteId, monoHex)
  if (tokens.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tokens.slice(0, 8).map(t => {
        const info = tokenMap.get(t.toLowerCase())!
        const c = info.color
        const useHex = c.bg.startsWith('bg-[#')
        const bgHex = useHex ? c.bg.slice(4, -1) : null
        const borderHex = useHex && c.border.startsWith('border-[#') ? c.border.slice(8, -1) : bgHex
        return (
          <span
            key={t}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border font-medium ${useHex ? c.text : `${c.bg} ${c.text} ${c.border}`}`}
            style={useHex ? { backgroundColor: bgHex!, borderColor: borderHex! } : undefined}
          >
            <span className="w-2 h-2 rounded-full" style={useHex ? { backgroundColor: bgHex!, filter: 'brightness(0.85)' } : undefined} />
            {t}
          </span>
        )
      })}
      {tokens.length > 8 && <span className="text-[11px] text-slate-400">+{tokens.length - 8}</span>}
    </div>
  )
}
