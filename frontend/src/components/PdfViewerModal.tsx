// @ts-nocheck — pdfjs v6 typing quirks
import { useCallback, useEffect, useRef, useState } from 'react'
import { findDoc, resolvePdfUrl, type DocInfoLite } from '../utils/pdf'
import { PdfExplainSidebar, type ExplainItem } from './PdfExplainSidebar'

/**
 * PdfViewerModal — PDF во всплывающем окне со сайдбаром-объяснятором.
 * Десктоп: документ слева + сайдбар справа. Мобилка: документ + bottom-sheet.
 * initialQuote — цитата/контекст из поиска: подсвечивается на странице + автоскролл.
 */
import { sigWords, normLower, stemWord } from '../utils/stem'
import type { ContextMarkMode } from '../utils/highlight'
import { pushRecentDoc } from '../utils/recentDocs'
import { addFavorite, removeFavorite, isFavorite, favoriteId, FAVORITES_EVENT } from '../utils/favorites'
import { Icon } from './Icon'

/** Бокс текстового фрагмента pdf.js в координатах viewport (CSS px, origin top-left). */
interface ItemBox {
  str: string
  x0: number
  y0: number
  x1: number
  y1: number
}

const TOKEN_RE = /[а-яa-z0-9]+/gi

/** Сырые боксы в порядке content stream (== порядку DOM-спанов слоя). */
export function boxesFromTextContent(tc: any, viewport: any): ItemBox[] {
  const out: ItemBox[] = []
  try {
    for (const it of tc.items ?? []) {
      const s = String(it.str ?? '')
      if (!s.trim()) continue
      const tr = it.transform
      if (!tr) continue
      const w = Number(it.width ?? 0)
      const h = Math.abs(Number(tr[3] ?? tr[0] ?? 12)) || 12
      const [x, y] = viewport.convertToViewportPoint(Number(tr[4]), Number(tr[5]))
      const [xe] = viewport.convertToViewportPoint(Number(tr[4]) + w, Number(tr[5]))
      out.push({ str: s, x0: Math.min(x, xe) - 1, y0: y - h - 1, x1: Math.max(x, xe) + 1, y1: y + h * 0.25 + 1 })
    }
  } catch {}
  return out
}

interface VWord {
  w: string // stem
  item: number // индекс бокса
  str: string // исходный кусок (для границ предложений)
}

/** Визуальный порядок: кластеризация в строки по Y, внутри строки — по X. */
export function visualWords(boxes: ItemBox[]): VWord[] {
  if (!boxes.length) return []
  const heights = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b)
  const med = heights[Math.floor(heights.length / 2)] || 10
  const tol = Math.max(2, med * 0.5)
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y0 - boxes[b].y0 || boxes[a].x0 - boxes[b].x0)
  const lines: number[][] = []
  for (const i of order) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(boxes[i].y0 - boxes[last[0]].y0) <= tol) last.push(i)
    else lines.push([i])
  }
  const out: VWord[] = []
  for (const line of lines) {
    line.sort((a, b) => boxes[a].x0 - boxes[b].x0)
    for (const i of line) {
      const re = new RegExp(TOKEN_RE.source, 'gi')
      let m: RegExpExecArray | null
      while ((m = re.exec(boxes[i].str))) {
        const st = stemWord(m[0])
        if (st.length >= 2 && !/^\d+$/.test(st)) out.push({ w: st, item: i, str: m[0] })
      }
    }
  }
  return out
}

interface AnchorHit {
  score: number
  matched: number
  total: number
  fromItem: number
  toItem: number
}

/** Скоринговый поиск: окна якорей (начало/середина/конец цитаты), допуск пропусков. */
export function findAnchor(vw: VWord[], quote: string): AnchorHit | null {
  const sig = sigWords(quote)
  if (sig.length < 2 || !vw.length) return null
  const page = vw.map((v) => v.w)
  const windows: string[][] = []
  if (sig.length <= 8) windows.push(sig)
  else {
    windows.push(sig.slice(0, 8))
    windows.push(sig.slice(Math.floor(sig.length / 2) - 4, Math.floor(sig.length / 2) + 4))
    windows.push(sig.slice(-8))
  }
  let best: AnchorHit | null = null
  for (const anchor of windows) {
    const m = matchScore(page, anchor)
    if (!m) continue
    if (!best || m.matched > best.matched || (m.matched === best.matched && m.score > best.score)) {
      best = { score: m.score, matched: m.matched, total: anchor.length, fromItem: vw[m.from].item, toItem: vw[m.to].item }
    }
    if (best.score === 1 && best.matched >= 6) break
  }
  if (!best) return null
  if (best.matched < 3) return null
  if (best.matched < 4 && best.score < 0.6) return null
  return best
}

/** Расширение диапазона до границ предложений (макс ±80 слов). */
export function expandToSentences(vw: VWord[], fromItem: number, toItem: number): { fromItem: number; toItem: number } {
  const idx = vw.map((v) => v.item)
  let a = idx.indexOf(fromItem)
  let b = idx.lastIndexOf(toItem)
  if (a === -1 || b === -1) return { fromItem, toItem }
  const isEnd = (s: string) => /[.!?…:;]$/.test(s.trim())
  let na = a
  for (let i = a - 1, n = 0; i >= 0 && n < 80; i--, n++) {
    if (isEnd(vw[i].str)) {
      na = i + 1
      break
    }
    na = i
  }
  let nb = b
  for (let i = b, n = 0; i < vw.length && n < 80; i++, n++) {
    nb = i
    if (isEnd(vw[i].str)) break
  }
  // кап: без пунктуации (таблицы) не расползаемся дальше ±25 слов от попадания
  na = Math.max(na, a - 25)
  nb = Math.min(nb, b + 25)
  return { fromItem: vw[na].item, toItem: vw[nb].item }
}

/**
 * Подсветка через спаны слоя (без surroundContents — не ломается на разрывах нод).
 * Спаны идут в порядке content stream == порядке боксов; сверяем покрытие.
 */
function highlightItems(
  container: HTMLElement,
  boxes: ItemBox[],
  fromItem: number,
  toItem: number
): number {
  const lo = Math.min(fromItem, toItem)
  const hi = Math.max(fromItem, toItem)
  const nodes: Text[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let nd: Text | null
  while ((nd = walker.nextNode() as Text | null)) {
    if ((nd.nodeValue || '').trim()) nodes.push(nd)
  }
  const nonEmpty = boxes.filter((b) => b.str.trim()).length
  // покрытие: количество текстовых нод должно биться с боксами (±20%)
  if (!nodes.length || !nonEmpty || Math.abs(nodes.length - nonEmpty) / nonEmpty > 0.2) return -1
  let marked = 0
  const n = Math.min(nodes.length, boxes.length)
  for (let i = 0; i < n; i++) {
    if (i >= lo && i <= hi) {
      const el = nodes[i].parentElement
      if (el && (el.tagName === 'SPAN' || el.tagName === 'DIV')) {
        el.classList.add('snip-hit')
        marked++
      }
    }
  }
  return marked
}

/** Ядро скоринга: упорядоченное совпадение с допуском ≤2 пропусков слов якоря. */
function matchScore(
  page: string[],
  anchor: string[],
  maxSkips = 2,
  windowSize = 100
): { matched: number; score: number; from: number; to: number } | null {
  let best: { matched: number; score: number; from: number; to: number } | null = null
  for (let i = 0; i < page.length; i++) {
    // старт: первое слово якоря либо одно из двух следующих (лидирующий пропуск)
    let k = 0
    let skips = 0
    if (page[i] === anchor[0]) k = 1
    else if (anchor.length > 1 && page[i] === anchor[1]) {
      k = 2
      skips = 1
    } else if (anchor.length > 2 && page[i] === anchor[2]) {
      k = 3
      skips = 2
    } else continue
    let matched = 1
    let last = i
    const end = Math.min(page.length, i + windowSize)
    for (let j = i + 1; j < end && k < anchor.length; j++) {
      if (page[j] === anchor[k]) {
        k++
        matched++
        last = j
      } else {
        for (let m = 1; m <= 2 && skips + m <= maxSkips && k + m < anchor.length; m++) {
          if (page[j] === anchor[k + m]) {
            skips += m
            k += m + 1
            matched++
            last = j
            break
          }
        }
      }
    }
    const score = matched / anchor.length
    if (!best || matched > best.matched || (matched === best.matched && score > best.score)) {
      best = { matched, score, from: i, to: last }
    }
    if (best && best.score === 1 && best.matched >= 6) break
  }
  return best
}

/** Быстрый скоринг последовательности (для пробы страниц без рендера). */
function scoreAnchorWords(pageStems: string[], quote: string): number {
  const sig = sigWords(quote)
  if (sig.length < 2 || !pageStems.length) return 0
  const anchor = sig.length <= 8 ? sig : sig.slice(0, 8)
  return matchScore(pageStems, anchor)?.score ?? 0
}

export function scorePageText(tc: any, quote: string): number {
  try {
    const parts: string[] = []
    for (const it of tc.items ?? []) parts.push(String(it.str ?? ''))
    const joined = parts.join(' ')
    const re = new RegExp(TOKEN_RE.source, 'gi')
    const words: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(joined))) {
      const st = stemWord(m[0])
      if (st.length >= 2 && !/^\d+$/.test(st)) words.push(st)
    }
    return scoreAnchorWords(words, quote)
  } catch {
    return 0
  }
}

export function PdfViewerModal({ docId, initialPage = 1, initialQuote = null, markMode = 'fill', onClose, onTopUp }: {
  docId: string
  initialPage?: number
  initialQuote?: string | null
  markMode?: ContextMarkMode
  onClose: () => void
  onTopUp: () => void
}) {
  const [doc, setDoc] = useState<DocInfoLite | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [ready, setReady] = useState(false) // pdf.js-документ загружен и готов к рендеру
  const [error, setError] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [pageNum, setPageNum] = useState(Math.max(1, initialPage || 1))
  const [pageInput, setPageInput] = useState(String(initialPage || 1))
  const [rendering, setRendering] = useState(false)
  const [searchingContext, setSearchingContext] = useState(false)
  // Якорь зоны контекста для режима «стикер»: y-центр первого бокса (CSS px от верха страницы)
  const [accentAnchor, setAccentAnchor] = useState<{ y: number } | null>(null)
  const [stickerHidden, setStickerHidden] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [items, setItems] = useState<ExplainItem[]>([])
  const [selBtn, setSelBtn] = useState<{ x: number; y: number; text: string } | null>(null)

  const pdfjsRef = useRef<any>(null)
  const pdfRef = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const anchorElRef = useRef<HTMLDivElement>(null)
  const markModeRef = useRef<ContextMarkMode>(markMode)
  useEffect(() => { markModeRef.current = markMode }, [markMode])
  const [hitInfo, setHitInfo] = useState<{ found: number; total: number; jumpedTo?: number; emptyLayer?: boolean } | null>(null)
  const quoteRef = useRef<string | null>(initialQuote || null)
  const quotePageRef = useRef<number>(Math.max(1, initialPage || 1))
  const quoteTargetRef = useRef<number>(Math.max(1, initialPage || 1)) // куда реально прыгнули
  const didScrollRef = useRef(false)
  const probeDoneRef = useRef(false)
  const boxesRef = useRef<ItemBox[] | null>(null)
  const numPagesRef = useRef(0)
  const runIdRef = useRef(0)

  const scrollToFirstHit = (tl: HTMLDivElement) => {
    setTimeout(() => {
      const first = tl.querySelector('.snip-hit') as HTMLElement | null
      first?.scrollIntoView({ block: 'center' })
    }, 50)
  }

  /** Скролл к якорю зоны через невидимый элемент (для режима «стикер» — меток в слое нет). */
  const scrollToZone = () => {
    setTimeout(() => {
      anchorElRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }

  /** Проба соседних страниц по тексту без рендера (дешёвая). */
  const probeNeighborPages = async (pdf: any, center: number, total: number, quote: string, runId: number) => {
    let best: { page: number; score: number } | null = null
    for (let d = 1; d <= 3; d++) {
      for (const p of [center - d, center + d]) {
        if (p < 1 || p > total) continue
        if (runIdRef.current !== runId) return null
        try {
          const pg = await pdf.getPage(p)
          const tc = await pg.getTextContent()
          const s = scorePageText(tc, quote)
          try {
            if (typeof pg.cleanup === 'function') pg.cleanup()
          } catch {}
          if (s >= 0.6 && (!best || s > best.score)) best = { page: p, score: s }
        } catch {}
      }
      if (best && best.score >= 0.85) break
    }
    return best
  }

  const runHighlight = async (tl: HTMLDivElement, boxes: ItemBox[], quote: string, page: number) => {
    const runId = ++runIdRef.current
    const total = sigWords(quote).length
    const sticker = markModeRef.current === 'sticker'
    setSearchingContext(true)
    try {
      const vw = visualWords(boxes)
      const hit = vw.length ? findAnchor(vw, quote) : null
      if (hit) {
        const exp = expandToSentences(vw, hit.fromItem, hit.toItem)
        const lo = Math.min(exp.fromItem, exp.toItem)
        const ab = boxes[lo]
        const anchorY = ab ? (ab.y0 + ab.y1) / 2 : null
        if (runIdRef.current !== runId) return
        if (sticker) {
          // Режим «стикер»: бумага чистая, только якорь зоны + скролл к нему
          if (anchorY != null) {
            setAccentAnchor({ y: anchorY })
            setStickerHidden(false)
          }
          setHitInfo({ found: hit.matched, total, jumpedTo: quoteTargetRef.current !== quotePageRef.current ? quoteTargetRef.current : undefined })
          if (!didScrollRef.current) {
            didScrollRef.current = true
            scrollToZone()
          }
          return
        }
        const marked = highlightItems(tl, boxes, exp.fromItem, exp.toItem)
        if (runIdRef.current !== runId) return
        if (marked > 0) {
          setHitInfo({ found: hit.matched, total, jumpedTo: quoteTargetRef.current !== quotePageRef.current ? quoteTargetRef.current : undefined })
          if (!didScrollRef.current) {
            didScrollRef.current = true
            scrollToFirstHit(tl)
          }
          return
        }
      }
      // Промах — один раз ищем на соседних страницах и перепрыгиваем
      if (!probeDoneRef.current && pdfRef.current) {
        probeDoneRef.current = true
        const best = await probeNeighborPages(pdfRef.current, page, numPagesRef.current || page, quote, runId)
        if (runIdRef.current !== runId) return
        if (best) {
          quoteTargetRef.current = best.page
          setPageNum(best.page)
          setPageInput(String(best.page))
          scrollAreaRef.current?.scrollTo({ top: 0 })
          return // эффект перерендерит страницу и снова вызовет runHighlight
        }
      }
      if (runIdRef.current !== runId) return
      setAccentAnchor(null)
      setHitInfo({ found: 0, total, emptyLayer: boxes.length === 0 })
    } finally {
      if (runIdRef.current === runId) setSearchingContext(false)
    }
  }

  // ── Блокировка скролла фона, пока открыт PDF ──
  const [, setFavTick] = useState(0)
  useEffect(() => {
    const onFav = () => setFavTick((t) => t + 1)
    window.addEventListener(FAVORITES_EVENT, onFav)
    return () => window.removeEventListener(FAVORITES_EVENT, onFav)
  }, [])
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    const prevPaddingRight = document.body.style.paddingRight
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPaddingRight
    }
  }, [])

  // ── Инициализация: pdf.js + документ + URL ──
  // «Недавние»: пишем при открытии, при закрытии обновляем текущей страницей.
  const pageNumRef = useRef(pageNum)
  useEffect(() => { pageNumRef.current = pageNum }, [pageNum])
  const docMetaRef = useRef<{ number: string; title: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (!pdfjsRef.current) {
          const lib = await import('pdfjs-dist')
          const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
          lib.GlobalWorkerOptions.workerSrc = workerUrl
          pdfjsRef.current = lib
        }
        const d = await findDoc(docId)
        if (!d?.file) throw new Error('У этого документа не приложен PDF')
        if (cancelled) return
        setDoc(d)
        docMetaRef.current = { number: d.number || docId, title: d.title || '' }
        pushRecentDoc({ docId, number: docMetaRef.current.number, title: docMetaRef.current.title, page: Math.max(1, initialPage || 1) })
        const u = await resolvePdfUrl(d.file)
        if (cancelled) return
        setUrl(u)
        const pdf = await pdfjsRef.current.getDocument({ url: u }).promise
        if (cancelled) return
        pdfRef.current = pdf
        setNumPages(pdf.numPages)
        numPagesRef.current = pdf.numPages
        const p = Math.min(Math.max(1, initialPage || 1), pdf.numPages)
        setPageNum(p)
        setPageInput(String(p))
        setReady(true) // триггерит рендер-эффект
      } catch (e: any) {
        if (cancelled) return
        const name = e?.name || ''
        const msg = e?.message || ''
        if (name === 'InvalidPDFException' || /invalid pdf|pdf structure/i.test(msg)) {
          setError('Файл документа повреждён или не является PDF. Мы уже знаем о проблеме — пока пользуйтесь текстом в поиске.')
        } else {
          setError(msg || 'Не удалось открыть PDF')
        }
      }
    })()
    return () => {
      cancelled = true
      try { renderTaskRef.current?.cancel() } catch {}
      const meta = docMetaRef.current
      if (meta) {
        try { pushRecentDoc({ docId, number: meta.number, title: meta.title, page: pageNumRef.current }) } catch {}
      }
    }
  }, [docId])

  // ── Рендер страницы ──
  useEffect(() => {
    const pdf = pdfRef.current
    const canvas = canvasRef.current
    const tl = textLayerRef.current
    if (!ready || !pdfjsRef.current || !pdf || !canvas || !tl) return
    let cancelled = false
    ;(async () => {
      try {
        try { renderTaskRef.current?.cancel() } catch {}
        tl.innerHTML = ''
        setRendering(true)
        const page = await pdf.getPage(pageNum)
        if (cancelled) return
        const area = scrollAreaRef.current
        const availW = Math.min((area?.clientWidth ?? 800) - 32, 920)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.max(0.3, (availW / base.width)) * zoom
        const viewport = page.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        const task = page.render({ canvasContext: ctx, viewport })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return
        const textLayer = new pdfjsRef.current.TextLayer({
          textContentSource: page.streamTextContent(),
          container: tl,
          viewport,
        })
        await textLayer.render()
        tl.style.setProperty('--scale-factor', String(scale))
        tl.style.width = `${Math.floor(viewport.width)}px`
        tl.style.height = `${Math.floor(viewport.height)}px`
        // ── Кэш текстовых боксов страницы (визуальный порядок для выделения и анкоров) ──
        let boxes: ItemBox[] = []
        try {
          const tc = await page.getTextContent()
          boxes = boxesFromTextContent(tc, viewport)
          boxesRef.current = boxes
        } catch {
          boxesRef.current = null
        }
        if (tl.childElementCount === 0 && boxes.length > 0) {
          console.warn('[pdf] текстовый слой пуст при непустом content — проверьте выравнивание слоёв, стр.', pageNum)
        }
        // ── Подсветка контекста из поиска ──
        if (!cancelled && quoteRef.current && pageNum === quoteTargetRef.current) {
          await runHighlight(tl, boxes, quoteRef.current, pageNum)
        } else if (!cancelled) {
          setHitInfo(null)
          setAccentAnchor(null)
        }
      } catch (e: any) {
        if (!cancelled && e?.name !== 'RenderingCancelledException') console.warn('page render', e)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => { cancelled = true }
  }, [pageNum, url, zoom, ready])

  // ── Клавиши ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') goPage(pageNum - 1)
      if (e.key === 'ArrowRight') goPage(pageNum + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pageNum, numPages])

  const goPage = (n: number) => {
    const clamped = Math.min(Math.max(1, n), numPages || 1)
    setPageNum(clamped)
    setPageInput(String(clamped))
    setSelBtn(null)
    setAccentAnchor(null)
    window.getSelection()?.removeAllRanges()
    scrollAreaRef.current?.scrollTo({ top: 0 })
  }

  const setZoomPreset = (z: number) => {
    if (z === zoom) return
    setSelBtn(null)
    window.getSelection()?.removeAllRanges()
    setZoom(z)
  }

  /** Текст выделения в визуальном порядке чтения (строки по Y, слова по X). */
  const selectionToVisualText = (sel: Selection): string | null => {
    const boxes = boxesRef.current
    const tl = textLayerRef.current
    if (!boxes?.length || !tl) return null
    try {
      const r = tl.getBoundingClientRect()
      const rects = Array.from(sel.getClientRects())
        .map((rc) => ({ x0: rc.left - r.left, y0: rc.top - r.top, x1: rc.right - r.left, y1: rc.bottom - r.top }))
        .filter((rc) => rc.x1 > 0 && rc.y1 > 0 && rc.x0 < r.width && rc.y0 < r.height)
      if (!rects.length) return null
      const hitIdx = boxes
        .map((b, i) => i)
        .filter((i) => {
          const b = boxes[i]
          return rects.some((rc) => b.x0 < rc.x1 && b.x1 > rc.x0 && b.y0 < rc.y1 && b.y1 > rc.y0)
        })
      if (!hitIdx.length) return null
      // кластеризация выбранного в строки (та же логика, что в visualWords)
      const heights = hitIdx.map((i) => boxes[i].y1 - boxes[i].y0).sort((a, b) => a - b)
      const tol = Math.max(2, (heights[Math.floor(heights.length / 2)] || 10) * 0.5)
      const byY = [...hitIdx].sort((a, b) => boxes[a].y0 - boxes[b].y0 || boxes[a].x0 - boxes[b].x0)
      const lines: number[][] = []
      for (const i of byY) {
        const last = lines[lines.length - 1]
        if (last && Math.abs(boxes[i].y0 - boxes[last[0]].y0) <= tol) last.push(i)
        else lines.push([i])
      }
      const text = lines
        .map((line) =>
          line
            .sort((a, b) => boxes[a].x0 - boxes[b].x0)
            .map((i) => boxes[i].str.trim())
            .filter(Boolean)
            .join(' ')
        )
        .join('\n')
        .replace(/[ \t]+/g, ' ')
        .trim()
      return text || null
    } catch {
      return null
    }
  }

  // ── Выделение текста → плавающая кнопка «Объяснить» ──
  const onMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection()
      const raw = sel?.toString().trim() ?? ''
      if (!sel || sel.isCollapsed) { setSelBtn(null); return }
      const node = sel.anchorNode
      if (!node || !textLayerRef.current?.contains(node)) { setSelBtn(null); return }
      // Предпочитаем визуальный порядок (защита от DOM-склейки колонок/таблиц)
      let text = raw
      const visual = selectionToVisualText(sel)
      if (visual && visual.length >= 10) text = visual
      if (text.length < 10) { setSelBtn(null); return }
      const range = sel.getRangeAt(0).getBoundingClientRect()
      setSelBtn({ x: range.left + range.width / 2, y: range.top - 8, text: text.slice(0, 1500) })
    }, 10)
  }

  // Кнопка не должна переживать скролл/клик в другое место
  useEffect(() => {
    const area = scrollAreaRef.current
    if (!area) return
    const clear = () => setSelBtn(null)
    area.addEventListener('scroll', clear)
    document.addEventListener('mousedown', clear)
    return () => {
      area.removeEventListener('scroll', clear)
      document.removeEventListener('mousedown', clear)
    }
  }, [url])

  // Выделение сохраняется после клика — кнопка лишь фиксирует фрагмент
  const explainSelection = () => {
    if (!selBtn) return
    const full = selBtn.text
    const item: ExplainItem = { id: Date.now(), quote: full.slice(0, 1500), truncated: full.length > 1500 }
    setItems((prev) => [...prev, item])
    setSheetOpen(true)
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex flex-col" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex-1 min-h-0 w-full max-w-[1400px] mx-auto my-0 md:my-4 md:px-4 flex">
        <div className="flex-1 min-w-0 flex flex-col bg-slate-100 dark:bg-slate-950 md:rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden">

          {/* Тулбар */}
          <div className="shrink-0 flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">{doc?.number || 'PDF'}</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-md:hidden">{doc?.title}</div>
            </div>
            {/* Десктоп/sm+: пресеты зума — без изменений */}
            <div className="hidden sm:flex items-center gap-0.5 mx-1 shrink-0 bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5" title="Масштаб">
              {[0.75, 1, 1.25].map((z) => (
                <button key={z} onClick={() => setZoomPreset(z)}
                  className={`px-2 py-1 rounded-md text-[11px] font-semibold tabular-nums transition ${zoom === z ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}>
                  {z * 100}%
                </button>
              ))}
            </div>
            {/* Мобайл: одна кнопка зума по кругу 100→125→150→75 */}
            <button
              onClick={() => {
                const order = [1, 1.25, 1.5, 0.75]
                const i = order.indexOf(zoom)
                setZoomPreset(order[(i + 1 + order.length) % order.length] ?? 1)
              }}
              title="Масштаб (нажмите чтобы изменить)"
              className="sm:hidden shrink-0 h-10 min-w-[56px] px-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-xs font-bold tabular-nums"
            >
              <Icon name="zoomIn" size={13} className="inline -mt-0.5" /> {Math.round(zoom * 100)}%
            </button>
            <div className="hidden sm:flex items-center gap-1 mx-1 shrink-0">
              <button onClick={() => goPage(pageNum - 1)} disabled={pageNum <= 1 || !ready || rendering} title="Предыдущая страница" className="icon-btn w-8 h-8 border border-slate-200 dark:border-slate-700"><Icon name="chevronLeft" size={15} /></button>
              <input value={pageInput} onChange={e => setPageInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => e.key === 'Enter' && goPage(Number(pageInput))}
                onBlur={() => setPageInput(String(pageNum))}
                className="w-12 text-center text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white py-1.5" />
              <span className="text-xs text-slate-400 tabular-nums">/ {numPages || '…'}</span>
              <button onClick={() => goPage(pageNum + 1)} disabled={(!!numPages && pageNum >= numPages) || !ready || rendering} title="Следующая страница" className="icon-btn w-8 h-8 border border-slate-200 dark:border-slate-700"><Icon name="chevronRight" size={15} /></button>
            </div>
            <button onClick={() => setSheetOpen(v => !v)} title="Объяснятор" className={`md:hidden w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg border transition shrink-0 flex items-center justify-center ${sheetOpen ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-indigo-600 dark:text-indigo-400'}`}><Icon name="lightbulb" size={16} /></button>
            {(() => {
              const fid = favoriteId({ kind: 'page', documentId: docId, page: pageNum })
              const saved = isFavorite(fid)
              return (
                <button
                  onClick={() => {
                    if (saved) removeFavorite(fid)
                    else addFavorite({ kind: 'page', documentId: docId, documentNumber: doc?.number || docId, documentTitle: doc?.title || '', page: pageNum })
                  }}
                  title={saved ? 'Убрать страницу из избранного' : 'Сохранить страницу в избранное'}
                  className={`w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg border transition shrink-0 flex items-center justify-center ${saved ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'}`}
                ><Icon name="star" size={15} fill={saved ? 'currentColor' : 'none'} /></button>
              )
            })()}
            <button onClick={onClose} title="Закрыть" className="w-8 h-8 max-md:w-10 max-md:h-10 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-red-500 hover:border-red-200 transition shrink-0 flex items-center justify-center">
              <Icon name="close" size={15} />
            </button>
          </div>

          {/* Баннер подсветки контекста из поиска */}
          {quoteRef.current && hitInfo && (
            <div className={`shrink-0 px-3 py-1.5 text-xs border-b ${hitInfo.found > 0 ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200' : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400'}`}>
              <div className="flex items-center gap-2">
                <span>
                  {hitInfo.found > 0
                    ? (markMode === 'sticker'
                      ? `Стикер указывает на зону контекста (совпало ${hitInfo.found} из ${hitInfo.total} слов)${hitInfo.jumpedTo ? ` · найдено на стр. ${hitInfo.jumpedTo}` : ''}`
                      : `Контекст подсвечен (совпало ${hitInfo.found} из ${hitInfo.total} слов)${hitInfo.jumpedTo ? ` · найдено на стр. ${hitInfo.jumpedTo}` : ''}`)
                    : hitInfo.emptyLayer
                      ? 'Текстовый слой пуст (скан?) — подсветка невозможна, смотрите страницу целиком'
                      : 'Точное место не подсвечено — страница открыта рядом, ниже текст из поиска'}
                </span>
                <button onClick={() => { quoteRef.current = null; setHitInfo(null); setAccentAnchor(null); textLayerRef.current?.querySelectorAll('.snip-hit').forEach((m) => m.classList.remove('snip-hit')) }} className="ml-auto underline shrink-0">Убрать подсветку</button>
              </div>
              {hitInfo.found === 0 && !hitInfo.emptyLayer && quoteRef.current && (
                <div className="mt-1.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-2 flex items-start gap-2">
                  <div className="flex-1 min-w-0 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-slate-200 [overflow-wrap:anywhere] max-h-20 overflow-y-auto">«{(quoteRef.current || '').slice(0, 500)}{(quoteRef.current || '').length > 500 ? '…' : ''}»</div>
                  <button
                    onClick={() => { try { navigator.clipboard?.writeText(quoteRef.current || '') } catch {} }}
                    title="Скопировать текст из поиска"
                    className="shrink-0 icon-btn w-8 h-8 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700"
                  ><Icon name="copy" size={13} /></button>
                </div>
              )}
            </div>
          )}

          {/* Контент: PDF + сайдбар */}
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            {/* PDF */}
            <div ref={scrollAreaRef} onMouseUp={onMouseUp} className="relative flex-1 min-h-0 overflow-auto overscroll-contain p-4 max-md:p-1.5 flex justify-center bg-slate-200/70 dark:bg-slate-900">
              {error ? (
                <div className="m-auto max-w-sm text-center bg-white dark:bg-slate-900 rounded-2xl border border-red-200 dark:border-red-900 p-6">
                  <div className="w-11 h-11 mx-auto mb-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center"><Icon name="file" size={20} /></div>
                  <div className="font-semibold text-slate-900 dark:text-white text-sm">PDF недоступен</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{error}</div>
                </div>
              ) : !url ? (
                <div className="m-auto w-full max-w-sm text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
                  <div className="flex items-center justify-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                    <span className="w-5 h-5 border-2 border-slate-300 dark:border-slate-600 border-t-blue-600 rounded-full animate-spin" />
                    Загружаем документ…
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 tabular-nums">
                    {initialQuote ? `Открываем стр. ${pageNum} + контекст из поиска` : `Открываем стр. ${pageNum}…`}
                  </div>
                  <div className="mt-4 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full w-2/3 rounded-full bg-slate-900/80 dark:bg-white/80 animate-pulse" />
                  </div>
                  <div className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">Большому PDF нужно несколько секунд — это нормально</div>
                </div>
              ) : (
                <div className="flex items-start justify-center gap-4">
                <div className="relative shadow-lg" style={{ width: 'fit-content', maxWidth: '100%' }}>
                  <canvas ref={canvasRef} className="block bg-white min-w-[280px] max-md:min-w-0 min-h-[380px] max-w-full" />
                  <div ref={textLayerRef} className="textLayer absolute left-0 top-0 overflow-hidden select-text" onMouseUp={onMouseUp} />
                  {/* Невидимый якорь зоны контекста — скролл через scrollIntoView (без ручной математики) */}
                  {markMode === 'sticker' && accentAnchor && (
                    <div ref={anchorElRef} aria-hidden className="pointer-events-none absolute left-0 h-px w-px" style={{ top: accentAnchor.y }} />
                  )}
                  {/* Мобилка: пилюля над зоной по центру (сбоку места нет) */}
                  {markMode === 'sticker' && accentAnchor && !stickerHidden && hitInfo && hitInfo.found > 0 && !rendering && !searchingContext && (
                    <div
                      className="sm:hidden absolute z-10 -translate-x-1/2 rounded-full border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/95 pl-2 pr-2 py-1.5 shadow-lg flex items-center gap-1.5 whitespace-nowrap"
                      style={{ left: '50%', top: Math.max(28, accentAnchor.y - 52) }}
                    >
                      <span aria-hidden className="absolute left-1/2 -translate-x-1/2 w-0 h-0 border-x-8 border-x-transparent border-t-8 border-t-amber-300 dark:border-t-amber-800" style={{ bottom: -8 }} />
                      <span className="text-[11px] font-semibold text-amber-900 dark:text-amber-200 tabular-nums">{hitInfo.found}/{hitInfo.total}</span>
                      <button onClick={scrollToZone} className="text-[11px] underline text-amber-800 dark:text-amber-300">К зоне</button>
                      <button onClick={() => setStickerHidden(true)} title="Скрыть стикер" className="text-amber-700/60 dark:text-amber-400/60 hover:text-red-500 px-0.5"><Icon name="close" size={12} /></button>
                    </div>
                  )}
                  {(rendering || searchingContext || !ready) && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-slate-950/70 backdrop-blur-[1px] min-w-[280px] max-md:min-w-0 min-h-[380px]">
                      <div className="mx-4 w-full max-w-xs text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 px-5 py-4 shadow-xl">
                        <div className="flex items-center justify-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                          <span className="w-5 h-5 border-2 border-slate-300 dark:border-slate-600 border-t-blue-600 rounded-full animate-spin" />
                          {searchingContext ? 'Ищем подсвеченный контекст…' : !ready ? 'Загружаем документ…' : `Открываем стр. ${pageNum}${numPages ? ` из ${numPages}` : ''}…`}
                        </div>
                        {initialQuote && !searchingContext && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">+ контекст из поиска</div>
                        )}
                        <div className="mt-3 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full w-2/3 rounded-full bg-slate-900/80 dark:bg-white/80 animate-pulse" />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {/* Десктоп: боковая колонка под стикер — сбоку от бумаги, не на ней */}
                {markMode === 'sticker' && accentAnchor && !stickerHidden && hitInfo && hitInfo.found > 0 && !rendering && !searchingContext && (
                  <div className="hidden sm:block relative w-[190px] shrink-0 self-stretch">
                    <div
                      className="absolute left-0 right-0 -translate-y-1/2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/90 px-3 py-2 shadow-lg"
                      style={{ top: Math.max(70, accentAnchor.y) }}
                    >
                      <span aria-hidden className="absolute top-1/2 -translate-y-1/2 w-0 h-0 border-y-8 border-y-transparent border-r-8 border-r-amber-300 dark:border-r-amber-800" style={{ left: -8 }} />
                      <div className="flex items-start gap-1">
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-semibold text-amber-900 dark:text-amber-200">Контекст из поиска</div>
                          <div className="text-[11px] text-amber-800 dark:text-amber-300 tabular-nums">совпало {hitInfo.found} из {hitInfo.total} слов</div>
                        </div>
                        <button onClick={() => setStickerHidden(true)} title="Скрыть стикер" className="shrink-0 text-amber-700/60 dark:text-amber-400/60 hover:text-red-500 px-0.5"><Icon name="close" size={12} /></button>
                      </div>
                      <button onClick={scrollToZone} className="mt-1 text-[11px] underline text-amber-800 dark:text-amber-300">К зоне</button>
                    </div>
                  </div>
                )}
                </div>
              )}

              {/* Плавающая кнопка «Объяснить» */}
              {selBtn && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={explainSelection}
                  className="fixed z-[60] -translate-x-1/2 -translate-y-full px-3 py-1.5 pb-2.5 rounded-xl rounded-bl-none bg-indigo-600 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 hover:bg-indigo-700 transition"
                  style={{ left: Math.max(70, selBtn.x), top: selBtn.y }}
                >
                  <Icon name="lightbulb" size={13} className="inline -mt-0.5" /> Объяснить фрагмент
                </button>
              )}
            </div>

            {/* Сайдбар: десктоп справа / мобилка снизу */}
            <div className={`
              ${sheetOpen ? 'flex' : 'hidden'} md:flex
              md:w-[360px] md:max-w-[40%] shrink-0
              fixed md:relative inset-x-0 bottom-0 md:inset-auto z-10
              h-[55dvh] md:h-auto max-h-[80dvh]
              bg-white dark:bg-slate-900 border-t md:border-t-0 md:border-l border-slate-200 dark:border-slate-800
              md:rounded-none rounded-t-2xl shadow-[0_-8px_30px_rgba(0,0,0,.15)] md:shadow-none flex-col
            `}>
              <div aria-hidden className="md:hidden mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" />
              <button onClick={() => setSheetOpen(false)} className="md:hidden absolute right-3 top-2 icon-btn w-9 h-9 bg-slate-100 dark:bg-slate-800"><Icon name="close" size={15} /></button>
              <PdfExplainSidebar docNumber={doc?.number ?? ''} items={items} onTopUp={onTopUp} />
            </div>
          </div>

          {/* Мобильная навигация страниц */}
          <div className="sm:hidden shrink-0 flex items-center justify-center gap-3 py-2 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800" style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}>
            <button onClick={() => goPage(pageNum - 1)} disabled={pageNum <= 1 || !ready || rendering} className="btn btn-md px-6 py-2.5 btn-secondary"><Icon name="chevronLeft" size={16} /></button>
            <span className="text-sm text-slate-600 dark:text-slate-300 tabular-nums min-w-[64px] text-center">{pageNum} / {numPages || '…'}</span>
            <button onClick={() => goPage(pageNum + 1)} disabled={(!!numPages && pageNum >= numPages) || !ready || rendering} className="btn btn-md px-6 py-2.5 btn-secondary"><Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
