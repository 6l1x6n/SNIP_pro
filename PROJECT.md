# SNIP.pro — полный обзор проекта

> Интеллектуальный справочник СНиП / СП / СН РК / СТ РК для архитекторов, ГИПов, конструкторов, инженеров.
> **Пользователь пишет вопрос своими словами → ИИ понимает смысл → находит релевантный пункт → показывает первым → даёт цитату, пункт, страницу, статус и ссылку.**
> Принцип: **No source → No claim**. Цитата проверяется дословно.

**Репозиторий:** `https://github.com/6l1x6n/SNIP_pro` `master` (зеркало `https://github.com/deepseekpowered/www`)
**Деплой:** фронт + статический индекс — Cloudflare Pages `https://snippy-llm.pages.dev`; API — Cloudflare Worker `https://snip-worker.postalarchive.workers.dev` + D1
**Локально:** `http://localhost:5173` (Vite, поиск работает по локальному индексу без бэка) + опционально `npx wrangler dev` (Worker, :8787)

---

## 1. Архитектура

```
Официальный источник (adilet.zan.kz) → PDF (PyMuPDF / OCR) → scripts/build_index.py
→ chunker 2800 зн. / overlap 600 (не режет пункт) → embeddings Cohere
embed-multilingual-v3.0 1024d int8-per-vector → статический шардированный индекс
frontend/public/index/ (manifest v2, chunks_0..7 + vectors_0..10 ≤4 МиБ, bm25.json,
values.json 7644 факта, builtAt-версионирование) → гибридный поиск В БРАУЗЕРЕ
(engine.ts: BM25 + int8-косинус + RRF k=60 + semantic-оверлей) → Worker /api/ask
(rerank-каскад Voyage → Cohere → Jina → LLM-listwise; LLM-каскад Groq → Zen →
Pollinations → Gemini → …) → ответ с доказательством (is_grounded, quote,
paragraph, page, status)
```

**Карточки значений (09.2026, прод):** `scripts/values_extract.py` извлекает числовые требования
(`ширина:коридор ≥1,4 м`) при сборке → `frontend/public/index/values.json` (7644 факта, manifest v2).
Фактоид-запросы закрываются БЕЗ LLM и БЕЗ списания: фронт (`search/values.ts` + `SearchView`) показывает
полоску карточек (0⚡), воркер `/api/ask` отвечает `provider:"values", free:true` до `chargeHybrid`.
Незаземлённые строки уходят в LLM-промпт как проверенные значения. `scripts/verify_values.py` — отчёт качества.
`--reuse-vectors` в `build_index.py`: кэш эмбеддингов `.index_cache/` по sha256 чанка (пересборка без API-квоты).
D1 `embed_cache` (30 дней, ключ по builtAt): повторные вопросы — 0 вызовов API эмбеддингов (`embedQuery`).

**Смарт-контур «Сниппи v2» (10.09.2026, прод):** чтобы Сниппи не тупил, `/api/ask` получил четыре слоя.
1. **Понимание запроса** `POST /api/rewrite` (`worker/src/index.ts` `rewriteSmart`): дешёвая LLM (Groq, таймаут 4с) даёт `{standalone, queries[2-3], terms[]}`, вырезает выдуманные номера СНиП. D1 `rewrite_cache` (тег версии промпта + сборки индекса, 30 дней). Уточнения переформулируются с историей в самодостаточный вопрос.
2. **Расширение кандидатов** (фронт `useSearch.ts` + `engine.ts`): базовый гибридный ранжир не меняется; BM25-хиты rewrite-запросов и векторные хиты русских переформулировок (важно для kz) добавляются в пул к top-24 → до 32 кандидатов (воркер принимает 32, `searchClient` больше не режет до 24).
3. **Reranking** `worker/src/index.ts` `rerankContexts`: каскад Voyage `rerank-2` → Cohere `rerank-multilingual-v3.0` → Jina `jina-reranker-v2-base-multilingual` → LLM-listwise (Groq) → исходный порядок; `@cf/baai/bge-reranker-base` (en/zh) на русском хвост портит — только для force-замеров. Бюджеты/брейкеры в `llm_budget` (`budget_*_rerank`), contextTopN: simple 4 / standard 6 / complex 8.
4. **Ответы**: prompt v2 (числа только из цитаты, сравнения построчно, частичный ответ не прячется) + **второй проход** при `is_grounded=false` (`smart_second_pass`) + существующий numeric-gate. Сравнения («сравните/чем отличается») всегда уходят в LLM с values-строками. Флаги в settings: `smart_rewrite`, `smart_rerank`, `smart_second_pass`.
Метрики: `ledger.meta` `{route, cands, rerank, sp, g}`, сводка за сутки — `GET /api/admin/health → smart{}`. Линейка: `scripts/eval/golden.jsonl` (106 кейсов: 46 ручных + 60 из values) + `scripts/eval_search.py`. Замер 09.2026 на 106: базовый ранжир Hit@1 50.0% / Hit@3 72.6% / MRR 0.630; смарт-контур (rewrite-кандидаты) на наборе прироста не дал (values-вопросы лексически точны); без semantic-оверлея Hit@1 51.9%, но colloquial 22%→11% — semantic оставлен дефолтом. Слабое место: kz-кейсы Hit@1 0%.

**Ключевой файл:** `frontend/src/search/engine.ts` — гибридный поиск в браузере (ядро), `worker/src/index.ts` — API/LLM/кредиты, `scripts/build_index.py` — сборка индекса.

---

## 1.1. Поток данных

1. **Источник** `scripts/check_updates.py` — diff текущей `norms/` с adilet.zan.kz; новые/изменённые PDF раскладываются вручную (полный автомат сознательно не делается: кривой парсинг отравит индекс), метаданные — `norms/meta.json`.
2. **Extractor** `scripts/pipeline/extractor.py` `fitz` `get_text(flags=TEXTFLAGS_TEXT)`, эвристика скана `scanned_ratio<0.3`, fallback `pytesseract rus+kaz+eng` dpi200 (build-time).
3. **Chunker** `scripts/pipeline/chunker.py` `MAX_CHARS=2800` overlap `600`, режет по `^\d+(\.\d+)*` `Глава|Раздел|Таблица`, не режет пункт.
4. **Indexer** `scripts/build_index.py` — эмбед-каскад `gemini(768) → jina/voyage/cohere/mistral(1024)` (ключи в корневом `.env`), int8-per-vector квантование, `values_extract.py` → `values.json`; выход: `chunks.json/vectors.bin + manifest/bm25/docs/synonyms.json`.
5. **Шардирование** `scripts/shard_index.py` — режет монолиты на шарды ≤4 МиБ (лимит Pages 25 МиБ), пишет `manifest.shards`; в `rebuild.sh` встроен.
6. **Поиск** `frontend/src/search/engine.ts` — BM25 по `bm25.json` + косинус int8-векторов (query-вектор — Worker `/api/embed` по провайдеру из манифеста) + RRF `k=60` → `0.45/0.55` (semantic) или `0.6/0.4` → `relevance_percent 10-98`; при 429 — деградация в BM25-only, 402 пробрасывается.
7. **Ответ** `worker/src/index.ts /api/ask` — rerank-каскад, роутер сложности, prompt v2 + второй проход; values-фактоиды отвечаются до LLM бесплатно.
8. **Гейты** `scripts/rebuild.sh` — `verify_values` (шум <2%), счётчик чанков не ужался; после деплоя `scripts/verify_search.py`.

---

## 2. Стек

| Слой | Технология | Версия / файл |
|---|---|---|
| **Фронт** | React 19 + Vite + Tailwind 3.4 + TypeScript | `frontend/package.json`, `vite.config.ts` |
| **Поиск** | Гибрид в браузере: BM25 + int8-векторы + RRF | `frontend/src/search/engine.ts` |
| **Индекс** | Статический, шардированный (≤4 МиБ), int8-per-vector | `frontend/public/index/manifest.json` v2, 40 931 чанк × 1024d |
| **Эмбеддинги** | Cohere `embed-multilingual-v3.0` 1024d (манифест-управляемый каскад) | `worker/src/index.ts` `embedQueryFresh`, `scripts/pipeline/provider.py` (build-time) |
| **API** | Cloudflare Worker (1 файл) + D1 | `worker/src/index.ts`, `worker/schema.sql` |
| **LLM** | Каскад: Groq → Zen → Pollinations → Gemini → Cerebras → OpenRouter → DeepSeek → Mistral → Cohere → workers-ai | `worker/src/index.ts` `llmLinks`, бюджеты `llm_budget` |
| **Rerank** | Каскад: Voyage `rerank-2` → Cohere `rerank-multilingual-v3.0` → Jina → LLM-listwise | `worker/src/index.ts` `rerankLinks` |
| **Сборка индекса** | Python 3.12 + PyMuPDF + backend-пайплайн (build-time) | `scripts/build_index.py`, `scripts/shard_index.py` |


---

## 3. Структура проекта

```
SNIP_pro/
  frontend/
    src/
      App.tsx                # табы search|docs|favorites|settings|profile
      views/                 # SearchView, DocsView, FavoritesView, ProfileView, AdminView
      search/engine.ts       # ГИБРИДНЫЙ ПОИСК В БРАУЗЕРЕ (ядро)
      search/searchClient.ts # /embed + /ask, ретраи, деградации, сессии
      search/values.ts       # values-карточки (0⚡ фактоиды)
      components/            # ~30: PdfViewerModal (pdfjs), HistorySidebar, FeedbackBar, MobileNav, admin/*
      hooks/useSearch.ts     # префлайт кредитов, rewrite-кандидаты, антиспам
      utils/stem.ts          # токенизатор (зеркало build_index.py; паритет — npm test)
      utils/api.ts           # WORKER_BASE + authFetch + DEVICE_ID
    public/index/            # СТАТИЧЕСКИЙ ИНДЕКС (в git): manifest v2 + shards + bm25 + values
    wrangler.toml / .env.production (VITE_WORKER_BASE)
  worker/
    src/index.ts             # auth, кредиты, /ask, /rewrite, /embed, values, админка, каскады
    schema.sql               # D1: users, usage, balances, ledger, ask_cache, embed_cache, llm_budget, …
  scripts/
    build_index.py           # сборка индекса из norms/ (+ --reuse-vectors, values_extract)
    shard_index.py           # шардирование ≤4 МиБ + manifest.shards
    rebuild.sh               # полный цикл: build → shard → гейты → PDF → R2 → Pages
    norms_refresh.sh         # полуавтомат: diff adilet → аппрув → build → гейты → деплой
    eval_search.py + eval/   # линейка качества (golden.jsonl 106 кейсов, results_*.json)
    gen_tokenize_fixture.py  # фикстура паритет-теста токенизатора
    gen_golden_from_values.py# рост golden из values-фактов
    verify_values.py / verify_search.py / check_updates.py
  scripts/pipeline/          # build-time библиотека сборщика (extractor, chunker, provider, config)
  norms/                     # корпус нормативки (в git только meta.json)
```

---

## 4. Данные

**Статический индекс (прод):** `frontend/public/index/` — `manifest.json` v2 (`dim 1024`, `count 40931`, `quantization: int8-per-vector`, `provider/model` для query-эмбеддингов, `builtAt`, `shards {vectors:11, chunks:8}`, `values {count:7644}`), `chunks_{0..7}.json`, `vectors_{0..10}.bin` (магия `SNV1`: u32 dim + u32 count + f32 scales + i8 данные), `bm25.json` (k1 1.2, b 0.75), `docs.json` (55 доков), `synonyms.json`, `values.json`.

**D1 (прод Worker):** `users(id,email,password_hash,plan,full_name,name_changed_at,created_at)`, `usage(day,subject,count)` — ключ дня для гостей / часа для юзеров, `balances`, `ledger`, `subscriptions`, `purchases`, `explain_usage/explain_cache`, `ask_cache` (ключ по builtAt), `embed_cache` (30д, ключ по builtAt), `llm_budget`, `rewrite_cache`, `feedback`, `settings` (`worker/schema.sql`; часть таблиц создаётся лениво — самозалечивающаяся миграция).



---

## 5. Гибридный поиск (`frontend/src/search/engine.ts`)

* **Токенизатор** `utils/stem.ts` — 1:1 порт `build_index.py` (стоп-слова, один суффикс, числительные словами → цифры); паритет гонится vitest-фикстурой из реальных чанков (`npm test`)
* **Варианты запроса** `expandVariants` — синонимы из `synonyms.json` + semantic-оверлей `utils/semanticSynonyms.ts` (тумблер в Настройках, дефолт ВКЛ; deep до 5 вариантов, fast до 3) + rewrite-варианты смарт-контра
* **BM25** по `bm25.json` (постинги в памяти, k1/b/avgdl из манифеста)
* **Vector** косинус по int8-векторам (dot со scale; query — Worker `/api/embed`); deep усредняет векторы переформулировок
* **RRF** `k=60` → вес `0.45*norm_rrf + 0.55*vector_score` (semantic) или `0.6/0.4` → `relevance_percent 10-98`
* **Деградация:** 429/5xx эмбеддера → BM25-only + плашка; 402 → проброс `insufficientCredits`; `loadIndex` самовосстанавливается после сбоя (сброс промиса), гейты `manifest.version=2` и dim
* **Anti-hallucination:** `weak` если `topVec<0.32 && topBm<0.005` (для мелких баз 0.25); <55% или нет цитаты → «не найдено»
* **Cache-busting:** manifest — `no-store`, остальные артефакты `?v=<builtAt>` (CDN не смешивает сборки)

---

## 6. Квота и лимиты (акция, прод Worker)

* **Акция:** зарегистрированные — **300⚡ каждый час** (`CREDITS_USER=300`, ключ периода `YYYY-MM-DDTHH`), гости — **30⚡/день** (`CREDITS_ANON=30`, ключ `YYYY-MM-DD`, сброс 00:00 UTC). Таблица `usage(day,subject)` хранит оба формата ключей, миграция не нужна.
* `worker/src/index.ts` `periodKey(isUser)`, `getCreditsState` возвращает `reset:'hourly'|'daily'`; `chargeHybrid`/`refundCharge` списывают сначала периодный лимит, затем `balances`. Фронт `utils/credits.ts:resetLabel` показывает «Обновляется каждый час (акция: 300⚡/час)» юзерам.
* **Бесплатно (0⚡, без LLM):** полоска карточек во фронте (локально); `embed_cache` (D1, 30d) — повторные эмбеддинги запросов бесплатны для квоты API.
* **Экономика «платят всегда» (09.2026):** списываются все ответы `/api/ask` — LLM, хит `ask_cache` и values (values-блок после `chargeHybrid`, `free:false`); исключение — спам дублем <10с режется на клиенте (ни сети, ни списания). Полоска карточек — витрина 0⚡.
* **Circuit breaker + дневные бюджеты (09.2026):** D1 `llm_budget(provider,variant,day,used,down_until)` — один SELECT на обход; 429/5xx глушат звено (Retry-After, иначе 60с, кап 10 мин), исчерпанный бюджет — скип до 00:00 UTC; все скипнуты → сразу extractive (`budgetExhausted`, `why:"budgets"` в ledger). Капы — `LLM_BUDGET_DEFAULTS` + override `budget_<id>` в settings (0 = мягкий kill). Видимость — `GET /api/admin/health → llm[]`.
* **Свежесть норм (09.2026):** дата базы в UI (`manifest.builtAt` → «база от …»); бейджи `status` (заменён/утратил) в карточках/ответах/модалке (`statusBadge`); ключи `ask_cache`/`embed_cache` версионированы `builtAt` индекса; полуавтомат `scripts/norms_refresh.sh` (diff → аппрув → build `--reuse-vectors` → гейты → deploy) + `scripts/check_updates.py`.
* **Роутер сложности (09.2026):** воркер `classifyAsk` → simple (top3/600 tok) / standard / complex (1200 tok); метрика `route` в `ledger.meta`. Смарт-чипсы типов зданий под values-ответом (фронт, тап дописывает тип к вопросу → docHit-буст).
* **Демо-оплата только админам:** `ADMIN_EMAILS = postalarchive@gmail.com, aidos77_77@mail.ru` (`worker/src/index.ts`, `frontend/src/utils/admin.ts`). `POST /api/billing/purchase` → `403 billing_disabled` для не-админов; кнопки «Пополнить/Купить» у остальных `disabled` + хинт про Kaspi/карты скоро.
* Costs: `FAST_COST=5`, `DEEP_COST=10`. Explain-кап подписчиков — `EXPLAIN_DAILY_CAP=40`/день (не менялся).

---

## 7. Деплой — где и как

### Текущий деплой (22.08.2026) — 0₸ без карты
* **Фронт:** Cloudflare Pages `https://snippy-llm.pages.dev` (wrangler CLI, бандл с `VITE_API_BASE=https://snip-backend-m21d.onrender.com`)
* **Бэк:** Render (удалён) — legacy Render-бэкенд и его keep-alive воркфлоу вычищены
* **БД:** Neon Free eu-central-1, pgvector, **direct-эндпоинт** (`-pooler` ломает интроспекцию типов asyncpg → InvalidCachedStatementError), пул 5+10
* **Эмбеддинги:** Gemini API `gemini-embedding-001` 768d, free tier (`EMBEDDING_PROVIDER=gemini`); локальный fallback fastembed ONNX MiniLM 384d; torch/sentence-transformers убраны → RAM ~144MB
* **Квоты в проде:** `QUOTA_ENABLED=1` anon 30/day registered 200/day

### Текущий деплой (09.2026) — 0₸, всё на Cloudflare

* **Фронт + индекс:** Cloudflare Pages `https://snippy-llm.pages.dev` — `npx wrangler pages deploy frontend/dist --project-name snippy-llm` (шаг 5 `scripts/rebuild.sh`); лимит 25 МиБ/файл соблюдён шардированием
* **API:** Cloudflare Worker `https://snip-worker.postalarchive.workers.dev` — `cd worker && npx wrangler deploy`; секреты через `wrangler secret put` (ключи LLM/эмбеддеров, `JWT_SECRET`), переменные в `worker/wrangler.toml` (`ALLOWED_ORIGINS`, `INDEX_BASE_URL`, `CREDITS_*`, `FAST_COST/DEEP_COST`)
* **БД:** Cloudflare D1 (`worker/schema.sql`); таблицы создаются лениво при первом обращении
* **Эмбеддинги запросов:** Worker `/api/embed` по провайдеру из `manifest.json` (сейчас Cohere `embed-multilingual-v3.0` 1024d), D1-кэш 30д по builtAt
* **Контур:** CORS `https://*.pages.dev` (regex-матч wildcard), 401 различает `token_expired`, глобальные 500 — generic без утечки внутренностей
* Деплой индекса: `./scripts/rebuild.sh` (сборка → шардирование → гейты → PDF-статика → R2 → Pages) или полуавтомат `./scripts/norms_refresh.sh`

### Исторические варианты (устарели, детали в `DEPLOY.md`)

Render/Neon/FastAPI-путь и Oracle VM-варианты описаны в `DEPLOY.md`; после переезда на Worker+D1 не используются. `docker-compose.yml`/`Caddyfile` — только локальный legacy-бэк.

### Env

* **Worker (прод):** секреты — `wrangler secret put` в `worker/`; публичные vars — `worker/wrangler.toml`. Ключи провайдеров: `GROQ_API_KEY`, `OPENCODE_API_KEY` (Zen), `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, `JINA_API_KEY`, `VOYAGE_API_KEY`, `EVAL_TOKEN`; конфиг: `ALLOWED_ORIGINS`, `INDEX_BASE_URL`, `JWT_SECRET`, `CREDITS_ANON/CREDITS_USER`, `FAST_COST/DEEP_COST`, `LLM_BUDGET_DEFAULTS`-override через D1 `settings`.
* **Сборка индекса:** ключи эмбеддеров в корневом `.env` (не в git) — читает `build_index.py`.
* **Фронт:** `frontend/.env.production` — `VITE_WORKER_BASE=https://snip-worker.postalarchive.workers.dev` (вшивается при сборке).

---

## 8. Локальный запуск (macOS)

```bash
# 1. Фронт (поиск работает сразу — индекс в git)
cd frontend && npm install
npm run dev -- --host 0.0.0.0 --port 5173   # http://localhost:5173
npm test          # паритет-тесты токенизатора (vitest)
npm run build     # tsc -b && vite build → dist/

# 2. Worker (auth/кредиты/ask) — опционально
cd worker
cp .dev.vars.example .dev.vars   # если есть; секреты не в git
npx wrangler dev                 # http://localhost:8787
npx tsc --noEmit

# 3. Пересборка индекса (обновление нормативки)
/opt/homebrew/bin/python3 scripts/build_index.py --reuse-vectors   # ключи в .env
/opt/homebrew/bin/python3 scripts/shard_index.py frontend/public/index
./scripts/rebuild.sh             # или полный цикл одной командой
/opt/homebrew/bin/python3 scripts/eval_search.py --tag myrun      # линейка качества
```

`start.sh` / `stop.sh` — обёртки локального фронта. 

---

## 9. API (прод — Worker; legacy FastAPI ниже в README)

```
POST /api/auth/register {email,password,full_name?} → {uid,email,full_name,token}
POST /api/auth/login {email,password} → {uid,email,full_name,token}
GET  /api/me → {uid,email,full_name,name_changed_at,name_can_change_at,created_at,is_admin,credits}
PATCH /api/me {full_name} → смена имени раз в 30 дней (первая установка свободна, иначе 429 name_cooldown)
GET  /api/credits → {daily:{used,limit,remaining},balance,plan,reset}
POST /api/credits/spend {mode} → 402 insufficient_credits
GET  /api/credits/history?limit=
POST /api/billing/purchase {sku} → только ADMIN_EMAILS, иначе 403 billing_disabled
POST /api/ask {query,mode,chunkIds|candidates[≤32],followUp,history} → списание DEEP_COST, rerank + Groq с заземлением
POST /api/rewrite {query,history?,followUp?} → {standalone,queries,terms} — понимание запроса, 0⚡, D1-кэш 30д
POST /api/embed {query} → float[]
POST /api/explain {text,doc_number?} → только Pro/Business
```

`X-Quota-Remaining/Limit` + `X-Device-Id` `frontend/src/utils/api.ts:31`, `Authorization Bearer JWT` (worker, WebCrypto HS256).

---

## 10. Данные индекса (прод, 09.2026)

* 55 документов (СН РК / СП РК / СТ РК / СНиП), **40 931 чанк** × 1024d Cohere int8, шарды `chunks_0..7` + `vectors_0..10`, `builtAt 2026-09-09`
* `values.json` — **7644 факта** (`ширина:коридор ≥1,4 м`), values-ответы 0⚡ без LLM
* Статусы в `docs.json`: бейджи «заменён/утратил» в карточках и ответах

Поиск-тест: `ширина коридора`, `лестничная клетка`, `марш` → top с цитатой и пунктом. Линейка: `python3 scripts/eval_search.py --tag <name>` → Hit@1 50.0% / Hit@3 72.6% / MRR 0.630 на golden 106.

---

## 11. Ограничения

* [ ] **kz-запросы**: Hit@1 0% на kz-подмножестве golden — kz-синонимы + kz-путь rewrite (главный рычаг)
* [ ] Таблицы `camelot/tabula` `type=table`
* [ ] i18n kz интерфейса (~1500 строк захардкоженного ru)
* [ ] Код-сплиттинг (pdfjs в основном бандле) + ErrorBoundary
* [ ] Пагинация чанков с bbox
* [ ] TypeScript: 12 файлов с `@ts-nocheck`, `strict` выключен; anon-квоты обходятся ротацией `X-Device-Id` (нет IP-рейт-лимита)
* Готово: паритет-тесты токенизатора (`npm test`), Jina в rerank-каскаде, self-healing `loadIndex`, cache-busting индекса, golden 106

---

## 12. Логи и дебаг

```bash
npx wrangler tail                # логи прод-воркера (ошибки /api теперь generic, детали тут)
curl -s https://snippy-llm.pages.dev/index/manifest.json | python3 -m json.tool
npx wrangler pages deployment list --project-name snippy-llm
GET /api/admin/health            # пул LLM, smart-метрики, бюджеты за сутки (админ-JWT)
npm --prefix frontend test       # паритет токенизатора
```

---

**No source → No claim. Если `relevance <55%` или нет фрагмента — «В доступной нормативной базе точного требования не найдено.»**
