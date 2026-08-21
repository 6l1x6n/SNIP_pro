/**
 * Shared badge/status utilities.
 * Single source of truth — no more duplicated functions.
 */

export function statusBadge(status: string): { label: string; cls: string } {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: 'действует', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    replaced: { label: 'заменён', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    expired: { label: 'утратил силу', cls: 'bg-red-100 text-red-700 border-red-200' },
    amended: { label: 'изменён', cls: 'bg-blue-100 text-blue-700 border-blue-200' },
    draft: { label: 'проект', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  }
  return map[status] || { label: status, cls: 'bg-slate-100 text-slate-700 border-slate-200' }
}

export function relevanceColor(pct: number): string {
  if (pct >= 90) return 'bg-emerald-500'
  if (pct >= 75) return 'bg-blue-500'
  if (pct >= 55) return 'bg-amber-500'
  return 'bg-slate-400'
}

export function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h} 70% 45%)`
}
