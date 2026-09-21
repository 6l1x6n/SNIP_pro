// @ts-nocheck
import { useMemo, useState } from 'react'
import { SnakeState } from '../components/SnakeState'
import { statusBadge } from '../utils/badges'
import { highlightText } from '../utils/highlight'
import { Icon } from '../components/Icon'

type DocsViewProps = {
  docs: any[]
  docsLoading: boolean
  filterStatus: string
  setFilterStatus: (v: string) => void
  loadDocs: () => void
  openPdf: (docId: string, page?: number | null, quote?: string | null) => void
  user: any
  onLogin?: () => void
}

/**
 * DocsView — фиксированный пакет нормативных документов.
 * Для гостей список заблюрен: для просмотра нужно войти.
 * Доступен всем без входа; загрузка/удаление не предусмотрены:
 * обновление пакета = пересборка индекса (scripts/build_index.py).
 */
export function DocsView({ docs, docsLoading, filterStatus, setFilterStatus, loadDocs, openPdf, user, onLogin }: DocsViewProps) {
  const totalChunks = docs.reduce((s: number, d: any) => s + (d.chunks_count || 0), 0)
  const locked = !user
  const [q, setQ] = useState('')

  const norm = (s: string) => (s || '').toLowerCase().replace(/ё/g, 'е')
  const words = useMemo(() => norm(q).split(/\s+/).filter(Boolean), [q])
  const filtered = useMemo(() => {
    if (!words.length) return docs
    return docs
      .map((d: any) => {
        const hay = norm(`${d.number} ${d.title}`)
        let hits = 0
        for (const w of words) if (hay.includes(w)) hits++
        return { d, hits }
      })
      .filter((x) => x.hits === words.length)
      .sort((a, b) => {
        // точное вхождение в номере — выше
        const an = norm(a.d.number), bn = norm(b.d.number)
        const aq = norm(q)
        const aExact = an.includes(aq) ? 1 : 0, bExact = bn.includes(aq) ? 1 : 0
        if (aExact !== bExact) return bExact - aExact
        return (b.d.chunks_count || 0) - (a.d.chunks_count || 0)
      })
      .map((x) => x.d)
  }, [docs, words, q])

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Нормативные документы</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Единый пакет действующих норм РК • {docs.length} док. • {totalChunks} фрагментов в поиске
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap max-md:w-full">
            <div className="relative flex-1 min-w-[180px] max-md:basis-full">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                <Icon name="search" size={15} />
              </div>
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Поиск: номер или название… (напр. 405, коридор, пожарная)"
                className="input pl-9 pr-8 py-2 max-md:py-2.5 max-md:text-base"
              />
              {q && (
                <button onClick={() => setQ('')} title="Очистить" className="absolute right-2 top-1/2 -translate-y-1/2 icon-btn w-7 h-7 max-md:w-9 max-md:h-9"><Icon name="close" size={14} /></button>
              )}
            </div>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="input w-auto px-3 py-2 max-md:py-2.5 max-md:flex-1"
            >
              <option value="active">Действующие</option>
              <option value="">Все</option>
              <option value="replaced">Заменённые</option>
              <option value="expired">Утратившие силу</option>
            </select>
            <button
              onClick={loadDocs}
              className="btn btn-md btn-secondary py-2 max-md:py-2.5 max-md:flex-1"
            >
              <Icon name="refresh" size={14} /> Обновить
            </button>
          </div>
        </div>
      </div>

      {docsLoading && (
        <div className="grid gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 animate-pulse">
              <div className="h-4 w-40 bg-slate-100 dark:bg-slate-800 rounded" />
              <div className="h-3 w-64 bg-slate-100 dark:bg-slate-800 rounded mt-2" />
            </div>
          ))}
        </div>
      )}

      {q && !docsLoading && (
        <div className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          Найдено {filtered.length} из {docs.length} {words.length > 1 ? '• все слова должны встречаться' : ''}
        </div>
      )}

      {!docsLoading && filtered.length === 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
          <SnakeState variant="failed" title={q ? 'По запросу ничего не нашлось' : 'Документов не найдено'} subtitle={q ? 'Попробуйте номер (405, 2.02) или слово из названия.' : 'Снимите фильтр статуса или обновите список.'} size={120} action={
            <button onClick={() => { if (q) setQ(''); else { setFilterStatus(''); loadDocs() } }} className="btn btn-sm btn-primary px-4 py-2 text-xs">{q ? 'Очистить поиск' : 'Показать все'}</button>
          } />
        </div>
      )}

      {!docsLoading && filtered.length > 0 && (
        <div className="relative">
          <div className={`grid gap-3 animate-[slideUp_.25s_ease-out] ${locked ? 'blur-sm pointer-events-none select-none' : ''}`} aria-hidden={locked || undefined}>
          {filtered.map((d: any, idx: number) => {
            const badge = statusBadge(d.status)
            const isPdf = !!d.pdf_path && /\.pdf$/i.test(d.pdf_path)
            return (
              <div
                key={d.id}
                className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 max-md:p-4 hover:shadow-md hover:-translate-y-px transition-all"
                style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
              >
                <div className="flex max-md:flex-col max-md:items-stretch items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-slate-900 dark:text-white truncate min-w-0" title={d.number}>{q ? highlightText(d.number, q) : d.number}</span>
                      {d.type && <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 whitespace-nowrap">{d.type}</span>}
                      <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${badge.cls}`}>{badge.label}</span>
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300 mt-1 line-clamp-2 [overflow-wrap:anywhere]" title={typeof d.title === 'string' ? d.title : undefined}>{q ? highlightText(d.title, q) : d.title}</div>
                    <div className="text-[11px] text-slate-400 mt-1.5 truncate">
                      {d.chunks_count} фрагментов в поиске{d.pages ? ` • ${d.pages} стр.` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => openPdf(d.id)}
                    disabled={!isPdf || locked}
                    title={locked ? 'Войдите, чтобы открыть PDF' : isPdf ? 'Открыть PDF' : 'PDF не приложен — доступен только текст в поиске'}
                    className="btn btn-md btn-primary py-2 max-md:py-2.5 max-md:text-[13px] shrink-0 md:w-[132px] md:justify-center max-md:w-full"
                  >
                    {isPdf ? <><Icon name="file" size={13} /> Открыть PDF</> : 'Только текст'}
                  </button>
                </div>
              </div>
            )
          })}
          </div>
          {locked && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-4">
              <div className="max-w-sm w-full bg-white/95 dark:bg-slate-900/95 backdrop-blur rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl p-6 text-center">
                <div className="w-12 h-12 mx-auto rounded-full bg-slate-900 dark:bg-slate-800 text-white flex items-center justify-center"><Icon name="lock" size={20} /></div>
                <div className="font-semibold text-slate-900 dark:text-white mt-3">Для просмотра войдите</div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
                  Раздел «Документы» и PDF доступны после входа. Это бесплатно — зарегистрированные получают 300 токенов каждый час по акции.
                </p>
                <button onClick={onLogin} className="btn btn-md btn-primary mt-4 px-6 py-2.5">Войти / Создать аккаунт</button>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-center text-[11px] text-slate-400 dark:text-slate-500 mt-6">
        Пакет документов единый для всех и обновляется вместе с изменениями норм. Нашли устаревшую норму? Напишите нам.
      </p>
    </main>
  )
}
