# SNIP.pro — Интеллектуальный справочник СНиП / СП / СН РК

Профессиональный AI-поиск по действующим строительным нормам Казахстана для архитекторов, ГИПов, конструкторов, инженеров.

> **Пользователь пишет вопрос своими словами → ИИ понимает смысл → находит релевантный пункт → показывает первым → даёт цитату, пункт, страницу, статус и ссылку.**

**Стек (прод):** Cloudflare Pages (фронт + статический шардированный индекс, `https://snippy-llm.pages.dev`) + Cloudflare Worker (`https://snip-worker.postalarchive.workers.dev`: auth, кредиты, `/ask`, `/rewrite`, `/embed`, values-ответы) + D1 + React + Vite + Tailwind.

**Кредиты (акция):** гости — 30⚡/день (сброс 00:00 UTC), зарегистрированные — 300⚡ каждый час. Списание: сначала бесплатный лимит, затем накопительный баланс. Быстрый поиск — 5⚡, глубокий с ИИ — 10⚡. Демо-оплата (пакеты/подписки без денег) — только админы `postalarchive@gmail.com`, `aidos77_77@mail.ru`, остальным кнопки неактивны.

---

## Архитектура

```
adilet.zan.kz / нормативка → norms/*.pdf → scripts/build_index.py
  → chunker (2800 зн., overlap 600, не режет пункт)
  → embeddings Mistral mistral-embed 1024d (int8-per-vector; был Cohere — квота, смена через manifest)
  → статический шардированный индекс frontend/public/index/
      (manifest.json v2, chunks_0..7.json, vectors_0..10.bin ≤4 МиБ,
       bm25.json, values.json — 7644 факта, builtAt-версионирование)
→ Гибридный поиск В БРАУЗЕРЕ (frontend/src/search/engine.ts):
  BM25 (bm25.json) + косинус по int8-векторам + RRF k=60 + semantic-оверлей синонимов
→ Worker /api/ask: rerank-каскад (Voyage → Cohere → Jina → LLM-listwise)
  → LLM-каскад (Groq → Zen → Pollinations → Gemini → …) с заземлением
  → ответ с цитатой, пунктом, страницей, статусом (No source → No claim)
```

- **Query-эмбеддинги** считает Worker `/api/embed` по провайдеру из манифеста индекса (сейчас Mistral 1024d; каскад jina → voyage → cohere → mistral → gemini), D1-кэш `embed_cache` на 30 дней с ключом по `builtAt`.
- **Деградация:** при 429/5xx провайдера поиск честно уходит в BM25-only с плашкой «текстовый поиск»; 402 (нет кредитов) не деградирует, а пробрасывается.
- **Values-карточки:** фактоиды («ширина коридора ≥1,4 м») отвечаются детерминированно из `values.json` БЕЗ LLM и списания (0⚡), LLM получает проверенные значения как контекст.
- **Смарт-контур (прод Worker, 10.09.2026):** понимание запроса (`/api/rewrite`, D1-кэш 30д) → расширение пула кандидатов BM25/векторными хитами переформулировок (до 32) → reranking каскадом → prompt v2 (числа строго из цитаты, сравнения построчно) + второй проход при «не найдено». Флаги в админке: `smart_rewrite`, `smart_rerank`, `smart_second_pass`. Метрики за сутки: `GET /api/admin/health → smart{}`.
- **Линейка качества:** `scripts/eval_search.py` + `scripts/eval/golden.jsonl` (106 кейсов; 46 ручных + 60 из values-фактов). Замер 09.2026 после kz-фикса и таблиц: Hit@1 54.7% / Hit@3 75.5% / MRR 0.666 (база до: 50.0/72.6/0.630); kz-кейсы Hit@3 80% (было 0%).
- **Паритет токенизатора:** TS-токенизатор `frontend/src/utils/stem.ts` — ручной порт Python из `scripts/build_index.py`; паритет гонится тестами (`npm test`, фикстура из реальных чанков: `npm run gen:fixture`).

**Принцип: No source → No claim.** Цитата проверяется дословно; если релевантность низкая — «В доступной нормативной базе точного требования не найдено».

---

## Быстрый старт

Продукт — статический фронт + Worker. Для разработки UI индекс уже в `frontend/public/index/`, бэкенд-стек (PostgreSQL/Ollama) не нужен.

### 1. Фронт

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 — поиск работает по локальному индексу
npm test             # паритет-тесты токенизатора (vitest)
npm run build        # tsc -b && vite build → dist/
```

### 2. Воркер (для auth/кредитов/ask)

```bash
cd worker
npx wrangler dev     # http://localhost:8787, секреты в worker/.dev.vars (не в git)
npx tsc --noEmit     # проверка типов
npx wrangler deploy  # деплой в прод
```

Без воркера фронт работает в режиме поиска, но `/ask`, кредиты и auth недоступны (`VITE_WORKER_BASE` в `frontend/.env.production`).

### 3. Пересборка индекса (обновление нормативки)

```bash
./scripts/rebuild.sh            # полный цикл: build → shard → гейты → PDF → R2 → Pages
./scripts/norms_refresh.sh      # полуавтомат: diff с adilet → аппрув → build --reuse-vectors → гейты → деплой
python3 scripts/gen_tokenize_fixture.py   # перегенерация фикстуры паритет-теста после смены токенизатора
python3 scripts/gen_golden_from_values.py # дожать golden-набор кейсами из values
```

Гейты: `verify_values.py` (шум <2%), счётчик чанков не ужался, `verify_search.py` после деплоя. Лимит Pages — 25 МиБ на файл, поэтому `build_index.py` всегда followed by `shard_index.py` (в `rebuild.sh` встроен).

Опционально: `--reuse-vectors` кэширует эмбеддинги по sha256 чанка (`.index_cache/`) — пересборка без расхода API-квоты.

---

## API (Worker, прод)

```
POST /api/auth/register {email,password,full_name?} → {uid,email,full_name,token}
POST /api/auth/login {email,password} → {uid,email,full_name,token}
GET  /api/me → {uid,email,full_name,name_changed_at,name_can_change_at,created_at,is_admin,credits}
PATCH /api/me {full_name} → смена имени (кулдаун 30 дней, первая установка свободна)
GET  /api/credits → {daily:{used,limit,remaining},balance,plan,reset:'hourly'|'daily'}
POST /api/credits/spend {mode:fast|deep}
GET  /api/credits/history?limit=
POST /api/billing/purchase {sku} → ТОЛЬКО админы, иначе 403 billing_disabled
POST /api/ask {query,mode,candidates[≤32],followUp,history} → списание, rerank + LLM-каскад с заземлением
POST /api/rewrite {query,history?,followUp?} → {standalone,queries,terms} — понимание запроса (0⚡, кэш 30д)
POST /api/embed {query} → float[] (провайдер/модель из манифеста индекса, D1-кэш 30д)
POST /api/explain {text,doc_number?} → только подписчики Pro/Business, кап/день
```

Ошибка 401 различает `token_expired` / `invalid_token`; фронт по `AUTH_EXPIRED_EVENT` чистит токен. Все списания атомарны, при падении провайдера — авто-refund с свежим балансом в ответе.

---

## Структура

```
frontend/
  src/search/engine.ts    # гибридный поиск в браузере (BM25 + int8 + RRF + синонимы)
  src/search/searchClient.ts  # /embed + /ask + ретраи + деградации
  src/utils/stem.ts       # токенизатор (зеркало build_index.py; паритет-тесты npm test)
  src/views/, components/ # UI: поиск, доки, профиль, админка, PDF-viewer (pdfjs-dist)
  public/index/           # СТАТИЧЕСКИЙ ИНДЕКС: manifest v2 + шарды + bm25 + values
worker/
  src/index.ts            # auth, кредиты, /ask, /rewrite, /embed, values, админка
  schema.sql              # D1: users, usage, balances, ledger, ask_cache, embed_cache, llm_budget, …
scripts/
  build_index.py          # сборка индекса из norms/ (+ values_extract, --reuse-vectors)
  shard_index.py          # шардирование ≤4 МиБ + manifest.shards
  rebuild.sh              # полный цикл обновления нормативки (5 шагов, с гейтами)
  norms_refresh.sh        # полуавтомат с diff по adilet и аппрувом
  eval_search.py          # линейка качества: Hit@k / MRR по golden.jsonl
  pipeline/               # build-time библиотека: PDFExtractor, SNIPChunker, эмбед-провайдеры, config (.env)
```

---

## Замена компонентов (модульность)

- **Эмбеддинги:** провайдер query-векторов берётся из `manifest.json` (`provider`/`model`) — Worker `/embed` подхватывает jina/voyage/cohere/mistral/gemini автоматически. Смена провайдера без пере-извлечения PDF: `python3 -u scripts/add_table_chunks.py --provider mistral` — пере-эмбеддирует тексты готовых чанков (без `--provider` — только таблицы текущим провайдером). Перед деплоем индекса нового провайдера выставь воркеру его секрет (`wrangler secret put MISTRAL_API_KEY`).
- **LLM:** каскад в `worker/src/index.ts` (`llmLinks` + `LLM_BUDGET_DEFAULTS`); дневные бюджеты и флаги — в настройках админки, без деплоя.
- **Reranker:** каскад `rerankLinks` (Voyage → Cohere → Jina → LLM-listwise → workers-ai), включается флагом `smart_rerank`.
- **Источник:** `scripts/check_updates.py` (diff с adilet) + ручная раскладка в `norms/` (`meta.json`) — полный автомат сознательно не делается: кривой парсинг отравит индекс.
- **OCR:** `scripts/pipeline/extractor.py` (PyMuPDF + tesseract) — вызывается на этапе сборки индекса.

---

## TODO / ограничения

- [x] ~~kz-запросы~~: kz-токенизатор + kz↔ru синонимы + kz-детект в rewrite (Hit@3 0→80% на kz-подмножестве); дальше —_live_ проверка kz→ru rewrite после деплоя воркера
- [x] ~~Таблицы~~: `page.find_tables()` → чанки `ty=table` (3845 шт.), приложение — `scripts/add_table_chunks.py`
- [ ] i18n kz интерфейса (сейчас ru, ~1500 строк захардкоженных строк)
- [x] ~~Код-сплиттинг + ErrorBoundary~~: PdfViewerModal ленивая (main 514→483 kB), boundaries root/поиск/PDF
- [ ] Пагинация чанков в PDF viewer с подсветкой bbox
- [ ] TypeScript: осталось 7 файлов с `@ts-nocheck` (большие вьюхи), `strict: false` во фронтенде
- [ ] kz Hit@1 на golden kz-подмножестве 20% (n=5) — после деплоя замерить с live rewrite kz→ru

---

## Логи и дебаг

```bash
npx wrangler tail  # логи прод-воркера в реальном времени
curl -s https://snippy-llm.pages.dev/index/manifest.json | python3 -m json.tool  # версия индекса
GET /api/admin/health  # пул LLM, smart-метрики, бюджеты за сутки
npx wrangler pages deployment list --project-name snippy-llm
```

---

**No source → No claim. Если релевантность низкая или нет фрагмента — ответ: «В доступной нормативной базе точного требования не найдено.»**
