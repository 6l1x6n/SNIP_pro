import { useMemo } from 'react'
import { Icon } from './Icon'
import { ListRow } from './ListRow'
import { stringToColor } from '../utils/badges'
import { getSession, orderHistory } from '../utils/sessions'

type HistorySidebarProps = {
  open: boolean
  history: string[]
  pins: string[]
  activeQuery: string
  onPick: (h: string) => void
  onRemove: (h: string) => void
  onClear: () => void
  onClose: () => void
  onNewChat: () => void
  onTogglePin: (h: string) => void
  onOpenSearch: () => void
  onHoverEnter: () => void
  onHoverLeave: () => void
  user: any
  onProfile: () => void
  onLogin: () => void
}

/**
 * HistorySidebar — десктопный сайдбар сессий поиска.
 * Клик по записи восстанавливает прошлую сессию целиком БЕЗ квоты и токенов.
 * Закреплённые живут сверху и переживают очистку.
 */
export function HistorySidebar({
  open,
  history,
  pins,
  activeQuery,
  onPick,
  onRemove,
  onClear,
  onClose,
  onNewChat,
  onTogglePin,
  onOpenSearch,
  onHoverEnter,
  onHoverLeave,
  user,
  onProfile,
  onLogin,
}: HistorySidebarProps) {
  const { pinned, rest } = useMemo(() => orderHistory(history, pins), [history, pins])
  const unpinnedCount = rest.length
  const displayName = user ? user.full_name || user.email : ''
  const first = displayName ? displayName[0].toUpperCase() : '?'
  const bg = user ? stringToColor(user.email || '?') : '#64748b'

  const row = (h: string, isPinned: boolean) => {
    const saved = !!getSession(h)
    return (
      <ListRow
        key={h}
        compact
        className={`hover:bg-slate-50 dark:hover:bg-slate-800 transition ${
          h === activeQuery ? 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700' : ''
        }`}
        lead={
          <span className="text-slate-400 dark:text-slate-500 inline-flex">
            <Icon name={isPinned ? 'pin' : 'clock'} size={14} />
          </span>
        }
        title={<span className="text-[13px] font-normal text-slate-700 dark:text-slate-200">{h}</span>}
        titleAttr={h}
        subtitle={
          saved ? (
            <span className="text-emerald-600/80 dark:text-emerald-400/80">бесплатно • токены целы</span>
          ) : undefined
        }
        onOpen={() => onPick(h)}
        titleOpenLabel={saved ? `Открыть сессию «${h}» бесплатно — токены не спишутся` : `Вставить «${h}» в поиск`}
        trail={
          <span className="inline-flex items-center">
            <button
              onClick={() => onTogglePin(h)}
              title={isPinned ? 'Открепить' : 'Закрепить сверху'}
              aria-label={isPinned ? `Открепить «${h}»` : `Закрепить «${h}» сверху`}
              aria-pressed={isPinned}
              tabIndex={open ? 0 : -1}
              className={`icon-btn w-8 h-8 ${isPinned ? 'text-slate-900 dark:text-white' : 'text-slate-300 hover:text-slate-500 dark:hover:text-slate-300'}`}
            >
              <Icon name="pin" size={13} fill={isPinned ? 'currentColor' : 'none'} />
            </button>
            <button
              onClick={() => onRemove(h)}
              title="Убрать из истории"
              aria-label={`Убрать «${h}» из истории`}
              tabIndex={open ? 0 : -1}
              className="icon-btn w-8 h-8 text-slate-300 hover:text-red-400"
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        }
        trailWide
      />
    )
  }

  return (
    <aside
      id="search-history-sidebar"
      aria-hidden={!open}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      className={`sidebar-history hidden md:flex flex-col shrink-0 overflow-hidden border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
        open ? 'sidebar-history--open' : ''
      }`}
    >
      <div className="w-72 min-w-72 flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <div className="flex-1 min-w-0">
            <div className="section-label">История поиска</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {history.length > 0 ? `${history.length} запр.` : 'Пока пусто'}
            </div>
          </div>
          <button
            onClick={onClose}
            title="Закрыть историю"
            aria-label="Закрыть историю поиска"
            tabIndex={open ? 0 : -1}
            className="icon-btn w-8 h-8 border border-slate-200 dark:border-slate-700"
          >
            <Icon name="chevronLeft" size={16} />
          </button>
        </div>

        <div className="px-4 pb-2">
          <button
            onClick={onNewChat}
            tabIndex={open ? 0 : -1}
            title="Начать новый чат (история сохраняется)"
            className="btn btn-sm btn-primary w-full py-2"
          >
            <Icon name="plus" size={14} /> Новый чат
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {history.length === 0 && (
            <div className="mx-2 mt-2 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 p-4 text-center">
              <div className="w-9 h-9 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center">
                <Icon name="clock" size={16} />
              </div>
              <div className="text-[13px] font-medium text-slate-600 dark:text-slate-300 mt-2">
                Сессии появятся здесь
              </div>
              <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                Повторное открытие — бесплатно, токены не списываются
              </div>
            </div>
          )}

          {pinned.length > 0 && (
            <div className="pt-1">
              <div className="px-2 py-1 text-[10px] font-semibold text-slate-500 tracking-widest uppercase flex items-center gap-1.5">
                <Icon name="pin" size={11} /> Закреплённые
              </div>
              <div className="space-y-0.5">{pinned.map((h) => row(h, true))}</div>
            </div>
          )}

          {rest.length > 0 && (
            <div className={pinned.length > 0 ? 'pt-2' : 'pt-1'}>
              {pinned.length > 0 && (
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-500 tracking-widest uppercase flex items-center gap-1.5">
                  <Icon name="clock" size={11} /> Недавние
                </div>
              )}
              <div className="space-y-0.5">{rest.map((h) => row(h, false))}</div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 dark:border-slate-800 px-3 pt-2 pb-2.5">
          <div className="flex items-center gap-2">
            {user ? (
              <button
                onClick={onProfile}
                tabIndex={open ? 0 : -1}
                title="Открыть профиль"
                className="flex-1 min-w-0 flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-left"
              >
                <span
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[13px] shrink-0"
                  style={{ backgroundColor: bg }}
                >
                  {first}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate" title={displayName}>
                    {displayName}
                  </span>
                  <span className="block text-[11px] text-slate-400 truncate" title={user.email}>
                    Мой профиль
                  </span>
                </span>
              </button>
            ) : (
              <button
                onClick={onLogin}
                tabIndex={open ? 0 : -1}
                title="Войти в профиль"
                className="flex-1 min-w-0 flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition text-left"
              >
                <span className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center shrink-0">
                  <Icon name="user" size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-slate-700 dark:text-slate-200 truncate">
                    Войти
                  </span>
                  <span className="block text-[11px] text-slate-400 truncate">
                    Мой профиль
                  </span>
                </span>
              </button>
            )}
            <button
              onClick={onOpenSearch}
              tabIndex={open ? 0 : -1}
              title="Найти сессию в истории"
              aria-label="Найти сессию в истории"
              className="icon-btn w-9 h-9 border border-slate-200 dark:border-slate-700 shrink-0"
            >
              <Icon name="search" size={16} />
            </button>
          </div>
          {unpinnedCount > 0 && (
            <button
              onClick={onClear}
              tabIndex={open ? 0 : -1}
              className="w-full text-center text-[11px] text-slate-400 hover:text-red-500 transition py-1 mt-1"
            >
              Очистить историю
            </button>
          )}
          <div className="text-center text-[10px] text-slate-400/80 leading-relaxed mt-0.5">
            snippy.llm © 2026 · All rights reserved
          </div>
        </div>
      </div>
    </aside>
  )
}
