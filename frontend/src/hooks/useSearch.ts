import { useState, useCallback, useRef, useEffect } from 'react'
import { hybridSearchLegacy, hybridSearchBm25Only, askAI, rewriteQuery, embedQueryCached, type RewriteResult } from '../search/searchClient'
import { bm25TopIds, vectorTopIds } from '../search/engine'
import { findValueCards, type ValueCard } from '../search/values'
import { dispatchCredits, fetchCredits, availableTotal, DEEP_COST, FAST_COST } from '../utils/credits'
import {
  saveSession, getSession, removeSession, clearUnpinnedSessions,
  loadPins, togglePin as togglePinStore,
  SESSIONS_EVENT, PINS_EVENT,
} from '../utils/sessions'

export type SearchResult = {
  chunk_id: string
  document_id: string
  document_number: string
  document_title: string
  paragraph?: string
  section?: string
  page?: number
  text: string
  quote: string
  score: number
  relevance_percent: number
  relevance_label: string
  status: string
  source_url?: string
}

export type Answer = {
  answer: string
  normative_basis?: string
  paragraph?: string
  page?: number
  quote?: string
  status?: string
  date_actual?: string
  is_grounded: boolean
  extractive?: boolean
  provider?: string
}

export type SearchResponse = {
  query: string
  mode: string
  answer?: Answer
  results: SearchResult[]
  /** Источники ответа ИИ (чанки, к которым привязан ответ) — для честной атрибуции. */
  sources?: Array<{ i: number; d: number; p: string; pg: number | null }>
  /** Карточки точных значений из норм (локально, 0⚡). */
  valueCards?: ValueCard[]
  took_ms: number
  total_found: number
  message?: string
  degraded?: boolean
}

type SearchMode = 'fast' | 'deep'

/**
 * Кэш последнего ответа в localStorage: рефреш/переоткрытие вкладки с ?q=
 * восстанавливает результаты БЕЗ повторного поиска — квота не тратится дважды.
 * TTL 2 часа на случай долгоживущих вкладок.
 */
const LAST_RESP_KEY = 'snip_last_resp_v1'
const LAST_RESP_TTL = 2 * 3600 * 1000
const MODE_KEY = 'snip_search_mode'

interface LastRespCache {
  q: string
  mode: SearchMode
  filterType: string
  filterStatus: string
  savedAt: number
  resp: SearchResponse
}

function saveLastResp(entry: Omit<LastRespCache, 'savedAt'>) {
  try {
    const payload: LastRespCache = { ...entry, savedAt: Date.now() }
    localStorage.setItem(LAST_RESP_KEY, JSON.stringify(payload))
  } catch {}
}

export function loadLastResp(q: string, mode: string, filterType: string, filterStatus: string): SearchResponse | null {
  try {
    const raw = localStorage.getItem(LAST_RESP_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as LastRespCache
    if (!c || !c.resp) return null
    if (Date.now() - (c.savedAt || 0) > LAST_RESP_TTL) return null
    if (c.q === q && c.mode === mode && (c.filterType || '') === (filterType || '') && (c.filterStatus || '') === (filterStatus || '')) {
      return c.resp as SearchResponse
    }
    return null
  } catch {
    return null
  }
}

interface UseSearchOptions {
  user: any
  setShowAuth: (v: boolean) => void
  setAuthMode: (v: 'login' | 'register') => void
}

export function useSearch(opts: UseSearchOptions) {
  const [query, setQuery] = useState('')
  const [mode, setModeRaw] = useState<SearchMode>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'deep' ? 'deep' : 'fast'
    } catch { return 'fast' }
  })
  /**
   * Последний использованный режим — только для авторизованных (пер-девайс,
   * бесплатно). Гости всегда стартуют с fast и ничего не пишут.
   * ?mode= из расшаренной ссылки по-прежнему приоритетнее (App.tsx).
   */
  const setMode = useCallback((v: SearchMode) => {
    setModeRaw(v)
    try { if (opts.user) localStorage.setItem(MODE_KEY, v) } catch {}
  }, [opts.user])
  const [loading, setLoading] = useState(false)
  const [resp, setResp] = useState<SearchResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      const r = localStorage.getItem('snip_search_hist')
      return r ? JSON.parse(r) : []
    } catch { return [] }
  })
  const [showHistory, setShowHistory] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('active')
  const [showFilters, setShowFilters] = useState(false)
  const [insufficientCredits, setInsufficientCredits] = useState(false)
  const [answering, setAnswering] = useState(false)
  /** Закреплённые сессии (пины): живут сверху, переживают очистку. */
  const [pins, setPins] = useState<string[]>(() => loadPins())
  /** Тик для перерисовки при обновлении чужих слепков сессий (мультитаб). */
  const [, setSessionsTick] = useState(0)
  useEffect(() => {
    const onSessions = () => setSessionsTick((t) => t + 1)
    const onPins = () => setPins(loadPins())
    window.addEventListener(SESSIONS_EVENT, onSessions)
    window.addEventListener(PINS_EVENT, onPins)
    return () => {
      window.removeEventListener(SESSIONS_EVENT, onSessions)
      window.removeEventListener(PINS_EVENT, onPins)
    }
  }, [])
  const abortRef = useRef<AbortController | null>(null)
  const respRef = useRef<SearchResponse | null>(null)
  respRef.current = resp
  // Антиспам: дубль того же запроса <10с (двойной клик по «Найти») — игнор,
  // иначе каждый клик списывал бы токены. Ключ нормализован: регистр/пробелы/режим/фильтры
  // не дают обойти защиту. Осознанный повтор позже — дёшево (кэш ask бесплатен, fast-кэш 30с).
  const lastSearchRef = useRef<{ key: string; t: number }>({ key: '', t: 0 })
  const searchKey = (q: string) =>
    `${q.trim().toLowerCase().replace(/\s+/g, ' ')}|${mode}|${filterType}|${filterStatus}`
  /**
   * Ключ последнего ОТПРАВЛЕННОГО поиска. Повтор того же запроса
   * (та же кнопка «Найти» / Enter без изменений) — игнор: результат уже
   * показан, квота дважды не тратится.
   */
  const [submittedKey, setSubmittedKey] = useState<string | null>(null)
  /** true — запрос/режим/фильтры не менялись с последнего поиска и ответ на экране. */
  const isUnchanged = submittedKey !== null && !loading && !!respRef.current &&
    searchKey(query) === submittedKey

  const doSearch = useCallback(async (q: string = query) => {
    const trimmed = q.trim()
    if (!trimmed) return
    // Спам дублем: тот же запрос в пределах 10с — игнор (ни сети, ни списания).
    const nowT = Date.now()
    const key = searchKey(trimmed)
    if (key === lastSearchRef.current.key && nowT - lastSearchRef.current.t < 10000) return
    lastSearchRef.current = { key, t: nowT }
    // Повтор без изменений (кнопка/Enter после показанного результата) — игнор,
    // иначе каждый клик «Найти» списывал бы квоту за тот же ответ.
    // Ключ фиксируется только на успехе (ниже): после ошибки повтор разрешён.
    if (key === submittedKey && respRef.current) return
    if (abortRef.current) {
      try { abortRef.current.abort() } catch {}
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setInsufficientCredits(false)
    // Update history
    const qq = trimmed
    setSearchHistory(prev => {
      const next = [qq, ...prev.filter(x => x !== qq)].slice(0, 20)
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
    setShowHistory(false)
    setLoading(true)
    setError(null)

    try {
      // Единая логика для всех режимов: «Найти» без токенов = 0 сети и 0 трат.
      // Префлайт до embed/rewrite/ask: если доступно < cost — локальный BM25 топ-3
      // + 1 карточка значений + баннер. Провайдерские квоты не тратятся вообще.
      if (!ctrl.signal.aborted) {
        const need = mode === 'deep' ? DEEP_COST : FAST_COST
        try {
          const c = await fetchCredits(false)
          if (c && availableTotal(c) < need) {
            const [bm25Res, cards] = await Promise.all([
              hybridSearchBm25Only(trimmed, 3),
              findValueCards(trimmed, 50).catch(() => [] as ValueCard[]),
            ])
            if (ctrl.signal.aborted) return
            let fbResults = bm25Res.results
            if (filterStatus && filterStatus !== 'all') {
              fbResults = fbResults.filter((r) => r.status === filterStatus)
            }
            if (filterType) {
              fbResults = fbResults.filter((r) => r.document_number.toUpperCase().startsWith(filterType.toUpperCase()))
            }
            // Как в fast: без отсечки 55%, ровно топ-3 + только 1 карточка-тизер.
            fbResults = fbResults.slice(0, 3)
            const fbCards = (cards || []).slice(0, 1)
            const fbResp: SearchResponse = {
              query: trimmed,
              mode,
              results: fbResults,
              valueCards: fbCards,
              took_ms: bm25Res.took_ms,
              total_found: fbResults.length,
              degraded: true,
            }
            setResp(fbResp)
            saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: fbResp })
            saveSession(trimmed, fbResp, { mode, filterType, filterStatus })
            setSubmittedKey(key)
            setInsufficientCredits(true)
            return
          }
        } catch {
          // Токены не прочитались — идём обычным путём, сервер сам вернёт 402.
        }
      }
      // Гибридный поиск — целиком в браузере. fast → 3 результата, deep → до 30.
      // Списание fast (5⚡) происходит внутри /api/embed; 402 прилетает оттуда же.
      // При 429/502 эмбеддингов engine деградирует до BM25-only (degraded) вместо ошибки.
      let allResults, took_ms, weak: boolean, degraded: boolean | undefined, degradedReason: string | undefined
      let valueCards: ValueCard[] = []
      let rewrite: RewriteResult | null = null
      try {
        // Карточки значений — локально и бесплатно; понимание запроса (deep) и базовый поиск — параллельно.
        // Fail-open: rewrite недоступен/таймаут → поиск как раньше, без задержки.
        // Сигнал отмены проброшен везде: новый поиск обрывает сетевые запросы старого.
        const cardsP = findValueCards(trimmed, 50).catch(() => [] as ValueCard[])
        const rewriteP = mode === 'deep' ? rewriteQuery(trimmed, { timeoutMs: 2500, signal: ctrl.signal }) : Promise.resolve(null)
        // База не меняется (rewrite не переголосовывает ранжир) — расширяем только пул кандидатов
        // для reranking в /api/ask через BM25/векторные совпадения rewrite-запросов.
        const searchP = hybridSearchLegacy(trimmed, mode, mode === 'deep' ? 30 : 3, { signal: ctrl.signal })
        const [searchRes, rw, cards] = await Promise.all([searchP, rewriteP, cardsP])
        rewrite = rw
        ;({ results: allResults, took_ms, weak, degraded, degradedReason } = searchRes)
        valueCards = cards
      } catch (e: any) {
        if (e?.insufficientCredits) {
          // Гонка со stale-кэшем баланса: сервер отказал — показываем тот же
          // locked-тизер без доп. сети: BM25 топ-3 + 1 карточка.
          if (!ctrl.signal.aborted) {
            try {
              const [bm25Res, cards] = await Promise.all([
                hybridSearchBm25Only(trimmed, 3),
                findValueCards(trimmed, 50).catch(() => [] as ValueCard[]),
              ])
              if (!ctrl.signal.aborted) {
                let fbResults = bm25Res.results
                if (filterStatus && filterStatus !== 'all') fbResults = fbResults.filter((r) => r.status === filterStatus)
                if (filterType) fbResults = fbResults.filter((r) => r.document_number.toUpperCase().startsWith(filterType.toUpperCase()))
                fbResults = fbResults.slice(0, 3)
                const fbResp: SearchResponse = {
                  query: trimmed, mode, results: fbResults,
                  valueCards: (cards || []).slice(0, 1),
                  took_ms: bm25Res.took_ms, total_found: fbResults.length, degraded: true,
                }
                setResp(fbResp)
                saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: fbResp })
                saveSession(trimmed, fbResp, { mode, filterType, filterStatus })
                setSubmittedKey(key)
              }
            } catch {}
            setInsufficientCredits(true)
          }
          return
        }
        throw e
      }

      // фильтры клиента по документам
      let results = allResults
      if (filterStatus && filterStatus !== 'all') {
        results = results.filter(r => r.status === filterStatus)
      }
      if (filterType) {
        results = results.filter(r => r.document_number.toUpperCase().startsWith(filterType.toUpperCase()))
      }
      // Глубокий: отсекаем слабые совпадения (<55%)
      if (mode === 'deep') {
        results = results.filter(r => r.relevance_percent >= 55)
      }

      // Кандидаты для /api/ask: база top-24 + BM25-хиты rewrite-запросов и векторные хиты
      // русских переформулировок (до 32, без дублей). Пул расширяем, базовый ранжир не трогаем.
      let askCandidates = results.slice(0, 24).map(r => r.chunk_id)
      if (mode === 'deep' && rewrite?.queries.length && results.length) {
        try {
          const baseIds = new Set(results.map(r => Number(r.chunk_id)))
          const extra: number[] = []
          for (const rq of rewrite.queries.slice(0, 3)) {
            for (const id of await bm25TopIds(rq, 8)) {
              if (!baseIds.has(id) && !extra.includes(id)) extra.push(id)
            }
          }
          for (const rq of rewrite.queries.slice(0, 2)) {
            for (const id of await vectorTopIds(rq, 8, (t) => embedQueryCached(t, 'deep', ctrl.signal))) {
              if (!baseIds.has(id) && !extra.includes(id)) extra.push(id)
            }
          }
          askCandidates = [...askCandidates, ...extra.map(String)].slice(0, 32)
        } catch (e) {
          console.warn('rewrite candidates failed', e)
        }
      }

      const respBase: SearchResponse = {
        query: trimmed,
        mode,
        results,
        valueCards,
        took_ms,
        total_found: results.length,
        message: degraded && degradedReason
          ? degradedReason
          : weak && !results.length
            ? 'В доступной нормативной базе точного требования не найдено.'
            : undefined,
        degraded,
      }

      if (!ctrl.signal.aborted) {
        setResp(respBase)
        saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: respBase })
        // Слепок сессии: повторное открытие — без сети и квоты.
        saveSession(trimmed, respBase, { mode, filterType, filterStatus })
        setSubmittedKey(key)
      }

      // ИИ-ответ — только в глубоком режиме. Повтор вопроса бесплатен (ask_cache),
      // values-ответ бесплатен — осознанный повтор не бьёт по квоте.
      if (mode === 'deep' && results.length && !weak && !ctrl.signal.aborted) {
        try {
          const ask = await askAI(trimmed, mode, askCandidates, ctrl.signal)
          if (!ctrl.signal.aborted) {
            const full = { ...respBase, answer: ask.answer, sources: ask.sources }
            setResp(full)
            saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: full })
            saveSession(trimmed, full, { mode, filterType, filterStatus })
            setSubmittedKey(key)
            if (ask.credits) dispatchCredits(ask.credits)
          }
        } catch (e: any) {
          if (e?.insufficientCredits) {
            if (!ctrl.signal.aborted) {
              setInsufficientCredits(true)
              // Гонка: префлайт пропустил, а /api/ask вернул 402 — урезаем уже
              // показанные результаты до 3 как в fast (вариант Б), без доп. трат.
              const cur = respRef.current
              if (cur && (cur.results.length > 3 || (cur.valueCards?.length ?? 0) > 1)) {
                const cut: SearchResponse = {
                  ...cur,
                  results: cur.results.slice(0, 3),
                  total_found: Math.min(cur.total_found, 3),
                  valueCards: (cur.valueCards || []).slice(0, 1),
                }
                setResp(cut)
                saveLastResp({ q: trimmed, mode, filterType, filterStatus, resp: cut })
                saveSession(trimmed, cut, { mode, filterType, filterStatus })
              }
            }
            return
          }
          console.warn('ask failed', e)
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // Отменённый поиск мог успеть списаться на сервере (там же и refund) —
        // принудительно тянем свежий баланс, а не ждём TTL.
        fetchCredits(true).catch(() => {})
        return
      }
      // Дружелюбный текст вместо "embed failed: 502 — cohere embed 429"
      if (e?.rateLimited || e?.status === 429) {
        const wait = typeof e?.retryAfterMs === 'number' ? ` (повтор через ~${Math.max(1, Math.ceil(e.retryAfterMs / 1000))} с)` : ''
        setError(`Лимит эмбеддингов временно исчерпан${wait} — подождите и нажмите поиск ещё раз. Токены за неудавшийся поиск возвращены автоматически.`)
        fetchCredits(true).catch(() => {})
      } else if (typeof e?.message === 'string' && e.message.startsWith('embed failed')) {
        setError('Векторный поиск временно недоступен — попробуйте ещё раз через несколько секунд. Токены за неудавшийся поиск возвращены автоматически.')
        fetchCredits(true).catch(() => {})
      } else {
        setError(e.message || 'Ошибка поиска')
      }
    } finally {
      if (abortRef.current === ctrl) setLoading(false)
    }
  }, [query, mode, filterType, filterStatus, submittedKey])

  /**
   * До-запрос ИИ-ответа к уже показанным результатам (без повторного поиска):
   * для кэша без ответа после рефреша. Тратит только ask (10⚡), embed не нужен.
   */
  const requestAnswer = useCallback(async () => {
    const cur = respRef.current
    if (!cur || answering || cur.answer?.is_grounded || !cur.results.length) return
    setAnswering(true)
    setError(null)
    try {
      const ask = await askAI(cur.query, cur.mode as SearchMode, cur.results.slice(0, 24).map(r => r.chunk_id))
      const full = { ...cur, answer: ask.answer, sources: ask.sources }
      setResp(full)
      saveLastResp({ q: cur.query, mode: cur.mode as SearchMode, filterType, filterStatus, resp: full })
      saveSession(cur.query, full, { mode: cur.mode, filterType, filterStatus })
      setSubmittedKey(`${cur.query.trim().toLowerCase().replace(/\s+/g, ' ')}|${cur.mode}|${filterType}|${filterStatus}`)
      if (ask.credits) dispatchCredits(ask.credits)
    } catch (e: any) {
      if (e?.insufficientCredits) { setInsufficientCredits(true); return }
      console.warn('ask failed', e)
    } finally {
      setAnswering(false)
    }
  }, [answering, filterType, filterStatus])

  /**
   * Восстановить прошлую сессию целиком (ответ + результаты) БЕЗ сети и квоты.
   * Возвращает true если слепок найден, иначе false (тогда caller вставляет текст).
   */
  const restoreSession = useCallback((q: string) => {
    const e = getSession(q)
    if (!e || !e.resp) return false
    if (e.mode === 'fast' || e.mode === 'deep') setMode(e.mode)
    setFilterType(e.filterType || '')
    setFilterStatus(e.filterStatus || 'active')
    setQuery(q)
    setResp(e.resp as SearchResponse)
    setError(null)
    setInsufficientCredits(false)
    setShowHistory(false)
    // Результат уже на экране — повтор «Найти» без изменений заблокирован.
    setSubmittedKey(`${q.trim().toLowerCase().replace(/\s+/g, ' ')}|${e.mode}|${e.filterType || ''}|${e.filterStatus || 'active'}`)
    return true
  }, [setMode])

  /** Новый чат: чистый экран + фокус в поиск. История и сессии сохраняются. */
  const newChat = useCallback(() => {
    if (abortRef.current) {
      try { abortRef.current.abort() } catch {}
    }
    setQuery('')
    setResp(null)
    setError(null)
    setInsufficientCredits(false)
    setShowHistory(false)
    setSubmittedKey(null)
  }, [])

  const togglePinHistory = useCallback((item: string) => {
    const next = togglePinStore(item)
    setPins(next)
    // Закреплённая запись обязана быть видна в истории — поднимаем наверх.
    if (next.includes(item)) {
      setSearchHistory(prev => {
        if (prev.includes(item)) return prev
        const updated = [item, ...prev].slice(0, 20)
        try { localStorage.setItem('snip_search_hist', JSON.stringify(updated)) } catch {}
        return updated
      })
    }
  }, [])

  const clearHistory = useCallback(() => {
    // Пины переживают очистку: остаются в истории и их сессии не удаляются.
    const keep = loadPins()
    setSearchHistory(prev => {
      const next = prev.filter(x => keep.includes(x))
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
    clearUnpinnedSessions(keep)
  }, [])

  const removeHistoryItem = useCallback((item: string) => {
    setSearchHistory(prev => {
      const next = prev.filter(x => x !== item)
      try { localStorage.setItem('snip_search_hist', JSON.stringify(next)) } catch {}
      return next
    })
    removeSession(item)
  }, [])

  return {
    query, setQuery,
    mode, setMode,
    loading,
    resp, setResp,
    error,
    isUnchanged,
    searchHistory, clearHistory, removeHistoryItem,
    pins, togglePinHistory, restoreSession, newChat,
    showHistory, setShowHistory,
    filterType, setFilterType,
    filterStatus, setFilterStatus,
    showFilters, setShowFilters,
    doSearch,
    requestAnswer, answering,
    insufficientCredits,
    setInsufficientCredits,
  }
}
