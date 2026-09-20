import { useState } from 'react'
import { SEGMENT_LABEL, SEGMENT_COLOR, type Segment, type ModelUsage } from '../../hooks/useAdmin'
import { Icon } from '../Icon'

function pct(x: number, n: number): number {
  if (!n) return 0
  return Math.min(100, Math.round((x / n) * 100))
}

function barColor(p: number): string {
  if (p >= 90) return 'bg-red-500'
  if (p >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

/** Кольцевая диаграмма сегментов (чистый SVG, без зависимостей). */
export function SegmentDonut({ segments, size = 132 }: { segments: { seg: Segment; n: number }[]; size?: number }) {
  const total = segments.reduce((s, x) => s + x.n, 0)
  const R = 48
  const C = 2 * Math.PI * R
  let acc = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 120 120" className="shrink-0">
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="16" className="stroke-slate-100 dark:stroke-slate-800" />
        {total > 0 &&
          segments.map((x) => {
            const frac = x.n / total
            const el = (
              <circle
                key={x.seg}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke={SEGMENT_COLOR[x.seg] || '#cbd5e1'}
                strokeWidth="16"
                strokeDasharray={`${Math.max(0, frac * C - 1.5)} ${C}`}
                strokeDashoffset={-acc * C}
                transform="rotate(-90 60 60)"
                strokeLinecap="butt"
              />
            )
            acc += frac
            return el
          })}
        <text x="60" y="58" textAnchor="middle" className="fill-slate-900 dark:fill-white" fontSize="20" fontWeight="700">
          {total}
        </text>
        <text x="60" y="74" textAnchor="middle" className="fill-slate-400" fontSize="10">
          вызовов
        </text>
      </svg>
      <div className="space-y-1.5 text-xs min-w-0">
        {segments.map((x) => (
          <div key={x.seg} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: SEGMENT_COLOR[x.seg] }} />
            <span className="text-slate-600 dark:text-slate-300">{SEGMENT_LABEL[x.seg] || x.seg}</span>
            <span className="ml-auto tabular-nums text-slate-500 pl-3">
              {x.n} · {total ? Math.round((x.n / total) * 100) : 0}%
            </span>
          </div>
        ))}
        {total === 0 && <div className="text-slate-400">Пока нет вызовов</div>}
      </div>
    </div>
  )
}

/** Карточка использования модели: x/N + % + клик → модалка с донатом по сегментам. */
export function ModelUsageCard({
  title,
  model,
  usage,
  kind,
}: {
  title: string
  model: string
  usage: ModelUsage
  kind: 'ask' | 'explain' | 'embed'
}) {
  const [open, setOpen] = useState(false)
  const x = usage.x ?? usage.x_est ?? 0
  const p = pct(x, usage.n)
  // API отдаёт seg строкой — кастуем к union; неизвестные сегменты не приходят
  const segs = (usage.by_segment || []).map((s) => ({ seg: s.seg as Segment, n: s.n }))
  const total = segs.reduce((s, v) => s + v.n, 0)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Нажмите — разбивка по подпискам"
        className="text-left card card-hover p-4 w-full"
      >
        <div className="flex items-center gap-2">
          <div className="text-xs text-slate-500 dark:text-slate-400">{title}</div>
          {usage.shared_pool && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950 border border-violet-200 dark:border-violet-900 text-violet-700 dark:text-violet-300">
              общий пул Groq
            </span>
          )}
          {usage.estimate && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500">
              оценка
            </span>
          )}
        </div>
        <div className="mt-1 font-mono text-[11px] text-slate-400 truncate">{model}</div>
        <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white tabular-nums">
          {x.toLocaleString('ru-RU')}
          <span className="text-sm font-normal text-slate-400"> / {usage.n.toLocaleString('ru-RU')}</span>
          <span className={`ml-2 text-sm font-bold ${p >= 90 ? 'text-red-500' : p >= 70 ? 'text-amber-500' : 'text-emerald-600'}`}>
            {p}%
          </span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full ${barColor(p)} transition-all`} style={{ width: `${p}%` }} />
        </div>
        <div className="mt-1.5 text-[11px] text-slate-400">Нажмите — кто сколько: гости / бесплатные / PRO / бизнес</div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-[fadeIn_.15s_ease-out]"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div className="w-full max-w-md card shadow-xl p-5 animate-[popIn_.18s_ease-out] max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div>
                <div className="font-semibold text-slate-900 dark:text-white text-sm">{title}</div>
                <div className="font-mono text-[11px] text-slate-400">{model}</div>
              </div>
              <button onClick={() => setOpen(false)} className="icon-btn w-8 h-8 shrink-0"><Icon name="close" size={15} /></button>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-3">
              {x.toLocaleString('ru-RU')} из {usage.n.toLocaleString('ru-RU')} ({p}%)
              {usage.shared_pool && ' • пул общий с Groq-ответами'}
              {usage.estimate && ' • эмбеддинги: оценка (fast×1 + deep×2)'}
              {kind === 'ask' && usage.refunds ? ` • возвратов: ${usage.refunds}` : ''}
            </div>
            <SegmentDonut segments={segs} />
            <div className="mt-4 space-y-1.5">
              {segs.map((s) => {
                const sp = total ? Math.round((s.n / total) * 100) : 0
                return (
                  <div key={s.seg}>
                    <div className="flex text-xs mb-0.5">
                      <span className="text-slate-600 dark:text-slate-300">{SEGMENT_LABEL[s.seg]}</span>
                      <span className="ml-auto tabular-nums text-slate-500">{s.n.toLocaleString('ru-RU')} · {sp}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${sp}%`, background: SEGMENT_COLOR[s.seg] }} />
                    </div>
                  </div>
                )
              })}
            </div>
            {usage.note && <div className="text-[11px] text-slate-400 mt-3">{usage.note}</div>}
          </div>
        </div>
      )}
    </>
  )
}
