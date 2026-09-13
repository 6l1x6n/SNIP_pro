// @ts-nocheck — TODO: fix TypeScript errors incrementally
import React, { useState, useEffect } from 'react'
import { statusBadge, relevanceColor } from '../utils/badges'
import { highlightText, HighlightLegend } from '../utils/highlight'
import { SnakeState } from '../components/SnakeState'
import { VoiceButton } from '../components/VoiceButton'
import { resultsToMarkdown, downloadAsFile, copyToClipboard, formatCitation, cleanParagraph, sanitizeQuote, truncateSmart, formatParagraph } from '../utils/exportUtils'
import type { SearchResponse } from '../hooks/useSearch'
import { loadQuickExamples, QUICK_EXAMPLES_EVENT } from '../utils/examples'
import { loadRecentDocs, removeRecentDoc, clearRecentDocs, RECENT_DOCS_EVENT, type RecentDoc } from '../utils/recentDocs'
import { addFavorite, removeFavorite, isFavorite, favoriteId, FAVORITES_EVENT } from '../utils/favorites'
import { FAST_COST, DEEP_COST, FOLLOWUP_COST } from '../utils/credits'
import { askFollowUp, rewriteQuery, hybridSearchLegacy } from '../search/searchClient'
import { isSemanticMode, loadIndex, bm25TopIds } from '../search/engine'
import { formatValue, formatLabel, valueBase, type ValueCard } from '../search/values'
import { ValueCardModal } from '../components/ValueCardModal'
import { ValueSourceCards } from '../components/ValueSourceCards'
import { FeedbackBar } from '../components/FeedbackBar'
import { Icon } from '../components/Icon'
import { ListRow } from '../components/ListRow'

/** Короткие подписи провайдера ИИ-ответа (приходит из /ask, бейдж — только для не-Groq звеньев). */
export const PROVIDER_LABEL: Record<string, string> = {
  groq: 'Groq',
  'groq-alt': 'Groq',
  gemini: 'Gemini',
  cerebras: 'Cerebras',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  'mistral-chat': 'Mistral',
  'cohere-chat': 'Cohere',
  custom: 'Резервный',
  cache: 'кэш',
  values: 'Значения из норм',
  'workers-ai': 'Workers AI',
  zen: 'Zen · MiMo',
  pollinations: 'Pollinations',
}

export function cleanAnswerText(s: string) {
  if (!s) return s
  // Наследие старого сбоя парсинга (больше не приходит с сервера) — человеческий текст
  if (s.trim() === 'Не удалось разобрать ответ модели.') {
    return 'Сервис ответов временно недоступен — смотрите подходящие варианты ниже.'
  }
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (t.startsWith('{') && t.includes('"answer"')) {
    try {
      const m = t.match(/\{[\s\S]*\}/)
      if (m) {
        let raw = m[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
        const j = JSON.parse(raw)
        if (j.answer && typeof j.answer === 'string') return j.answer.trim()
        if (j.ответ) return String(j.ответ).trim()
      }
    } catch {}
  }
  t = t.replace(/^\{\s*"answer"\s*:\s*"/, '').replace(/"\s*,\s*"normative_basis".*$/s, '').trim()
  // Транспортные маркеры hero-итога (⟦ИТОГ⟧…⟦/ИТОГ⟧) — наружу никогда: экспорт,
  // копирование, избранное и уточнения получают чистый текст
  t = t.replace(/⟦\/?ИТОГ⟧/g, '').replace(/[ \t]+\n/g, '\n').trim()
  return t
}

/**
 * Компактное тело старого values-кэша: подряд идущие пули «• … (источник)»
 * с ОДИНАКОВЫМ источником схлопываются — источник один раз подписью.
 * Новые ответы уже сгруппированы воркером (compactBody) — их не трогаем.
 */
export function compactBullets(body: string): string {
  if (!body || !body.includes('•')) return body
  const lines = body.split('\n')
  const out: string[] = []
  let i = 0
  const mOf = (s: string) => s.match(/^(•\s+.*?\S)\s+\(([^)]+)\)\s*$/)
  while (i < lines.length) {
    const m = mOf(lines[i])
    if (m) {
      const group = [m]
      let j = i + 1
      while (j < lines.length) {
        const mj = mOf(lines[j])
        if (!mj || mj[2] !== m[2]) break
        group.push(mj)
        j++
      }
      if (group.length >= 2) {
        out.push(`${m[2]}:`)
        for (const g of group) out.push(g[1])
        i = j
        continue
      }
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

/**
 * Permission-вопрос («можно ли», «разрешено ли», ...) vs фактоид
 * («минимальная ширина...?», «сколько...?», «какая...?»).
 * Зеркало worker isPermissionQuestion: Да/Нет-hero только для permission.
 */
export function isPermissionQuestion(query: string): boolean {
  const qN = String(query ?? '').toLowerCase().replace(/ё/g, 'е')
  if (!qN.trim()) return false
  return /(разреш|можно|допуск|запрещ|открыть|разместить|предусматр|вправе|нельзя|запрет)/.test(qN)
}

/**
 * Hero-итог ответа: ключевой фрагмент первой строки-вердикта («≥ 2,5 м», «Нет», «Да»)
 * крупным фирменным градиентом + остаток обычным текстом. Единый вид для всех типов:
 * Минимум/Максимум (values), Да/Нет (gate-override ТОЛЬКО для permission-вопросов),
 * первая строка LLM-ответа.
 * Источник: маркеры ⟦ИТОГ⟧ (новые ответы), старый values-кэш без маркеров,
 * первая строка grounded LLM-ответа («Да…» / ведущее число). Без совпадения — null.
 * query нужен чтобы не подсвечивать «Да» на фактоиде («Минимальная ширина...?» → акцент на числе).
 */
export function extractHero(
  answer: string, provider?: string, isGrounded = true, query?: string,
): { kind: 'yn' | 'minmax'; lead: string; accent: string; tail: string; rest: string } | null {
  if (!answer || !isGrounded) return null
  const permission = query ? isPermissionQuestion(query) : true
  const m = answer.match(/⟦ИТОГ⟧([\s\S]*?)⟦\/ИТОГ⟧/)
  let verdict = m ? m[1].trim() : ''
  let rest = m ? (answer.slice(0, m.index) + answer.slice((m.index ?? 0) + m[0].length)).replace(/^\s*\n/, '') : answer
  // шапка values-ответа после вырезания вердикта — мусор («Точные значения…:» дублирует hero)
  rest = rest.replace(/^Точные значения из норм[^\n]*\n/, '').replace(/^\s*\n/, '')
  if (!verdict && (provider === 'values' || provider === 'cache')) {
    // старый кэш без маркеров: вердикт может быть не первой строкой («Точные значения…\n\nМинимум — …»)
    const lm = rest.match(/(Минимум|Максимум)\s+—\s*[^\n]+/)
    if (lm && lm.index !== undefined) {
      verdict = lm[0].trim()
      rest = (rest.slice(0, lm.index) + rest.slice(lm.index + lm[0].length)).replace(/\n{3,}/g, '\n\n').trim()
    }
  }
  if (!verdict) {
    // LLM-ответ: hero только если первая строка — ведущее число;
    // «Да/Нет» — только для permission-вопросов (иначе «Да — 1,2 м» на фактоиде).
    const first = rest.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
    const clean = first.replace(/^\*\*|\*\*$/g, '').trim()
    const isYN = /^(Да|Нет)([^а-яёa-z0-9]|$)/.test(clean)
    const isNum = /^(?:более|менее|не более|не менее)?\s*[<>≤≥=]?\s*\d+[.,]?\d*\s*(м²|м|мм|см|эт\.?|чел\.?|%|°C|шт)?\b/.test(clean)
    if ((isYN && permission) || isNum) {
      verdict = clean
      rest = rest.replace(first, '').replace(/^\s*\n/, '').trim()
    } else if (isYN && !permission) {
      // Ложный «Да — ...» от LLM на фактоиде (старый кэш): срезаем префикс,
      // hero строим по остатку-числу ниже.
      const stripped = clean.replace(/^(Да|Нет)\s*[—–\-:.,]?\s*/, '').trim()
      if (stripped) {
        verdict = stripped
        rest = rest.replace(first, '').replace(/^\s*\n/, '').trim()
      }
    }
  }
  if (!verdict) return null
  // «Нет — не разрешено: …» / «Да — …» → инлайн: акцент на самом Да/Нет (kind yn).
  // Только для permission-вопросов; на фактоиде «Да — 1,2» → чистим и идем к числу.
  const yn = verdict.match(/^(Да|Нет)([^а-яёa-z0-9]|$)/)
  if (yn) {
    if (!permission) {
      const stripped = verdict.replace(/^(Да|Нет)\s*[—–\-:.,]?\s*/, '').trim()
      if (stripped) verdict = stripped
      else return null
    } else {
      return { kind: 'yn', lead: '', accent: yn[1], tail: verdict.slice(yn[0].length).replace(/^[\s—–-]+/, '').trim(), rest: rest.trim() }
    }
  }
  // «Минимум — ≥ 2,5 м (пояснение)» → подпись + число градиентом + хвост (kind minmax)
  const mm = verdict.match(/^(Минимум|Максимум)\s+—\s*([\s\S]+)$/)
  if (mm) {
    const lead = mm[1]
    const remainder = mm[2].trim()
    const num = remainder.match(/(?:более|менее|не более|не менее)?\s*[<>≤≥=]?\s*\d+[.,]?\d*\s*(м²|м|мм|см|эт\.?|чел\.?|%|°C|шт)?/)
    if (num && num.index !== undefined) {
      const accent = num[0].trim()
      const tail = (remainder.slice(0, num.index) + remainder.slice(num.index + num[0].length)).replace(/\s{2,}/g, ' ').trim()
      return { kind: 'minmax', lead, accent, tail, rest: rest.trim() }
    }
    return { kind: 'minmax', lead, accent: remainder, tail: '', rest: rest.trim() }
  }
  // прочее (число первым без подписи): акцент — само число
  const num = verdict.match(/^(?:более|менее|не более|не менее)?\s*[<>≤≥=]?\s*\d+[.,]?\d*\s*(м²|м|мм|см|эт\.?|чел\.?|%|°C|шт)?/)
  if (num) {
    return { kind: 'minmax', lead: '', accent: num[0].trim(), tail: verdict.slice(num[0].length).trim(), rest: rest.trim() }
  }
  return null
}

const FOLLOWUP_CHIPS = ['А для жилых зданий?', 'А пункт и страница точнее?', 'А исключения есть?']

/** Фирменный градиент ключевого фрагмента (число / Да / Нет). */
function Accent({ children }: { children: React.ReactNode }) {
  return <span className="bg-gradient-to-r from-violet-500 to-fuchsia-500 dark:from-violet-400 dark:to-fuchsia-400 bg-clip-text text-transparent font-semibold">{children}</span>
}

// Число+единица (с диапазоном), этажная форма — универсально, без хардкода параметров.
// Годы (2012), пункты (4.4.1.37), страницы — без единиц, regex их не задевает.
// NB: \b для кириллицы мёртв («м.» — оба не-word) → границы явно;
// (?<![\d.,]) спереди — чтобы из «19 этажей» не вырезалось «9 этажей».
// Без флага /g: split и так находит все совпадения, а lastIndex не дрейфует.
const VALUE_RE = /([<>≤≥=]?\s*(?<![\d.,])\d+[.,]?\d*\s*(?:[-–—]\s*\d+[.,]?\d*\s*)?(?:м²|м|мм|см|эт\.?|чел\.?|%|°C|шт|м2)(?=[^а-яёa-z0-9]|$)|(?<![\d.,])\d+\s*(?:-го|-й|-м|-х)?\s*этаж[а-я]*)/

/**
 * Акцентный ответ: бренд + числа с единицами + этажные формы — градиентом,
 * «Да/Нет» — только первым словом И только для permission-вопросов.
 * Цитаты, сниппеты и стрип сюда не ходят — только hero-хвост и тело ответа.
 */
function renderAccentedAnswer(text: string, allowYN = false) {
  if (!text) return text
  // «Да/Нет» первым словом — отдельно (внутри VALUE_RE их нет).
  // На фактоидах allowYN=false: «Да — 1,2 м» остается обычным текстом, градиент только на числе.
  const yn = allowYN ? text.match(/^(Да|Нет)(?=[^а-яёa-z0-9]|$)/) : null
  const head = yn ? yn[1] : ''
  const tail = yn ? text.slice(yn[0].length) : text
  // бренд внутри частей красится своим спаном — режем по нему, чтобы не ломать разметку
  const BRAND = 'snippy.llm'
  const chunks = tail.split(BRAND)
  const out: React.ReactNode[] = []
  if (head) out.push(<Accent key="yn">{head}</Accent>)
  chunks.forEach((chunk, ci) => {
    const parts = chunk.split(VALUE_RE)
    parts.forEach((p, pi) => {
      if (!p) return
      // split с capture-группой: нечётные индексы — совпадения
      if (pi % 2 === 1) out.push(<Accent key={`${ci}-${pi}`}>{p}</Accent>)
      else out.push(<React.Fragment key={`${ci}-${pi}`}>{p}</React.Fragment>)
    })
    if (ci < chunks.length - 1) out.push(<Accent key={`brand-${ci}`}>{BRAND}</Accent>)
  })
  return out
}

/** Русские формы числительных: 1 требование / 2 требования / 5 требований. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

/** «5 требований из 1 документа» — нейтральная подпись вместо вводящего в заблуждение Σ-диапазона. */
function valuesCountLabel(cards: ValueCard[]): string {
  const docs = new Set(cards.map((c) => c.fact.d)).size
  return `${cards.length} ${plural(cards.length, 'требование', 'требования', 'требований')} из ${docs} ${plural(docs, 'документа', 'документов', 'документов')}`
}

type BodyBlock =
  | { type: 'ul'; items: string[] }
  | { type: 'group'; title: string; items: string[] }
  | { type: 'p'; text: string }

/** Лёгкий парсер тела LLM-ответа: пули → список, «Заголовок:» + пули → подзаголовок, остальное — абзац. */
export function parseAnswerBody(body: string): BodyBlock[] {
  const out: BodyBlock[] = []
  const isBullet = (l: string) => /^[•\-*]\s+/.test(l)
  for (const chunk of body.split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) continue
    const bullets = lines.filter(isBullet)
    const plain = lines.filter((l) => !isBullet(l))
    if (bullets.length && !plain.length) {
      out.push({ type: 'ul', items: bullets.map((l) => l.replace(/^[•\-*]\s+/, '')) })
    } else if (bullets.length && plain.length === 1 && /:\s*$/.test(plain[0])) {
      out.push({ type: 'group', title: plain[0].replace(/:\s*$/, ''), items: bullets.map((l) => l.replace(/^[•\-*]\s+/, '')) })
    } else {
      out.push({ type: 'p', text: lines.join('\n') })
    }
  }
  return out
}

/** Структурированное тело ответа: без стены текста, с акцентами чисел. */
function AnswerBody({ body, allowYN }: { body: string; allowYN: boolean }) {
  const blocks = parseAnswerBody(body)
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        if (b.type === 'ul') return (
          <ul key={i} className="space-y-1.5">
            {b.items.map((it, j) => (
              <li key={j} className="flex gap-2 text-[15px] max-md:text-[15px] leading-relaxed font-medium text-slate-900 dark:text-white">
                <span className="mt-[9px] w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                <span>{renderAccentedAnswer(it, allowYN)}</span>
              </li>
            ))}
          </ul>
        )
        if (b.type === 'group') return (
          <div key={i} className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">{b.title}</div>
            <ul className="space-y-1.5">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2 text-[14px] leading-relaxed text-slate-800 dark:text-slate-100">
                  <span className="mt-[9px] w-1 h-1 rounded-full bg-emerald-500 shrink-0" />
                  <span>{renderAccentedAnswer(it, allowYN)}</span>
                </li>
              ))}
            </ul>
          </div>
        )
        return <p key={i} className="m-0 text-[15px] leading-relaxed font-medium text-slate-900 dark:text-white whitespace-pre-wrap">{renderAccentedAnswer(b.text, allowYN)}</p>
      })}
    </div>
  )
}

/** Компактный выбор режима поиска: ghost-кнопка + меню (ввод в баре — максимально широкий). */
function ModeSelect({ mode, setMode }: {
  mode: 'fast' | 'deep'
  setMode: (v: 'fast' | 'deep') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open ])
  const opts = [
    { v: 'fast' as const, label: 'Быстрый', cost: FAST_COST, hint: '3 результата', title: `Быстрый поиск: 3 результата • ${FAST_COST} кредитов` },
    { v: 'deep' as const, label: 'Глубокий', cost: DEEP_COST, hint: 'до 30 + цитата', title: `Глубокий поиск: до 30 результатов + ответ с цитатой • ${DEEP_COST} кредитов` },
  ]
  const cur = opts.find((o) => o.v === mode) ?? opts[0]
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Режим поиска"
        className="chip py-1.5"
      >
        {cur.label}
        <span className="inline-flex items-center gap-0.5 text-slate-400 dark:text-slate-500"><Icon name="bolt" size={11} />{cur.cost}</span>
        <Icon name="chevronDown" size={13} className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 min-w-[190px] bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden z-30 py-1 animate-dropdown">
          {opts.map((o) => (
            <button
              key={o.v}
              type="button"
              role="menuitemradio"
              aria-checked={mode === o.v}
              title={o.title}
              onClick={() => { setMode(o.v); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition ${mode === o.v ? 'bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
            >
              <span className="font-semibold whitespace-nowrap">{o.label}</span>
              <span className="inline-flex items-center gap-0.5 text-slate-400"><Icon name="bolt" size={11} />{o.cost}</span>
              <span className="text-slate-400 truncate">{o.hint}</span>
              {mode === o.v && <Icon name="check" size={13} className="ml-auto shrink-0 text-slate-900 dark:text-white" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Тред уточняющих вопросов под ответом: поиск не повторяется, контекст chunkIds + история (до 2 витков). */
function FollowUpThread({ query, baseAnswer, chunkIds, onNeedCredits }: {
  query: string
  baseAnswer: string
  chunkIds: string[]
  onNeedCredits: () => void
}) {
  const [turns, setTurns] = useState<{ q: string; a: string; quote?: string; grounded: boolean; extractive?: boolean }[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const history = [{ q: query, a: baseAnswer }, ...turns.map((t) => ({ q: t.q, a: t.a }))].slice(-3)
      // Уточнение — это новый вопрос: переформулируем и ищем заново (база + новые кандидаты),
      // а не отвечаем тем же контекстом. Fail-open: поиск не удался → старые chunkIds.
      let candidates = chunkIds.slice(0, 32)
      try {
        const rw = await rewriteQuery(text, { history, followUp: true, timeoutMs: 2500 })
        const sq = rw?.standalone || text
        const found = await hybridSearchLegacy(sq, 'deep', 20)
        const baseSet = new Set(chunkIds.map(Number))
        const extra: number[] = []
        for (const r of found.results) {
          const id = Number(r.chunk_id)
          if (!baseSet.has(id) && !extra.includes(id)) extra.push(id)
        }
        for (const rq of (rw?.queries ?? []).slice(0, 2)) {
          for (const id of await bm25TopIds(rq, 6)) {
            if (!baseSet.has(id) && !extra.includes(id)) extra.push(id)
          }
        }
        candidates = [...chunkIds, ...extra.map(String)].slice(0, 32)
      } catch (e) {
        console.warn('follow-up re-search failed', e)
      }
      const res = await askFollowUp(text, candidates, history)
      setTurns((prev) => [...prev, {
        q: text,
        a: cleanAnswerText(res.answer.answer),
        quote: res.answer.quote,
        grounded: res.answer.is_grounded,
        extractive: res.answer.extractive,
      }])
      setInput('')
    } catch (e: any) {
      if (e?.insufficientCredits) { onNeedCredits(); return }
      setError('Не удалось получить уточнение — попробуйте новый поиск')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
      <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase mb-2">Уточнить у Сниппи</div>
      {turns.map((t, i) => (
        <div key={i} className="mb-3 animate-[slideUp_.2s_ease-out]">
          <div className="flex justify-end"><div className="max-w-[90%] px-3 py-2 rounded-2xl rounded-br-md bg-slate-900 text-white dark:bg-white dark:text-slate-900 text-[13px]">{t.q}</div></div>
          <div className="mt-1.5 px-3 py-2.5 rounded-2xl rounded-tl-md bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{t.a}</div>
          <div className="mt-1 flex items-center gap-2 text-[11px]">
            {t.grounded
              ? <span className="badge"><Icon name="check" size={11} /> По источнику из норм</span>
              : <span className="badge border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300">Точного требования не найдено</span>}
            {t.extractive && <span className="text-slate-400">цитаты из норм · резерв</span>}
          </div>
          {t.quote && <div className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400 border-l-2 border-slate-300 dark:border-slate-600 pl-2 overflow-hidden max-w-full [overflow-wrap:anywhere]">«{(() => { const q = sanitizeQuote(t.quote); return q.length > 300 ? q.slice(0, 300) + '…' : q })()}»</div>}
        </div>
      ))}
      {error && <div className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {FOLLOWUP_CHIPS.map((c) => (
          <button key={c} onClick={() => send(c)} disabled={sending} className="text-[11px] px-2.5 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 transition disabled:opacity-40">{c}</button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="flex max-md:flex-col max-md:items-stretch items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Спросите вдогонку…"
          maxLength={300}
          className="flex-1 min-w-0 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2 max-md:py-2.5 max-md:text-base text-sm bg-white dark:bg-slate-900 dark:text-white placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-slate-900/15 focus:border-slate-900 dark:focus:ring-white/20 dark:focus:border-slate-300"
        />
        <button type="submit" disabled={sending || !input.trim()} title={`Уточнение без нового поиска • ${FOLLOWUP_COST} кредитов`} className="btn btn-sm btn-primary py-2 max-md:py-2.5 shrink-0 max-md:w-full">
          {sending ? '…' : <><span>Уточнить</span><span className="inline-flex items-center gap-0.5 opacity-80"><Icon name="bolt" size={11} />{FOLLOWUP_COST}</span></>}
        </button>
      </form>
    </div>
  )
}

type SearchViewProps = {
  query: string
  setQuery: (v: string) => void
  mode: 'fast' | 'deep'
  setMode: (v: 'fast' | 'deep') => void
  loading: boolean
  resp: any | null
  error: string | null
  searchHistory: string[]
  clearHistory: () => void
  removeHistoryItem?: (item: string) => void
  /** Восстановить сессию целиком бесплатно — кредиты не списываются (если слепка нет — вставить текст). */
  onPickSession?: (q: string) => void
  pins?: string[]
  showHistory: boolean
  setShowHistory: (v: boolean) => void
  filterType: string
  setFilterType: (v: string) => void
  filterStatus: string
  setFilterStatus: (v: string) => void
  showFilters: boolean
  setShowFilters: (v: boolean) => void
  doSearch: (q?: string) => void
  /** true — запрос/режим/фильтры не менялись с последнего поиска: повтор заблокирован. */
  isUnchanged?: boolean
  requestAnswer?: () => void
  answering?: boolean
  highlightPalette: string
  setHighlightPalette?: (v: string) => void
  monoHex: string
  setMonoHex?: (v: string) => void
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
  openPdf: (documentId: string, page?: number, quote?: string | null) => void
  searchInputRef?: React.RefObject<HTMLInputElement>
  insufficientCredits?: boolean
  setInsufficientCredits?: (v: boolean) => void
  onTopUp?: () => void
}

export function SearchView(props: SearchViewProps) {
  const {
    query, setQuery, mode, setMode, loading, resp, error,
    searchHistory, clearHistory, removeHistoryItem, onPickSession, pins, showHistory, setShowHistory,
    filterType, setFilterType, filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    doSearch, isUnchanged, highlightPalette, monoHex,
    requestAnswer, answering,
    user, setShowAuth, setAuthMode, openPdf, searchInputRef, insufficientCredits, setInsufficientCredits, onTopUp,
  } = props

  const [examples, setExamples] = useState<string[]>(() =>
    loadQuickExamples().length ? loadQuickExamples() : ['ширина коридора', 'высота подоконника', 'ширина лестничного марша']
  )
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyTimer = React.useRef<number | null>(null)
  // Карточки значений: выбранная (модалка), сортировка мин→макс
  const [selectedCard, setSelectedCard] = useState<ValueCard | null>(null)
  const [valuesAsc, setValuesAsc] = useState(false)
  useEffect(() => { setSelectedCard(null); setValuesAsc(false) }, [resp?.query, resp?.took_ms]) // eslint-disable-line react-hooks/exhaustive-deps
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>(() => loadRecentDocs())
  // Дата нормативной базы (manifest.builtAt) — видно, насколько свежи нормы
  const [indexDate, setIndexDate] = useState<string>('')
  useEffect(() => {
    loadIndex().then((b) => {
      const m = b.manifest.builtAt || ''
      const d = m.match(/(\d{4})-(\d{2})-(\d{2})/)
      if (d) setIndexDate(`${d[3]}.${d[2]}.${d[1]}`)
    }).catch(() => {})
  }, [])
  const [, setFavTick] = useState(0)
  useEffect(() => {
    const onRecent = () => setRecentDocs(loadRecentDocs())
    window.addEventListener(RECENT_DOCS_EVENT, onRecent)
    return () => window.removeEventListener(RECENT_DOCS_EVENT, onRecent)
  }, [])
  useEffect(() => {
    const onFav = () => setFavTick((t) => t + 1)
    window.addEventListener(FAVORITES_EVENT, onFav)
    return () => window.removeEventListener(FAVORITES_EVENT, onFav)
  }, [])
  const copyWithHint = (key: string, text: string) => {
    copyToClipboard(text)
    setCopiedKey(key)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopiedKey(null), 1500)
  }
  useEffect(() => {
    const onUpdate = () => setExamples(loadQuickExamples())
    window.addEventListener(QUICK_EXAMPLES_EVENT, onUpdate)
    return () => window.removeEventListener(QUICK_EXAMPLES_EVENT, onUpdate)
  }, [])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Повтор без изменений (кнопка серая) — игнор и по Enter: квота не тратится дважды.
    if (isUnchanged) return
    doSearch()
  }
  // Кнопка «Найти» гаснет, пока запрос/режим/фильтры не менялись с последнего поиска.
  const searchDisabled = loading || isUnchanged || !query.trim()

  const snakeVariant: 'thinking' | 'searching' | 'success' | 'failed' =
    loading ? 'searching' : error ? 'failed' : resp ? 'success' : 'thinking'

  // Ответ из точных значений норм (0 LLM-токенов): тело-дубль не рендерим — его заменяют субкарточки.
  const answerRaw = resp?.answer?.answer || ''
  const isValuesAnswer = resp?.answer?.provider === 'values'
    || (resp?.answer?.provider === 'cache' && /^Точные значения из норм/.test(cleanAnswerText(answerRaw)))
  const answerCards: ValueCard[] = resp?.valueCards || []
  const orderedAnswerCards = valuesAsc
    ? [...answerCards].sort((a, b) => valueBase(a.fact) - valueBase(b.fact))
    : answerCards
  // Locked-тизер: нет кредитов — показываем 1 карточку + 3 результата в блюре,
  // всё некликабельно, CTA — баннер сверху. Общая логика для fast/deep.
  const locked = !!insufficientCredits && !!resp && !loading
  const goLockedCta = () => {
    if (!user) { setAuthMode('register'); setShowAuth(true); return }
    if (onTopUp) onTopUp()
  }

  return (
    <>
      {/* ── Hero / Search Bar ── */}
      <div className="bg-white dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-5xl mx-auto px-4 py-6 md:py-10 max-md:py-4 max-md:pb-2 flex flex-col md:flex-row md:items-center gap-4 md:gap-10">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl sm:text-3xl md:text-4xl max-md:text-[22px] font-bold text-slate-900 dark:text-white text-center md:text-left leading-tight">
              Что вы хотите найти?
            </h1>
            <p className="text-center md:text-left text-slate-500 dark:text-slate-400 mt-2 mb-5 max-md:mb-4 max-md:text-sm">
              Поиск по действующим строительным нормам Казахстана
            </p>

          <form onSubmit={onSubmit} className="relative">
            <div className="flex items-center gap-2 max-md:gap-1 bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-1.5 max-md:p-1 focus-within:ring-2 focus-within:ring-slate-900/15 focus-within:border-slate-900 dark:focus-within:ring-white/20 dark:focus-within:border-slate-300 transition">
              <div className="pl-3 text-slate-400 shrink-0 max-md:hidden">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              </div>
              <input
                ref={searchInputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 180)}
                placeholder="Например: ширина коридора"
                // max-md:text-base: 16px на телефоне — iOS не зумит при фокусе
                className="flex-1 min-w-0 w-full outline-none text-[15px] max-md:text-base py-2.5 max-md:py-2 max-md:pl-2 placeholder:text-slate-400 dark:text-white dark:bg-transparent"
              />
              <VoiceButton onTranscript={(text) => { setQuery(text); searchInputRef?.current?.focus() }} className="max-md:w-9 max-md:h-9" />
              <button type="submit" disabled={searchDisabled} title={isUnchanged && !loading ? 'Запрос не менялся — результат уже показан' : mode === 'fast' ? `Быстрый поиск: 3 результата` : `Глубокий поиск: до 30 результатов + ответ с цитатой`} className="btn btn-primary flex items-center gap-2 px-5 max-md:px-3 py-2.5 max-md:py-2 max-md:min-h-[40px] text-sm font-semibold rounded-xl transition disabled:opacity-50 shrink-0">
                <span className="max-md:hidden">{loading ? 'Поиск…' : 'Найти'}</span>
                {/* Мобайл: компактная лупа вместо слова «Найти» — поле ввода шире */}
                <span className="md:hidden flex items-center">
                  {loading ? (
                    <span className="w-5 h-5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : (
                    <Icon name="search" size={19} strokeWidth={2.2} />
                  )}
                </span>
              </button>
            </div>

            {/* ── Search History Dropdown ── */}
            {showHistory && searchHistory.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-2 bg-white dark:bg-slate-900 rounded-2xl shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden z-30 max-h-[280px] overflow-y-auto animate-dropdown">
                <div className="px-3 py-2 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                  <span className="text-xs font-semibold text-slate-500 tracking-widest uppercase">История поиска</span>
                  <button type="button" onMouseDown={e => { e.preventDefault(); clearHistory() }} className="text-xs text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                <div onMouseDown={e => e.preventDefault()} className="px-1.5 pb-1.5">
                {(() => {
                  const pinSet = new Set(pins ?? [])
                  const ordered = [...searchHistory.filter(h => pinSet.has(h)), ...searchHistory.filter(h => !pinSet.has(h))]
                  return ordered.filter(h => !query || h.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(h => (
                  <ListRow
                    key={h}
                    compact
                    className="hover:bg-slate-50 dark:hover:bg-slate-800 transition"
                    lead={<span className="text-slate-400 dark:text-slate-500 inline-flex"><Icon name={pinSet.has(h) ? 'pin' : 'clock'} size={14} /></span>}
                    title={<span className="text-sm font-normal text-slate-700 dark:text-slate-200">{h}</span>}
                    titleAttr={h}
                    onOpen={() => { if (onPickSession) onPickSession(h); else { setQuery(h); setShowHistory(false); setTimeout(() => searchInputRef?.current?.focus(), 0) } }}
                    titleOpenLabel={`Открыть «${h}» бесплатно — кредиты не спишутся`}
                    trail={
                      <button
                        type="button"
                        title="Убрать из истории"
                        aria-label={`Убрать «${h}» из истории`}
                        onClick={(e) => { e.stopPropagation(); if (removeHistoryItem) removeHistoryItem(h) }}
                        className="icon-btn w-8 h-8 text-slate-300 hover:text-red-400"
                      >
                        <Icon name="close" size={13} />
                      </button>
                    }
                  />
                ))})()}
                </div>
                <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800/60 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400">синонимы • опечатки • семантика</div>
              </div>
            )}

            {/* ── Mode + Filters Row: одна слим-строка по центру ── */}
            <div className="mt-3 flex items-center justify-center gap-2">
              <ModeSelect mode={mode} setMode={setMode} />
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <button type="button" onClick={() => setShowFilters(!showFilters)} className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
                Фильтры {filterType || filterStatus !== 'active' ? '• активны' : ''}
              </button>
              {(filterType || filterStatus !== 'active') && <button type="button" onClick={() => { setFilterType(''); setFilterStatus('active') }} className="text-xs text-slate-600 dark:text-slate-300 underline underline-offset-2">Сбросить</button>}
            </div>

            {/* ── Filters Panel ── */}
            {showFilters && (
              <div className="mt-3 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                <label className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Тип документа</span>
                  <select value={filterType} onChange={e => setFilterType(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white px-2 py-1.5 text-sm">
                    <option value="">Все типы</option>
                    <option value="СНиП">СНиП</option>
                    <option value="СН РК">СН РК</option>
                    <option value="СП РК">СП РК</option>
                    <option value="ГОСТ">ГОСТ</option>
                    <option value="НТД">НТД</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Статус</span>
                  <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white px-2 py-1.5 text-sm">
                    <option value="active">Только действующие</option>
                    <option value="">Все</option>
                    <option value="expired">Утратил силу</option>
                    <option value="replaced">Заменён</option>
                  </select>
                </label>
                <div className="text-[11px] text-slate-400 flex items-end pb-1">По умолчанию — только действующие</div>
              </div>
            )}
          </form>

          {/* ── Example Queries: на мобайле — скролл в одну строку, на десктопе — wrap по центру ── */}
          <div className="flex gap-2 mt-5 max-md:mt-4 flex-wrap justify-center max-md:flex-nowrap max-md:justify-start max-md:overflow-x-auto max-md:pb-1 max-md:-mx-4 max-md:px-4 no-scrollbar">
            {examples.map(ex => (
              <button key={ex} onClick={() => { setQuery(ex); searchInputRef?.current?.focus() }} title="Вставить в поиск" className="chip shrink-0 max-md:py-2">{ex}</button>
            ))}
          </div>
          </div>
          {/* Змейка — только десктоп: на мобилке съедает экран */}
          <div className="hidden md:flex md:shrink-0 items-center justify-center order-first md:order-none">
            <SnakeState variant={snakeVariant} size={170} />
          </div>
        </div>
      </div>

      {/* ── Results Area ── */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-6 max-md:py-3">

        {!user && !loading && !resp && !insufficientCredits && (
          <div className="text-center py-2 mb-2">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs">
              Гостям — 30 кредитов в день. <button onClick={() => { setAuthMode('register'); setShowAuth(true) }} className="underline font-medium">Зарегистрируйтесь</button> — 300 каждый час + накопительный баланс
            </div>
          </div>
        )}

        {error && !insufficientCredits && <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 rounded-xl p-4 text-sm">{error}</div>}

        {insufficientCredits && (
          <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/20 p-6 text-center animate-[slideUp_.2s_ease-out] mb-5 max-md:mb-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 dark:bg-amber-900/50 text-amber-600 dark:text-amber-300 flex items-center justify-center mb-3"><Icon name="bolt" size={22} /></div>
            <div className="font-semibold text-slate-900 dark:text-white text-lg">Недостаточно кредитов</div>
            <div className="text-sm text-slate-600 dark:text-slate-300 mt-2 max-w-md mx-auto">
              Зарегистрируйтесь и получайте бесплатные кредиты.
            </div>
            <div className="mt-4 flex items-center justify-center gap-3 flex-wrap max-md:flex-col max-md:items-stretch">
              <button onClick={() => { if (onTopUp) onTopUp() }} className="btn btn-md btn-primary px-6 py-2.5 max-md:w-full">Пополнить баланс</button>
              {!user && (
                <button onClick={() => { setAuthMode('register'); setShowAuth(true) }} className="btn btn-md btn-secondary px-6 py-2.5 max-md:w-full">Регистрация (бесплатные кредиты)</button>
              )}
            </div>
          </div>
        )}

        {/* ── Empty State ── */}
        {!resp && !loading && !error && !insufficientCredits && (
          <div className="text-center py-10">
            {recentDocs.length > 0 && (
              <div className="mb-8 text-left bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">Недавние документы</div>
                  <button onClick={() => { clearRecentDocs(); setRecentDocs([]) }} className="text-[11px] text-slate-400 hover:text-red-500">Очистить</button>
                </div>
                <div className="space-y-1.5">
                  {recentDocs.map((d) => {
                    const sub = d.title ? `${d.title} • стр. ${d.page}` : `стр. ${d.page}`
                    return (
                      <ListRow
                        key={d.docId}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-700 transition"
                        lead={<span className="text-slate-400 dark:text-slate-500 inline-flex"><Icon name="file" size={16} /></span>}
                        title={<span className="text-slate-800 dark:text-slate-100">{d.number}</span>}
                        titleAttr={d.number}
                        subtitle={<span className="text-slate-400">{sub}</span>}
                        subtitleAttr={sub}
                        onOpen={() => openPdf(d.docId, d.page)}
                        titleOpenLabel={`Открыть ${d.number}, стр. ${d.page}`}
                        trail={
                          <button
                            onClick={() => { removeRecentDoc(d.docId); setRecentDocs(loadRecentDocs()) }}
                            title="Убрать"
                            aria-label={`Убрать ${d.number} из недавних`}
                            className="icon-btn w-8 h-8 text-slate-300 hover:text-red-400"
                          >
                            <Icon name="close" size={14} />
                          </button>
                        }
                      />
                    )
                  })}
                </div>
              </div>
            )}
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-6">Быстрый поиск — 3 результата, глубокий — до 30 + ответ с цитатой.</p>
          </div>
        )}

        {/* ── Loading State ── */}
        {loading && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center">
            <div className="flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400">
              <span className="w-5 h-5 border-2 border-slate-300 dark:border-slate-600 border-t-slate-900 dark:border-t-white rounded-full animate-spin" />
              <span className="text-sm">{mode === 'deep' ? 'Snippy глубоко анализирует нормы…' : 'Snippy листает нормы…'}</span>
            </div>
            <div className="mt-4 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden max-w-xs mx-auto"><div className="h-full bg-slate-900 dark:bg-white animate-pulse" style={{ width: '60%' }} /></div>
          </div>
        )}

        {/* ── Results ── */}
        {resp && !loading && (
          <div className={`flex flex-col gap-5 max-md:gap-3 ${locked ? 'mt-5 max-md:mt-3' : ''}`}>
            {/* Meta bar: только десктоп, в локе скрыт целиком — не липнет к баннеру */}
            {!locked && (
            <div className="order-[-2] hidden md:flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>Найдено {resp.total_found} за {resp.took_ms} мс • {resp.mode === 'deep' ? 'Глубокий режим' : 'Быстрый'}{indexDate && <span title="Дата сборки нормативной базы (индекс)"> • база от {indexDate}</span>} {mode === 'deep' && resp.mode === 'deep' && <span className="ml-1 badge">расширенный</span>}{isSemanticMode() && <span title="Смысловой режим: векторный приоритет + расширенные синонимы (Настройки → Режим поиска)" className="ml-1 badge">смысловой</span>}</span>
              <div className="flex flex-wrap max-md:flex-nowrap max-md:overflow-x-auto max-md:w-full max-md:pb-0.5 items-center gap-1.5 no-scrollbar">
                <button onClick={() => { const md = resultsToMarkdown(resp); downloadAsFile(md, `snippy_${resp.query.slice(0,30).replace(/\s+/g,'_')}.md`, 'text/markdown') }} className="chip py-1 shrink-0"><Icon name="download" size={12} /> Markdown</button>
                <button onClick={() => { copyToClipboard(resultsToMarkdown(resp)) }} className="chip py-1 shrink-0"><Icon name="copy" size={12} /> Копировать</button>
                <button onClick={() => copyWithHint('share', `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(resp.query)}&mode=${resp.mode}`)} title="Ссылка на этот поиск" className="chip py-1 shrink-0">{copiedKey === 'share' ? <><Icon name="check" size={12} /> Ссылка скопирована</> : <><Icon name="link" size={12} /> Поделиться</>}</button>
              </div>
            </div>
            )}

            {/* ── Value Cards: точные значения из норм (локально, 0⚡) — быстрый режим без Итога ── */}
            {!resp.answer && resp.valueCards && resp.valueCards.length > 0 && (() => {
              const all: ValueCard[] = locked ? resp.valueCards.slice(0, 1) : resp.valueCards
              const ordered = valuesAsc
                ? [...all].sort((a, b) => valueBase(a.fact) - valueBase(b.fact))
                : all
              const copyAll = () => {
                const lines = ordered.slice(0, 8).map((vc) =>
                  `• ${formatValue(vc.fact)} — ${formatLabel(vc.fact.k)} (${vc.docNumber || 'норма'}${vc.fact.p ? `, ${formatParagraph(vc.fact.p)}` : ''}${vc.fact.pg != null ? `, стр. ${vc.fact.pg}` : ''})`)
                copyWithHint('cite-values', `Точные значения из норм — «${resp.query}»\n${lines.join('\n')}`)
              }
              // Смарт-чипсы: типы зданий из найденных доков — тап сужает вопрос
              // («ширина проёма» + «Школы» → «ширина проёма школа», дальше работает docHit-буст).
              const CHIP_RULES: Array<[RegExp, string, string]> = [
                [/жил/, 'Жилые', 'жилые здания'],
                [/общеобразовательн|школьн/, 'Школы', 'школа'],
                [/дошкольн|детск/, 'Детсады', 'детский сад'],
                [/пожарн/, 'Пожарка', 'пожарная безопасность'],
                [/административн|офис/, 'Офисы', 'административное здание'],
                [/лечебн|медицинск|больнич|поликлиник/, 'Больницы', 'больница'],
                [/торгов|розничн|магазин/, 'Торговля', 'магазин'],
                [/гостиниц/, 'Гостиницы', 'гостиница'],
                [/бассейн|плавательн/, 'Бассейны', 'бассейн'],
                [/спортивн|физкультурн/, 'Спорт', 'спортивное сооружение'],
                [/зрелищн|культурн/, 'Культура', 'зрелищное учреждение'],
                [/питан/, 'Общепит', 'общественное питание'],
                [/стоян|парков/, 'Паркинги', 'стоянка'],
                [/банн/, 'Бани', 'баня'],
              ]
              const seenChips = new Set<string>()
              const chips: Array<{ label: string; q: string }> = []
              for (const vc of all) {
                const t = (vc.docTitle || '').toLowerCase().replace(/ё/g, 'е')
                for (const [re, label, q] of CHIP_RULES) {
                  if (re.test(t) && !seenChips.has(label)) {
                    seenChips.add(label)
                    chips.push({ label, q })
                    break
                  }
                }
                if (chips.length >= 5) break
              }
              return (
              <div className="relative">
                <div className={`rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 max-md:p-3 animate-[slideUp_.25s_ease-out] ${locked ? 'pointer-events-none select-none blur-[3px] opacity-60 saturate-50' : ''}`} aria-hidden={locked || undefined} inert={locked ? true : undefined}>
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <span className="w-7 h-7 rounded-full flex items-center justify-center bg-slate-900 text-white dark:bg-white dark:text-slate-900 shrink-0"><Icon name="bolt" size={14} /></span>
                    <span className="font-semibold text-slate-900 dark:text-white text-sm">Точные значения из норм</span>
                    <span title="Значения из текста норм" className="badge">snippy.llm</span>
                    {!locked && (
                    <span className="ml-auto flex items-center gap-1.5">
                      <button onClick={() => setValuesAsc((v) => !v)} title="Сортировать карточки по величине значения" className={`chip py-1 ${valuesAsc ? 'chip-active' : ''}`}><Icon name="arrowUpDown" size={12} /> мин→макс</button>
                      <button onClick={copyAll} title="Скопировать все показанные значения текстом" className="chip py-1">{copiedKey === 'cite-values' ? <><Icon name="check" size={12} /> Скопировано</> : <><Icon name="copy" size={12} /> Всё</>}</button>
                    </span>
                    )}
                  </div>
                  {!locked && chips.length > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap mb-3">
                      <span className="text-[11px] text-slate-400 dark:text-slate-500">Уточнить для:</span>
                      {chips.map((c) => (
                        <button key={c.label} onClick={() => doSearch(`${resp.query} ${c.q}`)} title={`Искать «${resp.query} ${c.q}»`} className="chip py-1">{c.label}</button>
                      ))}
                    </div>
                  )}
                  <div className="mb-3 text-[11px] text-slate-400 dark:text-slate-500">{valuesCountLabel(all)}</div>
                  <ValueSourceCards
                    cards={locked ? ordered.slice(0, 1) : ordered}
                    query={resp.query || query}
                    openPdf={locked ? (() => {}) as any : openPdf}
                    onOpenCard={locked ? (() => {}) as any : setSelectedCard}
                    copiedKey={copiedKey}
                    onCopy={locked ? (() => {}) as any : copyWithHint}
                  />
                </div>
                {locked && (
                  <button type="button" onClick={goLockedCta} aria-label="Зарегистрируйтесь и получайте бесплатные кредиты" className="absolute inset-0 w-full h-full cursor-pointer bg-transparent" />
                )}
              </div>
              )
            })()}

            {/* ── До-запрос ИИ-ответа: кэш без ответа после рефреша (без повторного поиска, только ask) ── */}
            {resp && !resp.answer && resp.mode === 'deep' && resp.results.length > 0 && !loading && !locked && requestAnswer && (
              <button onClick={requestAnswer} disabled={answering} className="w-full card card-hover p-4 text-sm font-semibold inline-flex items-center justify-center gap-2">
                <Icon name="lightbulb" size={16} />
                {answering ? 'Snippy думает…' : <span>Получить ответ ИИ · <span className="inline-flex items-center gap-0.5"><Icon name="bolt" size={12} />{DEEP_COST}</span> (поиск уже готов)</span>}
              </button>
            )}

            {/* ── Answer Block: Итог сверху, emerald-callout ── */}
            {resp.answer && (
              <div id="answer" className={`order-[-1] rounded-2xl border p-5 max-md:p-4 animate-[slideUp_.25s_ease-out] scroll-mt-20 ${resp.answer.is_grounded ? 'bg-white dark:bg-slate-900 border border-emerald-200/70 dark:border-emerald-800/60 shadow-[0_0_32px_-6px_rgba(16,185,129,0.55)] dark:shadow-[0_0_36px_-6px_rgba(16,185,129,0.4)]' : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900 border-l-2 border-l-amber-500'}`}>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center text-white shrink-0 ${resp.answer.is_grounded ? 'bg-emerald-500' : 'bg-amber-500'}`}><Icon name={resp.answer.is_grounded ? 'check' : 'alertCircle'} size={16} strokeWidth={2.4} /></span>
                  <span className="font-bold text-slate-900 dark:text-white text-base max-md:text-[15px]">{resp.answer.is_grounded ? 'Итог' : 'Точного требования не найдено'}</span>
                  {resp.answer.is_grounded && !resp.answer.extractive && <span title="Ответ только при найденной норме; без источника — честно говорит «не найдено»" className="ml-auto badge border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"><Icon name="check" size={11} /> По источнику из норм</span>}
                  {resp.answer.is_grounded && !resp.answer.extractive && resp.answer.provider && resp.answer.provider !== 'groq' && resp.answer.provider !== 'values' && <span className="badge">{PROVIDER_LABEL[resp.answer.provider] || resp.answer.provider}</span>}
                  {resp.answer.is_grounded && resp.answer.status && resp.answer.status !== 'active' && (() => { const b = statusBadge(resp.answer.status); return <span title="Статус документа — уточните действующую редакцию" className={`text-[11px] px-2 py-1 rounded-full border ${b.cls}`}>{b.label}</span> })()}
                  {resp.answer.extractive && <span className="ml-auto badge" title="Ответ собран из цитат найденных норм: основные звенья были недоступны">цитаты из норм · резерв</span>}
                </div>
                {(() => {
                  // Hero-парсер — по СЫРОМУ тексту (маркеры ⟦ИТОГ⟧ живы до cleanAnswerText);
                  // вторая попытка — по чищеному (старый кэш без маркеров).
                  // query прокидываем чтобы «Да» подсвечивалось только на permission-вопросах.
                  const raw = resp.answer.answer || ''
                  const q = resp.query || query || ''
                  const hero = extractHero(raw, resp.answer.provider, resp.answer.is_grounded, q)
                    ?? extractHero(cleanAnswerText(raw), resp.answer.provider, resp.answer.is_grounded, q)
                  const allowYN = isPermissionQuestion(q)
                  const clean = (s: string) => cleanAnswerText(s).replace(/⟦\/?ИТОГ⟧/g, '').replace(/\n{3,}/g, '\n\n').trim()
                  const lead = hero ? clean(hero.lead) : ''
                  const accent = hero ? clean(hero.accent) : ''
                  const tail = hero ? clean(hero.tail) : ''
                  // Старый кэш / LLM-огрех: «Да — ...» на фактоиде. Сервер новые чистит сам,
                  // тут — косметика отображения: префикс долой, число подсветит renderAccentedAnswer.
                  const rawBody = compactBullets(hero ? clean(hero.rest) : cleanAnswerText(raw))
                  const body = allowYN ? rawBody : rawBody.replace(/^(Да|Нет)\s*[—–\-:.,]?\s*/, '').trim() || rawBody
                  return (<>
                {hero && hero.kind === 'yn' && (
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 p-4 max-md:p-3.5 mb-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 rounded-full px-2.5 py-0.5">Итог</span>
                  </div>
                  <div className="text-xl max-md:text-lg font-bold leading-snug text-slate-900 dark:text-white [overflow-wrap:anywhere]">
                    <span className="bg-gradient-to-r from-violet-500 to-fuchsia-500 dark:from-violet-400 dark:to-fuchsia-400 bg-clip-text text-transparent">{accent}</span>
                    {tail ? ` — ${tail}` : ''}
                  </div>
                </div>
                )}
                {hero && hero.kind === 'minmax' && (
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 p-4 max-md:p-3.5 mb-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-900 rounded-full px-2.5 py-0.5">Итог</span>
                    {lead && <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">{lead}</span>}
                  </div>
                  <div className="text-2xl max-md:text-xl font-extrabold leading-snug [overflow-wrap:anywhere]"><span className="bg-gradient-to-r from-violet-500 to-fuchsia-500 dark:from-violet-400 dark:to-fuchsia-400 bg-clip-text text-transparent">{accent}</span></div>
                  {tail && <div className="mt-1 text-sm max-md:text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{renderAccentedAnswer(tail, allowYN)}</div>}
                </div>
                )}
                {body && (!isValuesAnswer || !answerCards.length) && (
                <div className="rounded-xl bg-emerald-50/70 dark:bg-emerald-950/25 border border-emerald-100 dark:border-emerald-900/60 p-3.5 max-md:p-3">
                  {!hero && <div className="text-[11px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 font-semibold mb-2">Ответ</div>}
                  {hero && <div className="text-[11px] uppercase tracking-widest text-emerald-600 dark:text-emerald-400 font-semibold mb-2">Детали</div>}
                  <AnswerBody body={body} allowYN={allowYN} />
                </div>
                )}
                {answerCards.length > 0 && (
                <div className={body && (!isValuesAnswer || !answerCards.length) ? 'mt-3' : ''}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="section-label">Значения из норм</span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">{valuesCountLabel(answerCards)}</span>
                  </div>
                  <ValueSourceCards
                    cards={orderedAnswerCards}
                    query={resp.query || query}
                    openPdf={openPdf}
                    onOpenCard={setSelectedCard}
                    copiedKey={copiedKey}
                    onCopy={copyWithHint}
                  />
                </div>
                )}
                  </>)
                })()}
                {resp.answer.is_grounded && !isValuesAnswer && (
                  <div className="mt-4 max-md:mt-3 grid grid-cols-1 max-md:grid-cols-2 md:grid-cols-2 gap-3 max-md:gap-2 text-xs">
                    {(() => {
                      // Свои поля ответа — первичны; топ поиска — только фолбэк ПО ТОМУ ЖЕ
                      // документу (иначе «основание СП 110 + цитата про архивы»).
                      const src = resp.sources?.[0]
                      const rMatch = src ? resp.results.find((r) => r.document_id === String(src.d)) : undefined
                      const r0 = rMatch ?? resp.results[0]
                      const basis = resp.answer.normative_basis || r0?.document_number || '—'
                      const para = cleanParagraph(resp.answer.paragraph) || resp.answer.paragraph || r0?.paragraph
                      const pg = resp.answer.page ?? src?.pg ?? r0?.page ?? null
                      return (<>
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 max-md:p-2 border border-slate-200 dark:border-slate-700 max-md:min-w-0"><div className="text-slate-500 dark:text-slate-400 max-md:text-[11px]">Нормативное основание</div><div className="font-medium text-slate-900 dark:text-white mt-0.5 max-md:truncate" title={basis}>{basis}</div></div>
                    <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-3 max-md:p-2 border border-slate-200 dark:border-slate-700 max-md:min-w-0"><div className="text-slate-500 dark:text-slate-400 max-md:text-[11px]">Пункт • Страница</div><div className="font-medium text-slate-900 dark:text-white mt-0.5 max-md:truncate">{formatParagraph(para)} • стр. {pg ?? '—'}</div></div>
                      </>)
                    })()}
                    {resp.answer.quote && <div className="max-md:col-span-2 md:col-span-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40 p-3 max-md:p-2.5"><div className="section-label mb-1">Цитата из нормы</div><div className="mono-quote">"{highlightText(sanitizeQuote(resp.answer.quote.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}"</div></div>}
                    {(() => {
                      // Атрибуция ответа: сначала собственные поля ответа и его sources,
                      // топ гибридного поиска — только фолбэк по тому же документу.
                      const src = resp.sources?.[0]
                      const rMatch = src ? resp.results.find((r) => r.document_id === String(src.d)) : undefined
                      const r0 = rMatch ?? resp.results[0]
                      const docId = src ? String(src.d) : r0?.document_id
                      const docNumber = resp.answer.normative_basis || r0?.document_number || ''
                      const docTitle = r0 && (!src || String(src.d) === r0.document_id) ? r0.document_title : ''
                      const para = cleanParagraph(resp.answer.paragraph) || resp.answer.paragraph || r0?.paragraph
                      const page = resp.answer.page ?? src?.pg ?? r0?.page
                      const quote = resp.answer.quote || r0?.text
                      if (!docId) return null
                      return (
                      <div className="max-md:col-span-2 md:col-span-2 flex flex-wrap max-md:flex-col max-md:items-stretch items-center gap-2">
                        <button onClick={() => openPdf(docId, page ?? 1, quote)} className="btn btn-sm btn-primary px-4 py-2 max-md:py-2.5 max-md:text-[13px] max-md:w-full">
                          <Icon name="file" size={13} />
                          <span className="max-md:hidden">Открыть PDF · стр. {page ?? '—'} + контекст ответа</span>
                          <span className="md:hidden">Открыть PDF · стр. {page ?? '—'}</span>
                        </button>
                        <div className="flex flex-wrap max-md:grid max-md:grid-cols-2 items-center gap-2 max-md:w-full">
                        <button onClick={() => copyWithHint('cite-answer', formatCitation({ document_number: docNumber, paragraph: cleanParagraph(resp.answer.paragraph) || para, page }))} title="Скопировать сноску на норму" className="btn btn-sm btn-secondary py-2">{copiedKey === 'cite-answer' ? <><Icon name="check" size={12} /> Скопировано</> : <><Icon name="copy" size={12} /> Сноска</>}</button>
                        {(() => {
                          const fid = favoriteId({ kind: 'answer', query: resp.query, documentNumber: docNumber, page: page ?? undefined });
                          const saved = isFavorite(fid);
                          return (
                            <button
                              onClick={() => {
                                if (saved) removeFavorite(fid);
                                else addFavorite({
                                  kind: 'answer', query: resp.query,
                                  answer: cleanAnswerText(resp.answer.answer),
                                  quote: quote || '',
                                  documentId: docId,
                                  documentNumber: docNumber,
                                  documentTitle: docTitle,
                                  paragraph: cleanParagraph(resp.answer.paragraph) || para,
                                  page: page ?? null,
                                });
                              }}
                              title={saved ? 'Убрать из избранного' : 'Сохранить ответ в избранное'}
                              className={`btn btn-sm py-2 border ${saved ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white' : 'btn-secondary'}`}
                            ><Icon name="star" size={13} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Сохранено' : 'В избранное'}</button>
                          );
                        })()}
                        </div>
                      </div>
                      )
                    })()}
                  </div>
                )}
                {resp.answer.is_grounded && (
                  <FollowUpThread
                    key={`${resp.query}:${resp.took_ms}`}
                    query={resp.query || query}
                    baseAnswer={cleanAnswerText(resp.answer.answer)}
                    chunkIds={resp.sources?.length ? resp.sources.map((s) => String(s.i)) : resp.results.slice(0, 5).map((r) => r.chunk_id)}
                    onNeedCredits={() => setInsufficientCredits?.(true)}
                  />
                )}
                {resp.answer.is_grounded && (
                  <FeedbackBar
                    key={`${resp.query}:${resp.took_ms}:fb`}
                    query={resp.query || query}
                    mode={resp.mode}
                    provider={resp.answer.provider}
                    chunkIds={resp.sources?.length ? resp.sources.map((s) => String(s.i)) : resp.results.slice(0, 5).map((r) => r.chunk_id)}
                    paragraph={cleanParagraph(resp.answer.paragraph) || resp.answer.paragraph || resp.results[0]?.paragraph}
                    answerExcerpt={cleanAnswerText(resp.answer.answer)}
                  />
                )}
              </div>
            )}

            {resp.message && (!resp.answer?.is_grounded || resp.degraded) && <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-3">{resp.message}</div>}

            {/* ── Result Cards ── */}
            {(() => {
              const displayResults = resp.answer?.is_grounded ? resp.results.slice(1) : resp.results
              const filtered = locked ? displayResults.slice(0, 3) : displayResults
              const hasMore = filtered.length > 0

              return (
                <div className="relative">
                  <div className={locked ? 'pointer-events-none select-none blur-[3px] opacity-60 saturate-50' : undefined} aria-hidden={locked || undefined} inert={locked ? true : undefined}>
                  {hasMore && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 tracking-widest uppercase">{resp.answer?.is_grounded ? 'Другие подходящие варианты' : 'Подходящие варианты'} • {filtered.length}</div>
                      {!locked && <span className="contents max-md:hidden"><HighlightLegend query={resp.query || query} paletteId={highlightPalette} monoHex={highlightPalette === 'mono' ? monoHex : undefined} /></span>}
                    </div>
                  )}
                  {filtered.map((r, idx) => {
                    const badge = statusBadge(r.status)
                    const isTopOther = idx === 0 && !resp.answer?.is_grounded
                    return (
                      <div
                        key={r.chunk_id}
                        className={`bg-white dark:bg-slate-900 rounded-2xl border p-4 md:p-5 transition animate-[slideUp_.25s_ease-out] ${isTopOther ? 'border-slate-900 dark:border-white ring-1 ring-slate-900/10 dark:ring-white/10' : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'}`}
                        style={{ animationDelay: `${Math.min(idx * 40, 240)}ms` }}
                      >
                        {isTopOther && <div className="section-label mb-2">Наиболее подходящее</div>}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900 dark:text-white text-sm">{r.document_number}</span>
                              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                              {r.paragraph && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">п. {r.paragraph}</span>}
                              {r.page && <span className="text-xs text-slate-500 dark:text-slate-400">стр. {r.page}</span>}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">{r.document_title}</div>
                          </div>
                          <div className="flex items-start gap-2 shrink-0">
                            <div className="text-right">
                              <div className={`inline-flex items-center gap-1.5 text-xs font-semibold text-white px-2.5 py-1 rounded-full ${relevanceColor(r.relevance_percent)}`}><span>{r.relevance_percent}%</span></div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 text-center">{r.relevance_label}</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border border-slate-200 dark:border-slate-700 overflow-hidden max-w-full [overflow-wrap:anywhere]">{highlightText(truncateSmart(r.text, 600), resp.query || query, highlightPalette, highlightPalette === 'mono' ? monoHex : undefined)}</div>
                        {!locked && (
                        <div className="mt-3 flex flex-wrap max-md:flex-col max-md:items-stretch items-center gap-2 text-xs">
                          <button onClick={() => openPdf(r.document_id, r.page, r.text)} className="btn btn-sm btn-secondary py-1.5 max-md:py-2.5 max-md:w-full max-md:text-[13px]">
                            <Icon name="file" size={13} />
                            <span className="max-md:hidden">Открыть PDF · стр. {r.page ?? '—'} + контекст</span>
                            <span className="md:hidden">PDF · стр. {r.page ?? '—'}</span>
                          </button>
                          <div className="flex flex-wrap max-md:grid max-md:grid-cols-2 items-center gap-2 max-md:w-full">
                          <button onClick={() => copyWithHint(`cite-${r.chunk_id}`, formatCitation({ document_number: r.document_number, paragraph: r.paragraph, page: r.page }))} title="Скопировать сноску на норму" className="btn btn-sm btn-secondary py-1.5 max-md:py-2">{copiedKey === `cite-${r.chunk_id}` ? <Icon name="check" size={12} /> : <><Icon name="copy" size={12} /> Сноска</>}</button>
                          {(() => {
                            const fid = favoriteId({ kind: 'fragment', chunkId: r.chunk_id, query: resp.query });
                            const saved = isFavorite(fid);
                            return (
                              <button
                                onClick={() => {
                                  if (saved) removeFavorite(fid);
                                  else addFavorite({
                                    kind: 'fragment', chunkId: r.chunk_id, query: resp.query, text: r.text,
                                    documentId: r.document_id, documentNumber: r.document_number,
                                    documentTitle: r.document_title, paragraph: r.paragraph, page: r.page,
                                  });
                                }}
                                title={saved ? 'Убрать из избранного' : 'Сохранить фрагмент в избранное'}
                                className={`btn btn-sm py-1.5 max-md:py-2 border ${saved ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white' : 'btn-secondary'}`}
                              ><Icon name="star" size={13} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Сохранено' : 'Сохранить'}</button>
                            );
                          })()}
                          </div>
                          {r.source_url && r.source_url !== 'file://local' && <a href={r.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white max-md:py-1"><Icon name="external" size={12} /> Первоисточник</a>}
                        </div>
                        )}
                      </div>
                    )
                  })}
                  </div>
                  {locked && (
                    <button type="button" onClick={goLockedCta} aria-label="Зарегистрируйтесь и получайте бесплатные кредиты" className="absolute inset-0 w-full h-full cursor-pointer bg-transparent" />
                  )}
                </div>
              )
            })()}

            {resp.results.length === 0 && (
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
                <SnakeState variant="failed" title="Ничего не нашёл, но я старался" subtitle="Попробуйте синоним: коридор → проход / лестница → марш. Или снимите фильтры." size={140} action={<button onClick={() => { setFilterStatus(''); setFilterType(''); if (query) doSearch(query) }} className="btn btn-sm btn-primary px-4 py-2 text-xs">Сбросить фильтры</button>} />
              </div>
            )}

            <ValueCardModal card={selectedCard} query={resp.query || query} highlightPalette={highlightPalette} monoHex={monoHex} openPdf={openPdf} onClose={() => setSelectedCard(null)} />
          </div>
        )}
      </main>
    </>
  )
}
