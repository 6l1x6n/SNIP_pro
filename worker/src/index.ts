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
  CREDITS_ANON: string; // 30
  CREDITS_USER: string; // 50
  ASK_COST: string; // 10
}

const CORS_HEADERS = (env: Env, origin: string | null): Record<string, string> => {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  const ok = origin && (allowed.includes(origin) || allowed.some((a) => a.endsWith("*") && origin.startsWith(a.slice(0, -1))));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : allowed[0] ?? "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
      const [bin, chunksRes] = await Promise.all([fetch(`${base}/vectors.bin`), fetch(`${base}/chunks.json`)]);
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.EMBED_MODEL}:embedContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ taskType: "RETRIEVAL_QUERY", content: { parts: [{ text: query }] }, outputDimensionality: 768 }),
  });
  if (!r.ok) throw new Error(`gemini embed ${r.status}`);
  const d: any = await r.json();
  const v: number[] = d.embedding.values;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
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

// ---------- Кредиты ----------

const todayKey = (): string => new Date().toISOString().slice(0, 10);

async function getCredits(env: Env, subject: string, isUser: boolean): Promise<{ used: number; limit: number }> {
  const limit = isUser ? Number(env.CREDITS_USER) : Number(env.CREDITS_ANON);
  const row = await env.DB.prepare("SELECT count FROM usage WHERE day=? AND subject=?").bind(todayKey(), subject).first<{ count: number }>();
  return { used: row?.count ?? 0, limit };
}

async function spendCredits(env: Env, subject: string, isUser: boolean, cost: number): Promise<{ ok: boolean; remaining: number; limit: number }> {
  const { used, limit } = await getCredits(env, subject, isUser);
  if (used + cost > limit) return { ok: false, remaining: Math.max(0, limit - used), limit };
  await env.DB.prepare(
    "INSERT INTO usage (day, subject, count) VALUES (?, ?, ?) ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count"
  )
    .bind(todayKey(), subject, cost)
    .run();
  return { ok: true, remaining: limit - used - cost, limit };
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
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d: any = await r.json();
  return JSON.parse(d.choices[0].message.content);
}

function verifyGrounded(answer: any, contexts: string[]): boolean {
  if (!answer.is_grounded || !answer.quote) return !!answer.is_grounded;
  const q = normWs(answer.quote).toLowerCase();
  return contexts.some((c) => normWs(c).toLowerCase().includes(q));
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
        const credits = await getCredits(env, subject, isUser);
        return json({ uid: payload.uid, email: payload.email, credits }, 200, cors);
      }

      // GET /api/credits — остаток для текущего субъекта
      if (url.pathname === "/api/credits" && req.method === "GET") {
        const { subject, isUser } = await subjectFromRequest(env, req);
        return json(await getCredits(env, subject, isUser), 200, cors);
      }

      // POST /api/ask {query, mode?, chunkIds?} → списывает кредиты, Groq с заземлением
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const body = (await req.json()) as any;
        const query = String(body.query ?? "").trim();
        if (!query) return json({ error: "query required" }, 400, cors);

        const { subject, isUser } = await subjectFromRequest(env, req);
        const spend = await spendCredits(env, subject, isUser, Number(env.ASK_COST));
        if (!spend.ok) {
          return json(
            { error: "quota_exceeded", detail: "Дневной лимит ИИ-запросов исчерпан. Зарегистрируйтесь или приходите завтра." },
            429,
            { ...cors, "X-Credits-Remaining": String(spend.remaining), "X-Credits-Limit": String(spend.limit) }
          );
        }
        const creditHeaders = { "X-Credits-Remaining": String(spend.remaining), "X-Credits-Limit": String(spend.limit) };

        const idx = await loadIndex(env);
        let ids: number[];
        if (Array.isArray(body.chunkIds) && body.chunkIds.length) {
          ids = body.chunkIds.map(Number).filter((i: number) => i >= 0 && i < idx.count).slice(0, 5);
        } else {
          ids = await vectorTopK(env, query, body.mode === "deep" ? 5 : 3);
        }
        const contexts = ids.map((i) => idx.chunks[i]?.t).filter(Boolean);
        if (!contexts.length) return json({ answer: { answer: "Индекс пуст.", is_grounded: false }, took_ms: 0, ...creditHeaders }, 200, cors);

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
            took_ms: Date.now() - t0,
          },
          200,
          { ...cors, ...creditHeaders }
        );
      }

      return json({ error: "not found" }, 404, cors);
    } catch (e: any) {
      return json({ error: e?.message ?? "internal" }, 500, cors);
    }
  },
};
