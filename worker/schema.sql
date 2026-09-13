-- SNIP Worker D1 schema
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  full_name TEXT,
  name_changed_at TEXT,
  created_at TEXT NOT NULL
);

-- Ежедневное/почасовое использование бесплатного лимита.
-- АКЦИЯ: гости — ключ дня "YYYY-MM-DD" (сброс в 00:00 UTC),
-- зарегистрированные — ключ часа "YYYY-MM-DDT HH" (300⚡ каждый час).
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
);

-- Накопительный баланс (пакеты кредитов, не сгорают)
CREATE TABLE IF NOT EXISTS balances (
  subject TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- История операций по кредитам
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  delta INTEGER NOT NULL,          -- отрицательное = списание, положительное = зачисление
  kind TEXT NOT NULL,              -- grant | spend_fast | spend_deep | purchase | subscription
  meta TEXT,                       -- произвольные детали (sku и т.п.)
  created_at TEXT NOT NULL
);

-- Активные подписки (повышают дневной лимит)
CREATE TABLE IF NOT EXISTS subscriptions (
  subject TEXT PRIMARY KEY,
  plan TEXT NOT NULL,              -- pro | business
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Транзакции покупки (демо: status='demo', позже 'paid' от PSP-вебхука)
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  sku TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0, -- зачислено на баланс (для пакетов)
  status TEXT NOT NULL DEFAULT 'demo',
  created_at TEXT NOT NULL
);

-- Дневной счётчик объяснений фрагментов (сайдбар PDF-вьюера, только подписчики)
CREATE TABLE IF NOT EXISTS explain_usage (
  day TEXT NOT NULL,
  subject TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
);

-- Кэш объяснений по хешу фрагмента: повторное выделение того же текста — без Groq
CREATE TABLE IF NOT EXISTS explain_cache (
  hash TEXT PRIMARY KEY,
  doc_number TEXT,
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Кэш ответов /api/ask: повторный вопрос (тот же режим) — без LLM.
-- Списание кредитов при хите идёт как обычно (экономика не меняется, бережём квоты провайдеров).
CREATE TABLE IF NOT EXISTS ask_cache (
  hash TEXT PRIMARY KEY,          -- sha256("ask|<mode>|<норм. запрос>")
  query_norm TEXT,
  mode TEXT,                      -- fast | deep
  answer_json TEXT NOT NULL,      -- финальный объект ответа (с is_grounded)
  sources_json TEXT,              -- sources для ответа
  provider TEXT,                  -- кто ответил изначально
  grounded INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Оверрайды настроек из Админки поверх env (quota_anon, quota_user, cost_fast,
-- cost_deep, explain_cap, cap_groq_rpd, cap_embed_rpd). Создаётся и лениво
-- через ensureSettingsTable(), env остаётся дефолтом/fallback.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Кэш векторов запроса для /api/embed и vectorTopK (/api/ask): повторные
-- вопросы всех юзеров — 0 вызовов API эмбеддингов. Создаётся и лениво
-- через ensureEmbedCacheTable(). TTL 30 дней, чистка при записи.
CREATE TABLE IF NOT EXISTS embed_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  qhash TEXT NOT NULL,              -- normAskQuery(query)
  vec TEXT NOT NULL,                -- JSON-массив float
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, model, qhash)
);

-- Circuit breaker + дневные бюджеты LLM-звеньев (/api/ask): мёртвые скипаются
-- без fetch, исчерпанные — до 00:00 UTC. Создаётся и лениво через
-- ensureLlmBudgetTable(). Капы: LLM_BUDGET_DEFAULTS + override budget_<id> в settings.
CREATE TABLE IF NOT EXISTS llm_budget (
  provider TEXT NOT NULL,           -- groq | groq-alt | gemini | ...
  variant TEXT NOT NULL DEFAULT '', -- модель для groq-alt, иначе ''
  day TEXT NOT NULL,                -- YYYY-MM-DD UTC
  used INTEGER NOT NULL DEFAULT 0,
  down_until INTEGER NOT NULL DEFAULT 0,  -- epoch ms, 0 = живо
  PRIMARY KEY (provider, variant, day)
);

-- Фидбек под ответом (👍/👎 + причина + коммент). Без списания кредитов.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 0,
  query TEXT NOT NULL,
  mode TEXT,
  provider TEXT,
  chunk_ids TEXT,
  answer_excerpt TEXT,
  paragraph TEXT,
  rating INTEGER NOT NULL,          -- 1 = 👍, -1 = 👎
  reason TEXT,                      -- wrong_paragraph | no_quote | off_topic | outdated | other
  comment TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);

-- Переформулировки запросов (smart_rewrite): LLM-запросы для ретривала.
-- Создаётся лениво через ensureRewriteCacheTable(). TTL 30 дней, ключ содержит
-- версию промпта и тег сборки индекса. Повторные формулировки — 0 вызовов LLM.
CREATE TABLE IF NOT EXISTS rewrite_cache (
  hash TEXT PRIMARY KEY,            -- sha256(rw|prompt_ver|kind|history|norm_query)
  payload TEXT NOT NULL,            -- JSON {standalone, queries[], terms[]}
  created_at TEXT NOT NULL
);
