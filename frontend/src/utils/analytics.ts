/**
 * Client-side search analytics — tracks popular queries and personal stats.
 * Stored in localStorage, no backend required.
 */

const LS_KEY = 'snip_search_analytics'
const MAX_ENTRIES = 200

interface QueryRecord {
  query: string
  count: number
  lastSearched: string
}

interface Analytics {
  queries: Record<string, QueryRecord>
  totalSearches: number
}

function load(): Analytics {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { queries: {}, totalSearches: 0 }
}

function save(analytics: Analytics) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(analytics)) } catch {}
}

/**
 * Record a search query.
 */
export function trackSearch(query: string) {
  const a = load()
  const q = query.trim().toLowerCase()
  if (!q) return

  if (a.queries[q]) {
    a.queries[q].count++
    a.queries[q].lastSearched = new Date().toISOString()
  } else {
    a.queries[q] = {
      query: query.trim(),
      count: 1,
      lastSearched: new Date().toISOString(),
    }
  }
  a.totalSearches++

  const entries = Object.entries(a.queries)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => new Date(a[1].lastSearched).getTime() - new Date(b[1].lastSearched).getTime())
    a.queries = Object.fromEntries(entries.slice(-MAX_ENTRIES))
  }

  save(a)
}

/**
 * Get trending queries (most searched).
 */
export function getTrendingQueries(limit = 5): string[] {
  const a = load()
  return Object.values(a.queries)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map(r => r.query)
}

/**
 * Get recently searched queries.
 */
export function getRecentQueries(limit = 5): string[] {
  const a = load()
  return Object.values(a.queries)
    .sort((a, b) => new Date(b.lastSearched).getTime() - new Date(a.lastSearched).getTime())
    .slice(0, limit)
    .map(r => r.query)
}

/**
 * Get personal analytics summary.
 */
export function getPersonalStats(): { totalSearches: number; uniqueQueries: number; topQuery: string | null } {
  const a = load()
  const entries = Object.values(a.queries)
  return {
    totalSearches: a.totalSearches,
    uniqueQueries: entries.length,
    topQuery: entries.length > 0 ? entries.sort((x, y) => y.count - x.count)[0].query : null,
  }
}
