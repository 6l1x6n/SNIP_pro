/**
 * Export utilities for search results.
 */

import type { SearchResponse } from '../hooks/useSearch'

/**
 * Format search results as Markdown text.
 */
export function resultsToMarkdown(resp: SearchResponse): string {
  const lines: string[] = []
  lines.push(`# Поиск: ${resp.query}`)
  lines.push(`Режим: ${resp.mode === 'deep' ? 'Глубокий' : 'Быстрый'} | Найдено: ${resp.total_found} | Время: ${resp.took_ms} мс`)
  lines.push('')

  if (resp.answer) {
    lines.push('## Ответ')
    lines.push(resp.answer.answer)
    lines.push('')
    if (resp.answer.normative_basis) lines.push(`**Нормативное основание:** ${resp.answer.normative_basis}`)
    if (resp.answer.paragraph) lines.push(`**Пункт:** ${resp.answer.paragraph}`)
    if (resp.answer.page) lines.push(`**Страница:** ${resp.answer.page}`)
    if (resp.answer.quote) lines.push(`\n> ${resp.answer.quote}`)
    if (resp.answer.is_grounded && resp.results[0]) {
      lines.push(`\n**Сноска:** ${formatCitation({ document_number: resp.results[0].document_number, paragraph: resp.answer.paragraph && resp.answer.paragraph !== '—' ? resp.answer.paragraph : resp.results[0].paragraph, page: resp.results[0].page })}`)
    }
    lines.push('')
  }

  lines.push('## Результаты')
  lines.push('')
  for (const r of resp.results) {
    lines.push(`### ${r.document_number} — ${r.document_title}`)
    lines.push(`Статус: ${r.status} | Релевантность: ${r.relevance_percent}% (${r.relevance_label})`)
    if (r.paragraph) lines.push(`Пункт: ${r.paragraph}`)
    if (r.page) lines.push(`Страница: ${r.page}`)
    lines.push('')
    lines.push(r.text.slice(0, 500) + (r.text.length > 500 ? '…' : ''))
    lines.push('')
    lines.push(`Сноска: ${formatCitation({ document_number: r.document_number, paragraph: r.paragraph, page: r.page })}`)
    if (r.source_url) lines.push(`Источник: ${r.source_url}`)
    lines.push('---')
    lines.push('')
  }

  lines.push('*Экспортировано из snippy.llm*')
  return lines.join('\n')
}

/**
 * Короткая сноска на норму: «СП РК 3.02-101-2012, п. 5.4, стр. 311».
 */
export function formatCitation(s: {
  document_number?: string
  paragraph?: string | number | null
  page?: number | null
}): string {
  const bits: string[] = [s.document_number || 'Норма']
  const p = formatParagraph(s.paragraph != null ? String(s.paragraph) : '')
  if (p !== '—') bits.push(p)
  if (s.page != null) bits.push(`стр. ${s.page}`)
  return bits.join(', ')
}

/**
 * Номер пункта от модели: мусор вида "[1]"/"Источник 1" → пусто (фронт добьёт номером чанка).
 * Совпадает с серверным cleanParagraphValue (worker/src/index.ts).
 */
export function cleanParagraph(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s || s === '—') return ''
  if (/[\[\]]/.test(s)) return ''
  // «Таблица А.1» — не номер пункта (иначе ниже вынется «1»)
  if (/таблиц/i.test(s)) return ''
  const m = s.match(/\d+(\.\d+)*[а-яa-z]?/)
  const num = m ? m[0] : ''
  return num && /^\d+(\.\d+)*[а-яa-z]?$/.test(num) ? num : ''
}

/** Показ пункта: «п. 5.4» для номеров, «Таблица А.1» как есть, иначе прочерк. */
export function formatParagraph(p?: string | null): string {
  const s = String(p ?? '').trim()
  if (!s || s === '—') return '—'
  // Таблицу проверяем ДО cleanParagraph: иначе из «Таблица А.1» вынется «1»
  if (/^Таблица\s+[А-ЯA-Zа-яa-z]?\s*\.?\s*\d+(\.\d+)*/.test(s)) {
    return s.replace(/\s+/g, ' ').replace(/\s*\.\s*/g, '.')
  }
  const c = cleanParagraph(s)
  return c ? `п. ${c}` : '—'
}

/** Чистка цитаты для показа: линейки оглавлений и лишний шум (зеркало sanitizeContextText воркера). */
export function sanitizeQuote(s: string): string {
  return String(s ?? '')
    .split('\n')
    .map((line) => {
      const toc = line.match(/^(.+?)\s*[….]{3,}\s*\d{1,4}\s*$/)
      if (toc) line = toc[1]
      return line.replace(/[….]{4,}/g, ' … ')
    })
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Умная обрезка: по границе предложения, иначе слова, с многоточием. */
export function truncateSmart(s: string, limit = 600): string {
  const t = String(s ?? '')
  if (t.length <= limit) return t
  const slice = t.slice(0, limit)
  const sent = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '), slice.lastIndexOf('\n'))
  if (sent > limit * 0.4) return slice.slice(0, sent + 1).trim() + '…'
  const sp = slice.lastIndexOf(' ')
  if (sp > limit * 0.5) return slice.slice(0, sp).trim() + '…'
  return slice.trim() + '…'
}

/**
 * Download a string as a file.
 */
export function downloadAsFile(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * Copy text to clipboard with fallback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
