/** Синтетика LLM-цепочки: 400 скипает звено (не абортит), 401 абортит, фолбэки отвечают. */
import { answerWithFallback } from '../worker/src/index'

let fail = 0
function ok(cond: boolean, name: string, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    fail++
    console.log(`  ✗ ${name}`, extra ?? '')
  }
}

const dbStub = () => ({
  prepare: () => {
    const q = {
      bind: (..._a: any[]) => q,
      run: async () => ({}),
      first: async () => null,
      all: async () => ({ results: [] }),
    }
    return q
  },
  batch: async () => [],
})
const env: any = {
  DB: dbStub(),
  GROQ_API_KEY: 'x',
  GROQ_MODEL: 'openai/gpt-oss-120b',
  GEMINI_API_KEY: 'y',
}

const CTX = ['Ширина коридоров должна быть не менее 1,4 м при длине до 10 м.']
const good = (quote: string) =>
  JSON.stringify({ answer: 'Ширина коридоров — не менее 1,4 м.', quote, paragraph: '5.8', is_grounded: true })
const QUOTE = 'Ширина коридоров должна быть не менее 1,4 м'
const mk = (extra: string) => `ответь JSON ${extra} контекст: ${CTX[0]} вопрос: ширина?`

function mockFetch(handler: (url: string, init: any) => { status: number; body: any }) {
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    const r = handler(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }
}
async function main() {
  const groqModelOf = (init: any) => {
    try {
      return JSON.parse(init.body).model
    } catch {
      return '?'
    }
  }

  // Тест 1: primary 429 → 8b 429 → qwen отвечает (20b 400 скипается)
  mockFetch((url, init) => {
    if (url.includes('groq')) {
      const m = groqModelOf(init)
      if (m === 'qwen/qwen3.6-27b')
        return { status: 200, body: { choices: [{ message: { content: good(QUOTE) } }] } }
      if (m === 'openai/gpt-oss-20b') return { status: 400, body: { error: 'model_not_found' } }
      return { status: 429, body: { error: 'rate_limited' } }
    }
    return { status: 500, body: {} }
  })
  const t1 = await answerWithFallback(env, mk, CTX, 500)
  ok(t1.provider === 'groq-alt' && t1.answer?.is_grounded === true, '400 скипает звено, qwen отвечает', t1.provider)

  // Тест 2: весь Groq мёртв → Gemini отвечает
  mockFetch((url, init) => {
    if (url.includes('groq')) return { status: 503, body: { error: 'down' } }
    if (url.includes('googleapis'))
      return {
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: good(QUOTE) }] } }] },
      }
    return { status: 500, body: {} }
  })
  const t2 = await answerWithFallback(env, mk, CTX, 500)
  ok(t2.provider === 'gemini' && t2.answer?.is_grounded === true, 'Gemini-фолбэк отвечает', t2.provider)

  // Тест 3: всё мертво → throw (вызыватель построит extractive)
  mockFetch(() => ({ status: 503, body: {} }))
  let threw = ''
  try {
    await answerWithFallback(env, mk, CTX, 500)
  } catch (e: any) {
    threw = e.message
  }
  ok(!!threw, 'полный провал → throw для extractive', threw)

  // Тест 4: 401 на primary → мгновенный аборт (не жрём чужие квоты)
  let calls = 0
  mockFetch((url) => {
    calls++
    if (url.includes('groq')) return { status: 401, body: { error: 'bad key' } }
    return { status: 200, body: {} }
  })
  let err401 = 0
  try {
    await answerWithFallback(env, mk, CTX, 500)
  } catch (e: any) {
    err401 = e.status
  }
  ok(err401 === 401 && calls === 1, '401 абортит цепочку сразу', { err401, calls })

  // Тест 5: недословная цитата чинится подменой фрагмента, звено засчитывается
  const PARAPHRASE = 'коридоры шириной минимум 1,4 метра должны быть'
  mockFetch((url) => {
    if (url.includes('groq'))
      return { status: 200, body: { choices: [{ message: { content: good(PARAPHRASE) } }] } }
    return { status: 500, body: {} }
  })
  const t5 = await answerWithFallback(env, mk, CTX, 500)
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
  ok(
    t5.provider === 'groq' && norm(CTX[0]).includes(norm(String(t5.answer?.quote ?? ''))),
    'недословная цитата отремонтирована подстрокой контекста',
    t5.answer?.quote,
  )

  // Тест 6: reasoning_effort шлём только reasoning-моделям (Llama без него, иначе 400)
  const llamaEnv: any = { ...env, GROQ_MODEL: 'llama-3.3-70b-versatile' }
  let llamaBody: any = null
  mockFetch((url, init) => {
    if (url.includes('groq')) {
      try { llamaBody = JSON.parse(init.body) } catch { llamaBody = {} }
      return { status: 200, body: { choices: [{ message: { content: good(QUOTE) } }] } }
    }
    return { status: 500, body: {} }
  })
  const t6 = await answerWithFallback(llamaEnv, mk, CTX, 500)
  ok(
    t6.provider === 'groq' && llamaBody && !('reasoning_effort' in llamaBody),
    'Llama-primary отвечает без reasoning_effort',
    { provider: t6.provider, hasParam: !!(llamaBody && 'reasoning_effort' in llamaBody) },
  )

  // Тест 7: фолбэк получает укороченные контексты (shortCtx), primary — полные
  const LONG7 = 'А'.repeat(700) + 'Б'.repeat(1100) // полный контекст 1800 символов
  const SHORT7 = LONG7.slice(0, 700) // только «А»
  let fbPrompt7 = ''
  const mk2 = (_extra: string, ctxs: string[]) => `промпт:${ctxs.join('|')}`
  const good7 = JSON.stringify({ answer: 'ок', quote: 'А'.repeat(100), paragraph: '', is_grounded: true })
  mockFetch((url, init) => {
    if (url.includes('groq')) return { status: 503, body: {} }
    if (url.includes('googleapis')) {
      try { fbPrompt7 = JSON.parse(init.body).contents[0].parts[0].text } catch {}
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: good7 }] } }] } }
    }
    return { status: 500, body: {} }
  })
  const t7 = await answerWithFallback(env, mk2, [LONG7], 500, [SHORT7])
  ok(
    t7.provider === 'gemini' && fbPrompt7.includes('А'.repeat(50)) && !fbPrompt7.includes('Б'),
    'фолбэк видит short-контексты (без хвоста полного)',
    { provider: t7.provider, fbLen: fbPrompt7.length },
  )

  console.log(fail ? `\nИТОГ: FAIL=${fail}` : '\nИТОГ: все тесты цепочки пройдены')
  if (fail) throw new Error('chain tests failed')

}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1) }
)
