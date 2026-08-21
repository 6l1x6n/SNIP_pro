// Custom user-defined highlight palettes (stored in localStorage).
// "Default" built-in palette always exists; custom presets are user-created
// sets of colors. Limit: default + up to 4 custom = 5 multi-color presets total.
// The "mono" mode (single chosen color) is a separate rendering mode and not counted.

const LS_CUSTOM = 'snip_custom_highlight_palettes'

export type CustomPalette = {
  id: string
  name: string
  colors: string[] // hex strings, e.g. "#fde68a"
}

// Max number of *custom* presets (default is separate and always present).
export const MAX_CUSTOM_PRESETS = 4

function isValidHex(h: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h.trim())
}

export function loadCustomPalettes(): CustomPalette[] {
  try {
    const raw = localStorage.getItem(LS_CUSTOM)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((p: any) => p && typeof p.id === 'string' && Array.isArray(p.colors))
      .map((p: any) => ({
        id: p.id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'Палитра',
        colors: (p.colors as string[]).filter((c) => isValidHex(c)),
      }))
  } catch {
    return []
  }
}

export function saveCustomPalettes(list: CustomPalette[]): void {
  try {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(list))
  } catch {}
}

export function canCreateCustom(): boolean {
  return loadCustomPalettes().length < MAX_CUSTOM_PRESETS
}

export function createCustomPalette(name: string, colors: string[]): CustomPalette {
  const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const palette: CustomPalette = {
    id,
    name: name.trim() || 'Моя палитра',
    colors: colors.filter(isValidHex).slice(0, 8),
  }
  const list = loadCustomPalettes()
  list.push(palette)
  saveCustomPalettes(list)
  return palette
}

export function updateCustomPalette(id: string, patch: Partial<Pick<CustomPalette, 'name' | 'colors'>>): void {
  const list = loadCustomPalettes()
  const next = list.map((p) => {
    if (p.id !== id) return p
    return {
      ...p,
      name: patch.name !== undefined ? patch.name.trim() || p.name : p.name,
      colors: patch.colors !== undefined ? patch.colors.filter(isValidHex).slice(0, 8) : p.colors,
    }
  })
  saveCustomPalettes(next)
}

export function deleteCustomPalette(id: string): void {
  const list = loadCustomPalettes().filter((p) => p.id !== id)
  saveCustomPalettes(list)
}
