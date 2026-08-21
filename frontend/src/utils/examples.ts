// Quick-suggestion buttons shown under the main search bar.
// User-editable in Settings → "Быстрые подсказки".

export const QUICK_EXAMPLES_KEY = 'snip_quick_examples'
export const QUICK_EXAMPLES_EVENT = 'snip:quick-examples'
export const QUICK_EXAMPLES_MAX = 10

export const DEFAULT_EXAMPLES: string[] = [
  'Минимальная ширина коридора в общественном здании',
  'Требования к высоте помещения',
  'Минимальное расстояние между зданиями',
  'Ширина эвакуационного выхода',
  'Состав проектно-сметной документации',
  'Порядок утверждения проекта',
]

function sanitize(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null
  const out = list
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
    .slice(0, QUICK_EXAMPLES_MAX)
  return out
}

export function loadQuickExamples(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_EXAMPLES_KEY)
    if (raw === null) return DEFAULT_EXAMPLES
    const parsed = sanitize(JSON.parse(raw))
    return parsed ?? DEFAULT_EXAMPLES
  } catch {
    return DEFAULT_EXAMPLES
  }
}

export function saveQuickExamples(list: string[]): void {
  try {
    const cleaned = (list.map((x) => x.trim()).filter((x) => x.length > 0))
    localStorage.setItem(QUICK_EXAMPLES_KEY, JSON.stringify(cleaned.slice(0, QUICK_EXAMPLES_MAX)))
    window.dispatchEvent(new Event(QUICK_EXAMPLES_EVENT))
  } catch {}
}

export function resetQuickExamples(): string[] {
  try { localStorage.removeItem(QUICK_EXAMPLES_KEY) } catch {}
  window.dispatchEvent(new Event(QUICK_EXAMPLES_EVENT))
  return DEFAULT_EXAMPLES
}
