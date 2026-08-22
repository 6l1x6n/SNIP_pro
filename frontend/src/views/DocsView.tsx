// @ts-nocheck
import { SnakeState } from '../components/SnakeState'
import { statusBadge } from '../utils/badges'

type DocsViewProps = {
  docs: any[]
  docsLoading: boolean
  filterStatus: string
  setFilterStatus: (v: string) => void
  loadDocs: () => void
  openPdf: (docId: string, page?: number | null) => void
  user: any
}

/**
 * DocsView — фиксированный пакет нормативных документов.
 * Доступен всем без входа; загрузка/удаление не предусмотрены:
 * обновление пакета = пересборка индекса (scripts/build_index.py).
 */
export function DocsView({ docs, docsLoading, filterStatus, setFilterStatus, loadDocs, openPdf }: DocsViewProps) {
  const totalChunks = docs.reduce((s: number, d: any) => s + (d.chunks_count || 0), 0)

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
          <div className="flex items-center gap-2">
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-white px-3 py-2 text-sm"
            >
              <option value="active">Действующие</option>
              <option value="">Все</option>
              <option value="replaced">Заменённые</option>
              <option value="expired">Утратившие силу</option>
            </select>
            <button
              onClick={loadDocs}
              className="px-4 py-2 bg-white dark:bg-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl text-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition"
            >
              Обновить
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

      {!docsLoading && docs.length === 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6">
          <SnakeState variant="failed" title="Документов не найдено" subtitle="Снимите фильтр статуса или обновите список." size={120} action={
            <button onClick={() => { setFilterStatus(''); loadDocs() }} className="px-4 py-2 rounded-full bg-blue-600 text-white text-xs">Показать все</button>
          } />
        </div>
      )}

      {!docsLoading && docs.length > 0 && (
        <div className="grid gap-3 animate-[slideUp_.25s_ease-out]">
          {docs.map((d: any, idx: number) => {
            const badge = statusBadge(d.status)
            return (
              <div
                key={d.id}
                className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 hover:shadow-md hover:-translate-y-px transition-all"
                style={{ animationDelay: `${Math.min(idx * 30, 200)}ms` }}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{d.number}</span>
                      {d.type && <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">{d.type}</span>}
                      <span className={`text-[11px] px-2 py-0.5 rounded-full border ${badge.cls}`}>{badge.label}</span>
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300 mt-1 line-clamp-2">{d.title}</div>
                    <div className="text-[11px] text-slate-400 mt-1.5">
                      {d.chunks_count} фрагментов в поиске{d.pages ? ` • ${d.pages} стр.` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => openPdf(d.id)}
                    disabled={!d.pdf_path}
                    title={d.pdf_path ? 'Открыть PDF' : 'PDF не приложен к индексу'}
                    className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition shrink-0 shadow-sm shadow-blue-600/20"
                  >
                    Открыть PDF
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-center text-[11px] text-slate-400 dark:text-slate-500 mt-6">
        Пакет документов единый для всех и обновляется вместе с изменениями норм. Нашли устаревшую норму? Напишите нам.
      </p>
    </main>
  )
}
