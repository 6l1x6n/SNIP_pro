/**
 * SNIP Worker — auth, кредиты, /ask → Groq, /embed → Gemini.
 * Без зависимостей: WebCrypto (PBKDF2 + JWT HS256), D1, fetch.
 */

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  GROQ_MODEL: string;
  EMBED_MODEL: string;
  INDEX_BASE_URL: string; // https://snippy-llm.pages.dev/index
  ALLOWED_ORIGINS: string; // comma-separated
  CREDITS_ANON: string; // 30 — дневной лимит гостя
  CREDITS_USER: string; // 50 — дневной лимит зарегистрированного
  FAST_COST: string; // 5 — быстрый поиск
  DEEP_COST: string; // 10 — глубокий поиск с ИИ
  NORMS?: R2Bucket; // опционально: включается после активации R2 (см. wrangler.toml)
  EXPLAIN_DAILY_CAP?: string; // дефолт 40 объяснений/день подписчику
  // Резервные эмбеддинг-провайдеры (нужен только тот, кем собран текущий индекс —
  // см. provider в index/manifest.json; секреты: npx wrangler secret put <ИМЯ>)
  JINA_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  COHERE_API_KEY?: string;
  MISTRAL_API_KEY?: string;
}

// ---------- Каталог биллинга (цены в тенге, демо-активация без денег) ----------

export const PLANS: Record<string, { label: string; price: number; dailyLimit: number; days: number }> = {
  pro: { label: "Pro", price: 2990, dailyLimit: 200, days: 30 },
  business: { label: "Business", price: 7990, dailyLimit: 500, days: 30 },
};

export const PACKS: Record<string, { label: string; price: number; credits: number }> = {
  pack_starter: { label: "Старт", price: 990, credits: 100 },
  pack_optimum: { label: "Оптимум", price: 3490, credits: 400 },
  pack_max: { label: "Максимум", price: 9990, credits: 1300 },
};

const CORS_HEADERS = (env: Env, origin: string | null): Record<string, string> => {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const ok = origin && (allowed.includes(origin) || allowed.some((a) => a.endsWith("*") && origin.startsWith(a.slice(0, -1))));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : allowed[0] ?? "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

// ---------- PBKDF2 пароль-хеширование ----------

async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  return bufToHex(salt) + "$" + bufToHex(new Uint8Array(bits));
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex] = stored.split("$");
  return hashPassword(password, saltHex).then((h) => h === stored);
}

const hexToBuf = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
const bufToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// ---------- JWT HS256 ----------

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDecode = (s: string): string =>
  atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4));

async function signJwt(payload: Record<string, unknown>, secret: string, ttlSec = 60 * 60 * 24 * 7): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = b64urlDecode(parts[2]);
  const sigBuf = new Uint8Array(sig.length).map((_, i) => sig.charCodeAt(i));
  const ok = await crypto.subtle.verify("HMAC", key, sigBuf, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const payload = JSON.parse(b64urlDecode(parts[1]));
  if (payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ---------- Индекс (вектора+чанки кэшируются в изоляте) ----------

interface CachedIndex {
  dim: number;
  count: number;
  scales: Float32Array;
  int8: Int8Array;
  chunks: Array<{ d: number; p: string; pg: number; t: string; ty: string }>;
}
let indexCache: Promise<CachedIndex> | null = null;

function loadIndex(env: Env): Promise<CachedIndex> {
  if (!indexCache) {
    const p = (async (): Promise<CachedIndex> => {
      const base = env.INDEX_BASE_URL.replace(/\/$/, "");
      // cache: no-store — иначе изолят может годами держать устаревший индекс через CDN
      const [bin, chunksRes] = await Promise.all([
        fetch(`${base}/vectors.bin`, { cache: "no-store" }),
        fetch(`${base}/chunks.json`, { cache: "no-store" }),
      ]);
      const buf = await bin.arrayBuffer();
      const view = new DataView(buf);
      const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      if (magic !== "SNV1") throw new Error("bad vectors.bin");
      const dim = view.getUint32(4, true);
      const count = view.getUint32(8, true);
      const scales = new Float32Array(buf.slice(12, 12 + 4 * count));
      const int8 = new Int8Array(buf, 12 + 4 * count, count * dim);
      const chunks = (await chunksRes.json()) as CachedIndex["chunks"];
      return { dim, count, scales, int8, chunks };
    })();
    indexCache = p;
  }
  return indexCache;
}

async function embedQuery(env: Env, query: string): Promise<number[]> {
  const { provider, model } = await getIndexManifest(env);
  switch (provider) {
    case "jina": {
      const r = await fetch("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.JINA_API_KEY}` },
        body: JSON.stringify({ model, task: "retrieval.query", input: [query] }),
      });
      if (!r.ok) throw new Error(`jina embed ${r.status}`);
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    case "voyage": {
      const r = await fetch("https://api.voyageai.com/api/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
        body: JSON.stringify({ model, input_type: "query", input: [query] }),
      });
      if (!r.ok) throw new Error(`voyage embed ${r.status}`);
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    case "cohere": {
      const r = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.COHERE_API_KEY}` },
        body: JSON.stringify({ model, texts: [query], input_type: "search_query", embedding_types: ["float"] }),
      });
      if (!r.ok) throw new Error(`cohere embed ${r.status}`);
      const d: any = await r.json();
      return normalizeVec(d.embeddings.float_[0]);
    }
    case "mistral": {
      const r = await fetch("https://api.mistral.ai/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
        body: JSON.stringify({ model, input: [query] }),
      });
      if (!r.ok) throw new Error(`mistral embed ${r.status}`);
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    default: {
      // gemini (дефолт и обратная совместимость со старыми манифестами)
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ taskType: "RETRIEVAL_QUERY", content: { parts: [{ text: query }] }, outputDimensionality: 768 }),
      });
      if (!r.ok) throw new Error(`gemini embed ${r.status}`);
      const d: any = await r.json();
      return normalizeVec(d.embedding.values);
    }
  }
}

function normalizeVec(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

// Провайдер/модель читаем из манифеста индекса — так запросы всегда
// совпадают с тем, чем собран текущий vectors.bin. Кэш на 10 минут.
interface ManifestInfo {
  provider: string;
  model: string;
}
let manifestCache: { info: ManifestInfo; at: number } | null = null;
const MANIFEST_TTL_MS = 10 * 60 * 1000;

async function getIndexManifest(env: Env): Promise<ManifestInfo> {
  const now = Date.now();
  if (manifestCache && now - manifestCache.at < MANIFEST_TTL_MS) return manifestCache.info;
  const base = env.INDEX_BASE_URL.replace(/\/$/, "");
  let info: ManifestInfo = { provider: "gemini", model: env.EMBED_MODEL };
  try {
    const r = await fetch(`${base}/manifest.json`, { cache: "no-store" });
    if (r.ok) {
      const m: any = await r.json();
      info = { provider: m.provider ?? "gemini", model: m.model ?? env.EMBED_MODEL };
    }
  } catch {}
  manifestCache = { info, at: now };
  return info;
}

async function vectorTopK(env: Env, query: string, k: number): Promise<number[]> {
  const idx = await loadIndex(env);
  const q = await embedQuery(env, query);
  const scores: Array<[number, number]> = [];
  for (let i = 0; i < idx.count; i++) {
    let acc = 0;
    for (let j = 0; j < idx.dim; j++) acc += q[j] * idx.int8[i * idx.dim + j];
    scores.push([i, acc * idx.scales[i]]);
  }
  return scores.sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
}

// ---------- Кредиты: гибридная модель (дневной лимит + накопительный баланс) ----------

const todayKey = (): string => new Date().toISOString().slice(0, 10);

export interface CreditsState {
  daily: { used: number; limit: number; remaining: number };
  balance: number;
  plan: string | null;
}

async function getActivePlan(env: Env, subject: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT plan, expires_at FROM subscriptions WHERE subject=?")
    .bind(subject)
    .first<{ plan: string; expires_at: string }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.plan;
}

function baseDailyLimit(env: Env, isUser: boolean): number {
  return isUser ? Number(env.CREDITS_USER) : Number(env.CREDITS_ANON);
}

async function getCreditsState(env: Env, subject: string, isUser: boolean): Promise<CreditsState> {
  const day = todayKey();
  const [usageRow, balRow, plan] = await Promise.all([
    env.DB.prepare("SELECT count FROM usage WHERE day=? AND subject=?").bind(day, subject).first<{ count: number }>(),
    env.DB.prepare("SELECT credits FROM balances WHERE subject=?").bind(subject).first<{ credits: number }>(),
    isUser ? getActivePlan(env, subject) : Promise.resolve(null),
  ]);
  const used = usageRow?.count ?? 0;
  let limit = baseDailyLimit(env, isUser);
  if (plan && PLANS[plan]) limit = Math.max(limit, PLANS[plan].dailyLimit);
  return { daily: { used, limit, remaining: Math.max(0, limit - used) }, balance: balRow?.credits ?? 0, plan };
}

interface ChargeSplit { daily: number; balance: number }

/** Списывает cost кредитов: сначала дневной лимит, затем накопительный баланс. */
async function chargeHybrid(
  env: Env,
  subject: string,
  isUser: boolean,
  cost: number,
  kind: string,
  meta?: string
): Promise<{ ok: boolean; state: CreditsState; need?: number; split?: ChargeSplit }> {
  const day = todayKey();
  const state = await getCreditsState(env, subject, isUser);
  const fromDaily = Math.min(state.daily.remaining, cost);
  const fromBalance = cost - fromDaily;
  if (fromBalance > state.balance) {
    return { ok: false, state, need: fromBalance - state.balance };
  }
  const stmts: D1PreparedStatement[] = [];
  if (fromDaily > 0) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO usage (day, subject, count) VALUES (?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count"
      ).bind(day, subject, fromDaily)
    );
  }
  if (fromBalance > 0) {
    stmts.push(
      env.DB.prepare("UPDATE balances SET credits = credits - ?, updated_at = ? WHERE subject = ?").bind(
        fromBalance,
        new Date().toISOString(),
        subject
      )
    );
  }
  stmts.push(
    env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      subject,
      -cost,
      kind,
      meta ?? JSON.stringify({ split: { daily: fromDaily, balance: fromBalance } }),
      new Date().toISOString()
    )
  );
  await env.DB.batch(stmts);
  const newState = await getCreditsState(env, subject, isUser);
  return { ok: true, state: newState, split: { daily: fromDaily, balance: fromBalance } };
}

/** Возврат списания при внутренней ошибке (восстанавливает точный split). */
async function refundCharge(env: Env, subject: string, cost: number, split: ChargeSplit, kind: string): Promise<void> {
  const day = todayKey();
  const stmts: D1PreparedStatement[] = [];
  if (split.daily > 0) {
    stmts.push(
      env.DB.prepare("UPDATE usage SET count = MAX(0, count - ?) WHERE day = ? AND subject = ?").bind(split.daily, day, subject)
    );
  }
  if (split.balance > 0) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO balances (subject, credits, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at"
      ).bind(subject, split.balance, new Date().toISOString())
    );
  }
  stmts.push(
    env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      subject,
      cost,
      kind,
      JSON.stringify({ refundOf: kind, split }),
      new Date().toISOString()
    )
  );
  await env.DB.batch(stmts);
}

async function subjectFromRequest(env: Env, req: Request): Promise<{ subject: string; isUser: boolean }> {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
    if (payload?.uid) return { subject: `user:${payload.uid}`, isUser: true };
  }
  const deviceId = req.headers.get("X-Device-Id") || "anon";
  return { subject: `anon:${deviceId}`, isUser: false };
}

// ---------- Groq /ask ----------

const normWs = (s: string): string => s.replace(/\s+/g, " ").trim();

async function askGroq(env: Env, query: string, contexts: string[], maxTokens: number): Promise<any> {
  const contextText = contexts.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
  const prompt = `Ты — эксперт по строительным нормам РК (СНиП/СП/СН/СТ РК). Ответь на вопрос ТОЛЬКО по контексту ниже.

Правила:
1. Если в контексте нет ответа — верни {"answer":"В доступной нормативной базе точного требования не найдено.","quote":"","paragraph":"","is_grounded":false}
2. quote — ДОСЛОВНАЯ цитата из контекста (можно сократить многоточием внутри, но слова должны совпадать)
3. Ответ на русском, кратко, с конкретными числами
4. Верни строго JSON без markdown

Контекст:
${contextText}

Вопрос: ${query}`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
      reasoning_effort: "low",
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d: any = await r.json();
  let text: string = d.choices?.[0]?.message?.content ?? "";
  // qwen иногда вставляет <think>...</think> — срезаем
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // защитный парсинг JSON из текста
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return { answer: "Не удалось разобрать ответ модели.", is_grounded: false };
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return { answer: text.slice(0, 400), is_grounded: false };
  }
}

function verifyGrounded(answer: any, contexts: string[]): boolean {
  if (!answer.is_grounded || !answer.quote) return !!answer.is_grounded;
  const q = normWs(answer.quote).toLowerCase();
  return contexts.some((c) => normWs(c).toLowerCase().includes(q));
}

// ---------- Объяснятор фрагментов (сайдбар PDF-вьюера) ----------

async function getExplainUsage(env: Env, subject: string): Promise<{ used: number; cap: number }> {
  const row = await env.DB.prepare("SELECT count FROM explain_usage WHERE day=? AND subject=?")
    .bind(todayKey(), subject)
    .first<{ count: number }>();
  return { used: row?.count ?? 0, cap: Number(env.EXPLAIN_DAILY_CAP ?? "40") };
}

async function askGroqExplain(env: Env, fragment: string, docNumber: string): Promise<string> {
  const prompt = `Ты — технический справочник по строительным нормам Казахстана (СНиП/СП/СН/СТ РК).
${docNumber ? `Фрагмент из документа ${docNumber}.` : ""}
Объясни выделенный фрагмент норматива: что он означает простыми словами, какой термин/требование определяет, к чему применяется.

Правила:
- Опирайся ТОЛЬКО на текст фрагмента и общепринятые определения строительной терминологии
- НЕ придумывай номера пунктов, ссылки на другие документы или значения, которых нет во фрагменте
- Если фрагмент не является нормой/термином (например обрывок фразы) — так и скажи
- Ответ по-русски, 2-4 предложения, без markdown

Фрагмент:
"""${fragment.slice(0, 1500)}"""`;

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: env.GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    }),
  });
  if (!r.ok) throw new Error(`groq explain ${r.status}`);
  const d: any = await r.json();
  let text: string = d.choices?.[0]?.message?.content ?? "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return text.slice(0, 1200);
}

// ---------- Роутер ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = CORS_HEADERS(env, req.headers.get("Origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      // POST /api/embed {query} → float[] (для клиентского гибридного поиска)
      if (url.pathname === "/api/embed" && req.method === "POST") {
        const { query } = (await req.json()) as any;
        if (!query?.trim()) return json({ error: "query required" }, 400, cors);
        return json({ embedding: await embedQuery(env, query) }, 200, cors);
      }

      // POST /api/auth/register {email,password,full_name?}
      if (url.pathname === "/api/auth/register" && req.method === "POST") {
        const { email, password } = (await req.json()) as any;
        if (!email || !password || String(password).length < 6)
          return json({ error: "email и password (6+) обязательны" }, 400, cors);
        const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
        if (exists) return json({ error: "email уже зарегистрирован" }, 409, cors);
        const uid = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)")
          .bind(uid, email, await hashPassword(password), new Date().toISOString())
          .run();
        return json({ uid, email, token: await signJwt({ uid, email }, env.JWT_SECRET) }, 201, cors);
      }

      // POST /api/auth/login {email,password}
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const { email, password } = (await req.json()) as any;
        const row = await env.DB.prepare("SELECT id,password_hash FROM users WHERE email=?").bind(email).first<{ id: string; password_hash: string }>();
        if (!row || !(await verifyPassword(password, row.password_hash))) return json({ error: "неверный email или пароль" }, 401, cors);
        return json({ uid: row.id, email, token: await signJwt({ uid: row.id, email }, env.JWT_SECRET) }, 200, cors);
      }

      // GET /api/me
      if (url.pathname === "/api/me" && req.method === "GET") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: "unauthorized" }, 401, cors);
        const { subject, isUser } = await subjectFromRequest(env, req);
        const credits = await getCreditsState(env, subject, isUser);
        return json({ uid: payload.uid, email: payload.email, credits }, 200, cors);
      }

      // GET /api/credits — состояние: дневной остаток + накопительный баланс + план
      if (url.pathname === "/api/credits" && req.method === "GET") {
        const { subject, isUser } = await subjectFromRequest(env, req);
        return json(await getCreditsState(env, subject, isUser), 200, cors);
      }

      // POST /api/credits/spend {mode:'fast'} — списание за быстрый поиск
      if (url.pathname === "/api/credits/spend" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const mode = body.mode === "deep" ? "deep" : "fast";
        const cost = mode === "deep" ? Number(env.DEEP_COST) : Number(env.FAST_COST);
        const { subject, isUser } = await subjectFromRequest(env, req);
        const res = await chargeHybrid(env, subject, isUser, cost, `spend_${mode}`);
        if (!res.ok) {
          return json(
            { error: "insufficient_credits", detail: "Недостаточно кредитов", ...res.state, need: res.need },
            402,
            cors
          );
        }
        return json(res.state, 200, cors);
      }

      // GET /api/credits/history — последние операции
      if (url.pathname === "/api/credits/history" && req.method === "GET") {
        const { subject } = await subjectFromRequest(env, req);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
        const rows = await env.DB.prepare(
          "SELECT id, delta, kind, meta, created_at FROM ledger WHERE subject=? ORDER BY id DESC LIMIT ?"
        )
          .bind(subject, limit)
          .all<{ id: number; delta: number; kind: string; meta: string | null; created_at: string }>();
        return json({ items: rows.results ?? [] }, 200, cors);
      }

      // POST /api/billing/purchase {sku} — ДЕМО-активация пакета или подписки (только для залогиненных)
      if (url.pathname === "/api/billing/purchase" && req.method === "POST") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized", detail: "Войдите, чтобы пополнять баланс" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: "unauthorized" }, 401, cors);
        const body = (await req.json().catch(() => ({}))) as any;
        const sku = String(body.sku ?? "");
        const { subject } = await subjectFromRequest(env, req);

        const pack = PACKS[sku];
        const plan = PLANS[sku.replace(/^sub_/, "")];
        if (!pack && !plan) return json({ error: "unknown_sku" }, 400, cors);
        if (plan && !payload.uid) return json({ error: "unauthorized" }, 401, cors);

        const now = new Date();
        if (pack) {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO balances (subject, credits, updated_at) VALUES (?, ?, ?) ON CONFLICT(subject) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at"
            ).bind(subject, pack.credits, now.toISOString()),
            env.DB.prepare("INSERT INTO purchases (id, subject, sku, credits, status, created_at) VALUES (?, ?, ?, ?, 'demo', ?)").bind(
              crypto.randomUUID(),
              subject,
              sku,
              pack.credits,
              now.toISOString()
            ),
            env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, 'purchase', ?, ?)").bind(
              subject,
              pack.credits,
              JSON.stringify({ sku, demo: true }),
              now.toISOString()
            ),
          ]);
        } else if (plan) {
          const planKey = sku.replace(/^sub_/, "");
          const expires = new Date(now.getTime() + plan.days * 24 * 3600 * 1000).toISOString();
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO subscriptions (subject, plan, started_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET plan = excluded.plan, started_at = excluded.started_at, expires_at = excluded.expires_at"
            ).bind(subject, planKey, now.toISOString(), expires),
            env.DB.prepare("INSERT INTO purchases (id, subject, sku, credits, status, created_at) VALUES (?, ?, ?, 0, 'demo', ?)").bind(
              crypto.randomUUID(),
              subject,
              sku,
              now.toISOString()
            ),
            env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, 0, 'subscription', ?, ?)").bind(
              subject,
              JSON.stringify({ sku, until: expires, demo: true }),
              now.toISOString()
            ),
          ]);
        }
        const state = await getCreditsState(env, subject, !!payload.uid);
        return json({ ok: true, demo: true, ...state }, 200, cors);
      }

      // POST /api/ask {query, mode?, chunkIds?} → списывает DEEP_COST, Groq с заземлением
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const body = (await req.json()) as any;
        const query = String(body.query ?? "").trim();
        if (!query) return json({ error: "query required" }, 400, cors);

        const { subject, isUser } = await subjectFromRequest(env, req);
        const spend = await chargeHybrid(env, subject, isUser, Number(env.DEEP_COST), "spend_deep");
        if (!spend.ok || !spend.split) {
          return json(
            { error: "insufficient_credits", detail: "Недостаточно кредитов для глубокого поиска", ...spend.state, need: spend.need },
            402,
            cors
          );
        }
        const state = await getCreditsState(env, subject, isUser);

        const idx = await loadIndex(env);
        let ids: number[];
        try {
          if (Array.isArray(body.chunkIds) && body.chunkIds.length) {
            ids = body.chunkIds.map(Number).filter((i: number) => i >= 0 && i < idx.count).slice(0, 5);
          } else {
            ids = await vectorTopK(env, query, body.mode === "deep" ? 5 : 3);
          }
          const contexts = ids.map((i) => idx.chunks[i]?.t).filter(Boolean);
          if (!contexts.length) {
            refundCharge(env, subject, Number(env.DEEP_COST), spend.split, "refund_deep").catch(() => {});
            return json({ answer: { answer: "Индекс пуст.", is_grounded: false }, took_ms: 0, ...state }, 200, cors);
          }

          const maxTokens = body.mode === "deep" ? 1600 : 1000;
          const t0 = Date.now();
          let answer = await askGroq(env, query, contexts, maxTokens);
          if (!verifyGrounded(answer, contexts)) {
            // повтор со строгим напоминанием про дословность
            answer = await askGroq(env, query + "\n\n(ВАЖНО: quote обязана быть дословным фрагментом контекста)", contexts, maxTokens);
          }
          return json(
            {
              answer: { ...answer, is_grounded: verifyGrounded(answer, contexts) },
              sources: ids.map((i) => ({ i, d: idx.chunks[i].d, p: idx.chunks[i].p, pg: idx.chunks[i].pg })),
              credits: state,
              took_ms: Date.now() - t0,
            },
            200,
            cors
          );
        } catch (e: any) {
          // внутренняя ошибка — возвращаем списанные кредиты
          refundCharge(env, subject, Number(env.DEEP_COST), spend.split, "refund_deep").catch(() => {});
          throw e;
        }
      }

      // GET /api/norms/:file — PDF из R2 со стримингом и Range (если R2 включён)
      if (url.pathname.startsWith("/api/norms/") && req.method === "GET") {
        if (!env.NORMS) return json({ error: "r2_not_configured" }, 501, cors);
        const file = decodeURIComponent(url.pathname.slice("/api/norms/".length));
        if (!file || file.includes("..") || file.includes("/") || !file.toLowerCase().endsWith(".pdf"))
          return json({ error: "bad_file" }, 400, cors);
        const range = req.headers.get("Range");
        const obj = await env.NORMS.get(file, range ? { range } : undefined);
        if (!obj) return json({ error: "not_found" }, 404, cors);
        const headers = new Headers(cors);
        headers.set("Content-Type", "application/pdf");
        headers.set("Content-Disposition", "inline");
        headers.set("Cache-Control", "public, max-age=86400");
        obj.writeHttpMetadata(headers);
        headers.set("ETag", obj.httpEtag);
        return new Response(obj.body, { status: range ? 206 : 200, headers });
      }

      // POST /api/explain {text, doc_number?} — дефиниция выделенного фрагмента.
      // Только подписчики; дневной кап; кэш по хешу — повторное выделение бесплатно.
      if (url.pathname === "/api/explain" && req.method === "POST") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized", detail: "Войдите, чтобы пользоваться объяснениями" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: "unauthorized" }, 401, cors);
        const body = (await req.json()) as any;
        const text = String(body.text ?? "").trim();
        if (text.length < 10) return json({ error: "bad_text", detail: "Выделите фрагмент текста подлиннее" }, 400, cors);

        const { subject } = await subjectFromRequest(env, req);
        const plan = await getActivePlan(env, subject);
        if (!plan) return json({ error: "subscription_required", detail: "Объяснение фрагментов доступно подписчикам Pro и Business" }, 403, cors);

        // кэш: одинаковый фрагмент + документ → мгновенный ответ без Groq
        const docNumber = body.doc_number ? String(body.doc_number).slice(0, 120) : "";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase().replace(/\s+/g, " ") + "|" + docNumber));
        const hash = bufToHex(new Uint8Array(digest));
        const cached = await env.DB.prepare("SELECT explanation FROM explain_cache WHERE hash=?").bind(hash).first<{ explanation: string }>();
        if (cached) {
          const st = await getCreditsState(env, subject, true);
          return json({ explanation: cached.explanation, cached: true, usage: await getExplainUsage(env, subject), credits: st }, 200, cors);
        }

        // дневной кап
        const cap = Number(env.EXPLAIN_DAILY_CAP ?? "40");
        const day = todayKey();
        const used = await env.DB.prepare("SELECT count FROM explain_usage WHERE day=? AND subject=?").bind(day, subject).first<{ count: number }>();
        const count = used?.count ?? 0;
        if (count >= cap) {
          return json({ error: "daily_cap", detail: `Дневной лимит объяснений (${cap}) исчерпан — обновится в 00:00 UTC` }, 429, cors);
        }
        await env.DB.prepare(
          "INSERT INTO explain_usage (day, subject, count) VALUES (?, ?, 1) ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count"
        ).bind(day, subject).run();

        let explanation = "";
        try {
          explanation = await askGroqExplain(env, text, docNumber);
        } catch {
          return json({ error: "llm_failed", detail: "Сервис объяснений временно недоступен, попробуйте позже" }, 502, cors);
        }
        if (explanation) {
          await env.DB.prepare("INSERT INTO explain_cache (hash, doc_number, explanation, created_at) VALUES (?, ?, ?, ?)")
            .bind(hash, docNumber, explanation, new Date().toISOString()).run();
        }
        const st = await getCreditsState(env, subject, true);
        return json({ explanation, cached: false, usage: { used: count + 1, cap }, credits: st }, 200, cors);
      }

      return json({ error: "not found" }, 404, cors);
    } catch (e: any) {
      return json({ error: e?.message ?? "internal" }, 500, cors);
    }
  },
};
