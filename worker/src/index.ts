/**
 * SNIP Worker — auth, токены, /ask → Groq, /embed → Gemini.
 * Без зависимостей: WebCrypto (PBKDF2 + JWT HS256), D1, fetch.
 */

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  GROQ_API_KEY: string;
  GEMINI_API_KEY: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_TEXT_MODEL?: string;
  GEMINI_ALT_MODEL?: string;
  // Почта (восстановление пароля): каскад Brevo → SendGrid, письма от верифицированного отправителя
  BREVO_API_KEY?: string;
  SENDGRID_API_KEY?: string;
  MAIL_FROM?: string; // дефолт postalarchive@gmail.com — тот, что верифицирован у провайдера
  MAIL_FROM_NAME?: string; // дефолт snippy.llm
  // Telegram-бот: доставка кода сброса пароля (webhook-схема, без polling)
  TG_BOT_TOKEN?: string;
  TG_BOT_USERNAME?: string; // для глубокой ссылки t.me/<username>?start=<token>
  TG_WEBHOOK_SECRET?: string; // секретный сегмент пути вебхука
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
  EVAL_TOKEN?: string; // секрет для /api/eval/* (офлайн-замеры; без него эндпоинты 404)
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

// ---------- Удаление аккаунтов: архив 30 дней ----------
export const ARCHIVE_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Причины удаления с шаблонами писем; {имя} подставляется в момент удаления. */
export const DELETION_REASONS: Array<{ id: string; title: string; template: string }> = [
  {
    id: "violation",
    title: "Нарушение правил использования",
    template:
      "Ваш аккаунт удалён за нарушение правил использования сервиса (автоматизированные запросы, обход лимитов или иной злоупотребительный сценарий). " +
      "Данные аккаунта хранятся в архиве 30 дней, после чего будут удалены безвозвратно.",
  },
  {
    id: "multiaccount",
    title: "Мультиаккаунт",
    template:
      "Обнаружено несколько аккаунтов, созданных для обхода лимитов сервиса. Этот аккаунт удалён; " +
      "данные хранятся в архиве 30 дней, после чего будут удалены безвозвратно.",
  },
  {
    id: "on_request",
    title: "Удаление по запросу владельца",
    template:
      "По вашей просьбе аккаунт удалён. Данные хранятся в архиве 30 дней: если передумаете, {имя}, напишите нам — администратор восстановит аккаунт. " +
      "После этого срока данные будут удалены безвозвратно.",
  },
  {
    id: "other",
    title: "Другое",
    template: "Ваш аккаунт удалён администратором. Подробности — ниже.",
  },
];

/** Свои причины админа: JSON [{id,title}] в settings (del_tpl_custom). */
async function getCustomReasons(env: Env): Promise<Array<{ id: string; title: string }>> {
  try {
    const raw = (await getSettings(env)).values["del_tpl_custom"];
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r: any) => r && typeof r.id === "string" && typeof r.title === "string")
      .slice(0, 10)
      .map((r: any) => ({ id: String(r.id).slice(0, 24), title: String(r.title).slice(0, 100) }));
  } catch {
    return [];
  }
}

/** Эффективные причины: встроенные (с шаблонами из settings) + свои. */
async function effectiveReasons(env: Env): Promise<Array<{ id: string; title: string; template: string; custom: boolean; default_template: string | null }>> {
  const { values } = await getSettings(env);
  const built = DELETION_REASONS.map((r) => ({
    ...r,
    template: values[`del_tpl_${r.id}`]?.trim() || r.template,
    default_template: r.template,
    custom: false,
  }));
  const custom = (await getCustomReasons(env)).map((r) => ({
    id: r.id,
    title: r.title,
    template: values[`del_tpl_${r.id}`]?.trim() || "",
    default_template: null,
    custom: true,
  }));
  return [...built, ...custom];
}

/** Шаблон причины → финальный текст письма: обращение + подстановка {имя} в любом месте текста. */
export function buildDeletionText(name: string | null, template: string): string {
  const who = String(name ?? "").trim() || "пользователь";
  return `Уважаемый ${who}! ${String(template ?? "").trim().replaceAll("{имя}", who)}`;
}

// ---------- Почта: каскад Brevo → SendGrid (восстановление пароля) ----------

export function makeResetCode(): string {
  // 6 цифр: знакомый формат, перепечатывается с телефона; перебор закрыт лимитом попыток
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
}

/** Отправка письма каскадом Brevo → SendGrid. Возвращает имя удавшегося провайдера. */
export async function sendMail(env: Env, to: string, subject: string, text: string): Promise<string> {
  const from = env.MAIL_FROM ?? "postalarchive@gmail.com";
  const fromName = env.MAIL_FROM_NAME ?? "snippy.llm";
  const errors: string[] = [];
  if (env.BREVO_API_KEY) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": env.BREVO_API_KEY, Accept: "application/json" },
        body: JSON.stringify({
          sender: { email: from, name: fromName },
          to: [{ email: to }],
          subject,
          textContent: text,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return "brevo";
      errors.push(`brevo ${r.status}`);
    } catch (e: any) {
      errors.push(`brevo ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  if (env.SENDGRID_API_KEY) {
    try {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SENDGRID_API_KEY}` },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from, name: fromName },
          subject,
          content: [{ type: "text/plain", value: text }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) return "sendgrid";
      errors.push(`sendgrid ${r.status}`);
    } catch (e: any) {
      errors.push(`sendgrid ${String(e?.message ?? e).slice(0, 60)}`);
    }
  }
  if (!env.BREVO_API_KEY && !env.SENDGRID_API_KEY)
    throw Object.assign(new Error("mailer_not_configured"), { status: 503 });
  throw Object.assign(new Error(`mailer failed: ${errors.join(", ")}`), { status: 502 });
}

// ---------- Telegram: привязка аккаунта через глубокую ссылку ----------

/** tg_chat_id/tg_username у users — ленивая миграция (игнорирует duplicate column). */
async function ensureUserTgColumns(env: Env): Promise<void> {
  for (const sql of [
    "ALTER TABLE users ADD COLUMN tg_chat_id TEXT",
    "ALTER TABLE users ADD COLUMN tg_username TEXT",
  ]) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      /* колонка уже есть — ок */
    }
  }
}

async function ensureTgLinkTokens(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS tg_link_tokens (token TEXT PRIMARY KEY, uid TEXT NOT NULL, created_at TEXT NOT NULL)"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

/** Просроченные токены привязки (15 мин) чистятся при касании. */
export async function purgeExpiredTgTokens(env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM tg_link_tokens WHERE created_at < ?")
      .bind(new Date(Date.now() - 15 * 60_000).toISOString())
      .run();
  } catch {
    /* таблицы может не быть — ок */
  }
}

/** Сообщение в Telegram. Бросает, если бот не настроен или Telegram отказал. */
export async function tgSendMessage(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TG_BOT_TOKEN) throw Object.assign(new Error("tg_not_configured"), { status: 503 });
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw Object.assign(new Error(`tg send ${r.status}`), { status: 502 });
}

async function ensureResetTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS password_resets (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT)"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

/** Просроченные/использованные заявки чистятся при касании (без крона). */
export async function purgeExpiredResets(env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL")
      .bind(new Date().toISOString())
      .run();
  } catch {
    /* таблицы может не быть — ок */
  }
}

const CORS_HEADERS = (env: Env, origin: string | null): Record<string, string> => {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  // «https://*.pages.dev» — звёздочка в начале хоста: матчим через regex,
  // а не endsWith("*") (паттерн кончается на «v», старый путь никогда не срабатывал).
  const ok =
    origin &&
    (allowed.includes(origin) ||
      allowed.some((a) => {
        if (!a.includes("*")) return false;
        if (a.endsWith("*")) return origin.startsWith(a.slice(0, -1));
        const re = new RegExp(
          "^" + a.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+") + "$"
        );
        return re.test(origin);
      }));
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

export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  return bufToHex(salt) + "$" + bufToHex(new Uint8Array(bits));
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
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

export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSec = 60 * 60 * 24 * 7): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const r = await verifyJwtWithReason(token, secret);
  return r.payload;
}

/** Проверка JWT с причиной отказа — чтобы фронт различал expired vs invalid и не ронял сессию зря. */
export async function verifyJwtWithReason(
  token: string,
  secret: string
): Promise<{ payload: Record<string, unknown> | null; reason: "expired" | "invalid" | null }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { payload: null, reason: "invalid" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = b64urlDecode(parts[2]);
  const sigBuf = new Uint8Array(sig.length).map((_, i) => sig.charCodeAt(i));
  const ok = await crypto.subtle.verify("HMAC", key, sigBuf, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { payload: null, reason: "invalid" };
  const payload = JSON.parse(b64urlDecode(parts[1]));
  if (payload.exp < Date.now() / 1000) return { payload: null, reason: "expired" };
  return { payload, reason: null };
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
  // При неудаче кэш сбрасывается: следующий вызов ретраит, а не ломает изолят до рестарта.
  if (!indexCache) {
    const p = (async (): Promise<CachedIndex> => {
      const base = env.INDEX_BASE_URL.replace(/\/$/, "");
      // cache: no-store — иначе изолят может годами держать устаревший индекс через CDN
      const manifestRes = await fetch(`${base}/manifest.json`, { cache: "no-store" });
      const manifest = manifestRes.ok
        ? ((await manifestRes.json()) as CachedIndex)
        : ({} as CachedIndex);
      // Чанки: шарды по manifest.shards.chunks или классический одиночный chunks.json
      const nChunkShards = manifest.shards?.chunks ?? 0;
      const nVecShards = manifest.shards?.vectors ?? 0;
      const [chunks, ...binBufs] = await Promise.all([
        (async () => {
          if (nChunkShards === 0) {
            const r = await fetch(`${base}/chunks.json`, { cache: "no-store" });
            if (!r.ok) throw new Error(`chunks.json → HTTP ${r.status}`);
            return r.json() as Promise<CachedIndex["chunks"]>;
          }
          const parts = await Promise.all(
            Array.from({ length: nChunkShards }, (_, k) =>
              fetch(`${base}/chunks_${k}.json`, { cache: "no-store" }).then((r) => {
                if (!r.ok) throw new Error(`chunks_${k}.json → HTTP ${r.status}`);
                return r.json() as Promise<CachedIndex["chunks"]>;
              })
            )
          );
          return ([] as CachedIndex["chunks"]).concat(...parts);
        })(),
        ...Array.from({ length: Math.max(1, nVecShards) }, (_, k) =>
          fetch(nVecShards === 0 ? `${base}/vectors.bin` : `${base}/vectors_${k}.bin`, { cache: "no-store" }).then(
            (r) => {
              if (!r.ok) throw new Error(`vectors_${k}.bin → HTTP ${r.status}`);
              return r.arrayBuffer();
            }
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
      if (manifest.dim && dim !== manifest.dim) throw new Error(`dim векторов ${dim} ≠ манифесту ${manifest.dim}`);
      if (totalCount !== chunks.length) throw new Error("vectors не совпадает с chunks");
      return { dim, count: totalCount, scales, int8, chunks };
    })();
    indexCache = p.catch((e) => {
      indexCache = null;
      throw e;
    });
  }
  return indexCache;
}

// ---------- Карточки значений (values.json, офлайн-экстракт; ответы 0⚡ без LLM) ----------

interface ValueFact {
  i: number; d: number; p: string; pg: number | null;
  k: string; op: ">=" | "<=" | ">" | "<" | "=" | "range";
  v: number | null; hi?: number; u: string; raw: string; s: string;
  cls?: string; scope?: string; nolimit?: boolean;
}
interface ValueDoc { id: string; number: string; title: string; status: string }

let valuesCache: { facts: ValueFact[]; docs: ValueDoc[]; at: number } | null = null;
const VALUES_TTL_MS = 3600_000;

async function loadValues(env: Env): Promise<{ facts: ValueFact[]; docs: ValueDoc[] } | null> {
  const now = Date.now();
  if (valuesCache && now - valuesCache.at < VALUES_TTL_MS) return valuesCache;
  try {
    const base = env.INDEX_BASE_URL.replace(/\/$/, "");
    const [vr, dr] = await Promise.all([
      fetch(`${base}/values.json`, { cache: "no-store" }),
      fetch(`${base}/docs.json`, { cache: "no-store" }),
    ]);
    if (!vr.ok) return null;
    const vj: any = await vr.json();
    const facts: ValueFact[] = Array.isArray(vj?.facts) ? vj.facts : [];
    let docs: ValueDoc[] = [];
    try { docs = dr.ok ? (await dr.json() as ValueDoc[]) : []; } catch { docs = []; }
    if (!facts.length) return null;
    valuesCache = { facts, docs, at: now };
    return valuesCache;
  } catch {
    return null;
  }
}

const V_INTERROGATIVE = new Set(
  ("какая какой какое какие каков какова каково каковы какому какую каких сколько " +
   "минимальная минимальный минимальное минимальных минимально минимум " +
   "максимальная максимальный максимальное максимальных максимально максимум " +
   "наименьшая наименьший наименьшее наибольшая наибольший наибольшее " +
   "допустимая допустимый допустимое допустимо допускается " +
   "норма нормы норматив требования требование должен должна должно должны положено " +
   "равен равна равно").split(" ")
);

/** Минимальный русский стеммер: один суффикс (как в build_index.py). */
const V_SUFFIXES = ["ование", "ование", "ение", "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими",
  "ых", "их",
  "ая", "ое", "ые", "ий", "ый", "ой", "ей", "ом", "ем", "ах", "ях", "ую", "юю",
  "ее", "ии", "ия", "ие", "ов", "ев", "ь", "а", "я", "о", "е", "у", "ю", "ы", "и", "й"];
function vStem(w: string): string {
  if (/^\d+$/.test(w) || w.length < 3) return w;
  for (const suf of V_SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}
function vNormWords(q: string): string[] {
  return q.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
}
function vFuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true;
  return false;
}
function vToksFuzzyHit(queryToks: Set<string>, factToks: Set<string>): boolean {
  for (const ft of factToks) for (const qt of queryToks) if (vFuzzyEqual(qt, ft)) return true;
  return false;
}
function vPrefixHit(words: string[], stems: Set<string>): boolean {
  for (const w of words) {
    if (w.length < 4) continue;
    for (const st of stems) {
      if (st.length >= 3 && vFuzzyEqual(w, st)) return true;
      if (st.length >= 3 && w.length >= 4) {
        const sw = w.slice(0, Math.min(w.length, 7));
        if (st.startsWith(sw) || sw.startsWith(st)) return true;
      }
    }
  }
  return false;
}

/** Алиасы типов зданий: стем слова вопроса → стемы в названиях документов. */
const V_DOCTYPE_ALIASES: Record<string, string[]> = {
  жил: ["жил", "многоквартирн", "социальн"],
  квартир: ["квартир", "жил", "многоквартирн"],
  многоквартирн: ["многоквартирн", "жил"],
  социальн: ["социальн", "жил"],
  школ: ["общеобразовательн", "школьн"],
  больниц: ["лечебн", "медицинск", "больничн", "поликлиник", "стационар"],
  детск: ["дошкольн"],
  дошкольн: ["дошкольн"],
  сад: ["дошкольн", "детск"],
  детсад: ["дошкольн"],
  ясли: ["дошкольн"],
  дошкольных: ["дошкольн"],
  детских: ["дошкольн", "детск"],
  торгов: ["торгов", "розничн", "магазин"],
  магазин: ["торгов", "розничн"],
  офис: ["административн", "офис"],
  гостиниц: ["гостиниц"],
  бан: ["банн"],
  бассейн: ["бассейн", "плавательн"],
  спортивн: ["спортивн", "физкультурн"],
  театр: ["зрелищн", "культурн"],
  кино: ["зрелищн", "культурн"],
  кафе: ["питан", "обществен"],
  ресторан: ["питан"],
  стоян: ["стоян", "парков"],
  паркин: ["стоян", "парков"],
};

function vExtractNums(query: string): number[] {
  const out: number[] = [];
  const re = /[+-]?\d+(?:[.,]\d+)?/g;
  const s = query.toLowerCase().replace(/ё/g, "е");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const v = Number(m[0].replace(",", "."));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function vInferUnits(qNorm: string): Set<string> {
  const u = new Set<string>();
  if (/(этаж|этажност)/.test(qNorm)) u.add("эт");
  if (/(площад|м2|м²|кв\.?\s*м)/.test(qNorm)) u.add("м²");
  if (/(высот|ширин|длин|глубин|толщин|расстоян)/.test(qNorm)) u.add("м");
  if (/(детей|дети|человек|людей|чел)/.test(qNorm)) u.add("чел");
  if (/(мм)/.test(qNorm)) u.add("мм");
  return u;
}

function vNumScore(f: ValueFact, qNums: number[], qUnits: Set<string>): number {
  if (!qNums.length || f.v === null || f.v === undefined) return 0;
  if (qUnits.size > 0 && !qUnits.has(f.u)) return 0;
  const q = qNums[0];
  const v = f.v;
  const hi = f.hi ?? v;
  switch (f.op) {
    case "range":
      if (q >= v && q <= hi) return 4 + 2 / (1 + (hi - v));
      return Math.max(-3, -Math.min(Math.abs(q - v), Math.abs(q - hi)) / 2);
    case "<=":
      if (q <= v) return 2 + 1 / (1 + (v - q));
      return -2;
    case ">=":
      if (q >= v) return 2 + 1 / (1 + (q - v));
      return -2;
    case "=":
      if (Math.abs(q - v) < 1e-9) return 4;
      return Math.max(-3, -Math.abs(q - v) / 2);
    case ">":
      if (q > v) return 2 + 1 / (1 + (q - v));
      return -2;
    case "<":
      if (q < v) return 2 + 1 / (1 + (v - q));
      return -2;
    default:
      return 0;
  }
}

const V_SUBJECT_ALIASES: Record<string, string[]> = {
  "потолок": ["потолк", "потолоч", "перекрыт"],
  "квартира": ["квартир", "внутриквартирн"],
  "помещение": ["помещен", "комнат", "квартир"],
  "этаж": ["этаж", "этажн"],
  "коридор": ["коридор", "холл"],
  "мгн": ["маломобильн", "инвалид", "коляс", "кресл", "посетител"],
  "проход": ["проход", "коридор", "проезд"],
  "путь эвакуации": ["эвакуацион"],
  "эвакуационный выход": ["эвакуацион"],
};

/**
 * Permission-вопрос («можно ли», «разрешено ли», ...) vs фактоид
 * («минимальная ширина...?», «сколько...?», «какая...?»).
 * Да/Нет-вердикт и hero-акцент на Да/Нет разрешены ТОЛЬКО для permission.
 */
export function isPermissionQuestion(query: string): boolean {
  const qN = String(query ?? "").toLowerCase().replace(/ё/g, "е");
  if (!qN.trim()) return false;
  return /(разреш|можно|допуск|запрещ|открыть|разместить|предусматр|вправе|нельзя|запрет)/.test(qN);
}

/**
 * Срезает ложный префикс «Да — ...» / «Нет — ...» с фактоид-ответа.
 * Применяется только когда вопрос НЕ permission, а LLM все равно начал с Да/Нет.
 */
export function stripLeadingYesNo(answerText: string): string {
  const s = String(answerText ?? "");
  const m = s.match(/^\s*(Да|Нет)\s*[—–\-:.,]?\s*/);
  if (!m) return s;
  const rest = s.slice(m[0].length).trim();
  // Не оставляем пустой ответ: если после Да/Нет ничего нет — возвращаем как есть
  return rest ? rest : s;
}

const V_IRRELEVANT = [
  "лифт", "подъем", "подьем", "проезд", "арк", "эвакуац",
  "огражд", "лестнич", "марш", "клетк", "балкон", "лоджи",
  "архив", "гостиниц", "кухн", "сейсм", "торгов", "магазин",
  "школ", "больниц", "спортивн", "бассейн", "театр", "офис",
  "стоян", "парков", "банн", "питан", "ресторан", "кафе",
];

function vEscRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Стем по левой границе слова: «школ» ловит «школы», но не «дошкольные». */
function vStemIn(st: string, text: string): boolean {
  try {
    return new RegExp(`(^|[^а-яa-z0-9])${vEscRe(st)}`).test(text);
  } catch {
    return text.includes(st);
  }
}

function vIrrelevant(qNorm: string, sNorm: string, docText = ""): number {
  let p = 0;
  const hay = `${sNorm} ${docText}`;
  for (const st of V_IRRELEVANT) {
    if (vStemIn(st, hay) && !vStemIn(st, qNorm)) {
      p += 2;
      if (p >= 4) break;
    }
  }
  // Явный тип объекта в запросе, а док чужой → сильный штраф.
  const intent: Array<[string, string[]]> = [];
  for (const qs of Object.keys(V_DOCTYPE_ALIASES)) {
    if (qs.length >= 3 && qNorm.includes(qs)) intent.push([qs, V_DOCTYPE_ALIASES[qs]]);
  }
  if (intent.length > 0) {
    const match = intent.some(([, kws]) => kws.some((kw) => docText.includes(kw)));
    if (!match) p += 3;
  }
  return Math.min(p, 7);
}

function vDocBoost(qNorm: string, docText: string): number {
  const asks = qNorm.includes("детск") || qNorm.includes("сад") || qNorm.includes("дошкольн") || qNorm.includes("одво") || qNorm.includes("ясли");
  if (asks && (docText.includes("дошкольн") || docText.includes("детск") || docText.includes("одво"))) return 2;
  return 0;
}

function vBoost(qNorm: string, sNorm: string): number {
  let b = 0;
  const asksCeiling = qNorm.includes("потол") || qNorm.includes("высот") || qNorm.includes("этаж");
  if (asksCeiling && sNorm.includes("от пола до")) b += 2;
  if (asksCeiling && (sNorm.includes("низа потол") || sNorm.includes("низ потол"))) b += 1;
  if ((qNorm.includes("жил") || qNorm.includes("квартир")) && (sNorm.includes("жил") || sNorm.includes("квартир") || sNorm.includes("внутриквартирн"))) b += 1;
  const asksK = qNorm.includes("детск") || qNorm.includes("сад") || qNorm.includes("дошкольн") || qNorm.includes("одво") || qNorm.includes("ясли");
  if (asksK && (sNorm.includes("детск") || sNorm.includes("дошкольн") || sNorm.includes("одво") || sNorm.includes("семейн") || sNorm.includes("группов"))) b += 2;
  // МГН-специфика: вопрос про маломобильных — факты про МГН/коляски выше generic «проход 1,2»
  const asksMgn = qNorm.includes("маломобильн") || qNorm.includes("мгн") || qNorm.includes("инвалид") || qNorm.includes("коляс") || qNorm.includes("кресл");
  if (asksMgn && (sNorm.includes("маломобильн") || sNorm.includes("кресл") || sNorm.includes("коляс") || sNorm.includes("инвалид"))) b += 4;
  return b;
}

/** Штраф generic-факту, когда вопрос явно про МГН, а сниппет — общий проход/коридор без МГН-маркера. */
function vMgnPenalty(qNorm: string, sNorm: string, factKey: string): number {
  const asksMgn = qNorm.includes("маломобильн") || qNorm.includes("мгн") || qNorm.includes("инвалид") || qNorm.includes("коляс") || qNorm.includes("кресл");
  if (!asksMgn) return 0;
  const k = String(factKey ?? "").toLowerCase();
  if (k.includes("мгн")) return 0;
  if (sNorm.includes("маломобильн") || sNorm.includes("кресл") || sNorm.includes("коляс") || sNorm.includes("инвалид")) return 0;
  return 3;
}

const V_DEIXIS_RE = /(перед ними|для них|в них|в этих|в указанных|этих помещен)/;

/**
 * Частный случай (scope/cls) или дейксис в сниппете, не упомянутый в запросе, —
 * мягкий штраф: общая норма должна выигрывать у «для семей с инвалидами»,
 * «при освещении…», «коридоров перед ними» (герой честнее, values-ответ чаще без LLM).
 */
function vScopePenalty(qNorm: string, f: ValueFact): number {
  let p = 0;
  const scope = String((f as any).scope || (f as any).cls || "").toLowerCase().replace(/ё/g, "е").trim();
  if (scope) {
    const keyToks = new Set(String(f.k || "").toLowerCase().split(/[^a-zа-я0-9]+/).filter(Boolean).map(vStem));
    const extra = scope.split(/[^a-zа-я0-9]+/).filter((w) => w.length >= 4).map(vStem).filter((w) => !keyToks.has(w));
    if (extra.length && !extra.some((w) => qNorm.includes(w.slice(0, Math.max(4, w.length - 2))))) p += 1;
  }
  const s = String(f.s || "").toLowerCase().replace(/ё/g, "е");
  if (V_DEIXIS_RE.test(s) && !V_DEIXIS_RE.test(qNorm)) p += 1;
  return p;
}

export interface ValueCardHit {
  fact: ValueFact;
  docNumber: string;
  docTitle: string;
}

/** Подбор карточек под фактоид-запрос (зеркало frontend/src/search/values.ts, 0⚡). */
export function findValueCardsLocal(query: string, facts: ValueFact[], docs: ValueDoc[], limit = 6): ValueCardHit[] {
  const scored = findValueCardsScored(query, facts, docs, limit);
  return scored.map((s) => s.hit);
}

/** Скоринг с метаданными для строгого гейта tryValuesAnswer (docHit/paramOrig/num/rel). */
export function findValueCardsScored(query: string, facts: ValueFact[], docs: ValueDoc[], limit = 6): Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }> {
  const words = vNormWords(query);
  if (!words.length) return [];
  const interrogative = words.some((w) => V_INTERROGATIVE.has(w));
  const qtoks = new Set(words.map(vStem));
  const qstr = words.join(" ");
  const qNorm = qstr.toLowerCase().replace(/ё/g, "е");
  const minHint = /(миним|наименьш|наименьш|не менее|минимум)/.test(qNorm);
  const maxHint = /(максим|наибольш|наименьш|не более|максимум)/.test(qNorm) && !minHint;
  const ordMap: Record<string, number> = maxHint
    ? { "<=": 0, ">=": 1, range: 2, "<": 3, ">": 4, "=": 5 }
    : { ">=": 0, "<=": 1, range: 2, ">": 3, "<": 4, "=": 5 };
  const qNums = vExtractNums(query);
  const qUnits = vInferUnits(qNorm);
  const scored: Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }> = [];
  for (const f of facts) {
    const [param = "", subj = ""] = String(f.k || "").split(":");
    const paramToks = new Set(param.split(" ").map(vStem));
    const subjToks = new Set(subj ? subj.split(" ").map(vStem) : []);
    let paramHit = false;
    for (const t of paramToks) if (qtoks.has(t)) { paramHit = true; break; }
    if (!paramHit && vToksFuzzyHit(qtoks, paramToks)) paramHit = true;
    if (!paramHit && vPrefixHit(words, paramToks)) paramHit = true;
    if (!paramHit) continue;
    let subjHit = false;
    let subjStrong = false;
    if (subjToks.size) {
      for (const t of subjToks) if (qtoks.has(t)) { subjHit = true; subjStrong = true; break; }
      if (!subjHit && vToksFuzzyHit(qtoks, subjToks)) { subjHit = true; subjStrong = true; }
      if (!subjHit && vPrefixHit(words, subjToks)) { subjHit = true; subjStrong = true; }
      if (!subjHit) {
        // case-insensitive: ключ «МГН» vs «мгн»
        const al = V_SUBJECT_ALIASES[subj.toLowerCase()] ?? V_SUBJECT_ALIASES[subj] ?? [];
        if (al.some((a) => qstr.includes(a))) { subjHit = true; subjStrong = true; }
      }
      // обратное направление: запрос «МГН», а субъект факта — «проход/коридор» с МГН-сниппетом
      if (!subjHit) {
        const asksMgn = qNorm.includes("мгн") || qNorm.includes("маломобильн") || qNorm.includes("инвалид") || qNorm.includes("коляс") || qNorm.includes("кресл");
        if (asksMgn) {
          const sLow = String(f.s || "").toLowerCase();
          if (sLow.includes("маломобильн") || sLow.includes("кресл") || sLow.includes("коляс") || sLow.includes("инвалид")) {
            subjHit = true; subjStrong = true;
          }
        }
      }
    }
    if (!subjHit && !interrogative) continue;
    if (!subjToks.size && !interrogative) continue;
    const doc = docs[f.d];
    // Буст по типу здания: стемы слов вопроса в названии документа
    // («…в квартире» → жилые многоквартирные первыми) + алиасы синонимов.
    // includes + fuzzy по токенам дока: «дошкольных» ловит «дошкольные».
    const docText = `${doc?.number ?? ""} ${doc?.title ?? ""}`.toLowerCase().replace(/ё/g, "е");
    const docToks = new Set(docText.split(/[^a-zа-я0-9]+/).filter(Boolean).map(vStem));
    const docHit = [...qtoks].some((st) => {
      if (st.length < 3) return false;
      if (docText.includes(st)) return true;
      const al = V_DOCTYPE_ALIASES[st];
      if (al && al.some((a) => docText.includes(a))) return true;
      for (const dt of docToks) if (vFuzzyEqual(st, dt)) return true;
      return false;
    });
    const sNorm = String(f.s || "").toLowerCase().replace(/ё/g, "е");
    let overlap = 0;
    for (const t of qtoks) {
      if (t.length >= 3 && sNorm.includes(t)) {
        overlap++;
        if (overlap >= 5) break;
      }
    }
    const boost = vBoost(qNorm, sNorm) + vDocBoost(qNorm, docText);
    const penalty = vIrrelevant(qNorm, sNorm, docText) + vMgnPenalty(qNorm, sNorm, String(f.k || "")) + vScopePenalty(qNorm, f);
    const num = vNumScore(f, qNums, qUnits);
    const rel = (subjHit ? (subjStrong ? 3 : 1) : 0) + (paramHit ? 1 : 0) + (docHit ? 2 : 0) + overlap + boost + num - penalty;
    scored.push({ hit: { fact: f, docNumber: doc?.number ?? "", docTitle: doc?.title ?? "" }, rel, ord: ordMap[f.op] ?? 9, docHit, paramOrig: paramHit, num });
  }
  scored.sort((a, b) => b.rel - a.rel || a.ord - b.ord || a.hit.fact.i - b.hit.fact.i);
  const seen = new Set<string>();
  const out: Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }> = [];
  for (const s of scored) {
    const key = `${s.hit.fact.k}|${s.hit.fact.op}|${s.hit.fact.v}|${s.hit.fact.u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function formatValueRu(f: ValueFact): string {
  const num = (v: number | null) => (v === null || v === undefined ? "" : String(v).replace(".", ","));
  if (f.op === "range") return `${num(f.v)}–${num(f.hi ?? null)} ${f.u}`.trim();
  if (f.v === null) return f.raw;
  // "=" — явно ровно: «= 2,7 м» отличается от границы «≥ 2,5 м» (раньше было голое «2,7 м»)
  const sym = f.op === ">=" ? "≥ " : f.op === "<=" ? "≤ " : f.op === ">" ? "> " : f.op === "<" ? "< " : f.op === "=" ? "= " : "";
  return `${sym}${num(f.v)} ${f.u}`.trim();
}
function formatLabelRu(k: string): string {
  const [param = "", subj = ""] = String(k || "").split(":");
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  return subj ? `${cap(param)} · ${subj}` : cap(param);
}

/** Число из факта дословно есть в сниппете (с учётом десятичной запятой и минуса)? */
function valueGrounded(f: ValueFact): boolean {
  const s = String(f.s || "").toLowerCase().replace(/ё/g, "е").replace(/−/g, "-");
  const comma = (v: number) => String(v).replace(".", ",");
  if (f.op === "range") {
    return typeof f.v === "number" && s.includes(comma(f.v));
  }
  if (f.v === null) return s.includes(f.raw.toLowerCase());
  const tok = f.raw.split(" ")[0] || comma(f.v);
  return s.includes(tok.toLowerCase()) || s.includes(comma(f.v)) || s.includes(String(f.v));
}

/* ---------- Универсальный gate «вердикт vs числа» (детерминированный, 0⚡) ---------- */

const V_CARDINAL_WORDS: Record<string, number> = {
  "один": 1, "одна": 1, "одно": 1, "одного": 1, "одной": 1, "одному": 1, "одним": 1,
  "два": 2, "две": 2, "двух": 2, "двум": 2, "двумя": 2,
  "три": 3, "трех": 3, "трем": 3, "тремя": 3,
  "четыре": 4, "четырех": 4,
  "пять": 5, "пяти": 5, "пятью": 5,
  "шесть": 6, "шести": 6, "шестью": 6,
  "семь": 7, "семи": 7, "семью": 7,
  "восемь": 8, "восьми": 8, "восемью": 8,
  "девять": 9, "девяти": 9, "девятью": 9,
  "десять": 10, "десяти": 10, "десятью": 10,
  "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
  "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18,
  "девятнадцать": 19, "двадцать": 20,
};

const V_ORDINAL_STEMS: Record<string, number> = {
  "перв": 1, "втор": 2, "трет": 3, "четверт": 4, "пят": 5,
  "шест": 6, "седьм": 7, "восьм": 8, "девят": 9, "десят": 10,
  "одиннадцат": 11, "двенадцат": 12, "тринадцат": 13,
  "четырнадцат": 14, "пятнадцат": 15, "шестнадцат": 16,
  "семнадцат": 17, "восемнадцат": 18, "девятнадцат": 19,
  "двадцат": 20,
};

/** Все числа запроса: цифры + числительные словами («на 7 этаже», «на седьмом этаже»). */
export function vQueryNumbersFull(query: string): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  const push = (v: number) => {
    const k = `n${v}`;
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  };
  const s = String(query ?? "").toLowerCase().replace(/ё/g, "е");
  const re = /[+-]?\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const v = Number(m[0].replace(",", "."));
    if (Number.isFinite(v)) push(v);
  }
  for (const raw of s.match(/[а-яa-z0-9]+/g) ?? []) {
    const c = V_CARDINAL_WORDS[raw];
    if (c !== undefined) { push(c); continue; }
    const o = V_ORDINAL_STEMS[vStem(raw)];
    if (o !== undefined) push(o);
  }
  return out;
}

interface VTextLimit { op: "<=" | ">=" | ">" | "<"; v: number; u: string; span: string }

/** Лимиты вида «не выше пятого этажа / не более 9 м / до 5 детей» из текста.
 * Единицы — любые (эт/м/м²/мм/см/чел); «средневзвешенная этажность застройки»
 * лимитом размещения НЕ является — такие окна пропускаем. */
const V_LIMIT_RE =
  /(не выше|не более|не больше|не превыша[а-я]*|не должн[а-я]*\s+превыша[а-я]*|не ниже|не менее|не меньше|более|больше|свыше|выше|менее|меньше|ниже|минимум|максимум|до|от)\s+(\d+(?:[.,]\d+)?|[а-я]+)\s*(эт\.|этаж[а-я]*|м²|м2|кв\.?\s*м(?:²|2)?|миллиметр[а-я]*|мм|сантиметр[а-я]*|см|метр[а-я]*|(?<![а-яa-z0-9])м(?![а-яa-z0-9²2])|дет[а-я]*|детей|ребен[а-я]*|человек[а-я]*|люд[а-я]*)/gi;

export function vLimitOp(w: string): VTextLimit["op"] | "" {
  // m[1] — ровно одна ветка альтернации; якоря обязательны («не менее» содержит «менее»).
  const t = w.toLowerCase().trim();
  if (/^(не ниже|не менее|не меньше|минимум|от)$/.test(t)) return ">=";
  if (/^(не выше|не более|не больше|максимум|до|ниже|менее|меньше)$/.test(t)) return "<=";
  if (/превыша/.test(t)) return "<=";
  if (/^(более|больше|свыше|выше)$/.test(t)) return ">";
  return "";
}

export function vLimitUnit(w: string): string {
  const t = w.toLowerCase().replace(/\s+/g, "");
  if (/^эт/.test(t)) return "эт";
  if (/м²|м2|^кв/.test(t)) return "м²";
  if (/^мм|^миллиметр/.test(t)) return "мм";
  if (/^см|^сантиметр/.test(t)) return "см";
  if (/^метр|^м$/.test(t)) return "м";
  if (/^дет|^ребен|^человек|^люд/.test(t)) return "чел";
  return "";
}

export function vWordNum(w: string): number | undefined {
  const c = V_CARDINAL_WORDS[w];
  if (c !== undefined) return c;
  return V_ORDINAL_STEMS[vStem(w)];
}

export function vFindLimits(text: string): VTextLimit[] {
  const out: VTextLimit[] = [];
  const s = String(text ?? "").toLowerCase().replace(/ё/g, "е");
  V_LIMIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const UNIT = String.raw`(?:эт\.|этаж[а-я]*|м²|м2|кв\.?\s*м(?:²|2)?|миллиметр[а-я]*|мм|сантиметр[а-я]*|см|метр[а-я]*|(?<![а-яa-z0-9])м(?![а-яa-z0-9²2])|дет[а-я]*|детей|ребен[а-я]*|человек[а-я]*|люд[а-я]*)`;
  while ((m = V_LIMIT_RE.exec(s)) !== null) {
    const start = m.index;
    // «средневзвешенная этажность застройки 5 и более» — характеристика района, не лимит
    if (/средневзвешен/.test(s.slice(Math.max(0, start - 60), start))) continue;
    const op = vLimitOp(m[1]);
    if (!op) continue;
    const numRaw = m[2];
    const v = /^\d/.test(numRaw) ? Number(numRaw.replace(",", ".")) : vWordNum(numRaw);
    if (v === undefined || !Number.isFinite(v)) continue;
    const u = vLimitUnit(m[3] || "");
    if (!u) continue;
    out.push({ op, v, u, span: m[0].slice(0, 80) });
  }
  // Постфикс: «высотой 10 м и более», «температура не ниже −5 °C» уже покрыта выше;
  // здесь только «число + единица + и более/менее».
  const postRe = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(${UNIT})\s+(и\s+более|и\s+выше|или\s+более|и\s+менее|и\s+ниже|или\s+менее)` , "gi");
  while ((m = postRe.exec(s)) !== null) {
    const more = /более|выше/.test(m[3]);
    const v = Number(m[1].replace(",", "."));
    if (!Number.isFinite(v)) continue;
    const u = vLimitUnit(m[2] || "");
    if (!u) continue;
    out.push({ op: more ? ">=" : "<=", v, u, span: m[0].slice(0, 80) });
  }
  return out;
}

export function vViolates(n: number, op: string, v: number, hi?: number): boolean {
  switch (op) {
    case "<=": return n > v;
    case ">=": return n < v;
    case ">": return n <= v;
    case "<": return n >= v;
    case "=": return Math.abs(n - v) > 1e-9;
    case "range": return hi === undefined ? false : n < v || n > hi;
    default: return false;
  }
}

/** DocHit для текстового чанка: намерение запроса vs название документа (как в скоринге). */
export function vTextDocHit(qN: string, docTitle: string): boolean {
  const dt = `${docTitle ?? ""}`.toLowerCase().replace(/ё/g, "е");
  if (!dt.trim()) return false;
  const toks = new Set(qN.split(/[^a-zа-я0-9]+/).filter(Boolean).map(vStem));
  for (const st of toks) {
    if (st.length < 3) continue;
    if (dt.includes(st)) return true;
    const al = V_DOCTYPE_ALIASES[st];
    if (al && al.some((a) => dt.includes(a))) return true;
  }
  return false;
}

/** Полярность вердикта ответа: да/нет/неизвестно (отказ «не найдено» — мимо gate). */
export function vVerdictPolarity(answerText: string): "yes" | "no" | "unknown" {
  const s = String(answerText ?? "").toLowerCase().replace(/ё/g, "е");
  if (!s || s.includes("не найдено") || s.includes("не удалось") || s.includes("резервный режим")) return "unknown";
  if (/(не разрешено|не разрешается|не допускается|не допуск|запрещено|запрещается|запрет|нельзя|не разрешен|не положено)/.test(s)) return "no";
  // \b с кириллицей не дружит («нет.» — оба не-word) → границы явно
  if (/(^|[^а-яёa-z0-9])нет([^а-яёa-z0-9]|$)/.test(s)) return "no";
  if (/(разрешено|разрешается|допускается|можно|допустимо)/.test(s)) return "yes";
  if (/(^|[^а-яёa-z0-9])да([^а-яёa-z0-9]|$)/.test(s)) return "yes";
  return "unknown";
}

export function vFormatLimit(op: string, v: number, u: string): string {  const num = String(v).replace(".", ",");
  if (u === "эт") {
    if (op === "<=") return `не выше ${num}-го этажа`;
    if (op === "<") return `ниже ${num}-го этажа`;
    if (op === ">=") return `не ниже ${num}-го этажа`;
    if (op === ">") return `выше ${num}-го этажа`;
    return `${num}-й этаж`;
  }
  const un = u === "м²" ? "м²" : u === "мм" ? "мм" : u === "см" ? "см" : u === "чел" ? "чел." : "м";
  if (op === "<=") return `не более ${num} ${un}`;
  if (op === ">=") return `не менее ${num} ${un}`;
  if (op === ">") return `более ${num} ${un}`;
  if (op === "<") return `менее ${num} ${un}`;
  return `${num} ${un}`;
}

interface VGateCite { i: number; d: number; p: string; pg: number | null; quote: string; docNumber: string; docTitle: string }

/**
 * Проверка вердикта LLM против чисел. Возвращает override-патч ответа
 * или null (вердикт consistent / gate неприменим). Только для permission-
 * вопросов («разрешено ли», «можно ли») — фактоиды идут мимо.
 */
export function vNumericGate(args: {
  query: string; answerText: string;
  scored: Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }>;
  promptContexts: string[]; rawContexts: string[]; ids: number[];
  chunks: Array<{ d: number; p: string; pg: number; t: string }>;
  docs: ValueDoc[];
}): { answer: string; cite: VGateCite } | null {
  const { query, answerText } = args;
  const qN = query.toLowerCase().replace(/ё/g, "е");
  if (!isPermissionQuestion(query)) return null;
  // Запрос сам с компаративом («выше 9», «до 5») — N не точка, арифметика gate
  // неприменима: оставляем LLM (промпт-правило 8 его страхует).
  // NB: \b для кириллицы мёртв → границы слов явно.
  if (/(выше|ниже|более|менее|больше|меньше|свыше|не менее|не более|(^|[^а-яёa-z0-9])(до|от)([^а-яёa-z0-9]|$))/.test(qN)) return null;
  const polarity = vVerdictPolarity(answerText);
  if (polarity === "unknown") return null;
  const qNums = vQueryNumbersFull(query);
  if (!qNums.length) return null;
  const qUnits = vInferUnits(qN);

  // Кандидаты-лимиты: (а) values-факты с совпадающей единицей, (б) лимиты из текстов.
  const cands: Array<{ op: string; v: number; hi?: number; u: string; docHit: boolean; rel: number; cite: VGateCite }> = [];
  for (const s of args.scored) {
    const f = s.hit.fact;
    if (f.v === null || f.v === undefined) continue;
    if (f.nolimit) continue; // процедура замера — не требование, вердикт не строим
    if (qUnits.size > 0 && !qUnits.has(f.u)) continue;
    if (f.op !== "<=" && f.op !== ">=" && f.op !== ">" && f.op !== "<" && f.op !== "=") continue;
    cands.push({
      op: f.op, v: f.v, hi: f.hi, u: f.u, docHit: s.docHit, rel: s.rel,
      cite: {
        i: f.i, d: f.d, p: f.p || "", pg: f.pg ?? null, quote: f.s || "",
        docNumber: s.hit.docNumber || "", docTitle: s.hit.docTitle || "",
      },
    });
  }
  args.promptContexts.forEach((ctx, k) => {
    for (const lim of vFindLimits(ctx)) {
      if (qUnits.size > 0 && !qUnits.has(lim.u)) continue;
      const ch = args.chunks[args.ids[k]];
      if (!ch) continue;
      const doc = args.docs[ch.d];
      const raw = args.rawContexts[k] || "";
      const low = raw.toLowerCase().replace(/ё/g, "е");
      let quote = raw.slice(0, 300);
      const at = low.indexOf(lim.span.slice(0, 20).toLowerCase());
      if (at >= 0) {
        const s0 = Math.max(0, raw.lastIndexOf(".", at - 1) + 1);
        let s1 = raw.indexOf(".", at + lim.span.length);
        s1 = s1 < 0 ? raw.length : Math.min(raw.length, s1 + 1);
        quote = raw.slice(s0, s1).trim().slice(0, 400) || quote;
      }
      cands.push({
        op: lim.op, v: lim.v, u: lim.u,
        docHit: vTextDocHit(qN, doc?.title ?? ""),
        rel: 0,
        cite: { i: args.ids[k], d: ch.d, p: ch.p || "", pg: ch.pg ?? null, quote, docNumber: doc?.number ?? "", docTitle: doc?.title ?? "" },
      });
    }
  });
  if (!cands.length) return null;

  const candViolated = (c: (typeof cands)[number], n: number): boolean => {
    if (c.op === "=") return vViolates(n, c.op, c.v);
    return vViolates(n, c.op, c.v, c.hi);
  };

  if (polarity === "yes") {
    // «Да» при нарушенном лимите СВОЕГО типа документа → override «Нет».
    // Чужие доки (зальные >5 при вопросе про сад) не ветируют: только docHit.
    let bad: typeof cands = [];
    for (const n of qNums) {
      for (const c of cands) {
        if (c.op === "=" || !c.docHit) continue;
        if (candViolated(c, n)) bad.push(c);
      }
      if (bad.length) break;
    }
    if (!bad.length) return null;
    bad.sort((a, b) => b.rel - a.rel);
    const win = bad[0];
    const lim = vFormatLimit(win.op, win.v, win.u);
    return {
      answer: `⟦ИТОГ⟧Нет — не разрешено: по норме ${lim} (${win.cite.docNumber || "нормативный документ"}${win.cite.p ? `, п. ${win.cite.p}` : ""}).⟦/ИТОГ⟧`,
      cite: win.cite,
    };
  }
  // polarity === "no": override «Да» — только если есть выполненный лимит своего
  // дока И нет нарушенного лимита своего дока. Чужие лимиты игнорируем.
  const own = cands.filter((c) => c.docHit && c.op !== "=");
  if (!own.some((c) => qNums.some((n) => !candViolated(c, n)))) return null;
  for (const n of qNums) {
    for (const c of own) {
      if (candViolated(c, n)) return null;
    }
  }
  const good = [...own].sort((a, b) => b.rel - a.rel)[0];
  const lim = vFormatLimit(good.op, good.v, good.u);
  return {
    answer: `⟦ИТОГ⟧Да — разрешено: по норме ${lim} (${good.cite.docNumber || "нормативный документ"}${good.cite.p ? `, п. ${good.cite.p}` : ""}).⟦/ИТОГ⟧`,
    cite: good.cite,
  };
}

/**
 * Строка-вердикт для мин/макс-вопросов («Минимальная высота…?» → «Минимум — ≥ 2,5 м»).
 * Универсально, только заземлённые факты; вердикт — по крупнейшей когерентной
 * группе (параметр+субъект+единица), иначе «максимум» склеился бы из забора и балкона.
 * Пустая строка в сомнении (смешанный набор → просто пули, как раньше).
 * Маркер ⟦ИТОГ⟧ — транспорт для hero-блока фронта (strip в cleanAnswerText).
 */
export function minMaxVerdict(query: string, facts: ValueFact[]): { line: string; win: ValueFact | null } {
  const none = { line: "", win: null };
  const qN = String(query ?? "").toLowerCase().replace(/ё/g, "е");
  const minHint = /(миним|наименьш|минимум)/.test(qN) && !/(максим|наибольш|максимум)/.test(qN);
  const maxHint = /(максим|наибольш|максимум)/.test(qN) && !/(миним|наименьш|минимум)/.test(qN);
  if (!minHint && !maxHint) return none;
  // процедуры замера — не требования: из hero-кандидатов вон (пули их покажут)
  const nums = facts.filter((f) => typeof f.v === "number" && f.u && !(f as any).nolimit);
  if (nums.length < 2) return none;
  // крупнейшая группа «параметр:субъект + единица»
  const groups = new Map<string, ValueFact[]>();
  for (const f of nums) {
    const k = `${f.k}|${f.u}`;
    const arr = groups.get(k) ?? [];
    arr.push(f);
    groups.set(k, arr);
  }
  const same = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!same?.length) return none;
  // Раньше требовали ≥2 факта в группе — МГН-вопрос с одним топ-фактом оставался без
  // вердикта и уходил в LLM, который лепил «Да —». Теперь одиночный направленный
  // факт тоже дает «Минимум — ≥ X» (без «также»).
  if (same.length < 2) {
    const single = same[0];
    if (single && typeof single.v === "number" && single.u) {
      const okOp = minHint ? (single.op === ">=" || single.op === ">") : (single.op === "<=" || single.op === "<");
      if (okOp) {
        const fmt1 = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");
        const sym = single.op === ">=" ? "≥" : single.op === "<=" ? "≤" : single.op === ">" ? "более" : "менее";
        const word = minHint ? "Минимум" : "Максимум";
        return { line: `⟦ИТОГ⟧${word} — ${sym} ${fmt1(single.v as number)} ${single.u}⟦/ИТОГ⟧`, win: single };
      }
    }
    return none;
  }
  const u = same[0].u;
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");
  const hero = (s: string) => `⟦ИТОГ⟧${s}⟦/ИТОГ⟧`;
  // число hero — ТОЛЬКО из направленных операторов (>=/> для минимума, <=/< для
  // максимума). Голое "=" — часто частный случай (ложи 0,8 / замер 1 м / 8,5 из
  // 25×8,5): в число не входит, только в «также» со своим знаком.
  const symOf = (op: string): string =>
    op === ">=" ? "≥" : op === "<=" ? "≤" : op === ">" ? "более" : op === "<" ? "менее" : "=";
  // Частный случай: scope/cls или дейксис в сниппете («коридоров перед ними»).
  const restrictive = (f: ValueFact): boolean => {
    if (String((f as any).scope || (f as any).cls || "").trim()) return true;
    return V_DEIXIS_RE.test(String(f.s || "").toLowerCase().replace(/ё/g, "е"));
  };
  const build = (pool: ValueFact[], word: string): { line: string; win: ValueFact | null } => {
    if (!pool.length) return none;
    // Hero — по общим нормам: частные случаи уходят в «в норме также» и субкарточки,
    // не перебивая общую норму минимумом (иначе «коридор ≥1,1 м перед лифтами»).
    const general = pool.filter((f) => !restrictive(f));
    const heroPool = general.length ? general : pool;
    const m = minHint ? Math.min(...heroPool.map((f) => f.v as number)) : Math.max(...heroPool.map((f) => f.v as number));
    // победитель: точное "=" нет — среди направленных минимальный/максимальный;
    // при равных значениях предпочитаем инклюзивный (>=/<=)
    const tied = heroPool.filter((f) => Math.abs((f.v as number) - m) < 1e-9);
    const win = tied.find((f) => minHint ? f.op === ">=" : f.op === "<=")
      ?? tied.find((f) => minHint ? f.op === ">" : f.op === "<")
      ?? tied[0];
    const alsoOps = minHint ? [">=", ">", "="] : ["<=", "<", "="];
    const others = [...new Set(
      same.filter((f) => alsoOps.includes(f.op)).map((f) => f.v as number)
        .filter((v) => Math.abs(v - m) > 1e-9)
    )].sort((a, b) => a - b);
    // квалификатор — по данным: эксклюзивная граница (>/<) или разные области
    const scopes = new Set(same.map((f) => String((f as any).scope || (f as any).cls || "")).filter(Boolean));
    const qualified = win.op === ">" || win.op === "<" || scopes.size > 1;
    // схлопываем две скобки в одну: «(также: … — зависит от случая, …)»
    let suffix = "";
    if (others.length && qualified) suffix = ` (в норме также: ${others.map(fmt).join(", ")} ${u} — зависит от случая, см. ниже)`;
    else if (others.length) suffix = ` (в норме также: ${others.map(fmt).join(", ")} ${u})`;
    else if (qualified) suffix = ` (зависит от случая, см. ниже)`;
    return { line: hero(`${word} — ${symOf(win.op)} ${fmt(m)} ${u}${suffix}`), win };
  };
  if (minHint) return build(same.filter((f) => f.op === ">=" || f.op === ">"), "Минимум");
  return build(same.filter((f) => f.op === "<=" || f.op === "<"), "Максимум");
}

/**
 * Бесплатный ответ из карточек (без LLM и списаний). Возвращает null,
 * если запрос не фактоидный или заземление не сошлось (тогда — обычная цепочка,
 * а строки карточек уйдут в LLM-промпт как проверенные значения).
 */
export async function tryValuesAnswer(env: Env, query: string): Promise<{
  answer: any; sources: Array<{ i: number; d: number; p: string; pg: number | null }>; lines: string[];
  scored: Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }>;
} | null> {
  const loaded = await loadValues(env);
  if (!loaded) return null;
  const scored = findValueCardsScored(query, loaded.facts, loaded.docs, 12);
  if (!scored.length) return null;
  const cards = scored.map((s) => s.hit);
  const shortTitle = (t: string) => (t.length > 44 ? t.slice(0, 43) + "…" : t);
  // «п. Таблица 1» — оксюморон: таблица не пункт, префикс опускаем (и тут, и в сносках).
  const fmtP = (p: string) => (!p ? "" : /^таблиц/i.test(p) ? p : `п. ${p}`);
  const clsOf = (f: ValueFact) => {
    const c = f?.cls;
    return typeof c === "string" && c.trim() ? c.trim().slice(0, 60) : "";
  };
  // Область применения рядом с классом: «· III класс · для входа в ложи»
  const scopeOf = (f: ValueFact) => {
    const c = f?.scope;
    return typeof c === "string" && c.trim() ? c.trim().slice(0, 60) : "";
  };
  const bulletRow = (c: (typeof cards)[number]) => {
    const tags = [clsOf(c.fact), scopeOf(c.fact)].filter(Boolean).join(" · ");
    return `• ${formatLabelRu(c.fact.k)}${tags ? ` · ${tags}` : ""} — ${formatValueRu(c.fact)}`;
  };
  const bullet = (c: (typeof cards)[number]) =>
    `${bulletRow(c)} (` +
    `${c.docNumber || "нормативный документ"}` +
    `${c.docTitle ? `, ${shortTitle(c.docTitle)}` : ""}` +
    `${c.fact.p ? `, ${fmtP(c.fact.p)}` : ""}${c.fact.pg != null ? `, стр. ${c.fact.pg}` : ""})`;
  const lines = cards.slice(0, 6).map(bullet);
  // Компактное тело ответа: пули группируются по источнику, общий источник —
  // один раз подписью. Вместо 4× повтора документа — чистая таблица значений.
  const compactBody = (idxs: number[]): string => {
    const groups = new Map<string, typeof cards>();
    for (const idx of idxs) {
      const c = cards[idx];
      const key = `${c.docNumber}|${c.fact.p}|${c.fact.pg}`;
      const arr = groups.get(key) ?? [];
      arr.push(c);
      groups.set(key, arr);
    }
    return [...groups.values()]
      .map((cs) => {
        const c0 = cs[0];
        const head =
          `${c0.docNumber || "нормативный документ"}` +
          `${c0.docTitle ? `, ${shortTitle(c0.docTitle)}` : ""}` +
          `${c0.fact.p ? `, ${fmtP(c0.fact.p)}` : ""}${c0.fact.pg != null ? `, стр. ${c0.fact.pg}` : ""}:`;
        return `${head}\n${cs.map(bulletRow).join("\n")}`;
      })
      .join("\n\n");
  };
  const groundedIdx = scored
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => valueGrounded(s.hit.fact));
  if (!groundedIdx.length) return { answer: null as any, sources: [], lines, scored };
  // Строгий гейт: прямой values-ответ только при уверенности, иначе — строки в LLM.
  // Модальность разрешения/размещения («можно ли», «на 6 этаже») требует LLM-синтеза,
  // табличная классификация (сейсмика 6-12) не должна маскироваться под разрешение.
  const qN = query.toLowerCase().replace(/ё/g, "е");
  const reasoningAsk = /(разреш|можно|допуск|запрещ|открыть|разместить|предусматр|допускается|на \d+\s*этаж|сравн|отлич|разниц|что лучше|плюсы|минусы)/.test(qN);
  // Сравнения всегда уходят в LLM (values-строки идут как valueLines) — буллеты не дают синтеза.
  const comparativeAsk = /(сравн|отлич|разниц|что лучше|плюсы|минусы)/.test(qN);
  if (comparativeAsk) return { answer: null as any, sources: [], lines, scored };
  const top = groundedIdx.slice(0, 4).map(({ s }) => s);
  const topDocs = new Set(top.map((s) => s.hit.docTitle || s.hit.docNumber));
  const ambiguousTypes = topDocs.size >= 2;
  const best = groundedIdx[0].s;
  const confident = best.docHit && best.paramOrig && best.num >= 0 && best.rel >= 6;
  if (reasoningAsk && (!confident || ambiguousTypes)) {
    return { answer: null as any, sources: [], lines, scored };
  }
  if (ambiguousTypes && !confident) {
    return { answer: null as any, sources: [], lines, scored };
  }
  const first = best.hit;
  const topIdx = groundedIdx.slice(0, 4).map(({ idx }) => idx);
  // Строка-вердикт для мин/макс-вопросов — только по видимым пулям (иначе в итог
  // просачивается шум хвоста: «1,6 / 75 м» при вопросе про потолок квартиры).
  const verdictFacts = topIdx.map((idx) => cards[idx].fact);
  const verdict = minMaxVerdict(query, verdictFacts);
  const verdictLine = verdict.line;
  // Основание — от факта-победителя вердикта (цитата grounds именно число hero),
  // иначе — от первой пули, как раньше.
  const basisCard = (verdict.win
    ? topIdx.map((idx) => cards[idx]).find((c) => c.fact === verdict.win)
    : null) ?? first;
  const basisFact = basisCard.fact;
  const answer = {
    answer: `Точные значения из норм (snippy.llm):\n\n${verdictLine ? verdictLine + "\n\n" : ""}${compactBody(topIdx)}`,
    normative_basis: basisCard.docNumber || "",
    paragraph: basisFact.p || "",
    page: basisFact.pg,
    quote: basisFact.s || "",
    status: "active",
    date_actual: new Date().toISOString().slice(0, 10),
    is_grounded: true,
    provider: "values",
  };
  const winSource = verdict.win
    ? [{ i: basisFact.i, d: basisFact.d, p: basisFact.p, pg: basisFact.pg }]
    : [];
  const sources = [
    ...winSource,
    ...groundedIdx.slice(0, 4).map(({ idx }) => ({ i: cards[idx].fact.i, d: cards[idx].fact.d, p: cards[idx].fact.p, pg: cards[idx].fact.pg })),
  ].filter((s, j, arr) => arr.findIndex((t) => t.i === s.i) === j).slice(0, 4);
  return { answer, sources, lines, scored };
}

/** Retry-After (сек или HTTP-date) → мс. Cap 10с чтобы не держать isolate. */
function parseEmbedRetryAfterMs(v: string | null): number | null {  if (!v) return null;
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
  const { provider, model, builtAt } = await getIndexManifest(env);
  // D1-кэш векторов запроса (общий на всех юзеров, TTL 30 дней):
  // повторные вопросы — 0 вызовов API эмбеддингов.
  // Тег сборки в ключе: после пересборки индекса векторы считаются заново.
  const qn = `${builtAt || "none"}|${normAskQuery(query)}`;
  try {
    await ensureEmbedCacheTable(env);
    const hit = await env.DB.prepare(
      "SELECT vec FROM embed_cache WHERE provider=? AND model=? AND qhash=? AND created_at > datetime('now','-30 days')"
    )
      .bind(provider, model, qn)
      .first<{ vec: string }>();
    if (hit?.vec) {
      const v = JSON.parse(hit.vec) as number[];
      if (Array.isArray(v) && v.length > 10) return v;
    }
  } catch {
    /* кэш недоступен — идём в API */
  }
  const vec = await embedQueryFresh(env, query, provider, model);
  try {
    await env.DB.prepare(
      "INSERT INTO embed_cache (provider, model, qhash, vec, created_at) VALUES (?,?,?,?,datetime('now')) " +
        "ON CONFLICT(provider, model, qhash) DO UPDATE SET vec=excluded.vec, created_at=excluded.created_at"
    )
      .bind(provider, model, qn, JSON.stringify(vec))
      .run();
    // ленивая чистка протухших (при записи)
    try {
      await env.DB.prepare("DELETE FROM embed_cache WHERE created_at < datetime('now','-30 days')").run();
    } catch {}
  } catch {
    /* запись кэша не должна ронять запрос */
  }
  return vec;
}

async function ensureEmbedCacheTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS embed_cache (provider TEXT NOT NULL, model TEXT NOT NULL, qhash TEXT NOT NULL, vec TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (provider, model, qhash))"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

async function embedQueryFresh(env: Env, query: string, provider: string, model: string): Promise<number[]> {
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

/** Cross-encoder reranking кандидатов. Каскад: Jina v2-m3 → Cohere multilingual → Voyage rerank-2
 *  → LLM-listwise (Groq) → Workers AI bge-reranker-base → исходный порядок.
 *  Возвращает порядок индексов contexts по убыванию релевантности (topN). */
type RerankLink = { id: string; run: (query: string, texts: string[], topN: number) => Promise<number[]> };

function rerankOrderFromPairs(arr: any[], contextsLen: number, topN: number): number[] {
  const ranked = arr
    .map((x: any) => ({ i: Number(x?.index ?? x?.id), s: Number(x?.relevance_score ?? x?.score) }))
    .filter((x) => Number.isInteger(x.i) && x.i >= 0 && x.i < contextsLen);
  if (!ranked.length) throw new Error("rerank: пустой/битый ответ");
  ranked.sort((a, b) => b.s - a.s);
  return ranked.slice(0, topN).map((x) => x.i);
}

function rerankLinks(env: Env): RerankLink[] {
  const links: RerankLink[] = [];
  if (env.VOYAGE_API_KEY) {
    links.push({
      id: "voyage-rerank",
      run: async (query, texts, topN) => {
        const r = await fetch("https://api.voyageai.com/v1/rerank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
          body: JSON.stringify({
            model: "rerank-2",
            query,
            documents: texts.map((t) => String(t ?? "").slice(0, 4000)),
            top_k: topN,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw statusError("voyage-rerank", r, await r.text());
        const d: any = await r.json();
        return rerankOrderFromPairs(d.data ?? d.results ?? [], texts.length, topN);
      },
    });
  }
  if (env.COHERE_API_KEY) {
    links.push({
      id: "cohere-rerank",
      run: async (query, texts, topN) => {
        const r = await fetch("https://api.cohere.com/v2/rerank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.COHERE_API_KEY}` },
          body: JSON.stringify({
            model: "rerank-multilingual-v3.0",
            query,
            documents: texts.map((t) => String(t ?? "").slice(0, 4000)),
            top_n: topN,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw statusError("cohere-rerank", r, await r.text());
        const d: any = await r.json();
        return rerankOrderFromPairs(d.results ?? [], texts.length, topN);
      },
    });
  }
  if (env.JINA_API_KEY) {
    links.push({
      id: "jina-rerank",
      run: async (query, texts, topN) => {
        const r = await fetch("https://api.jina.ai/v1/rerank", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.JINA_API_KEY}` },
          body: JSON.stringify({
            model: "jina-reranker-v2-base-multilingual",
            query,
            documents: texts.map((t) => String(t ?? "").slice(0, 4000)),
            top_n: topN,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw statusError("jina-rerank", r, await r.text());
        const d: any = await r.json();
        return rerankOrderFromPairs(d.results ?? [], texts.length, topN);
      },
    });
  }
  // LLM-listwise: gpt-oss-20b выбирает лучшие фрагменты (русский держит хорошо).
  links.push({
    id: "llm-rerank",
    run: async (query, texts, topN) => {
      const list = texts
        .map((t, i) => `[${i}] ${normWs(String(t ?? "")).slice(0, 260)}`)
        .join("\n");
      const prompt = `Ты — эксперт по строительным нормам Казахстана.
Даны вопрос и ${texts.length} нумерованных фрагментов из нормативов.
Выбери до ${topN} фрагментов, которые лучше всего отвечают на вопрос, по убыванию релевантности.
Верни СТРОГО JSON без markdown: {"best":[номера]}
Только индексы из списка, без повторов.

Вопрос: ${query}

Фрагменты:
${list}`;
      const raw = await groqText(env, env.GROQ_MODEL, prompt, 80, 0.1, 6000);
      let text = stripThink(raw.trim());
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
      let d: any = null;
      try {
        d = JSON.parse(text);
      } catch {
        // модель ответила массивом [1,4,2] — принимаем и это
        const m = text.match(/\[[\d,\s]+\]/);
        d = m ? { best: JSON.parse(m[0]) } : null;
      }
      const nums: number[] = (Array.isArray(d?.best) ? d.best : [])
        .map((x: any) => Number(x))
        .filter((x: number) => Number.isInteger(x) && x >= 0 && x < texts.length);
      const uniq = [...new Set(nums)].slice(0, topN);
      if (!uniq.length) throw new Error(`llm-rerank: нет индексов (${text.slice(0, 80)})`);
      // Модель может вернуть меньше topN — добиваем оставшимися в исходном порядке.
      return [...uniq, ...texts.map((_, i) => i).filter((i) => !uniq.includes(i))].slice(0, Math.min(topN, texts.length));
    },
  });
  if (env.AI) {
    // bge-reranker-base (en/zh) на русском ухудшает хвост выдачи — оставлен только для явного force в eval.
    links.push({
      id: "workers-rerank",
      run: async (query, texts, topN) => {
        const out: any = await env.AI.run("@cf/baai/bge-reranker-base", {
          query,
          contexts: texts.map((t) => ({ text: String(t ?? "").slice(0, 450) })),
          top_k: Math.min(topN, texts.length),
        });
        const arr = Array.isArray(out) ? out : out?.response;
        if (!Array.isArray(arr) || !arr.length) throw new Error("workers-rerank: пустой ответ");
        return rerankOrderFromPairs(arr, texts.length, topN);
      },
    });
  }
  return links;
}

export async function rerankContexts(
  env: Env,
  query: string,
  contexts: string[],
  topN: number,
  forceId?: string
): Promise<{ order: number[]; model: string; errors: string[] }> {
  const identity = { order: contexts.map((_, i) => i).slice(0, topN), model: "none", errors: [] as string[] };
  if (contexts.length <= 1) return identity;
  let values: Record<string, string> = {};
  try {
    values = (await getSettings(env)).values;
  } catch {}
  const budgets = await getLlmBudgetStates(env);
  const now = Date.now();
  const errors: string[] = [];
  let ran = false;
  for (const link of rerankLinks(env)) {
    if (forceId && link.id !== forceId) continue;
    // workers-rerank (bge-base) на русском портит хвост — только явный force для замеров
    if (!forceId && link.id === "workers-rerank") continue;
    if (!forceId && linkBlocked(budgets.get(`${link.id}\n`), llmBudgetCap(values, link.id), now)) {
      errors.push(`${link.id}: бюджет исчерпан/звено остывает`);
      continue;
    }
    ran = true;
    try {
      const order = await link.run(query, contexts, topN);
      if (order.length < Math.min(topN, contexts.length)) throw new Error("rerank: неполный ответ");
      await noteLlmUsed(env, link.id, "");
      return { order, model: link.id, errors };
    } catch (e: any) {
      const msg = `${link.id}: ${String(e?.message ?? e).slice(0, 160)}`;
      errors.push(msg);
      console.error(`[rerank] ${msg}`);
      if (retryableLlmError(e)) await noteLlmDown(env, link.id, "", e?.retryAfterMs);
    }
  }
  if (!ran && !forceId) errors.push("все rerank-звенья скипнуты (бюджеты/брейкер)");
  return { ...identity, errors };
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
// Лимитный период почасовой для всех: гости 30/час, зарегистрированные 300/час.
const periodKey = (_isUser: boolean): string => hourKey();

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

// ---------- Архив удалённых аккаунтов (30 дней, ленивая чистка) ----------

async function ensureArchivedTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS archived_users (email TEXT PRIMARY KEY, uid TEXT NOT NULL, full_name TEXT, password_hash TEXT NOT NULL, created_at TEXT, reason TEXT NOT NULL, reason_title TEXT NOT NULL, reason_text TEXT NOT NULL, deleted_by TEXT NOT NULL, deleted_at TEXT NOT NULL, purge_after TEXT NOT NULL)"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

/** Просроченные записи архива удаляются при любом касании (без крона). */
export async function purgeExpiredArchive(env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  try {
    const stale = await env.DB.prepare("SELECT uid FROM archived_users WHERE purge_after < ?").bind(nowIso).all<{ uid: string }>();
    for (const r of stale.results ?? []) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM archived_users WHERE uid = ?").bind(r.uid),
        env.DB.prepare("DELETE FROM balances WHERE subject = ?").bind(`user:${r.uid}`),
        env.DB.prepare("DELETE FROM usage WHERE subject = ?").bind(`user:${r.uid}`),
      ]);
    }
  } catch {
    /* таблицы может не быть — ок */
  }
}

/** Дата по-русски для сообщений: «2026-10-21T…» → «21.10.2026». */
export function fmtRuDate(iso: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso ?? "");
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
  // Дневные бюджеты LLM-звеньев (брейкер): 0 = звено мягко отключено.
  // В админке пока без отдельных полей — правятся тем же API настроек.
  budget_groq: { def: "90", min: 0, max: 10000000 },
  budget_groq_alt: { def: "150", min: 0, max: 10000000 },
  budget_gemini: { def: "1200", min: 0, max: 10000000 },
  budget_cerebras: { def: "350", min: 0, max: 10000000 },
  budget_openrouter: { def: "40", min: 0, max: 10000000 },
  budget_deepseek: { def: "150", min: 0, max: 10000000 },
  // Ключи без дефисов: llmBudgetCap ищет budget_<provider с "_" вместо "-">
  budget_mistral_chat: { def: "150", min: 0, max: 10000000 },
  budget_cohere_chat: { def: "150", min: 0, max: 10000000 },
  budget_custom: { def: "1000000", min: 0, max: 10000000 },
  budget_workers_ai: { def: "800", min: 0, max: 10000000 },
  budget_zen: { def: "100", min: 0, max: 10000000 },
  budget_pollinations: { def: "300", min: 0, max: 10000000 },
  budget_jina_rerank: { def: "300", min: 0, max: 10000000 },
  budget_cohere_rerank: { def: "300", min: 0, max: 10000000 },
  budget_voyage_rerank: { def: "300", min: 0, max: 10000000 },
  budget_llm_rerank: { def: "500", min: 0, max: 10000000 },
  budget_workers_rerank: { def: "800", min: 0, max: 10000000 },
  // Смарт-фичи (0 = выключено, 1 = включено): понимание запроса, reranking, второй проход
  smart_rewrite: { def: "1", min: 0, max: 1 },
  smart_rerank: { def: "1", min: 0, max: 1 },
  smart_second_pass: { def: "1", min: 0, max: 1 },
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
      // llm_* (kill-switchи звеньев) и budget_* — обе группы должны доходить из D1:
      // раньше фильтр по SETTING_DEFS отбрасывал llm_*, и тумблеры админки не работали
      if (SETTING_DEFS[r.key] || r.key.startsWith("llm_")) {
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

export async function getCreditsState(env: Env, subject: string, isUser: boolean): Promise<CreditsState> {
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
    reset: "hourly",
  };
}

interface ChargeSplit { daily: number; balance: number }

/** Списывает cost токенов: сначала часовой лимит, затем накопительный баланс. */
export async function chargeHybrid(
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
  const nowIso = new Date().toISOString();
  // Баланс списываем guard-UPDATE первым: при гонке двух запросов второй увидит
  // changes=0 и вернёт 402 вместо ухода в минус. Daily-доля пишется только после успеха.
  if (fromBalance > 0) {
    let changed = 0;
    try {
      const upd: any = await env.DB.prepare(
        "UPDATE balances SET credits = credits - ?, updated_at = ? WHERE subject = ? AND credits >= ?"
      )
        .bind(fromBalance, nowIso, subject, fromBalance)
        .run();
      changed = Number(upd?.meta?.changes ?? upd?.changes ?? 0) || 0;
    } catch {
      changed = 0;
    }
    if (!changed) {
      const fresh = await getCreditsState(env, subject, isUser);
      const need = Math.max(0, cost - fresh.daily.remaining - fresh.balance);
      return { ok: false, state: fresh, need };
    }
  }
  const stmts: D1PreparedStatement[] = [];
  if (fromDaily > 0) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO usage (day, subject, count) VALUES (?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count"
      ).bind(period, subject, fromDaily)
    );
  }
  stmts.push(
    env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, ?, ?, ?)").bind(
      subject,
      -cost,
      kind,
      meta ?? JSON.stringify({ split: { daily: fromDaily, balance: fromBalance } }),
      nowIso
    )
  );
  await env.DB.batch(stmts);
  const newState = await getCreditsState(env, subject, isUser);
  return { ok: true, state: newState, split: { daily: fromDaily, balance: fromBalance } };
}

/** Возврат списания при внутренней ошибке (восстанавливает точный split). */
export async function refundCharge(env: Env, subject: string, isUser: boolean, cost: number, split: ChargeSplit, kind: string): Promise<void> {
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

/** Ключ кэша /api/ask: режим + сборка индекса + нормализованный запрос.
 *  builtAt в ключе — старые ответы не переживают обновление норм (уточнения не кэшируем — там история). */
export async function askCacheKey(query: string, mode: string, buildTag = "none"): Promise<string> {
  const data = new TextEncoder().encode(`ask|${mode}|${buildTag}|${normAskQuery(query)}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// TTL кэша ответов: точные — 48ч, «не найдено» — 12ч (база может пополниться).
const ASK_CACHE_TTL_GROUNDED = 48 * 3600 * 1000;
const ASK_CACHE_TTL_UNGROUNDED = 12 * 3600 * 1000;

// ---------- Понимание запроса (smart_rewrite): LLM переписывает вопрос в поисковые формулировки ----------

export interface RewriteResult {
  standalone: string;
  queries: string[];
  terms: string[];
}

const REWRITE_EMPTY: RewriteResult = { standalone: "", queries: [], terms: [] };
const REWRITE_CACHE_TTL_DAYS = 30;
const REWRITE_MAX_QUERIES = 3;
/** Версия промпта в ключе кэша: смена промпта не отдаёт старые переформулировки. */
const REWRITE_PROMPT_VERSION = "3";
const DOC_NUM_RE = /(снип|сп|сн|ст|гост|тр)\s*[№#]?\s*\d[\d.\-*]*/gi;
/** Казахский запрос: спец-буквы вне ru-алфавита (зеркало _KZ_RE в eval_search.py). */
const KZ_LETTERS_RE = /[әғқңөұүһі]/i;

async function ensureRewriteCacheTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS rewrite_cache (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

async function rewriteCacheKey(kind: string, query: string, history?: Array<{ q: string; a: string }>): Promise<string> {
  const hist = (history ?? []).map((h) => `${normAskQuery(h.q)}|${normAskQuery(h.a).slice(0, 120)}`).join("~");
  const data = new TextEncoder().encode(`rw|${REWRITE_PROMPT_VERSION}|${kind}|${hist}|${normAskQuery(query)}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseRewriteJson(raw: string, query: string): RewriteResult {
  let text = stripThink(String(raw ?? "").trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let d: any = null;
  try {
    d = JSON.parse(text);
  } catch {
    d = null;
  }
  const clean = (v: unknown, max = 220): string => normWs(String(v ?? "")).slice(0, max);
  if (!d || typeof d !== "object") {
    // Модель вернула не-JSON: вытаскиваем строки из "queries":[...] регуляркой
    const block = /"queries"\s*:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
    const found = [...block.matchAll(/"([^"]{3,220})"/g)].map((m) => m[1]);
    if (!found.length) {
      console.error(`[rewrite] bad json: ${text.slice(0, 180)}`);
      return { ...REWRITE_EMPTY, standalone: query };
    }
    d = { queries: found };
    d.__raw = text.slice(0, 500);
  }
  const queries: string[] = [];
  const origHasDocNum = DOC_NUM_RE.test(query);
  DOC_NUM_RE.lastIndex = 0;
  for (const q of Array.isArray(d?.queries) ? d.queries : []) {
    let s = clean(q);
    // Модель любит выдумывать «СНиП 2.04.02-85» — вырезаем, если номера не было в вопросе.
    if (!origHasDocNum) s = normWs(s.replace(DOC_NUM_RE, " "));
    if (s.length >= 3 && !queries.some((x) => x.toLowerCase() === s.toLowerCase())) queries.push(s);
    if (queries.length >= REWRITE_MAX_QUERIES) break;
  }
  const terms: string[] = [];
  for (const t of Array.isArray(d?.terms) ? d.terms : []) {
    const s = clean(t, 60);
    if (s.length >= 2 && !terms.includes(s)) terms.push(s);
    if (terms.length >= 6) break;
  }
  const res: RewriteResult = { standalone: clean(d?.standalone, 300) || query, queries, terms };
  if (d?.__raw) (res as any).__raw = String(d.__raw).slice(0, 500);
  return res;
}

/** Переписывание запроса дешёвой моделью: Groq primary (4с) → Workers AI (8с) → без изменений. */
export async function rewriteSmart(
  env: Env,
  query: string,
  opts: { history?: Array<{ q: string; a: string }>; followUp?: boolean } = {}
): Promise<RewriteResult> {
  const fallback: RewriteResult = { ...REWRITE_EMPTY, standalone: query };
  const q = String(query ?? "").trim();
  if (!q || q.length > 400) return fallback;
  try {
    const { values } = await getSettings(env);
    if (settingInt(values, "smart_rewrite", "1") !== 1) return fallback;
  } catch {
    /* settings недоступны — пробуем дальше */
  }
  const kind = opts.followUp ? "followup" : "query";
  const history = (opts.history ?? []).filter((h) => h.q || h.a).slice(-2);
  let hash = "";
  try {
    hash = await rewriteCacheKey(kind, q, history);
    await ensureRewriteCacheTable(env);
    const hit = await env.DB.prepare(
      `SELECT payload FROM rewrite_cache WHERE hash=? AND created_at > datetime('now','-${REWRITE_CACHE_TTL_DAYS} days')`
    )
      .bind(hash)
      .first<{ payload: string }>();
    if (hit?.payload) {
      const parsed = JSON.parse(hit.payload) as RewriteResult;
      if (parsed && (parsed.standalone || parsed.queries?.length)) return parsed;
    }
  } catch {
    /* кэш недоступен — идём в LLM */
  }
  const histText = history.length
    ? `\nИстория диалога (раскрой местоимения и подразумеваемый контекст):\n${history
        .map((h, i) => `${i + 1}. Вопрос: ${String(h.q).slice(0, 200)}\n   Ответ: ${String(h.a).slice(0, 300)}`)
        .join("\n")}\n`
    : "";
  // Казахский запрос — не оставляем на усмотрение модели: база в основном на русском,
  // поэтому русский эквивалент идёт ПЕРВЫМ, kz-формулировка — второй (есть kz-документы).
  const kzHint = KZ_LETTERS_RE.test(q)
    ? `\nВАЖНО: вопрос на КАЗАХСКОМ. queries = [русский эквивалент запроса (официальная нормативная терминология: үй-жай=помещение, ені=ширина, биіктік=высота, аудан=площадь, өткел=проход), исходная формулировка на казахском]. Числа и единицы не переводить.`
    : "";
  const prompt = `Ты — поисковый ассистент по строительным нормам Казахстана (СНиП/СП/СН/СТ РК).
Преобразуй вопрос пользователя в запросы для поиска по нормативной базе.
Верни СТРОГО JSON без markdown:
{"standalone":"...","queries":["...","..."],"terms":["..."]}
Правила:
- standalone: самодостаточный вопрос (при истории — раскрой местоимения: «а для детских садов?» → «Какие требования к ширине коридора в детских садах?»)
- queries: 2-3 короткие поисковые формулировки на РУССКОМ с официальной нормативной терминологией
- terms: 3-6 ключевых терминов-существительных (для полнотекстового поиска; для казахского вопроса — термины на обоих языках)
- сохрани числа и единицы измерения (метры, этажи, люди, м2)
- НЕ придумывай номера документов (СНиП/СП/СН/СТ/ГОСТ): указывай только если они есть в вопросе
- без пояснений, без markdown${kzHint}${histText}
Вопрос: ${q}`;
  let raw = "";
  const groqModel = env.GROQ_MODEL;
  try {
    raw = await groqText(env, groqModel, prompt, 220, 0.1, 4000);
    await noteLlmUsed(env, "groq", groqModel);
  } catch (e: any) {
    if (fatalLlmError(e)) {
      console.error(`[rewrite] groq fatal: ${String(e?.message ?? e).slice(0, 120)}`);
      return fallback;
    }
    if (retryableLlmError(e)) await noteLlmDown(env, "groq", groqModel, e?.retryAfterMs);
    try {
      const out: any = await Promise.race([
        env.AI!.run("@cf/meta/llama-3.1-8b-instruct-fast", { prompt, max_tokens: 220, temperature: 0.1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("rewrite: workers-ai таймаут")), 8000)),
      ]);
      raw = typeof out === "string" ? out : String(out?.response ?? "");
    } catch (e2: any) {
      console.error(`[rewrite] llm недоступен: ${String(e2?.message ?? e2).slice(0, 120)}`);
      return fallback;
    }
  }
  const parsed = parseRewriteJson(raw, q);
  if (hash && (parsed.queries.length || parsed.standalone !== q)) {
    try {
      await env.DB.prepare(
        "INSERT INTO rewrite_cache (hash, payload, created_at) VALUES (?,?,datetime('now')) ON CONFLICT(hash) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at"
      )
        .bind(hash, JSON.stringify(parsed))
        .run();
    } catch {}
  }
  return parsed;
}


// ---------- LLM-цепочка фолбэков: Groq → Groq-alt → Gemini → Cerebras → OpenRouter → DeepSeek → Mistral → Cohere → Custom → Workers AI → Zen → Pollinations → extractive ----------

export type LlmProvider =
  | "groq" | "groq-alt" | "gemini" | "cerebras" | "openrouter" | "deepseek"
  | "mistral-chat" | "cohere-chat" | "custom" | "workers-ai" | "zen" | "pollinations" | "extractive"
  | "values";

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
  // Retry-After для брейкера (429 провайдеров): уважаем серверную паузу.
  try {
    const ra = parseEmbedRetryAfterMs(r.headers.get("Retry-After"));
    if (ra != null) e.retryAfterMs = ra;
  } catch {}
  return e;
}

const stripThink = (t: string): string => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

/** reasoning_effort=low поддерживают только reasoning-модели (GPT-OSS 20B/120B, Qwen 3.8);
 *  остальным (Llama и др.) параметр слать нельзя — Groq отвечает 400 и звено молча скипается. */
const REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]);

async function groqText(env: Env, model: string, prompt: string, maxTokens: number, temp = 0.1, timeoutMs = 20000): Promise<string> {
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw statusError(`groq ${model}`, r, await r.text());
  const d: any = await r.json();
  const text = stripThink(d.choices?.[0]?.message?.content ?? "");
  if (!text) throw new Error(`groq ${model}: пустой ответ`);
  return text;
}

async function geminiText(env: Env, prompt: string, maxTokens: number, key?: string, model?: string): Promise<string> {
    // "gemini-2.0-flash" удалён из API (404 no longer available) — берём живой алиас
  const m = model ?? env.GEMINI_TEXT_MODEL ?? "gemini-flash-latest";
  const k = key ?? env.GEMINI_API_KEY;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": k },
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
  id: Exclude<LlmProvider, "groq" | "extractive" | "values">;
  /** Вариант бакета квоты: модель для groq-alt, иначе "". */
  variant: string;
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
      links.push({ id: "groq-alt", variant: m, run: (p, t) => groqText(env, m, p, t) });
    }
  }
  if ((await llmEnabled(env, "llm_gemini")) && env.GEMINI_API_KEY) {
    links.push({ id: "gemini", variant: "", run: (p, t) => geminiText(env, p, t) });
    // alt-ключи (другие Google-проекты → свои квоты): Flash-Lite — дневной лимит в разы выше,
    // качество ниже — терпимо для фолбэк-позиции. Бюджет считается per-вариант (budget_gemini на каждый).
    const altModel = env.GEMINI_ALT_MODEL ?? "gemini-2.5-flash-lite";
    const altKeys: Array<[string, string | undefined]> = [["alt-2", env.GEMINI_API_KEY_2], ["alt-3", env.GEMINI_API_KEY_3], ["alt-4", env.GEMINI_API_KEY_4]];
    for (const [variant, key] of altKeys) {
      if (!key) continue;
      links.push({ id: "gemini", variant, run: (p, t) => geminiText(env, p, t, key, altModel) });
    }
  }
  if ((await llmEnabled(env, "llm_cerebras")) && env.CEREBRAS_API_KEY) {
    links.push({ id: "cerebras", variant: "", run: (p, t) => cerebrasText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_openrouter")) && env.OPENROUTER_API_KEY) {
    links.push({ id: "openrouter", variant: "", run: (p, t) => openrouterText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_deepseek")) && env.DEEPSEEK_API_KEY) {
    links.push({ id: "deepseek", variant: "", run: (p, t) => deepseekText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_mistral_chat")) && env.MISTRAL_API_KEY) {
    links.push({ id: "mistral-chat", variant: "", run: (p, t) => mistralChatText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_cohere_chat")) && env.COHERE_API_KEY) {
    links.push({ id: "cohere-chat", variant: "", run: (p, t) => cohereChatText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_custom")) && env.LLM_CUSTOM_BASE && env.LLM_CUSTOM_KEY) {
    links.push({ id: "custom", variant: "", run: (p, t) => customLlmText(env, p, t) });
  }
  if ((await llmEnabled(env, "llm_workers")) && env.AI) {
    links.push({ id: "workers-ai", variant: "", run: (p, t) => workersAiText(env, p, t) });
  }
  if ((await zenOptIn(env)) && env.OPENCODE_API_KEY) {
    links.push({ id: "zen", variant: "", run: (p, t) => zenText(env, p, t) });
  }
  if (await llmEnabled(env, "llm_pollinations")) {
    links.push({ id: "pollinations", variant: "", run: (p, t) => pollinationsText(p, t) });
  }
  return links;
}

// ---------- Circuit breaker + дневные бюджеты LLM-звеньев ----------
// Мёртвое звено (429/5xx) скипается без fetch до down_until; исчерпанный
// дневной бюджет — до 00:00 UTC. Состояние — D1 llm_budget (self-healing),
// один SELECT на весь обход цепочки. Установка budget_<id>=0 в settings
// мягко отключает звено. Капы — реалистичные free-tier сутки.

const LLM_BUDGET_DEFAULTS: Record<string, number> = {
  "groq": 90,
  "groq-alt": 150,
  "gemini": 1200,
  "cerebras": 350,
  "openrouter": 40,
  "deepseek": 150,
  "mistral-chat": 150,
  "cohere-chat": 150,
  "custom": 1000000,
  "workers-ai": 800,
  "zen": 100,
  "pollinations": 300,
  // Rerank-звенья (каскад /api/ask): trial-квоты Jina/Cohere/Voyage + Groq-listwise
  "jina-rerank": 300,
  "cohere-rerank": 300,
  "voyage-rerank": 300,
  "llm-rerank": 500,
  "workers-rerank": 800,
};

async function ensureLlmBudgetTable(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS llm_budget (provider TEXT NOT NULL, variant TEXT NOT NULL DEFAULT '', day TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, down_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, variant, day))"
    ).run();
  } catch {
    /* уже есть — ок */
  }
}

export function llmBudgetCap(values: Record<string, string>, provider: string): number {
  const def = LLM_BUDGET_DEFAULTS[provider] ?? 100;
  // Ключ настройки: дефисы id → подчёркивания (budget_groq-alt → budget_groq_alt).
  const raw = values[`budget_${provider.replace(/-/g, "_")}`];
  if (raw === undefined) return def;
  const v = Math.floor(Number(raw));
  if (!Number.isFinite(v)) return def;
  return Math.min(10000000, Math.max(0, v));
}

interface LlmBudgetRow {
  used: number;
  downUntil: number;
}

/** Все строки текущего дня одним SELECT: ключ `${provider}\n${variant}`. */
async function getLlmBudgetStates(env: Env): Promise<Map<string, LlmBudgetRow>> {
  const out = new Map<string, LlmBudgetRow>();
  try {
    await ensureLlmBudgetTable(env);
    const rows = await env.DB.prepare(
      "SELECT provider, variant, used, down_until FROM llm_budget WHERE day=?"
    )
      .bind(todayKey())
      .all<{ provider: string; variant: string; used: number; down_until: number }>();
    for (const r of rows.results ?? []) {
      out.set(`${r.provider}\n${r.variant ?? ""}`, { used: r.used ?? 0, downUntil: r.down_until ?? 0 });
    }
  } catch {
    /* D1 недоступен — считаем все звенья живыми */
  }
  return out;
}

function linkBlocked(state: LlmBudgetRow | undefined, cap: number, now: number): boolean {
  if (cap <= 0) return true;
  if (!state) return false;
  if (state.downUntil > now) return true;
  if (state.used >= cap) return true;
  return false;
}

/** Успешный вызов API (и мусор-JSON — квота провайдера всё равно потрачена). */
async function noteLlmUsed(env: Env, provider: string, variant: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO llm_budget (provider, variant, day, used, down_until) VALUES (?,?,?,1,0) " +
        "ON CONFLICT(provider, variant, day) DO UPDATE SET used=used+1"
    )
      .bind(provider, variant, todayKey())
      .run();
  } catch {
    /* учёт не должен ронять ответ */
  }
}

/** Retryable-ошибка: глушим звено (Retry-After сервера, иначе 60с; кап 10 мин). */
async function noteLlmDown(env: Env, provider: string, variant: string, retryAfterMs?: number | null): Promise<void> {
  try {
    const pause = Math.min(Math.max(retryAfterMs ?? 60000, 15000), 600000);
    const until = Date.now() + pause;
    await env.DB.prepare(
      "INSERT INTO llm_budget (provider, variant, day, used, down_until) VALUES (?,?,?,0,?) " +
        "ON CONFLICT(provider, variant, day) DO UPDATE SET down_until=MAX(down_until,excluded.down_until)"
    )
      .bind(provider, variant, todayKey(), until)
      .run();
  } catch {
    /* учёт не должен ронять ответ */
  }
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
  "7. В ТАБЛИЦАХ первое число строки — это НОМЕР СТРОКИ, а не значение и не номер этажа! Значение требования — число в КОНЦЕ строки рядом с единицей (м, мм, эт.). " +
  "Пример: «10 Жилые здания … освещенности … 15» при заголовке «в метрах» означает значение 15, а 10 — номер строки. " +
  "Голые числа (номера строк, номера страниц-колонтитулы внизу) значением не являются. " +
  "«Этажность застройки» (средневзвешенная, характеристика района) — НЕ то же, что этаж размещения объекта.";

const ASK_STRICT_SUFFIX = "\n\n(ВАЖНО: quote обязана быть дословным фрагментом контекста)";

/** Нормализация для сравнения цитаты с контекстом: lower + ё + схлоп пробелов. */
function normQuote(s: string): string {
  return String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Ремонт недословной цитаты вместо скипа звена: подменяем ближайшим фрагментом
 * контекста (косинусная схожесть по словам). Возвращаем и индекс контекста —
 * вызыватель обязан передвинуть paragraph/page/sources на тот же чанк.
 * Пустая цитата → начало топ-контекста (idx 0).
 */
function repairQuoteIdx(quote: string, contexts: string[]): { quote: string; idx: number } {
  const q = normQuote(quote);
  if (!contexts.length) return { quote: String(quote ?? "").slice(0, 500), idx: 0 };
  if (!q) return { quote: contexts[0].slice(0, 500), idx: 0 };
  for (let k = 0; k < contexts.length; k++) {
    if (normQuote(contexts[k]).includes(q)) return { quote, idx: k }; // дословная — как есть
  }
  const qWords = new Set(q.split(" ").filter((w) => w.length > 2));
  let best = 0, bestScore = 0;
  for (let k = 0; k < contexts.length; k++) {
    const cw = new Set(normQuote(contexts[k]).split(" ").filter((w) => w.length > 2));
    if (!qWords.size || !cw.size) continue;
    let inter = 0;
    for (const w of qWords) if (cw.has(w)) inter++;
    const score = inter / Math.sqrt(qWords.size * cw.size);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  if (bestScore < 0.2) {
    const snip0 = contexts[0].slice(0, 500);
    return { quote: snip0, idx: 0 };
  }
  let snip = contexts[best].slice(0, 500);
  const dot = snip.lastIndexOf(". ");
  if (dot > 200) snip = snip.slice(0, dot + 1);
  return { quote: snip.trim(), idx: best };
}

function repairQuote(quote: string, contexts: string[]): string {
  return repairQuoteIdx(quote, contexts).quote;
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

export type AskRoute = "simple" | "standard" | "complex";

const ASK_COMPLEX_RE =
  /сравн|отлич|разниц|противореч|почему|зачем|когда применять|когда нужно|если |несколько|все требован|перечень|список|сводн|что лучше|плюсы|минусы|какие |каковы/;
const ASK_SIMPLE_RE =
  /какая |какой |какое |сколько |минимальн|максимальн|наименьш|наибольш|равен|равна|равно|допустим|должен |должна |норма |ширина|высота|длина|площадь|расстояние|температура/;

/**
 * Роутер сложности (G3): простое — короткие фактоиды (меньше контекста и токенов),
 * сложное — сравнения/списки/«почему» (полный контекст). Уточнения — всегда standard.
 * Влияет только на глубину контекста и max_tokens, не на списание.
 */
export function classifyAsk(query: string, isFollowUp = false): AskRoute {
  if (isFollowUp) return "standard";
  const q = String(query ?? "").toLowerCase().replace(/ё/g, "е");
  if (ASK_COMPLEX_RE.test(q) || q.length > 140) return "complex";
  if (q.length < 90 && ASK_SIMPLE_RE.test(q)) return "simple";
  return "standard";
}

/**
 * Ответ с заземлением через цепочку: primary Groq (с 1 строгим ретраем) → фолбэки. * Явный «ответа нет» (is_grounded=false) принимается сразу — все звенья скажут то же.
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
  // Бюджеты/брейкер: один SELECT на обход; мёртвые и исчерпанные скипаем без fetch.
  let budgetValues: Record<string, string> = {};
  try {
    budgetValues = (await getSettings(env)).values ?? {};
  } catch {}
  const budgets = await getLlmBudgetStates(env);
  const now = Date.now();
  const blocked = (provider: string, variant: string): boolean =>
    linkBlocked(budgets.get(`${provider}\n${variant}`), llmBudgetCap(budgetValues, provider), now);
  let attempted = 0;
  let budgetSkipped = 0;
  // Резервам — ужатые контексты: им хватает фактуры для цитаты, а токены бережём.
  const shortCtx = shortContexts ?? contexts;
  // primary Groq: обычная попытка + строгая (как раньше)
  const groqVar = env.GROQ_MODEL ?? "";
  if (!blocked("groq", groqVar)) {
    for (const extra of ["", ASK_STRICT_SUFFIX]) {
      attempted++;
      try {
        const raw = await groqText(env, env.GROQ_MODEL, makePrompt(extra, contexts), maxTokens);
        await noteLlmUsed(env, "groq", groqVar);
        const parsed = extractJsonAnswer(raw);
        if (parsed?.[PARSE_ERROR]) {
          lastErr = noteErr(new Error("groq: bad json"), true);
          console.error(`[llm] groq ${env.GROQ_MODEL}: bad json`);
          continue; // мусор вместо JSON — пробуем дальше, а не выдаём за вердикт
        }
        if (parsed?.is_grounded === false || verifyGrounded(parsed, contexts)) return { answer: parsed, provider: "groq" };
        // недословная цитата — чиним подменой фрагмента контекста, sourceIdx двигаем за ней
        const rep = repairQuoteIdx(String(parsed?.quote ?? ""), contexts);
        parsed.quote = rep.quote;
        if (parsed && typeof parsed === "object") parsed.sourceIdx = rep.idx + 1;
        return { answer: parsed, provider: "groq" };
      } catch (e: any) {
        if (fatalLlmError(e)) throw e;
        lastErr = noteErr(e);
        if (retryableLlmError(e)) await noteLlmDown(env, "groq", groqVar, e?.retryAfterMs);
        console.error(`[llm] groq ${env.GROQ_MODEL} failed: status=${e?.status ?? "?"} ${String(e?.message ?? e).slice(0, 160)}`);
        break;
      }
    }
  } else {
    budgetSkipped++;
  }
  // фолбэки: по одной попытке (без строгого ретрая — экономим время и чужие квоты)
  for (const link of await fallbackLinks(env)) {
    if (blocked(link.id, link.variant)) {
      budgetSkipped++;
      continue;
    }
    attempted++;
    try {
      const raw = await link.run(makePrompt("", shortCtx), maxTokens);
      await noteLlmUsed(env, link.id, link.variant);
      const parsed = extractJsonAnswer(raw);
      if (parsed?.[PARSE_ERROR]) {
        lastErr = noteErr(new Error(`${link.id}: bad json`), true);
        console.error(`[llm] ${link.id}: bad json`);
        continue;
      }
      if (parsed?.is_grounded === false || verifyGrounded(parsed, shortCtx)) return { answer: parsed, provider: link.id };
      // недословная цитата — чиним подменой фрагмента контекста, sourceIdx двигаем за ней
      const repFb = repairQuoteIdx(String(parsed?.quote ?? ""), shortCtx);
      parsed.quote = repFb.quote;
      if (parsed && typeof parsed === "object") parsed.sourceIdx = repFb.idx + 1;
      return { answer: parsed, provider: link.id };
    } catch (e: any) {
      if (fatalLlmError(e)) throw e;
      lastErr = noteErr(e);
      if (retryableLlmError(e)) await noteLlmDown(env, link.id, link.variant, e?.retryAfterMs);
      console.error(`[llm] ${link.id} failed: status=${e?.status ?? "?"} ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  if (attempted === 0 && budgetSkipped > 0) {
    // Все звенья скипнуты брейкером/бюджетами — ни одного fetch не было:
    // сразу в extractive, без таймаутов. Вызыватель соберёт резервный ответ.
    const e: any = new Error("llm budgets exhausted");
    e.budgetExhausted = true;
    e.llmCauses = causes;
    throw e;
  }
  (lastErr as any).llmCauses = causes;
  throw lastErr;
}

async function askGroq(env: Env, query: string, contexts: string[], maxTokens: number, history?: Array<{ q: string; a: string }>, valueLines?: string[], secondPass = false): Promise<{ answer: any; provider: LlmProvider }> {
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
4. Верни строго JSON {"answer","quote","paragraph","sourceIdx","is_grounded"} без markdown; sourceIdx — номер Источника (1..N), откуда взята quote
5. paragraph — ТОЛЬКО номер пункта из текста вида 5.4 или 7.2.1. НИКОГДА не пиши туда номер источника («Источник 1», [1] и т.п.); если номера пункта в тексте нет — верни пустую строку
6. Число в конце строки оглавления после многоточия — это НОМЕР СТРАНИЦЫ, а не значение требования. Количественные значения (метры, миллиметры, этажи, люди) бери только из текста пунктов, никогда из оглавления
${TABLE_RULE}
8. Если в вопросе есть число N (этаж, метры, люди), а в контексте — лимит («не выше/не более/до N0», «не менее/от N0»): СРАВНИ числа. N нарушает лимит → ответ «Нет, не разрешено» с этим лимитом. N укладывается → «Да». Никогда не выводи разрешение из номеров строк таблицы
9. «Да»/«Нет» в начале ответа — ТОЛЬКО если вопрос прямо спрашивает разрешение («можно ли», «разрешено ли», «допускается ли», «запрещено ли»). На фактоид («минимальная ширина…?», «сколько…?», «какая…?», «чему равно…?») начинай с числа: «Минимум — ≥ …» / «Не менее …», БЕЗ «Да —».
10. Каждое число в answer обязано быть в выбранной quote. Не добавляй числа из других источников и не пересчитывай.
11. Сравнительный вопрос («чем отличаются», «сравните», «а если…») — перечисли требования по каждому случаю отдельными строками, каждое со своей нормой.
12. Если контекст покрывает вопрос лишь частично — ответь тем, что есть, и одной фразой укажи, чего именно в норме нет. Прятать частичный ответ нельзя.
${hist ? `\nИстория диалога (учитывай её, не повторяй уже сказанное):\n${hist}\n` : ``}${(valueLines ?? []).length ? `\nПроверенные числовые значения из индекса норм (приоритет над пересказом, используй дословно):\n${(valueLines ?? []).join("\n")}\n` : ``}`;
  const rebuildSuffix = secondPass
    ? "\n\n(Первый проход вернул «не найдено». Перечитай контекст внимательно: если есть ближайшее применимое требование или частичное покрытие — верни его с дословной цитатой. Если требования действительно нет — верни is_grounded=false.)"
    : "";
  const build = (extra: string, ctxs: string[]) =>
    `${head}\nКонтекст:\n${ctxs.map((c, i) => `Источник ${i + 1}: ${c}`).join("\n\n")}\n\n${hist ? "Уточняющий вопрос" : "Вопрос"}: ${query}${extra}${rebuildSuffix}`;
  return answerWithFallback(env, build, trimCtx, maxTokens, shortTrim);
}

function verifyGrounded(answer: any, contexts: string[]): boolean {
  if (!answer.is_grounded || !answer.quote) return !!answer.is_grounded;
  const q = normWs(answer.quote).toLowerCase();
  return contexts.some((c) => normWs(c).toLowerCase().includes(q));
}

export interface AnswerAttribution {
  answer: any;
  sources: Array<{ i: number; d: number; p: string; pg: number | null }> | null;
  claimIdx: number;
  skipCache: boolean;
}

/** Атомарная атрибуция: quote → чанк (sourceIdx модели или поиск по контекстам) → paragraph/page/sources
 *  только из ЭТОГО чанка. Смеси «п.4.4.1.37 + стр.101 + цитата таблицы» быть не должно. */
export function attributeAnswer(
  answer: any,
  promptContexts: string[],
  rawContexts: string[],
  ids: number[],
  chunks: CachedIndex["chunks"]
): AnswerAttribution {
  let skipCache = false;
  let resolvedSources: AnswerAttribution["sources"] = null;
  let claimIdx = 0;
  if (!answer.extractive) {
    const n = promptContexts.length;
    const normedCtx = promptContexts.map((c) => normWs(c).toLowerCase());
    const qNorm = normWs(String(answer.quote ?? "")).toLowerCase();
    let k = 0;
    const claimed = Number(answer.sourceIdx);
    if (Number.isInteger(claimed) && claimed >= 1 && claimed <= n) k = claimed - 1;
    if (qNorm && !normedCtx[k].includes(qNorm)) {
      const found = normedCtx.findIndex((c) => c.includes(qNorm));
      if (found >= 0) {
        k = found; // цитата из другого источника — двигаемся за ней
      } else {
        // недословная цитата на этом этапе — чиним и двигаем чанк за ней, в кэш — нет
        const rep = repairQuoteIdx(String(answer.quote ?? ""), promptContexts);
        answer = { ...answer, quote: rep.quote, sourceIdx: rep.idx + 1 };
        k = Math.min(Math.max(rep.idx, 0), n - 1);
        skipCache = true;
      }
    }
    claimIdx = k;
    const claimedChunk = chunks[ids[k]];
    const rawClaimed = rawContexts[k] || "";
    let para = cleanParagraphValue(answer.paragraph);
    // пункт обязан встречаться в тексте ТОГО ЖЕ чанка (иначе «п.4.3.2» при цитате таблицы)
    if (para && !normWs(rawClaimed).toLowerCase().includes(para.toLowerCase())) para = "";
    if (!para) para = String(claimedChunk?.p ?? "") || extractTableTitle(rawClaimed);
    answer = { ...answer, paragraph: para, page: claimedChunk?.pg ?? null, sourceIdx: k + 1 };
    const order = [k, ...Array.from({ length: n }, (_, j) => j).filter((j) => j !== k)];
    resolvedSources = order.map((j) => ({ i: ids[j], d: chunks[ids[j]].d, p: chunks[ids[j]].p, pg: chunks[ids[j]].pg }));
  }
  return { answer, sources: resolvedSources, claimIdx, skipCache };
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
/** Троттл /api/rewrite: 60 переформулировок в час на устройство (изолят-скоуп). */
const rewriteThrottle = new Map<string, { at: number; n: number }>();
/** Троттлы восстановления пароля: заявки 3/час, попытки ввода кода 5/час на устройство. */
const resetReqThrottle = new Map<string, { at: number; n: number }>();
const resetTryThrottle = new Map<string, { at: number; n: number }>();
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
        // Данные для авто-возврата, если провайдер упадёт уже после списания.
        let chargeSubject: string | null = null;
        let chargeIsUser = false;
        let chargeCost = 0;
        let chargeSplit: ChargeSplit | null = null;
        if (mode === "fast") {
          const { subject, isUser } = await subjectFromRequest(env, req);
          const lim = await getLimits(env);
          const res = await chargeHybrid(env, subject, isUser, lim.fast, "spend_fast");
          if (!res.ok) {
            return json(
              { error: "insufficient_credits", detail: "Недостаточно токенов для быстрого поиска", ...res.state, need: res.need },
              402,
              cors
            );
          }
          charged = res.state;
          chargeSubject = subject;
          chargeIsUser = isUser;
          chargeCost = lim.fast;
          chargeSplit = res.split ?? null;
        }
        try {
          const embedding = await embedQuery(env, query);
          return json(charged ? { embedding, credits: charged } : { embedding }, 200, cors);
        } catch (e: any) {
          // Деньги уже сняты, а эмбеддинга нет — возвращаем split и отдаём свежий баланс,
          // иначе ретрай фронта (до 3 попыток) превратится в 5×N за один поиск.
          let refundedState: CreditsState | null = null;
          let refunded = false;
          if (chargeSubject && chargeSplit) {
            try {
              await refundCharge(env, chargeSubject, chargeIsUser, chargeCost, chargeSplit, "refund_embed_provider");
              refundedState = await getCreditsState(env, chargeSubject, chargeIsUser);
              refunded = true;
            } catch {}
          }
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
                ...(refunded ? { refunded: true, credits: refundedState } : {}),
              },
              429,
              headers
            );
          }
          return json(
            {
              error: "embed_provider_failed",
              detail: e?.message ?? "embedding unavailable",
              provider,
              ...(refunded ? { refunded: true, credits: refundedState } : {}),
            },
            502,
            cors
          );
        }
      }

      // POST /api/rewrite {query, history?, followUp?} → {standalone, queries, terms}
      // Понимание запроса для ретривала: без списания, D1-кэш 30 дней, троттл 60/час на устройство.
      if (url.pathname === "/api/rewrite" && req.method === "POST") {
        const body = (await req.json()) as any;
        const query = String(body?.query ?? "").trim().slice(0, 400);
        if (!query) return json({ error: "query required" }, 400, cors);
        const deviceId = req.headers.get("X-Device-Id") || req.headers.get("CF-Connecting-IP") || "anon";
        const now = Date.now();
        const cur = rewriteThrottle.get(deviceId);
        if (!cur || now - cur.at > 3600_000) rewriteThrottle.set(deviceId, { at: now, n: 1 });
        else if (cur.n >= 60) {
          return json({ error: "rewrite_limit", detail: "Лимит переформулировок (60/час) — обновится позже" }, 429, cors);
        } else cur.n++;
        const history = Array.isArray(body?.history)
          ? body.history
              .slice(-2)
              .map((h: any) => ({ q: String(h?.q ?? "").slice(0, 300), a: String(h?.a ?? "").slice(0, 500) }))
          : [];
        try {
          const out = await rewriteSmart(env, query, { history, followUp: body?.followUp === true });
          if (body?.debug === true) return json({ ...out, raw: (out as any).__raw ?? "" }, 200, cors);
          return json(out, 200, cors);
        } catch (e: any) {
          console.error("rewrite failed", e?.message ?? e);
          return json({ standalone: query, queries: [], terms: [] }, 200, cors);
        }
      }

      // POST /api/eval/rerank {query, texts[]} → {order[], model} — только с X-Eval-Token (offline-eval).
      if (url.pathname === "/api/eval/rerank" && req.method === "POST") {
        if (!env.EVAL_TOKEN || req.headers.get("X-Eval-Token") !== env.EVAL_TOKEN) {
          return json({ error: "not_found" }, 404, cors);
        }
        const body = (await req.json()) as any;
        const query = String(body?.query ?? "").slice(0, 400);
        const texts: string[] = (Array.isArray(body?.texts) ? body.texts : [])
          .slice(0, 32)
          .map((t: any) => String(t ?? ""));
        if (!query || !texts.length) return json({ error: "query and texts required" }, 400, cors);
        const rr = await rerankContexts(
          env,
          query,
          texts,
          Math.min(8, texts.length),
          typeof body?.provider === "string" && body.provider ? body.provider : undefined
        );
        return json({ order: rr.order, model: rr.model, errors: rr.errors }, 200, cors);
      }

      // POST /api/voice (multipart audio) → {text} через Groq Whisper.
      // Резерв для Web Speech при ошибке network. Без списания токенов и записей в D1.
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
        // мейлера нет — формат почты строго на входе
        if (!EMAIL_RE.test(String(email).trim()))
          return json({ error: "Некорректный формат email" }, 400, cors);
        await ensureArchivedTable(env);
        await purgeExpiredArchive(env);
        const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
        if (exists) return json({ error: "email уже зарегистрирован" }, 409, cors);
        // почта удалённого аккаунта на архивном хранении — не отдаём (иначе аккаунт перехватят)
        const archived = await env.DB.prepare("SELECT purge_after FROM archived_users WHERE email=?").bind(email).first<{ purge_after: string }>();
        if (archived)
          return json(
            { error: "email_archived", detail: `Эта почта на архивном хранении до ${fmtRuDate(archived.purge_after)} — после этой даты регистрация станет доступна` },
            409,
            cors
          );
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
        if (!row) {
          // аккаунта нет — возможно, удалён: для владельца (пароль верный) показываем уведомление,
          // неверный пароль — обычная 401 (факт удаления не светим посторонним)
          await ensureArchivedTable(env);
          await purgeExpiredArchive(env);
          const arc = await env.DB.prepare(
            "SELECT full_name, password_hash, reason_title, reason_text, deleted_by, deleted_at, purge_after FROM archived_users WHERE email=?"
          )
            .bind(email)
            .first<{ full_name: string | null; password_hash: string; reason_title: string; reason_text: string; deleted_by: string; deleted_at: string; purge_after: string }>();
          if (arc && (await verifyPassword(password, arc.password_hash))) {
            return json(
              {
                error: "account_deleted",
                notice: {
                  full_name: arc.full_name,
                  reason_title: arc.reason_title,
                  reason_text: arc.reason_text,
                  deleted_by: arc.deleted_by,
                  deleted_at: arc.deleted_at,
                  purge_after: arc.purge_after,
                },
              },
              403,
              cors
            );
          }
          return json({ error: "неверный email или пароль" }, 401, cors);
        }
        if (!(await verifyPassword(password, row.password_hash))) return json({ error: "неверный email или пароль" }, 401, cors);
        return json(
          { uid: row.id, email, full_name: (row as any).full_name ?? null, token: await signJwt({ uid: row.id, email }, env.JWT_SECRET) },
          200,
          cors
        );
      }

      // POST /api/auth/reset-request {email} — заявка на сброс. Код выдаёт администратор
      // вручную (мейлеры отключены: телефонная верификация провайдеров недоступна).
      // Ответ всегда нейтральный: существование аккаунта не раскрываем.
      if (url.pathname === "/api/auth/reset-request" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const email = String(body.email ?? "").trim();
        if (!EMAIL_RE.test(email)) return json({ error: "bad_email", detail: "Проверьте email — выглядит опечаткой" }, 400, cors);
        // троттлинг 3/час на устройство: спамить заявки бесполезно
        const dev = req.headers.get("X-Device-Id") || "anon";
        const nowMs = Date.now();
        const tr = resetReqThrottle.get(dev);
        if (!tr || nowMs - tr.at > 3600_000) resetReqThrottle.set(dev, { at: nowMs, n: 1 });
        else if (tr.n >= 3) return json({ error: "reset_limit", detail: "Слишком много заявок — попробуйте через час" }, 429, cors);
        else tr.n += 1;

        const user = await env.DB.prepare("SELECT id, tg_chat_id FROM users WHERE email=?").bind(email).first<{ id: string; tg_chat_id: string | null }>();
        const archived = await env.DB.prepare("SELECT email FROM archived_users WHERE email=?").bind(email).first();
        if (!user || archived)
          return json({ ok: true, detail: "Заявка принята — администратор рассмотрит её" }, 200, cors);

        // Привязан Telegram → код летит в бота автоматически, без админа
        if (user.tg_chat_id) {
          const code = makeResetCode();
          const expires = new Date(nowMs + 30 * 60_000).toISOString();
          await ensureResetTable(env);
          await purgeExpiredResets(env);
          await env.DB.prepare(
            "INSERT INTO password_resets (email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, created_at=excluded.created_at, used_at=NULL"
          )
            .bind(email, await hashPassword(code), expires, new Date().toISOString())
            .run();
          try {
            await tgSendMessage(
              env,
              user.tg_chat_id,
              `Код сброса пароля snippy.llm: ${code}\n\nЖивёт 30 минут. Если это были не вы — игнорируйте, пароль не изменится.`
            );
            return json(
              { ok: true, detail: "Заявка принята. Если к аккаунту привязан Telegram, код уже в боте; иначе администратор выдаст код вручную." },
              200,
              cors
            );
          } catch (e: any) {
            console.error(`[reset] tg send failed: ${String(e?.message ?? e).slice(0, 120)}`);
            // TG не доставил — падаем в ручную заявку ниже
          }
        }

        // Заявка живёт 7 дней: за это время админ выдаёт код (код_hash='pending' до одобрения)
        await ensureResetTable(env);
        await purgeExpiredResets(env);
        await env.DB.prepare(
          "INSERT INTO password_resets (email, code_hash, expires_at, created_at) VALUES (?, 'pending', ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash='pending', expires_at=excluded.expires_at, created_at=excluded.created_at, used_at=NULL"
        )
          .bind(email, new Date(nowMs + 7 * 86400000).toISOString(), new Date().toISOString())
          .run();
        return json(
          { ok: true, detail: "Заявка принята. Администратор выдаст вам одноразовый код — свяжитесь с поддержкой: postalarchive@gmail.com" },
          200,
          cors
        );
      }

      // POST /api/auth/reset-confirm {email, code, password} — смена пароля по коду из письма
      if (url.pathname === "/api/auth/reset-confirm" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as any;
        const email = String(body.email ?? "").trim();
        const code = String(body.code ?? "").trim();
        const password = String(body.password ?? "");
        if (!EMAIL_RE.test(email) || password.length < 6)
          return json({ error: "bad_input", detail: "Email и пароль (6+) обязательны" }, 400, cors);
        // антибрутфорс: 5 попыток/час на устройство
        const dev = req.headers.get("X-Device-Id") || "anon";
        const nowMs = Date.now();
        const tr = resetTryThrottle.get(dev);
        if (!tr || nowMs - tr.at > 3600_000) resetTryThrottle.set(dev, { at: nowMs, n: 1 });
        else if (tr.n >= 5) return json({ error: "reset_limit", detail: "Слишком много попыток — попробуйте через час" }, 429, cors);
        else tr.n += 1;

        const generic = { error: "bad_code", detail: "Неверный или просроченный код" };
        await ensureResetTable(env);
        await purgeExpiredResets(env);
        const row = await env.DB.prepare("SELECT code_hash, expires_at, used_at FROM password_resets WHERE email=?").bind(email).first<{
          code_hash: string; expires_at: string; used_at: string | null;
        }>();
        if (!row || row.used_at || row.expires_at < new Date().toISOString() || !/\d{6}/.test(code))
          return json(generic, 400, cors);
        if (!(await verifyPassword(code, row.code_hash))) return json(generic, 400, cors);
        const upd = await env.DB.prepare("UPDATE users SET password_hash=? WHERE email=?").bind(await hashPassword(password), email).run();
        if (!Number((upd as any)?.meta?.changes ?? 0)) return json(generic, 400, cors); // юзер удалён между делом
        await env.DB.prepare("DELETE FROM password_resets WHERE email=?").bind(email).run();
        return json({ ok: true, detail: "Пароль обновлён — войдите с новым паролем" }, 200, cors);
      }

      // GET /api/tg/link — одноразовая глубокая ссылка привязки Telegram (живёт 15 мин)
      if (url.pathname === "/api/tg/link" && req.method === "GET") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const { payload } = await verifyJwtWithReason(auth.slice(7), env.JWT_SECRET);
        if (!payload?.uid) return json({ error: "unauthorized" }, 401, cors);
        if (!env.TG_BOT_TOKEN || !env.TG_BOT_USERNAME)
          return json({ error: "tg_not_configured", detail: "Telegram-бот ещё не подключён" }, 503, cors);
        await ensureTgLinkTokens(env);
        await purgeExpiredTgTokens(env);
        const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare("INSERT INTO tg_link_tokens (token, uid, created_at) VALUES (?, ?, ?)")
          .bind(token, String(payload.uid), new Date().toISOString())
          .run();
        return json({ url: `https://t.me/${env.TG_BOT_USERNAME}?start=${token}` }, 200, cors);
      }

      // POST /api/tg/unlink — отвязать свой Telegram
      if (url.pathname === "/api/tg/unlink" && req.method === "POST") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const { payload } = await verifyJwtWithReason(auth.slice(7), env.JWT_SECRET);
        if (!payload?.uid) return json({ error: "unauthorized" }, 401, cors);
        await ensureUserTgColumns(env);
        await env.DB.prepare("UPDATE users SET tg_chat_id=NULL, tg_username=NULL WHERE id=?").bind(String(payload.uid)).run();
        return json({ ok: true }, 200, cors);
      }

      // POST /api/tg/webhook/<secret> — апдейты Telegram: /start <token> привязывает аккаунт
      if (url.pathname.startsWith("/api/tg/webhook/") && req.method === "POST") {
        const seg = url.pathname.slice("/api/tg/webhook/".length);
        if (!env.TG_WEBHOOK_SECRET || seg !== env.TG_WEBHOOK_SECRET) return json({ error: "not found" }, 404, cors);
        const update = (await req.json().catch(() => ({}))) as any;
        const msg = update?.message;
        const chatId = msg?.chat?.id != null ? String(msg.chat.id) : null;
        const fromUsername = msg?.from?.username ?? null;
        const text = String(msg?.text ?? "");
        const startPayload = text.startsWith("/start ") ? text.slice(7).trim() : "";
        await ensureUserTgColumns(env);
        await ensureTgLinkTokens(env);
        await purgeExpiredTgTokens(env);
        if (chatId && startPayload) {
          const row = await env.DB.prepare("SELECT uid FROM tg_link_tokens WHERE token=?").bind(startPayload).first<{ uid: string }>();
          if (row) {
            await env.DB.batch([
              env.DB.prepare("UPDATE users SET tg_chat_id=?, tg_username=? WHERE id=?").bind(chatId, fromUsername, row.uid),
              env.DB.prepare("DELETE FROM tg_link_tokens WHERE token=?").bind(startPayload),
            ]);
            await tgSendMessage(env, chatId, "✅ Telegram привязан к вашему аккаунту snippy.llm. Теперь коды восстановления приходят сюда.").catch((e) =>
              console.error(`[tg] confirm send failed: ${String(e?.message ?? e).slice(0, 120)}`)
            );
          }
        } else if (chatId) {
          await tgSendMessage(
            env,
            chatId,
            "Это бот восстановления snippy.llm. Чтобы привязать аккаунт: зайдите на сайт → Профиль → «Привязать Telegram» — ссылка придёт сюда автоматически."
          ).catch(() => {});
        }
        return json({ ok: true }, 200, cors);
      }

      // GET /api/me — профиль: uid/email/имя/кулдаун смены/токены
      if (url.pathname === "/api/me" && req.method === "GET") {
        const auth = req.headers.get("Authorization");
        if (!auth?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401, cors);
        const { payload, reason } = await verifyJwtWithReason(auth.slice(7), env.JWT_SECRET);
        if (!payload) {
          return json({ error: reason === "expired" ? "token_expired" : "invalid_token" }, 401, {
            ...cors,
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          });
        }
        await ensureUserNameColumns(env);
  const { subject, isUser } = await subjectFromRequest(env, req);
  const credits = await getCreditsState(env, subject, isUser);
        let full_name: string | null = null;
        let name_changed_at: string | null = null;
        let created_at: string | null = null;
        let tg_chat_id: string | null = null;
        let tg_username: string | null = null;
        try {
          const urow = await env.DB.prepare("SELECT full_name, name_changed_at, created_at, tg_chat_id, tg_username FROM users WHERE id=?")
            .bind(String(payload.uid))
            .first<{ full_name: string | null; name_changed_at: string | null; created_at: string | null; tg_chat_id: string | null; tg_username: string | null }>();
          full_name = urow?.full_name ?? null;
          name_changed_at = urow?.name_changed_at ?? null;
          created_at = urow?.created_at ?? null;
          tg_chat_id = urow?.tg_chat_id ?? null;
          tg_username = urow?.tg_username ?? null;
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
            telegram: {
              linked: Boolean(tg_chat_id),
              username: tg_username,
            },
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
            { error: "insufficient_credits", detail: "Недостаточно токенов", ...res.state, need: res.need },
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
        if (!pack && !plan) return json({ error: "unknown_sku", detail: `Неизвестный тариф: ${sku}` }, 400, cors);
        if (plan && !payload.uid) return json({ error: "unauthorized" }, 401, cors);

        const now = new Date();
        // Даунгрейд на Free: отменяем подписку, план сразу становится free.
        if (sku === "free" || sku === "sub_free") {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM subscriptions WHERE subject=?").bind(subject),
            env.DB.prepare("INSERT INTO purchases (id, subject, sku, credits, status, created_at) VALUES (?, ?, 'free', 0, 'demo', ?)").bind(
              crypto.randomUUID(),
              subject,
              now.toISOString()
            ),
            env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, 0, 'subscription', ?, ?)").bind(
              subject,
              JSON.stringify({ sku: "free", downgrade: true, demo: true }),
              now.toISOString()
            ),
          ]);
          const state = await getCreditsState(env, subject, !!payload.uid);
          return json({ ok: true, demo: true, ...state }, 200, cors);
        }
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
        const tAsk0 = Date.now();

        const cost = isFollowUp ? lim.followup : lim.deep;
        const spendKind = isFollowUp ? "spend_followup" : "spend_deep";
        const refundKind = isFollowUp ? "refund_followup" : "refund_deep";

        // Кэш ответов — ДО списания: повторный вопрос бесплатен
        // (cached:true, free:true). Тег сборки в ключе: после обновления норм старые ответы не отдаём.
        const askMode = body.mode === "deep" ? "deep" : "fast";
        let cacheHash = "";
        if (!isFollowUp) {
          try {
            let buildTag = "none";
            try {
              buildTag = (await getIndexManifest(env)).builtAt || "none";
            } catch {}
            cacheHash = await askCacheKey(query, askMode, buildTag);
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
                    const cachedState = await getCreditsState(env, subject, isUser);
                    return json(
                      { answer: cached, provider: "cache", sources: cachedSources || [], credits: cachedState, took_ms: Date.now() - tAsk0, cached: true, free: true },
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

        const spend = await chargeHybrid(env, subject, isUser, cost, spendKind);
        if (!spend.ok || !spend.split) {
          return json(
            { error: "insufficient_credits", detail: isFollowUp ? "Недостаточно токенов для уточняющего вопроса" : "Недостаточно токенов для глубокого поиска", ...spend.state, need: spend.need },
            402,
            cors
          );
        }
        const state = await getCreditsState(env, subject, isUser);

        // Карточки значений: фактоидный вопрос с заземлёнными фактами — БЕЗ LLM и БЕСПЛАТНО.
        // Списание выше тут же возвращаем: это локальные данные, а не работа модели.
        // Незаземлённые строки карточек (редкость) — в LLM-промпт как проверенные значения.
        let valueLines: string[] = [];
        let vcScored: Array<{ hit: ValueCardHit; rel: number; ord: number; docHit: boolean; paramOrig: boolean; num: number }> = [];
        if (!isFollowUp) {
          try {
            const vc = await tryValuesAnswer(env, query);
            if (vc?.answer) {
              let valuesState = state;
              try {
                await refundCharge(env, subject, isUser, cost, spend.split, refundKind);
                valuesState = await getCreditsState(env, subject, isUser);
              } catch {}
              return json(
                {
                  answer: vc.answer, provider: "values", sources: vc.sources,
                  credits: valuesState, took_ms: Date.now() - tAsk0, free: true,
                },
                200,
                cors
              );
            }
            if (vc?.lines?.length) valueLines = vc.lines.slice(0, 4);
            if (vc?.scored?.length) vcScored = vc.scored;
          } catch {}
        }

        const idx = await loadIndex(env);
        // Роутер сложности: глубина контекста и лимит токенов по типу вопроса.
        const askRoute = classifyAsk(query, isFollowUp);
        const contextTopN = askRoute === "complex" ? 8 : askRoute === "simple" ? 4 : 6;
        let ids: number[];
        let rerankModel = "none";
        let candidatesCount = 0;
        try {
          // Клиент присылает до 32 кандидатов (hybrid top + rewrite-расширение); cross-encoder выбирает лучшие top-N.
          const candRaw = Array.isArray(body.candidates) && body.candidates.length ? body.candidates : body.chunkIds;
          if (Array.isArray(candRaw) && candRaw.length) {
            ids = candRaw.map(Number).filter((i: number) => i >= 0 && i < idx.count).slice(0, 32);
          } else {
            ids = await vectorTopK(env, query, 12);
          }
          candidatesCount = ids.length;
          if (ids.length > contextTopN) {
            let rerankOn = true;
            try {
              const { values } = await getSettings(env);
              rerankOn = settingInt(values, "smart_rerank", "1") === 1;
            } catch {}
            if (rerankOn) {
              const texts = ids.map((i) => String(idx.chunks[i]?.t ?? ""));
              const rr = await rerankContexts(env, query, texts, contextTopN);
              if (rr.order.length) ids = rr.order.map((k) => ids[k]);
              rerankModel = rr.model;
            } else {
              ids = ids.slice(0, contextTopN);
            }
          }
          // Numeric-запрос: лучший values-факт принудительно в контекст (бесплатно).
          // Иначе top-3 вектора может оставить только таблицу-ловушку (А.1 со строками
          // 6/7), а правильная норма («не выше пятого») до LLM не дойдёт вообще.
          if (vQueryNumbersFull(query).length && vcScored.length) {
            const bestV = [...vcScored].sort(
              (a, b) => Number(b.docHit) - Number(a.docHit) || b.rel - a.rel
            )[0];
            const vi = bestV?.hit?.fact?.i;
            if (Number.isInteger(vi) && (vi as number) >= 0 && (vi as number) < idx.count && !ids.includes(vi as number)) {
              ids = [...ids, vi as number].slice(0, contextTopN + 1);
            }
          }
          const rawContexts = ids.map((i) => idx.chunks[i]?.t).filter(Boolean);
          if (!rawContexts.length) {
            let emptyState = state;
            try {
              await refundCharge(env, subject, isUser, cost, spend.split, refundKind);
              emptyState = await getCreditsState(env, subject, isUser);
            } catch {}
            return json({ answer: { answer: "Индекс пуст.", is_grounded: false }, took_ms: 0, credits: emptyState, refunded: true }, 200, cors);
          }
          // Чистим оглавления/линейки до промпта: модель не должна путать номер страницы со значением
          const contexts = rawContexts.map(sanitizeContextText).filter(Boolean);
          if (!contexts.length) {
            let noCtxState = state;
            try {
              await refundCharge(env, subject, isUser, cost, spend.split, refundKind);
              noCtxState = await getCreditsState(env, subject, isUser);
            } catch {}
            return json({ answer: { answer: "В доступной нормативной базе точного требования не найдено.", quote: "", paragraph: "", is_grounded: false }, took_ms: 0, credits: noCtxState, refunded: true }, 200, cors);
          }
          // Табличные контексты помечаем: первое число строки — номер строки, не значение
          const promptContexts = contexts.map((t, k) => {
            const ty = (idx.chunks[ids[k]] as any)?.ty;
            return isTableLike(t, ty) ? `${TABLE_NOTE}\n${t}` : t;
          });
          // paragraph первого чанка больше не используется как кросс-чаночный фолбэк
          // (см. атомарную атрибуцию ниже) — переменная оставлена для отладки экстрактива.
          const firstChunk = idx.chunks[ids[0]];
          void firstChunk;

          const maxTokens = askRoute === "complex" ? 1200 : askRoute === "simple" ? 600 : body.mode === "deep" ? 1000 : 800;
          const t0 = Date.now();
          let answer: any;
          let provider: LlmProvider = "groq";
          let collapseWhy = "";
          try {
            ({ answer, provider } = await askGroq(env, query, promptContexts, maxTokens, isFollowUp ? history : undefined, valueLines));
          } catch (e: any) {
            // вся LLM-цепочка легла → экстрактивный ответ из цитат (бесконечно, без ИИ)
            collapseWhy = (e as any)?.budgetExhausted
              ? "budgets"
              : dominantCause(((e as any)?.llmCauses ?? { rate429: 0, badJson: 0, other: 0 }) as LlmCauses);
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
          // paragraph от модели валидируем + атомарная атрибуция одной цепочкой:
          // quote → чанк (sourceIdx модели или поиск по контекстам) → paragraph/page/sources
          // только из ЭТОГО чанка. Смеси «п.4.4.1.37 + стр.101 + цитата таблицы» больше нет.
          let att = attributeAnswer(answer, promptContexts, rawContexts, ids, idx.chunks);
          answer = att.answer;
          let skipCache = att.skipCache;
          let finalAnswer = { ...answer, is_grounded: answer.extractive ? true : verifyGrounded(answer, answer.extractive ? promptContexts : [promptContexts[att.claimIdx]]) };
          let finalSources = att.sources ?? ids.map((i) => ({ i, d: idx.chunks[i].d, p: idx.chunks[i].p, pg: idx.chunks[i].pg }));
          // Второй проход: первый ответ — «не найдено» → перечитываем контекст с мягкой инструкцией.
          let secondPassUsed = false;
          if (!answer.extractive && !finalAnswer.is_grounded) {
            let spOn = true;
            try {
              const { values } = await getSettings(env);
              spOn = settingInt(values, "smart_second_pass", "1") === 1;
            } catch {}
            if (spOn && !isFollowUp) {
              secondPassUsed = true;
              try {
                const retry = await askGroq(env, query, promptContexts, maxTokens, undefined, valueLines, true);
                const att2 = attributeAnswer(retry.answer, promptContexts, rawContexts, ids, idx.chunks);
                const g2 = retry.answer.extractive ? true : verifyGrounded(att2.answer, [promptContexts[att2.claimIdx]]);
                if (g2) {
                  answer = att2.answer;
                  provider = retry.provider;
                  skipCache = att2.skipCache;
                  finalAnswer = { ...att2.answer, is_grounded: true };
                  finalSources = att2.sources ?? finalSources;
                }
              } catch (e: any) {
                console.error(`[second-pass] ${String(e?.message ?? e).slice(0, 120)}`);
              }
            }
          }
          // Детерминированный gate «вердикт vs числа»: противоречие лимиту → override шаблоном.
          let vOverridden = false;
          if (!answer.extractive && finalAnswer.is_grounded) {
            try {
              const gate = vNumericGate({
                query, answerText: String(finalAnswer.answer ?? ""),
                scored: vcScored, promptContexts, rawContexts, ids, chunks: idx.chunks,
                docs: (await loadValues(env))?.docs ?? [],
              });
              if (gate) {
                finalAnswer = {
                  ...finalAnswer,
                  answer: gate.answer,
                  normative_basis: gate.cite.docNumber || finalAnswer.normative_basis || "",
                  paragraph: gate.cite.p || "",
                  page: gate.cite.pg,
                  quote: gate.cite.quote || finalAnswer.quote || "",
                  numeric_override: true,
                };
                finalSources = [{ i: gate.cite.i, d: gate.cite.d, p: gate.cite.p, pg: gate.cite.pg }];
                vOverridden = true;
              }
            } catch {}
          }
          // Санитизация ложного «Да —»/«Нет —» на фактоидах: вопрос не про разрешение,
          // а LLM начал с вердикта → срезаем префикс, число остается hero-кандидатом.
          // Gate-override выше уже отработал только для permission-вопросов, его не трогаем.
          if (!answer.extractive && !vOverridden && !isPermissionQuestion(query) && typeof finalAnswer.answer === "string") {
            const stripped = stripLeadingYesNo(finalAnswer.answer);
            if (stripped !== finalAnswer.answer) finalAnswer = { ...finalAnswer, answer: stripped };
          }
          // Метрика роутера/rerank/второго прохода в ledger.meta (+1 write, дёшево и информативно).
          try {
            await env.DB.prepare(
              "UPDATE ledger SET meta=? WHERE id=(SELECT MAX(id) FROM ledger WHERE subject=? AND kind=?)"
            )
              .bind(JSON.stringify({ split: spend.split, llm: provider, route: askRoute, cands: candidatesCount, rerank: rerankModel, sp: secondPassUsed ? 1 : 0, g: finalAnswer.is_grounded ? 1 : 0, ...(provider === "extractive" && collapseWhy ? { why: collapseWhy } : {}) }), subject, spendKind)
              .run();
          } catch {}
          // Кэш: только не-экстрактив и только чистая атрибуция (коллапсы и
          // отремонтированные цитаты не кэшируем — иначе яд живёт 48ч).
          if (!isFollowUp && cacheHash && !answer.extractive && !skipCache) {
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
          // внутренняя ошибка — возвращаем списанные токены (await: баланс в ответе уже свежий)
          try {
            await refundCharge(env, subject, isUser, cost, spend.split, refundKind);
          } catch {}
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

      // ---------- Фидбек под ответом: 👍/👎 + причина + коммент. Без списания токенов. ----------
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
                  {
                    id: "gemini",
                    key_set: !!env.GEMINI_API_KEY,
                    alts: [env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4].filter(Boolean).length,
                    alt_model: env.GEMINI_ALT_MODEL ?? "gemini-2.5-flash-lite",
                  },
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
                mailer: {
                  brevo: !!env.BREVO_API_KEY,
                  sendgrid: !!env.SENDGRID_API_KEY,
                  from: env.MAIL_FROM ?? "postalarchive@gmail.com",
                },
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
          // Шаблоны писем об удалении: строковые, до 2000 знаков (в отличие от числовых квот)
          const customIds = (await getCustomReasons(env)).map((r) => r.id);
          const isTpl =
            (key.startsWith("del_tpl_") && DELETION_REASONS.some((r) => r.id === key.slice("del_tpl_".length))) ||
            (key.startsWith("del_tpl_c_") && customIds.includes(key.slice("del_tpl_".length)));
          if (isTpl) {
            const text = String(body.value ?? "").trim().slice(0, 2000);
            await ensureSettingsTable(env);
            await env.DB.prepare(
              "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
            )
              .bind(key, text, new Date().toISOString())
              .run();
            settingsCache = null;
            return json({ ok: true, key, value: text }, 200, cors);
          }
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
          // Состояние LLM-пула: бюджеты/брейкеры на сегодня (для Admiral: видно, кто в дауне).
          let llmPool: Array<{ id: string; cap: number; used: number; down: boolean }> = [];
          try {
            const [hVals, hStates] = await Promise.all([getSettings(env), getLlmBudgetStates(env)]);
            const hNow = Date.now();
            const agg = new Map<string, { used: number; down: boolean }>();
            for (const [key, st] of hStates) {
              const pid = key.split("\n")[0];
              const cur = agg.get(pid) ?? { used: 0, down: false };
              cur.used += st.used;
              if (st.downUntil > hNow) cur.down = true;
              agg.set(pid, cur);
            }
            llmPool = Object.keys(LLM_BUDGET_DEFAULTS).map((pid) => ({
              id: pid,
              cap: llmBudgetCap(hVals.values ?? {}, pid),
              used: agg.get(pid)?.used ?? 0,
              down: agg.get(pid)?.down ?? false,
            }));
          } catch {}
          // Смарт-метрики за сутки: grounded/not-found, второй проход, rerank-звено, кэш.
          let smart: Record<string, number> = {};
          try {
            const row = await env.DB.prepare(
              `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN meta LIKE '%"g":1%' THEN 1 ELSE 0 END),0) AS grounded,
                COALESCE(SUM(CASE WHEN meta LIKE '%"g":0%' THEN 1 ELSE 0 END),0) AS not_found,
                COALESCE(SUM(CASE WHEN meta LIKE '%"sp":1%' THEN 1 ELSE 0 END),0) AS second_pass,
                COALESCE(SUM(CASE WHEN meta LIKE '%"rerank":"voyage-rerank"%' THEN 1 ELSE 0 END),0) AS rr_voyage,
                COALESCE(SUM(CASE WHEN meta LIKE '%"rerank":"cohere-rerank"%' THEN 1 ELSE 0 END),0) AS rr_cohere,
                COALESCE(SUM(CASE WHEN meta LIKE '%"rerank":"llm-rerank"%' THEN 1 ELSE 0 END),0) AS rr_llm,
                COALESCE(SUM(CASE WHEN meta LIKE '%"llm":"cache"%' THEN 1 ELSE 0 END),0) AS cache
               FROM ledger WHERE kind LIKE 'spend_%' AND created_at >= datetime('now','-1 day')`
            ).first<Record<string, number>>();
            if (row) smart = row;
          } catch {}
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
              llm: llmPool,
              smart,
              billing: { plans: PLANS, packs: PACKS },
            },
            200,
            cors
          );
        }
        // POST /api/admin/set-password {uid, password} — суперадмин задаёт пользователю новый пароль
        if (url.pathname === "/api/admin/set-password" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const uid = String(body.uid ?? "").slice(0, 64);
          const password = String(body.password ?? "");
          if (!uid) return json({ error: "uid required" }, 400, cors);
          if (password.length < 6 || password.length > 128)
            return json({ error: "bad_password", detail: "Пароль — от 6 до 128 символов" }, 400, cors);
          const user = await env.DB.prepare("SELECT id, email FROM users WHERE id=?").bind(uid).first<{ id: string; email: string }>();
          if (!user) return json({ error: "user not found" }, 404, cors);
          await env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?")
            .bind(await hashPassword(password), uid)
            .run();
          // аудит: 0-дельта запись в ledger с исполнителем
          await env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, 0, 'admin', ?, ?)").bind(
            `user:${uid}`,
            JSON.stringify({ admin_password_set: true, by: admin.email }),
            new Date().toISOString()
          ).run();
          return json({ ok: true, email: user.email }, 200, cors);
        }

        // GET /api/admin/reset-requests — заявки на сброс пароля (ожидающие + с выданным кодом)
        if (url.pathname === "/api/admin/reset-requests" && req.method === "GET") {
          await ensureResetTable(env);
          await purgeExpiredResets(env);
          const rows = await env.DB.prepare(
            "SELECT email, code_hash, created_at, expires_at FROM password_resets ORDER BY created_at DESC LIMIT 100"
          ).all();
          const requests = (rows.results ?? []).map((r: any) => ({
            email: r.email,
            created_at: r.created_at,
            expires_at: r.expires_at,
            state: r.code_hash === "pending" ? "pending" : "coded",
          }));
          return json({ requests }, 200, cors);
        }

        // POST /api/admin/reset-approve {email} — выдать одноразовый код (возвращается один раз, хранится хешем)
        if (url.pathname === "/api/admin/reset-approve" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const email = String(body.email ?? "").slice(0, 200);
          if (!email) return json({ error: "email required" }, 400, cors);
          await ensureResetTable(env);
          const exists = await env.DB.prepare("SELECT email FROM password_resets WHERE email=?").bind(email).first();
          if (!exists) return json({ error: "not found" }, 404, cors);
          const code = makeResetCode();
          await env.DB.prepare(
            "UPDATE password_resets SET code_hash=?, expires_at=? WHERE email=?"
          )
            .bind(await hashPassword(code), new Date(Date.now() + 3600_000).toISOString(), email)
            .run();
          return json({ ok: true, code, expires_in_minutes: 60 }, 200, cors);
        }

        // POST /api/admin/reset-reject {email} — отклонить заявку
        if (url.pathname === "/api/admin/reset-reject" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const email = String(body.email ?? "").slice(0, 200);
          if (!email) return json({ error: "email required" }, 400, cors);
          await ensureResetTable(env);
          await env.DB.prepare("DELETE FROM password_resets WHERE email=?").bind(email).run();
          return json({ ok: true }, 200, cors);
        }

        // GET /api/admin/deletion-reasons — эффективные причины (дефолты + свои), с текстами по умолчанию
        if (url.pathname === "/api/admin/deletion-reasons" && req.method === "GET") {
          return json({ reasons: await effectiveReasons(env) }, 200, cors);
        }

        // POST /api/admin/reasons-add {title} — своя причина удаления (id генерируется)
        if (url.pathname === "/api/admin/reasons-add" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const title = String(body.title ?? "").trim().slice(0, 100);
          if (title.length < 3) return json({ error: "bad_title", detail: "Название — от 3 символов" }, 400, cors);
          const custom = await getCustomReasons(env);
          if (custom.length >= 10) return json({ error: "too_many", detail: "Максимум 10 своих причин" }, 400, cors);
          const id = "c_" + [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
          custom.push({ id, title });
          await ensureSettingsTable(env);
          await env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES ('del_tpl_custom', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
          )
            .bind(JSON.stringify(custom), new Date().toISOString())
            .run();
          settingsCache = null;
          return json({ ok: true, id, title }, 200, cors);
        }

        // POST /api/admin/reasons-remove {id} — удалить свою причину (и её шаблон)
        if (url.pathname === "/api/admin/reasons-remove" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const id = String(body.id ?? "").slice(0, 24);
          if (!id.startsWith("c_")) return json({ error: "bad_id", detail: "Свои причины удалять можно, встроенные — нет" }, 400, cors);
          const custom = (await getCustomReasons(env)).filter((r) => r.id !== id);
          await ensureSettingsTable(env);
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO settings (key, value, updated_at) VALUES ('del_tpl_custom', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
            ).bind(JSON.stringify(custom), new Date().toISOString()),
            env.DB.prepare("DELETE FROM settings WHERE key=?").bind(`del_tpl_${id}`),
          ]);
          settingsCache = null;
          return json({ ok: true }, 200, cors);
        }

        // GET /api/admin/archived — архив удалённых аккаунтов (+ ленивая чистка просроченных)
        if (url.pathname === "/api/admin/archived" && req.method === "GET") {
          await ensureArchivedTable(env);
          await purgeExpiredArchive(env);
          const rows = await env.DB.prepare(
            "SELECT email, uid, full_name, reason_title, reason_text, deleted_by, deleted_at, purge_after FROM archived_users ORDER BY deleted_at DESC LIMIT 200"
          ).all();
          const archived = (rows.results ?? []).map((r: any) => ({
            ...r,
            days_left: Math.max(0, Math.ceil((Date.parse(r.purge_after) - Date.now()) / 86400000)),
          }));
          return json({ archived }, 200, cors);
        }

        // POST /api/admin/delete-user {uid, reason, reason_text?} — удаление в архив на 30 дней
        if (url.pathname === "/api/admin/delete-user" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const uid = String(body.uid ?? "").slice(0, 64);
          if (!uid) return json({ error: "uid required" }, 400, cors);
          const allReasons = await effectiveReasons(env);
          const reason = allReasons.find((r) => r.id === body.reason) ?? allReasons[allReasons.length - 1];
          const user = await env.DB.prepare("SELECT id, email, password_hash, full_name, created_at FROM users WHERE id=?").bind(uid).first<{
            id: string; email: string; password_hash: string; full_name: string | null; created_at: string | null;
          }>();
          if (!user) return json({ error: "user not found" }, 404, cors);
          await ensureArchivedTable(env);
          const nowIso = new Date().toISOString();
          const purgeAfter = new Date(Date.now() + ARCHIVE_DAYS * 86400000).toISOString();
          const name = normalizeName(user.full_name);
          const tpl = reason.template;
          const text = buildDeletionText(name, String(body.reason_text ?? "").trim() || tpl);
          if (!text.replace(`Уважаемый ${name || "пользователь"}!`, "").trim())
            return json({ error: "empty_text", detail: "Опишите причину — текст письма пуст" }, 400, cors);
          const subject = `user:${uid}`;
          const bal = await env.DB.prepare("SELECT credits FROM balances WHERE subject=?").bind(subject).first<{ credits: number }>();
          const take = bal?.credits ?? 0;
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO archived_users (email, uid, full_name, password_hash, created_at, reason, reason_title, reason_text, deleted_by, deleted_at, purge_after) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET uid=excluded.uid, full_name=excluded.full_name, password_hash=excluded.password_hash, created_at=excluded.created_at, reason=excluded.reason, reason_title=excluded.reason_title, reason_text=excluded.reason_text, deleted_by=excluded.deleted_by, deleted_at=excluded.deleted_at, purge_after=excluded.purge_after"
            ).bind(user.email, user.id, name || null, user.password_hash, user.created_at, reason.id, reason.title, text, admin.email, nowIso, purgeAfter),
            env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid),
            env.DB.prepare(
              "INSERT INTO balances (subject, credits, updated_at) VALUES (?, 0, ?) ON CONFLICT(subject) DO UPDATE SET credits=0, updated_at=excluded.updated_at"
            ).bind(subject, nowIso),
            env.DB.prepare("INSERT INTO ledger (subject, delta, kind, meta, created_at) VALUES (?, ?, 'grant', ?, ?)").bind(
              subject,
              -take,
              JSON.stringify({ deleted: true, by: admin.email, reason: reason.id }),
              nowIso
            ),
          ]);
          return json({ ok: true, purge_after: purgeAfter }, 200, cors);
        }

        // POST /api/admin/restore-user {email} — возврат из архива до конца срока
        if (url.pathname === "/api/admin/restore-user" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as any;
          const email = String(body.email ?? "").slice(0, 200);
          if (!email) return json({ error: "email required" }, 400, cors);
          await ensureArchivedTable(env);
          await purgeExpiredArchive(env);
          const arc = await env.DB.prepare(
            "SELECT email, uid, full_name, password_hash, created_at FROM archived_users WHERE email=?"
          ).bind(email).first<{ email: string; uid: string; full_name: string | null; password_hash: string; created_at: string | null }>();
          if (!arc) return json({ error: "not in archive" }, 404, cors);
          const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
          if (exists) return json({ error: "email уже занят живым аккаунтом" }, 409, cors);
          await env.DB.batch([
            env.DB.prepare("INSERT INTO users (id, email, password_hash, full_name, created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, password_hash=excluded.password_hash, full_name=excluded.full_name")
              .bind(arc.uid, arc.email, arc.password_hash, arc.full_name, arc.created_at ?? new Date().toISOString()),
            env.DB.prepare("DELETE FROM archived_users WHERE email = ?").bind(email),
          ]);
          return json({ ok: true }, 200, cors);
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
      // Наружу — generic: сырые сообщения D1/провайдеров не утекают клиенту.
      console.error("unhandled /api error:", e?.stack || e?.message || e);
      return json({ error: "internal_error" }, 500, cors);
    }
  },
};
