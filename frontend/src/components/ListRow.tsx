import type { ReactNode } from 'react'

type ListRowProps = {
  /** Фикс. иконка слева 32×32 (28×28 в compact). Если нет — ячейка не рендерится. */
  lead?: ReactNode
  /** Заголовок — всегда 1 строка с ellipsis. */
  title: ReactNode
  /** Полный текст для title-атрибута (доступность + длинные названия). */
  titleAttr?: string
  /** Подзаголовок — всегда 1 строка с ellipsis. */
  subtitle?: ReactNode
  subtitleAttr?: string
  /** Правая фикс. ячейка 32×32 (кнопка ×, галочка) или wide для сумм. */
  trail?: ReactNode
  /** Широкая правая ячейка (суммы в «Последних операциях»). */
  trailWide?: boolean
  /** Клик по текстовому блоку (открыть документ и т.п.). Тело становится <button>. */
  onOpen?: () => void
  titleOpenLabel?: string
  /**
   * Вся строка — одна кнопка (для строк без интерактивного trail:
   * QuickSearch-подсказки, недавние/популярные запросы).
   * Нельзя сочетать с интерактивным trail (кнопка в кнопке).
   */
  wholeRow?: boolean
  compact?: boolean
  className?: string
  bodyClassName?: string
}

function attrOf(node: ReactNode, fallback?: string): string | undefined {
  if (fallback != null) return fallback
  return typeof node === 'string' ? node : undefined
}

/**
 * ListRow — единая фиксированная сетка для строк списков
 * («Недавние документы», «Недавние/Популярные», «Последние операции», «Избранное»).
 *
 * Сетка: [lead 32px | body minmax(0,1fr) | trail 32px], items-center.
 * Ширина всегда от контейнера, текст — truncate 1+1, иконка/экшен — фикс. размер.
 */
export function ListRow({
  lead,
  title,
  titleAttr,
  subtitle,
  subtitleAttr,
  trail,
  trailWide,
  onOpen,
  titleOpenLabel,
  wholeRow,
  compact,
  className = '',
  bodyClassName = '',
}: ListRowProps) {
  const cls = `list-row${compact ? ' list-row--compact' : ''} ${className}`
  const leadEl = lead != null ? (
    <span className="list-row__lead" aria-hidden={typeof titleAttr === 'string' ? undefined : true}>
      {lead}
    </span>
  ) : null
  const textEl = (
    <>
      <span className="list-row__title" title={attrOf(title, titleAttr)}>
        {title}
      </span>
      {subtitle !== undefined && subtitle !== null && (
        <span className="list-row__sub" title={attrOf(subtitle, subtitleAttr)}>
          {subtitle}
        </span>
      )}
    </>
  )
  const trailEl = trail != null ? (
    <span className={`list-row__trail${trailWide ? ' list-row__trail--wide' : ''}`}>{trail}</span>
  ) : null

  // Вся строка — кнопка (trail только декоративный, без вложенных кнопок).
  if (wholeRow && onOpen) {
    return (
      <button type="button" onClick={onOpen} title={titleOpenLabel} className={cls}>
        {leadEl}
        <span className={`list-row__body ${bodyClassName}`}>{textEl}</span>
        {trailEl}
      </button>
    )
  }

  // Кликабельное только текстовое тело (trail может быть кнопкой ×).
  const bodyEl = onOpen ? (
    <button type="button" onClick={onOpen} title={titleOpenLabel} className={`list-row__body ${bodyClassName}`}>
      {textEl}
    </button>
  ) : (
    <div className={`list-row__body ${bodyClassName}`}>{textEl}</div>
  )

  return (
    <div className={cls}>
      {leadEl}
      {bodyEl}
      {trailEl}
    </div>
  )
}
