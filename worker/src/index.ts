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
  FOLLOWUP_COST?: string; // 5 — уточняющий вопрос к ответу
  NORMS?: R2Bucket; // опционально: включается после активации R2 (см. wrangler.toml)
  AI?: any; // опционально: Workers AI binding ([ai] в wrangler.toml) — звено фолбэка
  GEMINI_TEXT_MODEL?: string; // опционально: модель Gemini для фолбэка (дефолт gemini-2.0-flash)
  EXPLAIN_DAILY_CAP?: string; // дефолт 40 объяснений/день подписчику
  // Резервные эмбеддинг-провайдеры (нужен только тот, кем собран текущий индекс —
  // см. provider в index/manifest.json; секреты: npx wrangler secret put <ИМЯ>)
  JINA_API_KEY?: string;
  VOYAGE_API_KEY?: string;
  COHERE_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  // Резервные LLM-звенья цепочки /ask (порядок: Groq → Groq-alt → Gemini →
  // Cerebras → OpenRouter → DeepSeek → Mistral → Cohere → Custom → Workers AI → Zen → Pollinations).
  // Секреты: npx wrangler secret put CEREBRAS_API_KEY / OPENROUTER_API_KEY / DEEPSEEK_API_KEY /
  //   COHERE_API_KEY / MISTRAL_API_KEY / LLM_CUSTOM_KEY / OPENCODE_API_KEY
  CEREBRAS_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string; // дефолт meta-llama/llama-3.1-8b-instruct:free
  DEEPSEEK_API_KEY?: string;
  LLM_CUSTOM_BASE?: string; // напр. https://your-gateway.example.com/v1 (без /chat/completions)
  LLM_CUSTOM_KEY?: string;
  LLM_CUSTOM_MODEL?: string;
  // OpenCode Zen (free-tier чат-модели, OpenAI-совместимый /v1/chat/completions).
  // Ключ: https://opencode.ai/auth (нужен биллинг-аккаунт даже для free).
  OPENCODE_API_KEY?: string;
  ZEN_MODEL?: string; // дефолт mimo-v2.5-free
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
};

// ---------- Админы: только у них работает демо-оплата ----------

export const ADMIN_EMAILS = ["postalarchive@gmail.com", "aidos77_77@mail.ru"];

export function isAdminEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

/** Проверка доступа в Админку: Bearer JWT + email из ADMIN_EMAILS. */
async function requireAdmin(env: Env, req: Request): Promise<Record<string, unknown> | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
  if (!payload || !isAdminEmail(payload.email)) return null;
  return payload;
}

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
  shards?: { vectors?: number; chunks?: number };
}
let indexCache: Promise<CachedIndex> | null = null;

function loadIndex(env: Env): Promise<CachedIndex> {
  if (!indexCache) {
    const p = (async (): Promise<CachedIndex> => {
      const base = env.INDEX_BASE_URL.replace(/\/$/, "");
      // cache: no-store — иначе изолят может годами держать устаревший индекс через CDN
      const manifestRes = await fetch(`${base}/manifest.json`, { cache: "no-store" });
      const manifest = manifestRes.ok
        ? ((await manifestRes.json()) as CachedIndex)
        : ({ shards: { vectors: 1, chunks: 1 } } as CachedIndex);
      const nChunkShards = manifest.shards?.chunks ?? 1;
      const nVecShards = manifest.shards?.vectors ?? 1;
      const [chunks, ...binBufs] = await Promise.all([
        (async () => {
          const parts = await Promise.all(
            Array.from({ length: nChunkShards }, (_, k) =>
              fetch(`${base}/chunks_${k}.json`, { cache: "no-store" })        .then((r) => r.json() as Promise<CachedIndex["chunks"]>)
            )
          );
          return ([] as CachedIndex["chunks"]).concat(...parts);
        })(),
        ...Array.from({ length: nVecShards }, (_, k) =>
          fetch(k === 0 && nVecShards === 1 ? `${base}/vectors.bin` : `${base}/vectors_${k}.bin`, { cache: "no-store" }).then(
            (r) => r.arrayBuffer()
          )
        ),
      ]);
      let dim = 0;
      let totalCount = 0;
      const slices: Array<{ scales: ArrayBuffer; data: ArrayBuffer }> = [];
      for (const buf of binBufs) {
        const view = new DataView(buf);
        const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== "SNV1") throw new Error("bad vectors.bin");
        dim = view.getUint32(4, true);
        const n = view.getUint32(8, true);
        totalCount += n;
        slices.push({ scales: buf.slice(12, 12 + 4 * n), data: buf.slice(12 + 4 * n, 12 + 4 * n + n * dim) });
      }
      const scales = new Float32Array(totalCount);
      const int8 = new Int8Array(totalCount * dim);
      let sOff = 0;
      let dOff = 0;
      for (const s of slices) {
        scales.set(new Float32Array(s.scales), sOff);
        int8.set(new Int8Array(s.data), dOff);
        sOff += s.scales.byteLength / 4;
        dOff += s.data.byteLength;
      }
      if (totalCount !== chunks.length) throw new Error("vectors не совпадает с chunks");
      return { dim, count: totalCount, scales, int8, chunks };
    })();
    indexCache = p;
  }
  return indexCache;
}

/** Retry-After (сек или HTTP-date) → мс. Cap 10с чтобы не держать isolate. */
function parseEmbedRetryAfterMs(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  const secs = Number(s);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), 10_000);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.min(Math.max(t - Date.now(), 0), 10_000);
  return null;
}

const embedSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function retryableEmbedStatus(s: number): boolean {
  return s === 429 || s === 502 || s === 503 || s === 504;
}

/**
 * fetch для эмбеддингов с ретраем: 429/5xx → до 3 попыток,
 * backoff 800мс → 2с → 5с + jitter, уважает Retry-After (cap 10с).
 * 4xx кроме 429 — сразу fatal через statusError (e.status проставляется).
 */
async function fetchEmbedWithRetry(tag: string, url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastStatus = 0;
  let lastBody = "";
  let lastRetryAfter: number | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch (e: any) {
      // сеть/таймаут — ретраим как retryable (status undefined → true в retryableLlmError)
      if (attempt < attempts - 1) {
        await embedSleep(800 * (attempt + 1) + Math.random() * 300);
        continue;
      }
      throw e;
    }
    if (r.ok) return r;
    const body = await r.text().catch(() => "");
    const retryAfterMs = parseEmbedRetryAfterMs(r.headers.get("Retry-After"));
    lastStatus = r.status;
    lastBody = body.slice(0, 300);
    lastRetryAfter = retryAfterMs;
    if (retryableEmbedStatus(r.status) && attempt < attempts - 1) {
      const backoff = [800, 2000, 5000][attempt] ?? 5000;
      await embedSleep((retryAfterMs ?? backoff) + Math.random() * 300);
      continue;
    }
    const e: any = statusError(`${tag} embed`, r, body);
    if (retryAfterMs != null) e.retryAfterMs = retryAfterMs;
    if (body) e.bodySnippet = body.slice(0, 300);
    throw e;
  }
  // все попытки исчерпаны ретраебельным статусом — кидаем типизированную ошибку с последним статусом
  const e: any = new Error(`embed ${lastStatus || 502}: лимит/временная недоступность провайдера`);
  e.status = lastStatus || 502;
  if (lastRetryAfter != null) e.retryAfterMs = lastRetryAfter;
  if (lastBody) e.bodySnippet = lastBody;
  throw e;
}

async function embedQuery(env: Env, query: string): Promise<number[]> {
  const { provider, model } = await getIndexManifest(env);
  switch (provider) {
    case "jina": {
      const r = await fetchEmbedWithRetry(
        "jina",
        "https://api.jina.ai/v1/embeddings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.JINA_API_KEY}` },
          body: JSON.stringify({ model, task: "retrieval.query", input: [query] }),
        }
      );
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    case "voyage": {
      const r = await fetchEmbedWithRetry(
        "voyage",
        "https://api.voyageai.com/v1/embeddings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
          body: JSON.stringify({ model, input_type: "query", input: [query] }),
        }
      );
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    case "cohere": {
      const r = await fetchEmbedWithRetry(
        "cohere",
        "https://api.cohere.com/v2/embed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.COHERE_API_KEY}` },
          body: JSON.stringify({ model, texts: [query], input_type: "search_query", embedding_types: ["float"] }),
        }
      );
      const d: any = await r.json();
      // v2 API: {"embeddings": {"float": [[...]]}}
      const vec = d.embeddings?.float?.[0] ?? d.embeddings?.float_?.[0];
      if (!vec) throw new Error("cohere embed: пустой ответ");
      return normalizeVec(vec);
    }
    case "mistral": {
      const r = await fetchEmbedWithRetry(
        "mistral",
        "https://api.mistral.ai/v1/embeddings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
          body: JSON.stringify({ model, input: [query] }),
        }
      );
      const d: any = await r.json();
      return normalizeVec(d.data[0].embedding);
    }
    default: {
      // gemini (дефолт и обратная совместимость со старыми манифестами)
      const r = await fetchEmbedWithRetry(
        "gemini",
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({ taskType: "RETRIEVAL_QUERY", content: { parts: [{ text: query }] }, outputDimensionality: 768 }),
        }
      );
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
  builtAt?: string;
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
        info = { provider: m.provider ?? "gemini", model: m.model ?? env.EMBED_MODEL, builtAt: m.builtAt ?? undefined };
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

// ---------- Кредиты: гибридная модель (периодный лимит + накопительный баланс) ----------
// АКЦИЯ: зарегистрированные — 300⚡ каждый ЧАС, гости — 30⚡ в день.
// Таблица usage(day,subject) хранит строковый ключ периода: день "YYYY-MM-DD"
// для гостей, час "YYYY-MM-DDT HH" для юзеров. Миграция не нужна.

const todayKey = (): string => new Date().toISOString().slice(0, 10);
const hourKey = (): string => new Date().toISOString().slice(0, 13);
const periodKey = (isUser: boolean): string => (isUser ? hourKey() : todayKey());

export interface CreditsState {
  daily: { used: number; limit: number; remaining: number };
  balance: number;
  plan: string | null;
  /** hourly = лимит обновляется каждый час (акция для юзеров), daily = раз в сутки (гости) */
  reset?: "hourly" | "daily";
}

// Имя пользователя: смена не чаще раза в 30 дней (первая установка — свободно)
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 3600 * 1000;
export const NAME_MIN_LEN = 2;
export const NAME_MAX_LEN = 50;

function normalizeName(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LEN);
}

/** Ленивая миграция D1: добавляет full_name/name_changed_at если их нет (игнорирует "duplicate column"). */
async function ensureUserNameColumns(env: Env): Promise<void> {
  for (const sql of [
    "ALTER TABLE users ADD COLUMN full_name TEXT",
    "ALTER TABLE users ADD COLUMN name_changed_at TEXT",
  ]) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      /* колонка уже есть — ок */
    }
  }
}

async function getActivePlan(env: Env, subject: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT plan, expires_at FROM subscriptions WHERE subject=?")
    .bind(subject)
    .first<{ plan: string; expires_at: string }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.plan;
}

function baseDailyLimit(env: Env, isUser: boolean, lim?: { anon: number; user: number }): number {
  if (lim) return isUser ? lim.user : lim.anon;
  return isUser ? Number(env.CREDITS_USER) : Number(env.CREDITS_ANON);
}

/** Настройки админки — оверрайды env в D1 (таблица settings), isolate-кэш 5 мин. */
const SETTING_DEFS: Record<string, { def: string; min: number; max: number }> = {
  quota_anon: { def: "30", min: 1, max: 100000 },
  quota_user: { def: "300", min: 1, max: 100000 },
  cost_fast: { def: "5", min: 1, max: 10000 },
  cost_deep: { def: "10", min: 1, max: 10000 },
  cost_followup: { def: "5", min: 1, max: 10000 },
  explain_cap: { def: "40", min: 1, max: 10000 },
  cap_groq_rpd: { def: "1000", min: 1, max: 10000000 },
  cap_embed_rpd: { def: "100000", min: 1, max: 1000000000 },
};
let settingsCache: { values: Record<string, string>; updated: Record<string, string>; at: number } | null = null;
const SETTINGS_TTL_MS = 5 * 60 * 1000;

async function ensureSettingsTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

async function getSettings(env: Env): Promise<{ values: Record<string, string>; updated: Record<string, string> }> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache;
  const values: Record<string, string> = {};
  const updated: Record<string, string> = {};
  try {
    await ensureSettingsTable(env);
    const rows = await env.DB.prepare("SELECT key, value, updated_at FROM settings").all<{
      key: string;
      value: string;
      updated_at: string;
    }>();
    for (const r of rows.results ?? []) {
      if (SETTING_DEFS[r.key]) {
        values[r.key] = r.value;
        updated[r.key] = r.updated_at;
      }
    }
  } catch {
    /* D1 недоступен — работаем на env-дефолтах */
  }
  settingsCache = { values, updated, at: now };
  return settingsCache;
}

function settingInt(values: Record<string, string>, key: string, envFallback: string): number {
  const def = SETTING_DEFS[key];
  const raw = values[key] ?? envFallback ?? def.def;
  const v = Math.floor(Number(raw));
  if (!Number.isFinite(v)) return Number(def.def);
  return Math.min(def.max, Math.max(def.min, v));
}

export interface EffectiveLimits {
  anon: number;
  user: number;
  fast: number;
  deep: number;
  followup: number;
  explainCap: number;
  groqCap: number;
  embedCap: number;
}

/** Эффективные лимиты: settings (правятся из Админки) поверх env. */
async function getLimits(env: Env): Promise<EffectiveLimits> {
  const { values } = await getSettings(env);
  return {
    anon: settingInt(values, "quota_anon", env.CREDITS_ANON ?? "30"),
    user: settingInt(values, "quota_user", env.CREDITS_USER ?? "300"),
    fast: settingInt(values, "cost_fast", env.FAST_COST ?? "5"),
    deep: settingInt(values, "cost_deep", env.DEEP_COST ?? "10"),
    followup: settingInt(values, "cost_followup", env.FOLLOWUP_COST ?? "5"),
    explainCap: settingInt(values, "explain_cap", env.EXPLAIN_DAILY_CAP ?? "40"),
    groqCap: settingInt(values, "cap_groq_rpd", "1000"),
    embedCap: settingInt(values, "cap_embed_rpd", "100000"),
  };
}

async function getCreditsState(env: Env, subject: string, isUser: boolean): Promise<CreditsState> {
  const period = periodKey(isUser);
  const [usageRow, balRow, plan, lim] = await Promise.all([
    env.DB.prepare("SELECT count FROM usage WHERE day=? AND subject=?").bind(period, subject).first<{ count: number }>(),
    env.DB.prepare("SELECT credits FROM balances WHERE subject=?").bind(subject).first<{ credits: number }>(),
    isUser ? getActivePlan(env, subject) : Promise.resolve(null),
    getLimits(env),
  ]);
  const used = usageRow?.count ?? 0;
  let limit = baseDailyLimit(env, isUser, lim);
  if (plan && PLANS[plan]) limit = Math.max(limit, PLANS[plan].dailyLimit);
  return {
    daily: { used, limit, remaining: Math.max(0, limit - used) },
    balance: balRow?.credits ?? 0,
    plan,
    reset: isUser ? "hourly" : "daily",
  };
}

interface ChargeSplit { daily: number; balance: number }

/** Списывает cost кредитов: сначала периодный лимит (час для юзеров / день для гостей), затем накопительный баланс. */
async function chargeHybrid(
  env: Env,
  subject: string,
  isUser: boolean,
  cost: number,
  kind: string,
  meta?: string
): Promise<{ ok: boolean; state: CreditsState; need?: number; split?: ChargeSplit }> {
  const period = periodKey(isUser);
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
      ).bind(period, subject, fromDaily)
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
async function refundCharge(env: Env, subject: string, isUser: boolean, cost: number, split: ChargeSplit, kind: string): Promise<void> {
  const period = periodKey(isUser);
  const stmts: D1PreparedStatement[] = [];
  if (split.daily > 0) {
    stmts.push(
      env.DB.prepare("UPDATE usage SET count = MAX(0, count - ?) WHERE day = ? AND subject = ?").bind(split.daily, period, subject)
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

async function subjectFromRequest(env: Env, req: Request): Promise<{ subject: string; isUser: boolean }> {  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
    if (payload?.uid) return { subject: `user:${payload.uid}`, isUser: true };
  }
  const deviceId = req.headers.get("X-Device-Id") || "anon";
  return { subject: `anon:${deviceId}`, isUser: false };
}

// ---------- Groq /ask ----------

const normWs = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Нормализация запроса для ключа кэша ответов: lower + ё + схлоп пробелов. */
function normAskQuery(q: string): string {
  return String(q ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Ключ кэша /api/ask: режим + нормализованный запрос (уточнения не кэшируем — там история). */
async function askCacheKey(query: string, mode: string): Promise<string> {
  const data = new TextEncoder().encode(`ask|${mode}|${normAskQuery(query)}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// TTL кэша ответов: точные — 48ч, «не найдено» — 12ч (база может пополниться).
const ASK_CACHE_TTL_GROUNDED = 48 * 3600 * 1000;
const ASK_CACHE_TTL_UNGROUNDED = 12 * 3600 * 1000;

// ---------- LLM-цепочка фолбэков: Groq → Groq-alt → Gemini → Cerebras → OpenRouter → DeepSeek → Mistral → Cohere → Custom → Workers AI → Zen → Pollinations → extractive ----------

export type LlmProvider =
  | "groq" | "groq-alt" | "gemini" | "cerebras" | "openrouter" | "deepseek"
  | "mistral-chat" | "cohere-chat" | "custom" | "workers-ai" | "zen" | "pollinations" | "extractive";

/** Альтернативные бесплатные бакеты Groq (отдельные лимиты моделей; дубликат primary скипается).
 *  ВАЖНО: Llama-модели (8b-instant, 70b-versatile, scout) этому аккаунту НЕДОСТУПНЫ
 *  (Groq 404 "does not exist or you do not have access" — Llama теперь enterprise-only).
 *  Проверено живьём: работают oss-20b, safeguard-20b; qwen3.6 существует, но 429. */
const GROQ_ALT_MODELS = ["openai/gpt-oss-safeguard-20b", "qwen/qwen3.8-27b", "minimaxai/minimax-m2.7", "qwen/qwen3.6-27b", "openai/gpt-oss-120b"];

/** Kill-switches звеньев (settings, дефолт вкл; primary Groq и extractive тоже отключаемы). */
const LLM_LINK_DEFS = [
  "llm_groq_alt", "llm_gemini",
  "llm_cerebras", "llm_openrouter", "llm_deepseek",
  "llm_mistral_chat", "llm_cohere_chat", "llm_custom",
  "llm_workers", "llm_zen", "llm_pollinations", "llm_extractive",
];

async function llmEnabled(env: Env, key: string): Promise<boolean> {
  try {
    const { values } = await getSettings(env);
    return (values[key] ?? "1") === "1";
  } catch {
    return true;
  }
}

function retryableLlmError(e: any): boolean {
  const s = e?.status;
  if (s === undefined || s === null) return true; // сеть/таймаут
  return s === 429 || s === 3036 || (s >= 500 && s <= 599);
}

/** Фатально для всей цепочки: битый ключ. 400/404 (нет модели, длинный контекст) — скип звена. */
function fatalLlmError(e: any): boolean {
  return e?.status === 401 || e?.status === 403;
}

function statusError(prefix: string, r: Response, body: string): Error {
  const e: any = new Error(`${prefix} ${r.status}: ${body.slice(0, 120)}`);
  e.status = r.status;
  return e;
}

const stripThink = (t: string): string => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

/** reasoning_effort=low поддерживают только reasoning-модели (GPT-OSS 20B/120B, Qwen 3.8);
 *  остальным (Llama и др.) параметр слать нельзя — Groq отвечает 400 и звено молча скипается. */
const REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);

async function groqText(env: Env, model: string, prompt: string, maxTokens: number, temp = 0.1): Promise<string> {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: temp,
      max_tokens: maxTokens,
      ...(REASONING_EFFORT_MODELS.has(model) ? { reasoning_effort: "low" } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw statusError(`groq ${model}`, r, await r.text());
  const d: any = await r.json();
  const text = stripThink(d.choices?.[0]?.message?.content ?? "");
  if (!text) throw new Error(`groq ${model}: пустой ответ`);
  return text;
}

async function geminiText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  const model = env.GEMINI_TEXT_MODEL ?? "gemini-2.0-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw statusError("gemini", r, await r.text());
  const d: any = await r.json();
  const text = stripThink((d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text || "").join(""));
  if (!text) throw new Error("gemini: пустой ответ");
  return text;
}

/** Generic OpenAI-совместимый chat completions (Cerebras/OpenRouter/DeepSeek/Mistral/custom). */
async function openAiChatText(
  tag: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
  extraHeaders: Record<string, string> = {},
  extraBody: Record<string, unknown> = {}
): Promise<string> {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
      ...extraBody,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw statusError(tag, r, await r.text());
  const d: any = await r.json();
  const text = stripThink(d.choices?.[0]?.message?.content ?? "");
  if (!text) throw new Error(`${tag}: пустой ответ`);
  return text;
}

async function cerebrasText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.CEREBRAS_API_KEY) throw new Error("cerebras: нет ключа");
  return openAiChatText("cerebras", "https://api.cerebras.ai/v1", env.CEREBRAS_API_KEY, "llama-3.1-8b", prompt, maxTokens);
}

async function openrouterText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error("openrouter: нет ключа");
  return openAiChatText(
    "openrouter",
    "https://openrouter.ai/api/v1",
    env.OPENROUTER_API_KEY,
    env.OPENROUTER_MODEL ?? "google/gemma-4-31b-it:free",
    prompt,
    maxTokens,
    { "HTTP-Referer": "https://snippy-llm.pages.dev", "X-Title": "snippy-llm" }
  );
}

async function deepseekText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) throw new Error("deepseek: нет ключа");
  return openAiChatText("deepseek", "https://api.deepseek.com", env.DEEPSEEK_API_KEY, "deepseek-chat", prompt, maxTokens);
}

async function mistralChatText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.MISTRAL_API_KEY) throw new Error("mistral-chat: нет ключа");
  return openAiChatText("mistral-chat", "https://api.mistral.ai/v1", env.MISTRAL_API_KEY, "ministral-8b-latest", prompt, maxTokens);
}

async function cohereChatText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.COHERE_API_KEY) throw new Error("cohere-chat: нет ключа");
  const r = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.COHERE_API_KEY}` },
    body: JSON.stringify({
      model: "command-r",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw statusError("cohere-chat", r, await r.text());
  const d: any = await r.json();
  const parts = d.message?.content ?? [];
  const text = stripThink(parts.map((p: any) => p.text || "").join(""));
  if (!text) throw new Error("cohere-chat: пустой ответ");
  return text;
}

async function customLlmText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.LLM_CUSTOM_BASE || !env.LLM_CUSTOM_KEY) throw new Error("custom: не настроен (LLM_CUSTOM_BASE/KEY)");
  return openAiChatText(
    "custom",
    env.LLM_CUSTOM_BASE,
    env.LLM_CUSTOM_KEY,
    env.LLM_CUSTOM_MODEL ?? "default",
    prompt,
    maxTokens
  );
}

async function workersAiText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.AI) throw new Error("workers-ai: binding не подключён");
  const out: any = await Promise.race([
    env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt, max_tokens: Math.min(maxTokens, 1024), temperature: 0.1 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("workers-ai: таймаут")), 25000)),
  ]);
  const text = stripThink(typeof out === "string" ? out : String(out?.response ?? ""));
  if (!text) throw new Error("workers-ai: пустой ответ");
  return text;
}

/** OpenCode Zen: free-tier чат-модели через OpenAI-совместимый /v1/chat/completions.
 *  Дефолт mimo-v2.5-free (free-промо, может исчезнуть — звено тогда скипается как 404).
 *  Free-модели могут использовать промпты для улучшения — чувствительные данные не слать. */
async function zenText(env: Env, prompt: string, maxTokens: number): Promise<string> {
  if (!env.OPENCODE_API_KEY) throw new Error("zen: нет ключа");
  return openAiChatText(
    "zen",
    "https://opencode.ai/zen/v1",
    env.OPENCODE_API_KEY,
    env.ZEN_MODEL ?? "mimo-v2.5-free",
    prompt,
    maxTokens
  );
}

async function pollinationsText(prompt: string, maxTokens: number): Promise<string> {
  // keyless резерв: GET text.pollinations.ai/{prompt}; негарантирован, поэтому последний перед экстрактивом
  const u = "https://text.pollinations.ai/" + encodeURIComponent(prompt.slice(0, 3500)) + "?model=openai&private=true";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "snippy-llm/1.0" } });
    if (!r.ok) throw statusError("pollinations", r, await r.text());
    const text = stripThink((await r.text()).trim().slice(0, maxTokens * 4));
    if (!text) throw new Error("pollinations: пустой ответ");
    return text;
  } finally {
    clearTimeout(t);
  }
}

interface LlmLink {
  id: Exclude<LlmProvider, "groq" | "extractive">;
  run: (prompt: string, maxTokens: number) => Promise<string>;
}

/** Zen ВКЛЮЧАЕТСЯ только явным opt-in (llm_zen=1 в settings): free-tier Zen закрыт
 *  для серверного использования (MissingSessionID — только внутри OpenCode-клиента),
 *  поэтому дефолт "0", а не "1" как у остальных звеньев. */
async function zenOptIn(env: Env): Promise<boolean> {
  try {
    const { values } = await getSettings(env);
    return (values["llm_zen"] ?? "0") === "1";
  } catch {
    return false;
  }
}

/** Звенья после primary Groq (с учётом kill-switches и наличия ключей/binding). */
export async function fallbackLinks(env: Env): Promise<LlmLink[]> {
  const links: LlmLink[] = [];
  if (await llmEnabled(env, "llm_groq_alt")) {
    for (const m of GROQ_ALT_MODELS) {
      if (m === env.GROQ_MODEL) continue;
      links.push({ id: "groq-alt", run: (p, t) => groqText(env, m, p, t) });
    }
  }
  if ((await llmEnabled(env, "llm_gemini")) && env.GEMINI_API_KEY) {
    links.push({ id: "gemini", run: (p, t) => geminiText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_cerebras")) && env.CEREBRAS_API_KEY) {
    links.push({ id: "cerebras", run: (p, t) => cerebrasText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_openrouter")) && env.OPENROUTER_API_KEY) {
    links.push({ id: "openrouter", run: (p, t) => openrouterText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_deepseek")) && env.DEEPSEEK_API_KEY) {
    links.push({ id: "deepseek", run: (p, t) => deepseekText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_mistral_chat")) && env.MISTRAL_API_KEY) {
    links.push({ id: "mistral-chat", run: (p, t) => mistralChatText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_cohere_chat")) && env.COHERE_API_KEY) {
    links.push({ id: "cohere-chat", run: (p, t) => cohereChatText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_custom")) && env.LLM_CUSTOM_BASE && env.LLM_CUSTOM_KEY) {
    links.push({ id: "custom", run: (p, t) => customLlmText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_workers")) && env.AI) {
    links.push({ id: "workers-ai", run: (p, t) => workersAiText(env, p, t) });
  }
  if ((await zenOptIn(env)) && env.OPENCODE_API_KEY) {
    links.push({ id: "zen", run: (p, t) => zenText(env, p, t) });
  }
  if (await llmEnabled(env, "llm_pollinations")) {
    links.push({ id: "pollinations", run: (p, t) => pollinationsText(p, t) });
  }
  return links;
}

/** Защитный парсинг JSON-ответа модели (как раньше, вынесен для переиспользования звеньями). */
/** Ошибка парсинга — НЕ то же самое, что явный отказ модели: помечаем сентинелом,
 *  чтобы цепочка продолжилась (другие звенья → экстрактив), а не выдала техно-текст за вердикт. */
const PARSE_ERROR = "__parseError";
function extractJsonAnswer(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return { [PARSE_ERROR]: true, raw: text.slice(0, 400) };
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return { [PARSE_ERROR]: true, raw: text.slice(0, 400) };
  }
}

/** Чистка контекста для промпта: строки оглавления (заголовок … номер_страницы) лишаем
 *  номера страницы (иначе модель принимает его за значение, напр. «95 м»);
 *  точечные линейки схлопываем, пробелы нормализуем. Заголовки сохраняем. */
export function sanitizeContextText(t: string): string {
  return String(t ?? "")
    .split("\n")
    .map((line) => {
      // "Минимально допустимые расстояния между зданиями ..... 95" → "…расстояния между зданиями"
      const toc = line.match(/^(.+?)\s*[.…]{3,}\s*\d{1,4}\s*$/);
      if (toc) line = toc[1];
      line = line.replace(/[.…]{4,}/g, " … ");
      return line;
    })
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Номер пункта вида 5.4 / 7.2.1 / 12а — и никогда номер источника вида [1]. */
const PARAGRAPH_RE = /^\d+(\.\d+)*[а-яa-z]?$/;
export function cleanParagraphValue(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s || s === "—") return "";
  if (/[\[\]]/.test(s)) return "";
  // «Таблица А.1» — не номер пункта, а название (иначе ниже вынется «1»)
  if (/таблиц/i.test(s)) return "";
  // модель иногда возвращает "п. 5.4" целиком — вынимаем номер
  const m = s.match(/\d+(\.\d+)*[а-яa-z]?/);
  const num = m ? m[0] : "";
  return num && PARAGRAPH_RE.test(num) ? num : "";
}

/** Название таблицы из текста чанка ("Таблица А.1") — fallback пункта, когда p пуст. */
const TABLE_TITLE_RE = /Таблица\s+[А-ЯA-Zа-яa-z]?\s*\.?\s*\d+(\.\d+)*/;
export function extractTableTitle(t: string): string {
  const m = String(t ?? "").match(TABLE_TITLE_RE);
  if (!m) return "";
  return m[0].replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".").trim();
}

/** Похоже ли на таблицу: явный тип чанка или продолжение таблицы
 *  (несколько паттернов «номер строки + текст»: "10 Жилые здания … 15 11 Корпуса … 30"). */
export function isTableLike(t: string, ty?: string): boolean {
  if (ty === "table") return true;
  const text = String(t ?? "");
  const hits = text.match(/\b\d{1,3}\s+[А-ЯЁA-Z][а-яёa-z]+/g);
  return !!hits && hits.length >= 2;
}

const TABLE_NOTE = "[таблица: первое число строки — номер строки, а значение требования — число в конце строки]";
const TABLE_RULE =
  "7. В ТАБЛИЦАХ первое число строки — это НОМЕР СТРОКИ, а не значение! Значение требования — число в КОНЦЕ строки (часто рядом с единицей из заголовка таблицы: м, мм). " +
  "Пример: «10 Жилые здания … освещенности … 15» при заголовке «в метрах» означает значение 15, а 10 — номер строки. " +
  "Голое число без единицы измерения рядом значением не является";

const ASK_STRICT_SUFFIX = "\n\n(ВАЖНО: quote обязана быть дословным фрагментом контекста)";

/** Нормализация для сравнения цитаты с контекстом: lower + ё + схлоп пробелов. */
function normQuote(s: string): string {
  return String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Ремонт недословной цитаты вместо скипа звена: подменяем ближайшим фрагментом
 * контекста (косинусная схожесть по словам). Возврат — всегда подстрока контекста,
 * поэтому verifyGrounded после ремонта проходит. Пустая цитата → начало топ-контекста.
 */
function repairQuote(quote: string, contexts: string[]): string {
  const q = normQuote(quote);
  if (!contexts.length) return String(quote ?? "").slice(0, 500);
  if (!q) return contexts[0].slice(0, 500);
  for (const c of contexts) {
    if (normQuote(c).includes(q)) return quote; // дословная — оставляем как есть
  }
  const qWords = new Set(q.split(" ").filter((w) => w.length > 2));
  let best = "", bestScore = 0;
  for (const c of contexts) {
    const cw = new Set(normQuote(c).split(" ").filter((w) => w.length > 2));
    if (!qWords.size || !cw.size) continue;
    let inter = 0;
    for (const w of qWords) if (cw.has(w)) inter++;
    const score = inter / Math.sqrt(qWords.size * cw.size);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best || bestScore < 0.2) return contexts[0].slice(0, 500);
  let snip = best.slice(0, 500);
  const dot = snip.lastIndexOf(". ");
  if (dot > 200) snip = snip.slice(0, dot + 1);
  return snip.trim();
}

/** Счётчики причин провалов звеньев (цепляются к бросаемой ошибке для диагностики в ledger.meta). */
export interface LlmCauses {
  rate429: number;
  badJson: number;
  other: number;
}

function dominantCause(c: LlmCauses): string {
  const entries = [["rate429", c.rate429], ["badJson", c.badJson], ["other", c.other]] as const;
  let top: string = "other";
  let topN = -1;
  for (const [k, n] of entries) {
    if (n > topN) {
      topN = n;
      top = k;
    }
  }
  return topN > 0 ? top : "unknown";
}

/**
 * Ответ с заземлением через цепочку: primary Groq (с 1 строгим ретраем) → фолбэки.
 * Явный «ответа нет» (is_grounded=false) принимается сразу — все звенья скажут то же.
 * Бросает только при полном провале всех звеньев (тогда вызыватель строит extractive).
 */
export async function answerWithFallback(
  env: Env,
  makePrompt: (extra: string, ctxs: string[]) => string,
  contexts: string[],
  maxTokens: number,
  shortContexts?: string[]
): Promise<{ answer: any; provider: LlmProvider }> {
  let lastErr: any = new Error("llm unavailable");
  const causes: LlmCauses = { rate429: 0, badJson: 0, other: 0 };
  const noteErr = (e: any, badJson = false) => {
    if (badJson) causes.badJson++;
    else if (e?.status === 429) causes.rate429++;
    else causes.other++;
    return e;
  };
  // Резервам — ужатые контексты: им хватает фактуры для цитаты, а токены бережём.
  const shortCtx = shortContexts ?? contexts;
  // primary Groq: обычная попытка + строгая (как раньше)
  for (const extra of ["", ASK_STRICT_SUFFIX]) {
    try {
      const parsed = extractJsonAnswer(await groqText(env, env.GROQ_MODEL, makePrompt(extra, contexts), maxTokens));
      if (parsed?.[PARSE_ERROR]) {
        lastErr = noteErr(new Error("groq: bad json"), true);
        console.error(`[llm] groq ${env.GROQ_MODEL}: bad json`);
        continue; // мусор вместо JSON — пробуем дальше, а не выдаём за вердикт
      }
      if (parsed?.is_grounded === false || verifyGrounded(parsed, contexts)) return { answer: parsed, provider: "groq" };
      // недословная цитата — чиним подменой фрагмента контекста, звено засчитываем
      parsed.quote = repairQuote(String(parsed?.quote ?? ""), contexts);
      return { answer: parsed, provider: "groq" };
    } catch (e: any) {
      if (fatalLlmError(e)) throw e;
      lastErr = noteErr(e);
      console.error(`[llm] groq ${env.GROQ_MODEL} failed: status=${e?.status ?? "?"} ${String(e?.message ?? e).slice(0, 160)}`);
      break;
    }
  }
  // фолбэки: по одной попытке (без строгого ретрая — экономим время и чужие квоты)
  for (const link of await fallbackLinks(env)) {
    try {
      const parsed = extractJsonAnswer(await link.run(makePrompt("", shortCtx), maxTokens));
      if (parsed?.[PARSE_ERROR]) {
        lastErr = noteErr(new Error(`${link.id}: bad json`), true);
        console.error(`[llm] ${link.id}: bad json`);
        continue;
      }
      if (parsed?.is_grounded === false || verifyGrounded(parsed, shortCtx)) return { answer: parsed, provider: link.id };
      // недословная цитата — чиним подменой фрагмента контекста, звено засчитываем
      parsed.quote = repairQuote(String(parsed?.quote ?? ""), shortCtx);
      return { answer: parsed, provider: link.id };
    } catch (e: any) {
      if (fatalLlmError(e)) throw e;
      lastErr = noteErr(e);
      console.error(`[llm] ${link.id} failed: status=${e?.status ?? "?"} ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  (lastErr as any).llmCauses = causes;
  throw lastErr;
}

async function askGroq(env: Env, query: string, contexts: string[], maxTokens: number, history?: Array<{ q: string; a: string }>): Promise<{ answer: any; provider: LlmProvider }> {
  // Экономия токенов: полный чанк модели не нужен — цитата и факты берутся из начала.
  // Урезанные контексты идут и в промпт, и в verifyGrounded — консистентно.
  const trimCtx = contexts.map((c) => String(c ?? "").slice(0, 1200));
  // Резервы видят ещё более короткий срез (700) — фактуры для цитаты хватает, токены целее.
  const shortTrim = trimCtx.map((c) => c.slice(0, 700));
  const hist = (history ?? [])
    .filter((h) => h.q || h.a)
    .slice(-2)
    .map((h, i) => `${i + 1}. Вопрос: ${h.q}\n   Ответ: ${h.a}`)
    .join("\n");
  const head = `Ты — эксперт по строительным нормам РК (СНиП/СП/СН/СТ РК). Ответь на вопрос ТОЛЬКО по контексту ниже.

Правила:
1. Если в контексте нет ответа — верни {"answer":"В доступной нормативной базе точного требования не найдено.","quote":"","paragraph":"","is_grounded":false}
2. quote — ДОСЛОВНАЯ цитата из контекста (можно сократить многоточием внутри, но слова должны совпадать)
3. Ответ на русском, кратко, с конкретными числами
4. Верни строго JSON без markdown
5. paragraph — ТОЛЬКО номер пункта из текста вида 5.4 или 7.2.1. НИКОГДА не пиши туда номер источника («Источник 1», [1] и т.п.); если номера пункта в тексте нет — верни пустую строку
6. Число в конце строки оглавления после многоточия — это НОМЕР СТРАНИЦЫ, а не значение требования. Количественные значения (метры, миллиметры) бери только из текста пунктов, никогда из оглавления
${TABLE_RULE}
${hist ? `\nИстория диалога (учитывай её, не повторяй уже сказанное):\n${hist}\n` : ``}`;
  const build = (extra: string, ctxs: string[]) =>
    `${head}\nКонтекст:\n${ctxs.map((c, i) => `Источник ${i + 1}: ${c}`).join("\n\n")}\n\n${hist ? "Уточняющий вопрос" : "Вопрос"}: ${query}${extra}`;
  return answerWithFallback(env, build, trimCtx, maxTokens, shortTrim);
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
  const lim = await getLimits(env);
  return { used: row?.count ?? 0, cap: lim.explainCap };
}

/** Простой текст через цепочку (для объяснятора; без grounding — там свободная форма). */
async function completeWithFallback(env: Env, prompt: string, maxTokens: number): Promise<{ text: string; provider: LlmProvider }> {
  let lastErr: any = new Error("llm unavailable");
  try {
    return { text: await groqText(env, env.GROQ_MODEL, prompt, maxTokens), provider: "groq" };
  } catch (e: any) {
    if (fatalLlmError(e)) throw e;
    lastErr = e;
  }
  for (const link of await fallbackLinks(env)) {
    try {
      return { text: await link.run(prompt, maxTokens), provider: link.id };
    } catch (e: any) {
      if (fatalLlmError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
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

  const { text } = await completeWithFallback(env, prompt, 300);
  return text.slice(0, 1200);
}

// ---------- Админ-статистика: использование ИИ по моделям и сегментам (деривация, 0 writes) ----------

export type Segment = "guest" | "free" | "pro" | "business";

/** CASE для сегмента субъекта: гости / бесплатные / PRO / Business (подписка не истекла). */
const SEGMENT_CASE = (subjCol: string) =>
  `CASE WHEN ${subjCol} LIKE 'anon:%' THEN 'guest' ` +
  `WHEN sub.plan='pro' AND sub.expires_at > ? THEN 'pro' ` +
  `WHEN sub.plan='business' AND sub.expires_at > ? THEN 'business' ` +
  `ELSE 'free' END`;

export interface SegmentRow {
  seg: Segment;
  n: number;
  s: number;
}

/**
 * Использование ИИ за период (деривация из существующих таблиц):
 * - ask (Groq ответы): spend_deep − refund_deep (refund = сбой Groq/пустой индекс)
 * - explain (Groq объяснятор): explain_usage (кэш-хиты туда не попадают)
 * - embed (Gemini, ОЦЕНКА): spend_fast×1 + spend_deep×2 (deep эмбеддит дважды: клиент + сервер)
 */
async function getModelUsage(
  env: Env,
  sinceIso: string,
  sinceDay: string
): Promise<{
  ask: { x: number; refunds: number; by_segment: SegmentRow[]; fb: Record<string, number> };
  explain: { x: number; by_segment: SegmentRow[] };
  embed: { x_est: number; by_segment: SegmentRow[] };
}> {
  const nowIso = new Date().toISOString();
  const [spendRows, refundRow, explainRows, fbRows] = await Promise.all([
    env.DB.prepare(
      `SELECT l.kind AS kind, ${SEGMENT_CASE("l.subject")} AS seg, COUNT(*) AS n, COALESCE(SUM(-l.delta),0) AS s
       FROM ledger l LEFT JOIN subscriptions sub ON sub.subject=l.subject
       WHERE l.kind IN ('spend_fast','spend_deep') AND l.created_at >= ?
       GROUP BY l.kind, seg`
    )
      .bind(nowIso, nowIso, sinceIso)
      .all<{ kind: string; seg: Segment; n: number; s: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM ledger WHERE kind LIKE 'refund%' AND created_at >= ?")
      .bind(sinceIso)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT ${SEGMENT_CASE("e.subject")} AS seg, COALESCE(SUM(e.count),0) AS n
       FROM explain_usage e LEFT JOIN subscriptions sub ON sub.subject=e.subject
       WHERE e.day >= ?
       GROUP BY seg`
    )
      .bind(nowIso, nowIso, sinceDay)
      .all<{ seg: Segment; n: number }>(),
    // счётчики звеньев фолбэка (метка llm пишется только на не-Groq пути — редкие writes)
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN meta LIKE '%"llm":"gemini"%' THEN 1 ELSE 0 END) AS gemini,
        SUM(CASE WHEN meta LIKE '%"llm":"cerebras"%' THEN 1 ELSE 0 END) AS cerebras,
        SUM(CASE WHEN meta LIKE '%"llm":"openrouter"%' THEN 1 ELSE 0 END) AS openrouter,
        SUM(CASE WHEN meta LIKE '%"llm":"deepseek"%' THEN 1 ELSE 0 END) AS deepseek,
        SUM(CASE WHEN meta LIKE '%"llm":"mistral-chat"%' THEN 1 ELSE 0 END) AS mistral_chat,
        SUM(CASE WHEN meta LIKE '%"llm":"cohere-chat"%' THEN 1 ELSE 0 END) AS cohere_chat,
        SUM(CASE WHEN meta LIKE '%"llm":"custom"%' THEN 1 ELSE 0 END) AS custom,
        SUM(CASE WHEN meta LIKE '%"llm":"workers-ai"%' THEN 1 ELSE 0 END) AS workers,
        SUM(CASE WHEN meta LIKE '%"llm":"zen"%' THEN 1 ELSE 0 END) AS zen,
        SUM(CASE WHEN meta LIKE '%"llm":"pollinations"%' THEN 1 ELSE 0 END) AS pollinations,
        SUM(CASE WHEN meta LIKE '%"llm":"groq-alt"%' THEN 1 ELSE 0 END) AS groq_alt,
        SUM(CASE WHEN meta LIKE '%"llm":"cache"%' THEN 1 ELSE 0 END) AS cache,
        SUM(CASE WHEN meta LIKE '%"llm":"extractive"%' THEN 1 ELSE 0 END) AS extractive
       FROM ledger WHERE kind='spend_deep' AND created_at >= ?`
    )
      .bind(sinceIso)
      .first<{ gemini: number; cerebras: number; openrouter: number; deepseek: number; mistral_chat: number; cohere_chat: number; custom: number; workers: number; zen: number; pollinations: number; groq_alt: number; cache: number; extractive: number }>(),
  ]);
  const byKind = (kind: string): SegmentRow[] =>
    (spendRows.results ?? [])
      .filter((r) => r.kind === kind)
      .map((r) => ({ seg: r.seg, n: r.n, s: r.s }));
  const deep = byKind("spend_deep");
  const fast = byKind("spend_fast");
  const refunds = refundRow?.c ?? 0;
  const askX = Math.max(0, deep.reduce((a, r) => a + r.n, 0) - refunds);
  // эмбеддинги: fast — 1 вызов, deep — 2 (клиент /api/embed + сервер vectorTopK); возвраты не вычитаем — эмбед уже потрачен
  const segMap = new Map<Segment, number>();
  for (const r of fast) segMap.set(r.seg, (segMap.get(r.seg) ?? 0) + r.n);
  for (const r of deep) segMap.set(r.seg, (segMap.get(r.seg) ?? 0) + 2 * r.n);
  const embedSeg: SegmentRow[] = [...segMap.entries()].map(([seg, n]) => ({ seg, n, s: 0 }));
  return {
    ask: {
      x: askX,
      refunds,
      by_segment: deep,
      fb: {
        groq_alt: fbRows?.groq_alt ?? 0,
        gemini: fbRows?.gemini ?? 0,
        cerebras: fbRows?.cerebras ?? 0,
        openrouter: fbRows?.openrouter ?? 0,
        deepseek: fbRows?.deepseek ?? 0,
        mistral_chat: fbRows?.mistral_chat ?? 0,
        cohere_chat: fbRows?.cohere_chat ?? 0,
        custom: fbRows?.custom ?? 0,
        workers: fbRows?.workers ?? 0,
        zen: fbRows?.zen ?? 0,
        pollinations: fbRows?.pollinations ?? 0,
        cache: fbRows?.cache ?? 0,
        extractive: fbRows?.extractive ?? 0,
      },
    },
    explain: {
      x: (explainRows.results ?? []).reduce((a, r) => a + r.n, 0),
      by_segment: (explainRows.results ?? []).map((r) => ({ seg: r.seg, n: r.n, s: 0 })),
    },
    embed: { x_est: [...segMap.values()].reduce((a, n) => a + n, 0), by_segment: embedSeg },
  };
}

/** Троттлинг голоса: 20 запр./день с устройства, в памяти изолята (без D1). */
const voiceThrottle = new Map<string, { day: string; n: number }>();
const VOICE_DAILY_LIMIT = 20;
const VOICE_MAX_BYTES = 3 * 1024 * 1024; // 3 МБ ≈ 30–60 сек opus

/** Троттлинг фидбека: 30 отзывов/день с субъекта, в памяти изолята (без D1). */
const feedbackThrottle = new Map<string, { n: number }>();
const FEEDBACK_DAILY_LIMIT = 30;
const FEEDBACK_REASONS = ["wrong_paragraph", "no_quote", "off_topic", "outdated", "other"];

/** Ленивая миграция D1: таблица feedback (игнорирует "already exists"). */
async function ensureFeedbackTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, subject TEXT NOT NULL, is_user INTEGER NOT NULL DEFAULT 0, query TEXT NOT NULL, mode TEXT, provider TEXT, chunk_ids TEXT, answer_excerpt TEXT, paragraph TEXT, rating INTEGER NOT NULL, reason TEXT, comment TEXT)"
    ).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating)").run();
  } catch {
    /* уже есть — ок */
  }
}

function voiceThrottleKey(req: Request): string {
  return req.headers.get("X-Device-Id") || req.headers.get("CF-Connecting-IP") || "anon";
}

// ---------- Роутер ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = CORS_HEADERS(env, req.headers.get("Origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      // POST /api/embed {query, mode?} → float[] (для клиентского гибридного поиска)
      // mode=fast: списание 5⚡ внутри (быстрый поиск — 1 запрос вместо 2); deep не списывает (спишет /ask)
      if (url.pathname === "/api/embed" && req.method === "POST") {
        const { query, mode } = (await req.json()) as any;
        if (!query?.trim()) return json({ error: "query required" }, 400, cors);
        let charged: CreditsState | null = null;
        if (mode === "fast") {
          const { subject, isUser } = await subjectFromRequest(env, req);
          const lim = await getLimits(env);
          const res = await chargeHybrid(env, subject, isUser, lim.fast, "spend_fast");
          if (!res.ok) {
            return json(
              { error: "insufficient_credits", detail: "Недостаточно кредитов для быстрого поиска", ...res.state, need: res.need },
              402,
              cors
            );
          }
          charged = res.state;
        }
        try {
          const embedding = await embedQuery(env, query);
          return json(charged ? { embedding, credits: charged } : { embedding }, 200, cors);
        } catch (e: any) {
          // Сбой провайдера эмбеддингов — не голый 500, а причина + провайдер из манифеста.
          // 429 (лимит Cohere/других) пробрасываем как 429, а не 502 — фронт делает
          // авторетрай с backoff и понятный тост вместо "embed failed: 502".
          let provider = "unknown";
          try {
            provider = (await getIndexManifest(env)).provider;
          } catch {}
          const status = e?.status;
          const retryAfterSec =
            e?.retryAfterMs != null ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : undefined;
          console.error("embed failed", provider, status ?? "", e?.message, e?.bodySnippet ?? "");
          if (status === 429) {
            const headers = { ...cors, ...(retryAfterSec != null ? { "Retry-After": String(retryAfterSec) } : {}) };
            return json(
              {
                error: "embed_rate_limited",
                detail: e?.message ?? "Лимит провайдера эмбеддингов — повторите через несколько секунд",
                provider,
                ...(retryAfterSec != null ? { retryAfter: retryAfterSec } : {}),
              },
              429,
              headers
            );
          }
          return json(
            { error: "embed_provider_failed", detail: e?.message ?? "embedding unavailable", provider },
            502,
            cors
          );
        }
      }

      // POST /api/voice (multipart audio) → {text} через Groq Whisper.
      // Резерв для Web Speech при ошибке network. Без списания кредитов и записей в D1.
      if (url.pathname === "/api/voice" && req.method === "POST") {
        const day = todayKey();
        const key = voiceThrottleKey(req);
        const cur = voiceThrottle.get(key);
        if (cur && cur.day === day && cur.n >= VOICE_DAILY_LIMIT) {
          return json({ error: "voice_limit", detail: "Лимит голосовых (20/день) исчерпан — обновится в 00:00 UTC" }, 429, cors);
        }
        let file: File | null = null;
        try {
          const form = await req.formData();
          const f = form.get("audio");
          if (f instanceof File) file = f;
        } catch {
          return json({ error: "bad_audio", detail: "Не удалось прочитать аудио" }, 400, cors);
        }
        if (!file || file.size === 0) return json({ error: "bad_audio", detail: "Пустая запись" }, 400, cors);
        if (file.size > VOICE_MAX_BYTES) return json({ error: "too_big", detail: "Запись длиннее ~30 сек — говорите короче" }, 413, cors);
        try {
          const out = new FormData();
          out.append("file", file, "voice.webm");
          out.append("model", "whisper-large-v3-turbo");
          out.append("language", "ru");
          out.append("response_format", "json");
          const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
            body: out,
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) throw statusError("whisper", r, await r.text());
          const d: any = await r.json();
          const text = String(d.text ?? "").trim();
          if (!text) return json({ error: "empty", detail: "Речь не распознана, попробуйте ещё раз" }, 422, cors);
          voiceThrottle.set(key, { day, n: (cur && cur.day === day ? cur.n : 0) + 1 });
          return json({ text }, 200, cors);
        } catch (e: any) {
          console.error("voice failed", e?.message);
          return json({ error: "voice_failed", detail: "Резервное распознавание недоступно, попробуйте позже" }, 502, cors);
        }
      }

      // POST /api/auth/register {email,password,full_name?}
      if (url.pathname === "/api/auth/register" && req.method === "POST") {
        const { email, password, full_name } = (await req.json()) as any;
        if (!email || !password || String(password).length < 6)
          return json({ error: "email и password (6+) обязательны" }, 400, cors);
        const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
        if (exists) return json({ error: "email уже зарегистрирован" }, 409, cors);
        await ensureUserNameColumns(env);
        const uid = crypto.randomUUID();
        const nowIso = new Date().toISOString();
        const cleanName = normalizeName(full_name);
        try {
          await env.DB.prepare(
            "INSERT INTO users (id,email,password_hash,full_name,name_changed_at,created_at) VALUES (?,?,?,?,?,?)"
          )
            .bind(uid, email, await hashPassword(password), cleanName || null, cleanName ? nowIso : null, nowIso)
            .run();
        } catch {
          // старая схема без новых колонок — fallback
          await env.DB.prepare("INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)")
            .bind(uid, email, await hashPassword(password), nowIso)
            .run();
        }
        return json(
          { uid, email, full_name: cleanName || null, token: await signJwt({ uid, email }, env.JWT_SECRET) },
          201,
          cors
        );
      }

      // POST /api/auth/login {email,password}
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const { email, password } = (await req.json()) as any;
        await ensureUserNameColumns(env);
        let row: { id: string; password_hash: string; full_name?: string | null } | null = null;
        try {
          row = await env.DB.prepare("SELECT id,password_hash,full_name FROM users WHERE email=?")
            .bind(email)
            .first<{ id: string; password_hash: string; full_name?: string | null }>();
        } catch {
          row = await env.DB.prepare("SELECT id,password_hash FROM users WHERE email=?").bind(email).first<{ id: string; password_hash: string }>();
        }
        if (!row || !(await verifyPassword(password, row.password_hash))) return json({ error: "неверный email или пароль" }, 401, cors);
        return json(
          { uid: row.id, email, full_name: (row as any).full_name ?? null, token: await signJwt({ uid: row.id, email }, env.JWT_SECRET) },
          200,
          cors
        );
      }

      // GET /api/me — профиль: uid/email/имя/кулдаун смены/кредиты
      if (url.pathname === "/api/me" && req.method === "GET") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: "unauthorized" }, 401, cors);
        await ensureUserNameColumns(env);
  const { subject, isUser } = await subjectFromRequest(env, req);
  const credits = await getCreditsState(env, subject, isUser);
        let full_name: string | null = null;
        let name_changed_at: string | null = null;
        let created_at: string | null = null;
        try {
          const urow = await env.DB.prepare("SELECT full_name,name_changed_at,created_at FROM users WHERE id=?")
            .bind(String(payload.uid))
            .first<{ full_name: string | null; name_changed_at: string | null; created_at: string | null }>();
          full_name = urow?.full_name ?? null;
          name_changed_at = urow?.name_changed_at ?? null;
          created_at = urow?.created_at ?? null;
        } catch {
          /* старая схема — без имени */
        }
        const changedMs = name_changed_at ? new Date(name_changed_at).getTime() : 0;
        const name_can_change_at =
          full_name && changedMs ? new Date(changedMs + NAME_CHANGE_COOLDOWN_MS).toISOString() : null;
        const canChange = !name_can_change_at || new Date(name_can_change_at).getTime() <= Date.now();
        return json(
          {
            uid: payload.uid,
            email: payload.email,
            full_name,
            name_changed_at,
            name_can_change_at: canChange ? null : name_can_change_at,
            created_at,
            is_admin: isAdminEmail(payload.email),
            credits,
          },
          200,
          cors
        );
      }

      // PATCH /api/me {full_name} — смена имени не чаще раза в 30 дней (первая установка свободна)
      if (url.pathname === "/api/me" && req.method === "PATCH") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload?.uid) return json({ error: "unauthorized" }, 401, cors);
        await ensureUserNameColumns(env);
        const patchBody = (await req.json().catch(() => ({}))) as any;
        const cleanName = normalizeName(patchBody.full_name);
        if (cleanName.length < NAME_MIN_LEN)
          return json({ error: "bad_name", detail: `Имя — минимум ${NAME_MIN_LEN} символа` }, 400, cors);
        let cur: { full_name: string | null; name_changed_at: string | null } | null = null;
        try {
          cur = await env.DB.prepare("SELECT full_name,name_changed_at FROM users WHERE id=?")
            .bind(String(payload.uid))
            .first<{ full_name: string | null; name_changed_at: string | null }>();
        } catch (e: any) {
          return json({ error: "name_unsupported", detail: "Смена имени временно недоступна" }, 500, cors);
        }
        if (!cur) return json({ error: "not_found" }, 404, cors);
        // первая установка (имя пустое) — без кулдауна; повторная — раз в 30 дней
        if (cur.full_name && cur.name_changed_at) {
          const next = new Date(cur.name_changed_at).getTime() + NAME_CHANGE_COOLDOWN_MS;
          if (next > Date.now()) {
            return json(
              {
                error: "name_cooldown",
                detail: `Имя можно менять раз в 30 дней. Следующая смена — ${new Date(next).toLocaleDateString("ru-RU")}`,
                name_can_change_at: new Date(next).toISOString(),
              },
              429,
              cors
            );
          }
        }
        const nowIso = new Date().toISOString();
        await env.DB.prepare("UPDATE users SET full_name=?, name_changed_at=? WHERE id=?")
          .bind(cleanName, nowIso, String(payload.uid))
          .run();
        return json(
          {
            ok: true,
            full_name: cleanName,
            name_changed_at: nowIso,
            name_can_change_at: new Date(Date.now() + NAME_CHANGE_COOLDOWN_MS).toISOString(),
          },
          200,
          cors
        );
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
        const lim = await getLimits(env);
        const cost = mode === "deep" ? lim.deep : lim.fast;
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

      // POST /api/billing/purchase {sku} — ДЕМО-активация пакета или подписки (ТОЛЬКО админы)
      if (url.pathname === "/api/billing/purchase" && req.method === "POST") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized", detail: "Войдите, чтобы пополнять баланс" }, 401, cors);
        const payload = await verifyJwt(auth.slice(7), env.JWT_SECRET);
        if (!payload) return json({ error: "unauthorized" }, 401, cors);
        if (!isAdminEmail(payload.email))
          return json(
            { error: "billing_disabled", detail: "Демо-оплата сейчас доступна только администраторам. Приём платежей (Kaspi/карты) — скоро." },
            403,
            cors
          );
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

      // POST /api/ask {query, mode?, chunkIds?, followUp?, history?} → списывает DEEP_COST (уточнение: FOLLOWUP_COST), Groq с заземлением
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const body = (await req.json()) as any;
        const query = String(body.query ?? "").trim();
        if (!query) return json({ error: "query required" }, 400, cors);
        // Уточняющий вопрос: контекст переиспользуется (chunkIds), диалог — последние 2 витка
        const isFollowUp = body.followUp === true;
        const history: Array<{ q: string; a: string }> = Array.isArray(body.history)
          ? body.history
              .slice(-2)
              .map((h: any) => ({ q: String(h?.q ?? h?.query ?? "").slice(0, 300), a: String(h?.a ?? h?.answer ?? "").slice(0, 800) }))
              .filter((h: { q: string; a: string }) => h.q || h.a)
          : [];

        const { subject, isUser } = await subjectFromRequest(env, req);
        const lim = await getLimits(env);
        const cost = isFollowUp ? lim.followup : lim.deep;
        const spendKind = isFollowUp ? "spend_followup" : "spend_deep";
        const refundKind = isFollowUp ? "refund_followup" : "refund_deep";
        const spend = await chargeHybrid(env, subject, isUser, cost, spendKind);
        if (!spend.ok || !spend.split) {
          return json(
            { error: "insufficient_credits", detail: isFollowUp ? "Недостаточно кредитов для уточняющего вопроса" : "Недостаточно кредитов для глубокого поиска", ...spend.state, need: spend.need },
            402,
            cors
          );
        }
        const state = await getCreditsState(env, subject, isUser);
        const tAsk0 = Date.now();

        // Кэш ответов: повторный вопрос — без LLM и эмбеддингов.
        // Смотрим после списания (хит списывается как обычно), уточнения не кэшируем.
        const askMode = body.mode === "deep" ? "deep" : "fast";
        let cacheHash = "";
        if (!isFollowUp) {
          try {
            cacheHash = await askCacheKey(query, askMode);
          } catch {
            cacheHash = "";
          }
          if (cacheHash) {
            try {
              const hit = await env.DB.prepare(
                "SELECT answer_json, sources_json, provider, grounded, created_at FROM ask_cache WHERE hash=?"
              )
                .bind(cacheHash)
                .first<{ answer_json: string; sources_json: string | null; provider: string; grounded: number; created_at: string }>();
              if (hit?.answer_json) {
                const age = Date.now() - Date.parse(hit.created_at);
                const ttl = hit.grounded ? ASK_CACHE_TTL_GROUNDED : ASK_CACHE_TTL_UNGROUNDED;
                if (age >= 0 && age < ttl) {
                  let cached: any = null;
                  let cachedSources: any = [];
                  try {
                    cached = JSON.parse(hit.answer_json);
                  } catch {}
                  try {
                    cachedSources = hit.sources_json ? JSON.parse(hit.sources_json) : [];
                  } catch {
                    cachedSources = [];
                  }
                  if (cached) {
                    try {
                      await env.DB.prepare(
                        "UPDATE ledger SET meta=? WHERE id=(SELECT MAX(id) FROM ledger WHERE subject=? AND kind=?)"
                      )
                        .bind(JSON.stringify({ split: spend.split, llm: "cache" }), subject, spendKind)
                        .run();
                    } catch {}
                    return json(
                      { answer: cached, provider: "cache", sources: cachedSources || [], credits: state, took_ms: Date.now() - tAsk0, cached: true },
                      200,
                      cors
                    );
                  }
                } else {
                  try {
                    await env.DB.prepare("DELETE FROM ask_cache WHERE hash=?").bind(cacheHash).run();
                  } catch {}
                }
              }
            } catch {}
          }
        }

        const idx = await loadIndex(env);
        let ids: number[];
        try {
          if (Array.isArray(body.chunkIds) && body.chunkIds.length) {
            ids = body.chunkIds.map(Number).filter((i: number) => i >= 0 && i < idx.count).slice(0, 5);
          } else {
            ids = await vectorTopK(env, query, body.mode === "deep" ? 5 : 3);
          }
          const rawContexts = ids.map((i) => idx.chunks[i]?.t).filter(Boolean);
          if (!rawContexts.length) {
            refundCharge(env, subject, isUser, cost, spend.split, refundKind).catch(() => {});
            return json({ answer: { answer: "Индекс пуст.", is_grounded: false }, took_ms: 0, ...state }, 200, cors);
          }
          // Чистим оглавления/линейки до промпта: модель не должна путать номер страницы со значением
          const contexts = rawContexts.map(sanitizeContextText).filter(Boolean);
          if (!contexts.length) {
            refundCharge(env, subject, isUser, cost, spend.split, refundKind).catch(() => {});
            return json({ answer: { answer: "В доступной нормативной базе точного требования не найдено.", quote: "", paragraph: "", is_grounded: false }, took_ms: 0, ...state }, 200, cors);
          }
          // Табличные контексты помечаем: первое число строки — номер строки, не значение
          const promptContexts = contexts.map((t, k) => {
            const ty = (idx.chunks[ids[k]] as any)?.ty;
            return isTableLike(t, ty) ? `${TABLE_NOTE}\n${t}` : t;
          });
          // paragraph первого чанка — надёжный фолбэк, если модель вернёт мусор вида "[1]"
          const firstChunk = idx.chunks[ids[0]];
          const firstChunkPara = String(firstChunk?.p ?? "") || extractTableTitle(rawContexts[0] ?? "");

          const maxTokens = body.mode === "deep" ? 1000 : 800;
          const t0 = Date.now();
          let answer: any;
          let provider: LlmProvider = "groq";
          let collapseWhy = "";
          try {
            ({ answer, provider } = await askGroq(env, query, promptContexts, maxTokens, isFollowUp ? history : undefined));
          } catch (e: any) {
            // вся LLM-цепочка легла → экстрактивный ответ из цитат (бесконечно, без ИИ)
            collapseWhy = dominantCause(((e as any)?.llmCauses ?? { rate429: 0, badJson: 0, other: 0 }) as LlmCauses);
            if ((await llmEnabled(env, "llm_extractive")) && contexts.length) {
              const first = idx.chunks[ids[0]];
              const top = contexts.slice(0, 3).map((c) => c.slice(0, 400));
              answer = {
                answer: `По запросу «${query}» найдено в нормах (резервный режим без ИИ):\n\n` +
                  top.map((t, i) => `${i + 1}. ${t}${t.length >= 400 ? "…" : ""}`).join("\n\n"),
                quote: contexts[0].slice(0, 300),
                paragraph: first?.p ?? "",
                page: first?.pg ?? null,
                is_grounded: true,
                extractive: true,
              };
              provider = "extractive";
            } else {
              throw e;
            }
          }
          if (provider !== "groq") {
            // метим не-Groq путь в ledger.meta (редкий путь — +1 write только тогда)
            try {
              await env.DB.prepare(
                "UPDATE ledger SET meta=? WHERE id=(SELECT MAX(id) FROM ledger WHERE subject=? AND kind=?)"
              )
                .bind(JSON.stringify({ split: spend.split, llm: provider, ...(provider === "extractive" && collapseWhy ? { why: collapseWhy } : {}) }), subject, spendKind)
                .run();
            } catch {}
          }
          // paragraph от модели валидируем: мусор вида "[1]" заменяем номером пункта первого чанка
          if (!answer.extractive) {
            const cleaned = cleanParagraphValue(answer.paragraph);
            answer = { ...answer, paragraph: cleaned || firstChunkPara };
          }
          const finalAnswer = { ...answer, is_grounded: answer.extractive ? true : verifyGrounded(answer, promptContexts) };
          const finalSources = ids.map((i) => ({ i, d: idx.chunks[i].d, p: idx.chunks[i].p, pg: idx.chunks[i].pg }));
          // Кэш: только не-экстрактив (коллапсы не кэшируем — пулы могут ожить к повтору).
          if (!isFollowUp && cacheHash && !answer.extractive) {
            try {
              await env.DB.prepare(
                "INSERT INTO ask_cache (hash, query_norm, mode, answer_json, sources_json, provider, grounded, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(hash) DO UPDATE SET answer_json=excluded.answer_json, sources_json=excluded.sources_json, provider=excluded.provider, grounded=excluded.grounded, created_at=excluded.created_at"
              )
                .bind(
                  cacheHash,
                  normAskQuery(query),
                  askMode,
                  JSON.stringify(finalAnswer).slice(0, 8000),
                  JSON.stringify(finalSources).slice(0, 4000),
                  provider,
                  finalAnswer.is_grounded ? 1 : 0,
                  new Date().toISOString()
                )
                .run();
            } catch {}
          }
          return json(
            {
              answer: finalAnswer,
              provider,
              sources: finalSources,
              credits: state,
              took_ms: Date.now() - t0,
            },
            200,
            cors
          );
        } catch (e: any) {
          // внутренняя ошибка — возвращаем списанные кредиты
          refundCharge(env, subject, isUser, cost, spend.split, refundKind).catch(() => {});
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
        const lim = await getLimits(env);
        const cap = lim.explainCap;
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

      // ---------- Фидбек под ответом: 👍/👎 + причина + коммент. Без списания кредитов. ----------
      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const { subject, isUser } = await subjectFromRequest(env, req);
        const day = todayKey();
        const fk = `${day}:${subject}`;
        const cur = feedbackThrottle.get(fk);
        if (cur && cur.n >= FEEDBACK_DAILY_LIMIT) {
          return json({ error: "feedback_limit", detail: "Лимит отзывов (30/день) исчерпан — обновится в 00:00 UTC" }, 429, cors);
        }
        const body = (await req.json().catch(() => ({}))) as any;
        const rating = Number(body.rating);
        if (rating !== 1 && rating !== -1) return json({ error: "bad_rating", detail: "rating должен быть 1 или -1" }, 400, cors);
        const query = String(body.query ?? "").trim().slice(0, 500);
        if (!query) return json({ error: "query required" }, 400, cors);
        const reason = String(body.reason ?? "").slice(0, 32);
        if (reason && !FEEDBACK_REASONS.includes(reason))
          return json({ error: "bad_reason", detail: "Неизвестная причина" }, 400, cors);
        const comment = String(body.comment ?? "").trim().slice(0, 1000);
        const chunkIds = Array.isArray(body.chunkIds)
          ? body.chunkIds.map(Number).filter((i: number) => Number.isFinite(i)).slice(0, 5).join(",")
          : "";
        await ensureFeedbackTable(env);
        await env.DB.prepare(
          "INSERT INTO feedback (created_at, subject, is_user, query, mode, provider, chunk_ids, answer_excerpt, paragraph, rating, reason, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            new Date().toISOString(),
            subject,
            isUser ? 1 : 0,
            query,
            String(body.mode ?? "").slice(0, 16),
            String(body.provider ?? "").slice(0, 32),
            chunkIds,
            String(body.answerExcerpt ?? "").slice(0, 500),
            String(body.paragraph ?? "").slice(0, 32),
            rating,
            reason || null,
            comment || null
          )
          .run();
        feedbackThrottle.set(fk, { n: (cur?.n ?? 0) + 1 });
        return json({ ok: true }, 201, cors);
      }

      // ---------- Админка: только ADMIN_EMAILS, только существующие таблицы ----------
      if (url.pathname.startsWith("/api/admin/") && req.method !== "OPTIONS") {
        const admin = await requireAdmin(env, req);
        if (!admin) return json({ error: "not_admin", detail: "Раздел только для администраторов" }, 403, cors);

        // GET /api/admin/stats?days=7 — активность, квоты ИИ, ошибки (агрегаты, без новых таблиц)
        if (url.pathname === "/api/admin/stats" && req.method === "GET") {
          const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
          const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10); // YYYY-MM-DD
          const sinceIso = new Date(Date.now() - days * 86400e3).toISOString();
          const [uAll, uNew, kinds, perDay, explainSum, cacheN, lim, settings, modelUsage, idxInfo, idxSize] = await Promise.all([
            env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>(),
            env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE created_at >= ?").bind(since).first<{ c: number }>(),
            env.DB.prepare(
              "SELECT kind, COUNT(*) AS n, COALESCE(SUM(delta),0) AS s FROM ledger WHERE created_at >= ? GROUP BY kind"
            )
              .bind(sinceIso)
              .all<{ kind: string; n: number; s: number }>(),
            env.DB.prepare(
              "SELECT SUBSTR(day,1,10) AS d, COUNT(DISTINCT subject) AS n, COALESCE(SUM(count),0) AS s FROM usage WHERE SUBSTR(day,1,10) >= ? GROUP BY d ORDER BY d DESC LIMIT ?"
            )
              .bind(since, days)
              .all<{ d: string; n: number; s: number }>(),
            env.DB.prepare("SELECT COALESCE(SUM(count),0) AS s FROM explain_usage WHERE day >= ?").bind(since).first<{ s: number }>(),
            env.DB.prepare("SELECT COUNT(*) AS c FROM explain_cache").first<{ c: number }>(),
            getLimits(env),
            getSettings(env),
            getModelUsage(env, sinceIso, since),
            getIndexManifest(env),
            loadIndex(env)
              .then((idx) => ({ dim: idx.dim, count: idx.count }))
              .catch(() => null),
          ]);
          const customKeys = Object.keys(settings.values);
          return json(
            {
              days,
              users: { total: uAll?.c ?? 0, fresh: uNew?.c ?? 0 },
              ledger_by_kind: kinds.results ?? [],
              usage_by_day: perDay.results ?? [],
              explain: { used: explainSum?.s ?? 0, cached: cacheN?.c ?? 0, cap: lim.explainCap },
              limits: {
                anon: lim.anon,
                user: lim.user,
                fast: lim.fast,
                deep: lim.deep,
                groq_model: env.GROQ_MODEL ?? "",
                embed_model: env.EMBED_MODEL ?? "",
              },
              settings_meta: Object.fromEntries(
                Object.keys(SETTING_DEFS).map((k) => [k, { custom: customKeys.includes(k), updated_at: settings.updated[k] ?? null }])
              ),
              model_usage: {
                ask: { ...modelUsage.ask, n: lim.groqCap, note: "≈: повторная попытка Groq считается за 1" },
                explain: { ...modelUsage.explain, n: lim.groqCap, shared_pool: true },
                embed: { ...modelUsage.embed, n: lim.embedCap, estimate: true },
              },
              providers: {
                active_embed: {
                  provider: idxInfo.provider,
                  model: idxInfo.model,
                  dim: idxSize?.dim ?? null,
                  count: idxSize?.count ?? null,
                  builtAt: idxInfo.builtAt ?? null,
                },
                llm: { provider: "groq", model: env.GROQ_MODEL ?? "", fallback: false },
                llm_fallbacks: [
                  { id: "groq-alt", key_set: !!env.GROQ_API_KEY },
                  { id: "gemini", key_set: !!env.GEMINI_API_KEY },
                  { id: "cerebras", key_set: !!env.CEREBRAS_API_KEY },
                  { id: "openrouter", key_set: !!env.OPENROUTER_API_KEY },
                  { id: "deepseek", key_set: !!env.DEEPSEEK_API_KEY },
                  { id: "mistral-chat", key_set: !!env.MISTRAL_API_KEY },
                  { id: "cohere-chat", key_set: !!env.COHERE_API_KEY },
                  { id: "custom", key_set: !!(env.LLM_CUSTOM_BASE && env.LLM_CUSTOM_KEY) },
                  { id: "workers-ai", key_set: !!env.AI },
                  { id: "zen", key_set: !!env.OPENCODE_API_KEY },
                  { id: "pollinations", key_set: true },
                ],
                embed_fallbacks: (["gemini", "jina", "voyage", "cohere", "mistral"] as const).map((id) => ({
                  id,
                  key_set:
                    id === "gemini"
                      ? !!env.GEMINI_API_KEY
                      : id === "jina"
                        ? !!env.JINA_API_KEY
                        : id === "voyage"
                          ? !!env.VOYAGE_API_KEY
                          : id === "cohere"
                            ? !!env.COHERE_API_KEY
                            : !!env.MISTRAL_API_KEY,
                  active: idxInfo.provider === id,
                })),
              },
            },
            200,
            cors
          );
        }

        // GET /api/admin/users?q=&limit=50&offset=0 — пользователи + баланс + потрачено
        if (url.pathname === "/api/admin/users" && req.method === "GET") {
          const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 80);
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
          const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
          const [rows, total] = await Promise.all([
            env.DB.prepare(
              `SELECT u.id,u.email,u.plan,u.full_name,u.created_at,
                COALESCE(b.credits,0) AS balance,
                COALESCE((SELECT -SUM(l.delta) FROM ledger l WHERE l.subject=('user:'||u.id) AND l.delta<0),0) AS spent,
                COALESCE((SELECT s.plan FROM subscriptions s WHERE s.subject=('user:'||u.id)),'') AS sub
               FROM users u LEFT JOIN balances b ON b.subject=('user:'||u.id)
               WHERE (?1='' OR u.email LIKE '%'||?1||'%')
               ORDER BY u.created_at DESC LIMIT ?2 OFFSET ?3`
            )
              .bind(q, limit, offset)
              .all(),
            env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE (?1='' OR email LIKE '%'||?1||'%')")
              .bind(q)
              .first<{ c: number }>(),
          ]);
          return json({ items: rows.results ?? [], total: total?.c ?? 0, limit, offset }, 200, cors);
        }

        // GET /api/admin/activity?kind=&kinds=a,b&limit=50&offset=0 — лента операций с email
        if (url.pathname === "/api/admin/activity" && req.method === "GET") {
          const KNOWN_KINDS = ["spend_fast", "spend_deep", "spend_followup", "purchase", "subscription", "grant", "refund_deep", "refund_fast"];
          const rawKinds = String(url.searchParams.get("kinds") ?? url.searchParams.get("kind") ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => KNOWN_KINDS.includes(s) || /^refund_[a-z_]{1,20}$/.test(s))
            .slice(0, 12);
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
          const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
          const inList = rawKinds.map(() => "?").join(",");
          const where = rawKinds.length ? `l.kind IN (${inList})` : "1=1";
          const [rows, total] = await Promise.all([
            env.DB.prepare(
              `SELECT l.id,l.subject,COALESCE(u.email,'') AS email,l.delta,l.kind,l.meta,l.created_at
               FROM ledger l LEFT JOIN users u ON l.subject=('user:'||u.id)
               WHERE ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`
            )
              .bind(...rawKinds, limit, offset)
              .all(),
            env.DB.prepare(`SELECT COUNT(*) AS c FROM ledger l WHERE ${where.replace(/l\./g, "")}`)
              .bind(...rawKinds)
              .first<{ c: number }>(),
          ]);
          return json({ items: rows.results ?? [], total: total?.c ?? 0, limit, offset }, 200, cors);
        }

        // GET /api/admin/feedback?rating=all|1|-1&limit=50&offset=0 — отзывы под ответами + агрегат
        if (url.pathname === "/api/admin/feedback" && req.method === "GET") {
          await ensureFeedbackTable(env);
          const ratingParam = String(url.searchParams.get("rating") ?? "all");
          const ratingFilter = ratingParam === "1" ? 1 : ratingParam === "-1" ? -1 : null;
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
          const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
          const where = ratingFilter === null ? "1=1" : "f.rating=?";
          const bindBase: unknown[] = ratingFilter === null ? [] : [ratingFilter];
          const [rows, total, agg] = await Promise.all([
            env.DB.prepare(
              `SELECT f.id,f.created_at,f.subject,f.is_user,COALESCE(u.email,'') AS email,f.query,f.mode,f.provider,f.paragraph,f.rating,f.reason,f.comment
               FROM feedback f LEFT JOIN users u ON f.subject=('user:'||u.id)
               WHERE ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`
            )
              .bind(...bindBase, limit, offset)
              .all(),
            env.DB.prepare(`SELECT COUNT(*) AS c FROM feedback f WHERE ${where}`)
              .bind(...bindBase)
              .first<{ c: number }>(),
            env.DB.prepare(
              "SELECT COALESCE(SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END),0) AS pos, COALESCE(SUM(CASE WHEN rating=-1 THEN 1 ELSE 0 END),0) AS neg, COUNT(*) AS total FROM feedback"
            )
              .first<{ pos: number; neg: number; total: number }>(),
          ]);
          return json(
            { items: rows.results ?? [], total: total?.c ?? 0, limit, offset, agg: agg ?? { pos: 0, neg: 0, total: 0 } },
            200,
            cors
          );
        }

        // GET /api/admin/settings — оверрайды квот/капов (settings поверх env)
        if (url.pathname === "/api/admin/settings" && req.method === "GET") {
          const lim = await getLimits(env);
          const settings = await getSettings(env);
          const llmVals: Record<string, string> = {};
          // llm_zen — исключение: opt-in, дефолт "0" (free-tier Zen недоступен серверам)
          for (const k of LLM_LINK_DEFS) llmVals[k] = settings.values[k] ?? (k === "llm_zen" ? "0" : "1");
          return json(
            {
              values: { quota_anon: lim.anon, quota_user: lim.user, cost_fast: lim.fast, cost_deep: lim.deep, cost_followup: lim.followup, explain_cap: lim.explainCap, cap_groq_rpd: lim.groqCap, cap_embed_rpd: lim.embedCap, ...llmVals },
              meta: Object.fromEntries(
                Object.keys(SETTING_DEFS).map((k) => [
                  k,
                  { custom: k in settings.values, updated_at: settings.updated[k] ?? null, min: SETTING_DEFS[k].min, max: SETTING_DEFS[k].max },
                ]).concat(LLM_LINK_DEFS.map((k) => [k, { custom: k in settings.values, updated_at: settings.updated[k] ?? null, min: 0, max: 1 }]))
              ),
            },
            200,
            cors
          );
        }

        // POST /api/admin/settings {key, value} — изменить квоту/кап/звено LLM (валидация + инвалидация кэша)
        if (url.pathname === "/api/admin/settings" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const key = String(body.key ?? "");
          const def = SETTING_DEFS[key];
          const isLink = !def && (LLM_LINK_DEFS as string[]).includes(key);
          if (!def && !isLink) return json({ error: "unknown_key" }, 400, cors);
          const value = Math.floor(Number(body.value));
          const min = def ? def.min : 0;
          const max = def ? def.max : 1;
          if (!Number.isFinite(value) || value < min || value > max)
            return json({ error: "bad_value", detail: `Целое число от ${min} до ${max}` }, 400, cors);
          await ensureSettingsTable(env);
          await env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
          )
            .bind(key, String(value), new Date().toISOString())
            .run();
          settingsCache = null; // инвалидация isolate-кэша
          return json({ ok: true, key, value }, 200, cors);
        }

        // GET /api/admin/health — здоровье воркера: индекс, R2, размеры таблиц D1 (по кнопке)
        if (url.pathname === "/api/admin/health" && req.method === "GET") {
            const TABLES = ["users", "ledger", "usage", "balances", "subscriptions", "purchases", "explain_usage", "explain_cache", "ask_cache", "settings", "feedback"];
          const [counts, idxInfo, idxSize] = await Promise.all([
            env.DB.batch(TABLES.map((t) => env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`))),
            getIndexManifest(env),
            loadIndex(env)
              .then((idx) => ({ dim: idx.dim, count: idx.count }))
              .catch(() => null),
          ]);
          const tables: Record<string, number> = {};
          counts.forEach((r: any, i: number) => {
            tables[TABLES[i]] = r.results?.[0]?.c ?? 0;
          });
          return json(
            {
              now: new Date().toISOString(),
              index: {
                ok: idxSize !== null,
                provider: idxInfo.provider,
                model: idxInfo.model,
                dim: idxSize?.dim ?? null,
                count: idxSize?.count ?? null,
                builtAt: idxInfo.builtAt ?? null,
                base_url: env.INDEX_BASE_URL ?? "",
              },
              r2_norms: !!env.NORMS,
              tables,
              billing: { plans: PLANS, packs: PACKS },
            },
            200,
            cors
          );
        }
        // POST /api/admin/freeze {uid, reason?} — заморозка: баланс в 0 + запись в ledger (без новых таблиц)
        if (url.pathname === "/api/admin/freeze" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const uid = String(body.uid ?? "").slice(0, 64);
          const reason = String(body.reason ?? "").slice(0, 200);
          if (!uid) return json({ error: "uid required" }, 400, cors);
          const subject = `user:${uid}`;
          const bal = await env.DB.prepare("SELECT credits FROM balances WHERE subject=?").bind(subject).first<{ credits: number }>();
          const take = bal?.credits ?? 0;
          const now = new Date().toISOString();
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO balances (subject, credits, updated_at) VALUES (?, 0, ?) ON CONFLICT(subject) DO UPDATE SET credits=0, updated_at=excluded.updated_at"
            ).bind(subject, now),
            env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, 'grant', ?, ?)").bind(
              subject,
              -take,
              JSON.stringify({ freeze: true, by: admin.email, reason }),
              now
            ),
          ]);
          return json({ ok: true, frozen: take }, 200, cors);
        }

        return json({ error: "not found" }, 404, cors);
      }

      return json({ error: "not found" }, 404, cors);
    } catch (e: any) {
      return json({ error: e?.message ?? "internal" }, 500, cors);
    }
  },
};
