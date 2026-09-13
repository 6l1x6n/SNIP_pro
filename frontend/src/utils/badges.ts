/**
 * Shared badge/status utilities.
 * Single source of truth — no more duplicated functions.
 */

export function statusBadge(status: string): { label: string; cls: string } {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: 'действует', cls: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' },
    replaced: { label: 'заменён', cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900' },
    expired: { label: 'утратил силу', cls: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900' },
    amended: { label: 'изменён', cls: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' },
    draft: { label: 'проект', cls: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' },
  };
  return map[status] || { label: status, cls: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' }
}

export function relevanceColor(pct: number): string {
  if (pct >= 90) return 'bg-slate-900 dark:bg-white dark:text-slate-900'
  if (pct >= 75) return 'bg-slate-600'
  if (pct >= 55) return 'bg-slate-400'
  return 'bg-slate-300 dark:bg-slate-700'
}

export function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h} 70% 45%)`
}
