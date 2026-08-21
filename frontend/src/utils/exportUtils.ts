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
    if (r.source_url) lines.push(`Источник: ${r.source_url}`)
    lines.push('---')
    lines.push('')
  }

  lines.push('*Экспортировано из snippy.llm*')
  return lines.join('\n')
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
