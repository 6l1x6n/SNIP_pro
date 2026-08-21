# SNIP.pro — полный обзор проекта

> Интеллектуальный справочник СНиП / СП / СН РК / СТ РК для архитекторов, ГИПов, конструкторов, инженеров.
> **Пользователь пишет вопрос своими словами → ИИ понимает смысл → находит релевантный пункт → показывает первым → даёт цитату, пункт, страницу, статус и ссылку.**
> Принцип: **No source → No claim**. Цитата проверяется дословно.

**Репозиторий:** `https://github.com/6l1x6n/SNIP_pro` `master` `538f202` (зеркало `https://github.com/deepseekpowered/www`)
**Деплой (фронт):** `https://snippy-llm.pages.dev` + `https://f7614645.snippy-llm.pages.dev` (Cloudflare Pages, `frontend/wrangler.toml:5`)
**Локально:** `http://localhost:5173` (Vite) → `http://localhost:8001` (FastAPI) → `PostgreSQL 17 /tmp` + `pgvector`

---

## 1. Архитектура

```
Официальный источник (adilet.zan.kz) → PDF (PyMuPDF / OCR) → PageText → SNIPChunker (regex пункт) → embeddings
paraphrase-multilingual-MiniLM-L12-v2 384d → PostgreSQL (pgvector HNSW + GIN tsvector + pg_trgm)
→ Hybrid search (BM25 + vector + RRF k=60 + 0.6*rrf+0.4*vector) → LLM (Groq qwen/qwen3.6-27b OpenAI-compat)
→ ответ с доказательством (is_grounded, quote, paragraph, page)
```

**Ключевой файл:** `backend/app/main.py:24` `lifespan` (создает `vector`, `pg_trgm`, `idx_chunks_*`), `backend/app/config.py:9` `Settings`, `backend/app/search/hybrid.py:335` — ядро.

### Поток данных
1. **Collector** `backend/app/collector/sources/adilet.py:114` парсит `adilet.zan.kz` (BeautifulSoup `a[href*=/rus/docs/]`), фильтр `СНиП/СН РК`, статус `утратил/заменён`, `download_pdf` по `a[href$=.pdf]`, checksum, `replaced_by_id`. `backend/app/collector/scheduler.py:89` APScheduler ежедневно `02:00 Asia/Almaty` (включается `ENABLE_COLLECTOR=1`).
2. **Extractor** `backend/app/pipeline/extractor.py:103` `fitz` `get_text(flags=TEXTFLAGS_TEXT)`, эвристика скана `scanned_ratio<0.3`, fallback `pytesseract rus+kaz+eng` dpi200.
3. **Chunker** `backend/app/pipeline/chunker.py:130` `MAX_CHARS=2000` overlap `400`, режет по `^\d+(\.\d+)*` `Глава|Раздел|Таблица`, не режет пункт, `token_count=len(split)`.
4. **Indexer** `backend/app/pipeline/indexer.py:167` `sha256` dedup по `checksum+owner_id`, batch embed `16`, `UPDATE chunks set text_tsv=to_tsvector`.
5. **Embeddings** `backend/app/embeddings/provider.py:106` `SentenceTransformerProvider` (lazy, `run_in_executor`) + `OllamaEmbeddingProvider` (`/api/embed`), фабрика `ollama:` prefix.
6. **Search** `backend/app/search/hybrid.py:335` — BM25 `ts_rank_cd`, Vector `1-(embedding<=>CAST)`, Trigram `similarity>0.2`, RRF `1/(60+rank)`, фильтры `status/type/document_id/owner_id`, `owner_id IS NULL OR =:id` (свои+общие).
7. **LLM** `backend/app/llm/provider.py:118` Groq `https://api.groq.com/openai/v1` `Bearer gsk_...` `model qwen/qwen3.6-27b` (был `llama-3.1-8b-instant` decommissioned 2025) → `/v1/chat/completions` → fallback `/api/chat` → `/api/generate`, `temperature 0.1` `max_tokens 1000/1600` `config.py:36`, strip `<think>` для qwen. `backend/app/llm/answer.py:235` `quote_grounded 85%` + JSON-only prompt + `date_actual`.

---

## 2. Стек

| Слой | Технология | Версия / файл |
|---|---|---|
| **Backend** | Python + FastAPI + Uvicorn | `backend/requirements.txt:1` `fastapi==0.115.6`, `uvicorn 0.34`, `python:3.12-slim` `backend/Dockerfile:1` |
| **DB** | PostgreSQL 17 + pgvector 0.4 + pg_trgm + HNSW/GIN | `docker-compose.yml:3` `ankane/pgvector:latest`, `backend/app/models/document.py:101` `Vector(384)` |
| **ORM** | SQLAlchemy 2.0 async + asyncpg 0.30 | `backend/app/core/db.py:6` `pool_pre_ping=True`, `pool_size 10` |
| **Embed** | sentence-transformers 5.0 + torch 2.7 | `backend/app/embeddings/provider.py:106` `paraphrase-multilingual-MiniLM-L12-v2 384d` |
| **LLM** | Groq OpenAI-compat `qwen/qwen3.6-27b` | `backend/app/config.py:19` `groq_model`, `backend/app/llm/provider.py:25` legacy map |
| **Frontend** | React 19.2.8 + Vite 8.2 + Tailwind 3.4 + TS 6.0 | `frontend/package.json:12` `vite.config.ts:5` proxy `/api→8001` |
| **Infra** | Docker Compose 4 сервиса + Caddy 2 + Nginx | `docker-compose.yml:1`, `Caddyfile:1`, `frontend/nginx.conf` |
| **Deploy** | Cloudflare Pages (Pages) + Render (Docker) / Oracle VM | `DEPLOY.md:154`, `frontend/wrangler.toml:5` `snippy-llm` |

---

## 3. Структура проекта

```
SNIP_pro/
  backend/
    app/
      main.py              # FastAPI + lifespan + CORS + /api/health + serve frontend/dist
      config.py            # Settings (env_file backend/.env, quota, disable_db, groq, top_k)
      core/db.py           # async_engine / sync_engine / get_db (DISABLE_DB mock)
      core/quota.py        # ANON 999999 / REGISTERED 999999, QUOTA_ENABLED=0 безлимит
      core/security.py     # bcrypt + JWT HS256 7 дней
      core/deps.py         # get_current_user_optional (Bearer JWT / sk- X-API-Key)
      models/document.py   # Document, Chunk(Vector384), DocumentVersion, CollectorLog
      models/user.py       # User api_key sk-
      models/pinned.py     # PinnedDocument
      pipeline/extractor.py, chunker.py, indexer.py
      search/hybrid.py     # HybridSearchService
      embeddings/provider.py
      llm/provider.py, answer.py
      collector/sources/adilet.py, scheduler.py
      api/search.py, documents.py, admin.py, auth.py, pins.py
      schemas/search.py, auth.py
    requirements.txt (42 пакета) / Dockerfile / alembic.ini (пуст)
    storage/pdfs/ 12 PDFs + chunks/
  frontend/
    src/
      App.tsx (266L, // @ts-nocheck) # God-component tab search|docs|settings|profile
      main.tsx # 5 провайдеров Theme>Auth>Pinned>Basket>Toast
      views/SearchView.tsx 453L, DocsView.tsx 874L, ProfileView.tsx
      components/ 17 шт: BasketBar, PinnedDropdown, SnakeState, VoiceButton, etc.
      context/AuthContext, PinnedContext 256L, BasketContext 295L, ThemeContext
      hooks/useSearch, useDocuments, useUpload 161L, useVoiceSearch
      utils/api.ts (API_BASE + DEVICE_ID + authFetch), highlight.tsx
    vite.config.ts / tailwind.config.cjs / wrangler.toml / nginx.conf / Dockerfile
    dist/ 368kB (index-9dEntI08.css + index-BlbXcgv9.js) / public/_redirects
  scripts/seed.py 147L / generate_secret.py / deploy_oracle.sh 32L
  docker-compose.yml / Caddyfile / .dockerignore / .env.example / PROJECT.md
  start.sh / stop.sh / SNIP_pro.command 127L / Запуск.txt
```

---

## 4. БД схема (`backend/app/models/document.py:101`)

* `Document` `id UUID pk`, `number String(200) unique`, `title/title_kz`, `type/category`, `status enum active/replaced/expired/amended/draft/archived`, `publication_date/effective_date`, `language`, `pdf_path`, `checksum`, `replaced_by_id FK`, `owner_id UUID FK users(CASCADE) idx` (личные vs общие `owner_id IS NULL`), `created_at/updated_at`, `chunks cascade delete`
* `Chunk` `id UUID`, `document_id FK`, `paragraph String(100) idx`, `section/chapter`, `page/page_bbox JSON`, `text Text`, `text_tsv Text` (GIN `to_tsvector(russian)`), `type paragraph|table|note`, `embedding Vector(384) HNSW cosine`, `token_count`
* `DocumentVersion`, `CollectorLog(status/details/created_at)`, `User(email unique, hashed_password bcrypt, api_key 120 unique, is_active/superuser)`, `PinnedDocument(user_id, document_id/chunk_id unique 50 limit)`

Индексы создаются в `backend/app/main.py:58` `idx_chunks_tsv` GIN + `idx_chunks_embedding` HNSW (self-healing без Alembic).

---

## 5. Гибридный поиск (`backend/app/search/hybrid.py:335`)

* **Synonyms** 11 ключей `коридор=проход=эвакуационный путь`, `лестница=марш=клетка` `normalize_query` + `expand_with_synonyms` (deep mode до 3 парафраз)
* **BM25** `ts_rank_cd(to_tsvector('russian', text), plainto_tsquery('russian', :q))` `bm25_limit 50/80` `config.py:30`
* **Vector** `1 - (embedding <=> CAST(:q_emb AS vector))` `vector_limit 50/80`, `normalize_embeddings=True`
* **Trigram** `similarity(text,:q)>0.2` fallback + `ILIKE %q%`
* **RRF** `k=60` `1/(k+rank) + bm*0.2 + vec*0.3`, нормализация `max_rrf` → `0.6*norm+0.4*vector_score` → `relevance_percent 10-98` `relevance_label`
* **Anti-hallucination** `backend/app/api/search.py:103` adaptive guard: `<2000 чанков` порог `vec<0.25 && bm<0.005 && fusion<0.35`, иначе `0.32/0.01`, лог `q top vec/bm/fusion`
* **Режимы** `fast top_k 10 / deep 20`, LLM `fast top3 1000 tokens 0.1` vs `deep top5 1600 0.15`

---

## 6. Квота и лимиты

**Текущее (безлимит для Pages free):**
* `backend/app/config.py:47` `quota_enabled=False` (`QUOTA_ENABLED=0` в `.env`), `quota_anon_limit=999999` `quota_registered_limit=999999` `quota_window_hours=24`
* `backend/app/core/quota.py:13` `ANON_QUOTA=999999` `REGISTERED_QUOTA=999999`, `check_quota` `quota.py:31` early return `remaining 999999` если `quota_enabled=False`, ключ `anon:X-Device-Id` (`frontend/src/utils/api.ts:31` `crypto.randomUUID` `snip_device_id`) или `user:<uuid>`, in-memory `dict count/first_seen` (сброс при рестарте, не шарится между `workers=2` — для прода нужен Redis)
* `backend/app/main.py:110` `Limiter 1000/minute` если безлимит, иначе `200/min`, `backend/app/api/search.py:51` `@limiter 1000/min` (было `30/min`)
* Фронт `frontend/src/hooks/useSearch.ts:98` ловит `429` → `quotaExceeded` модалка, иначе `X-Quota-Remaining/Limit` `search.py:210`

**Старое:** `ANON 30 lifetime / REGISTERED 200` — бьет за 10 мин демо, поэтому отключено.

---

## 7. Деплой — где и как

### Текущий деплой (фронт, 21.08.2026)
* **Git:** `https://github.com/6l1x6n/SNIP_pro` `master` `538f202` (зеркало `deepseekpowered/www` `e29fd92` — пуш туда `403` нет прав, новый `origin2` `6l1x6n/SNIP_pro`)
* **Фронт Cloudflare Pages:** `https://snippy-llm.pages.dev` (прод) + `https://f7614645.snippy-llm.pages.dev` (деплоя `f7614645-80e2-419c` `master` `538f202` `Project prod`), проект `snippy-llm` `frontend/wrangler.toml:5`, билд `npm install && npm run build` `frontend/package.json:8` `tsc -b && vite 368kB`, `Root: frontend`, `Output: dist`, `_redirects /* /index.html 200`, команда `npx wrangler pages deploy frontend/dist --project-name snippy-llm --branch master --commit-dirty=true` (локально `wrangler 4.125`)
* **Статус:** фронт без бэка — `/api/search` `fetch API_BASE` `frontend/src/utils/api.ts:5` `VITE_API_BASE || http://localhost:8001` → в проде уходит на `localhost` и падает (нужен `VITE_API_BASE=https://<render>.onrender.com` в Pages Env)

### Варианты из `DEPLOY.md:154`

| Вариант | Где | Цена | Когда |
|---|---|---|---|
| **А — Oracle Always Free** `DEPLOY.md:3` | `nic.ua pp.ua 0₸` + Cloudflare Free + Oracle VM `Standard.A1.Flex 4 OCPU/24GB/200GB/10TB` `eu-frankfurt-1` + `docker-compose.yml` `db/backend/frontend/caddy` (только Caddy `:80/443` наружу) | 0₸ навсегда (карта холд $1) | Прод 500 DAU, не спит, 24GB для `torch` |
| **B — Vercel+Supabase+Render** `DEPLOY.md:72` | Supabase `vector`, Vercel `frontend`, Render `backend` Docker | Free до 20 DAU, потом $35, Render спит 15м | Демо без карты, не для прода |
| **C1 — Pages фронт + существующий бэк** `DEPLOY.md:107` | Pages `frontend/dist` + твой бэк `VITE_API_BASE` | 0₸ фронт безлимит | Если бэк уже на `https://<бэк>.onrender.com` |
| **C2 — Полный free** `DEPLOY.md:126` | Pages `frontend` + Neon 0.5GB `CREATE EXTENSION vector` + Render `backend` Docker (`GROQ_API_KEY`) | 0₸ без карты, Render спит | Быстрый прод без VPS (512MB впритык) |

### Docker Compose (`docker-compose.yml:1`)

* `db: ankane/pgvector:latest` `snip_db` `pgdata:/var/lib/postgresql/data` `healthcheck pg_isready` (no ports)
* `backend: build ./backend` `snip_backend` `DATABASE_URL asyncpg db:5432` `SYNC_DATABASE_URL` `SECRET_KEY` `CORS_ORIGINS` `EMBEDDING_MODEL` `OLLAMA_HOST https://api.groq.com/openai/v1` `OLLAMA_MODEL qwen/qwen3.6-27b` `GROQ_API_KEY gsk_...` `GROQ_MODEL qwen/qwen3.6-27b` `QUOTA_ENABLED 0` `DISABLE_DB 0` `volumes ./backend/storage:/app/storage` `depends_on db healthy` `healthcheck curl -f /api/health` `workers 2`
* `frontend: build ./frontend` `args VITE_API_BASE` `snip_frontend` `depends_on backend` (no ports)
* `caddy: caddy:2-alpine` `snip_caddy` `ports 80:80 443:443/udp` `volumes Caddyfile + caddy_data/config` `encode zstd gzip` `header HSTS 31536000`

**Caddyfile:1** (для локального Docker, для Pages не нужен)
```
:80 {
  handle /api/* { reverse_proxy backend:8001 }
  handle /docs* { reverse_proxy backend:8001 }
  handle /openapi.json* { reverse_proxy backend:8001 }
  handle { reverse_proxy frontend:80 }
  header { HSTS; X-Frame-Options DENY; X-Content-Type-Options nosniff }
  encode zstd gzip
}
```
Для без домена — Pages фронт + Render бэк, Caddy не нужен.

### Env (`.env.example:1`, `.env` + `backend/.env` — в `.gitignore:9` не коммитить)

| Var | Значение (прод Pages) | Где |
|---|---|---|
| `POSTGRES_USER/PASSWORD/DB` | `snip / bYbJ... / snip_pro` | `docker-compose.yml:6` |
| `SECRET_KEY` | `openssl rand -hex 32` `4d063f...` | `backend/app/config.py:43` HS256 |
| `DATABASE_URL` | `postgresql+asyncpg://snip:...@db:5432/snip_pro` (compose) / `Neon` для Render | `backend/app/core/db.py:6` |
| `CORS_ORIGINS` | `https://snippy-llm.pages.dev,https://snippy-llm.workers.dev,http://localhost:5173,https://*.pages.dev,https://*.workers.dev,https://*.onrender.com` | `backend/app/main.py:137` `allow_origin_regex` |
| `VITE_API_BASE` | `https://<render>.onrender.com` (Pages → Env) | `frontend/Dockerfile:7` `ARG` (вшивается) / `frontend/src/utils/api.ts:5` |
| `EMBEDDING_MODEL` | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 384d | `backend/app/config.py:14` |
| `OLLAMA_HOST` | `https://api.groq.com/openai/v1` | `backend/app/llm/provider.py:25` `groq.com` check |
| `GROQ_API_KEY` | `gsk_VpTujd4QBbz...` `console.groq.com/keys` | `backend/.env:11` |
| `GROQ_MODEL` | `qwen/qwen3.6-27b` (был `llama-3.1-8b-instant` decommissioned) | `backend/app/config.py:19` |
| `QUOTA_ENABLED` | `0` безлимит `1` вкл | `backend/app/core/quota.py:31` |
| `DISABLE_DB` | `0` с PG `1` мок без БД (Pages) | `backend/app/core/db.py:6` `backend/app/main.py:24` |
| `ADMIN_EMAIL` | `postalarchive@gmail.com` | `backend/app/config.py:46` first superuser |
| `ENABLE_COLLECTOR` | `0` (включать `1` для APScheduler) | `backend/app/main.py:90` |

### Без БД режим (`DISABLE_DB=1` для Pages free)

* `backend/app/core/db.py:6` `async_engine=None`, `get_db` yield `None`, `backend/app/main.py:24` skip DDL + log `mock mode`, `backend/app/api/search.py:68` прямой `LLMProvider.generate` без RAG или заглушка «Загрузите PDF», `backend/app/api/documents.py:18` `[]`, `/stats` `mode:no_db`, `/health` `{"status":"ok","mode":"no_db"}`. Для Pages фронта достаточно — UI открывается, поиск честно говорит что БД выключена.

---

## 8. Локальный запуск (macOS M3)

```bash
# 1. PG 17 + pgvector
brew install postgresql@17 pgvector
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /opt/homebrew/var/log/postgresql@17.log start
psql -h /tmp -U alikhan -d postgres -c "CREATE DATABASE snip_pro;"
psql -h /tmp -U alikhan -d snip_pro -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;"

# 2. Backend
cd backend
/opt/homebrew/bin/python3 -m pip install --break-system-packages -r requirements.txt
cp .env.example .env  # заполни GROQ_API_KEY, SECRET_KEY
/opt/homebrew/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8001  # или DISABLE_DB=1
curl http://localhost:8001/api/health
curl http://localhost:8001/api/stats
# seed демо PDFs:
python ../scripts/seed.py  # копирует СНиП_1.02.01-85 (158 чанков) + 11 синтетических

# 3. Frontend
cd frontend
/opt/homebrew/bin/npm install
/opt/homebrew/bin/npm run dev -- --host 0.0.0.0 --port 5173  # http://localhost:5173
/opt/homebrew/bin/npm run build  # dist 368kB

# 4. Docker (прод локально)
docker compose up -d --build
docker compose logs -f backend
curl http://localhost:8001/api/health  # через Caddy :80
# или https://snippy-llm.pages.dev/api/health (если бэк на Render)
```

`start.sh` / `SNIP_pro.command 127L` (двойной клик, `ROOT="$(cd "$(dirname "$0")"`, `rm postmaster.pid`, `ollama serve`, `open http://localhost:5173`), `stop.sh` `pkill vite/uvicorn`.

---

## 9. API (`README.md:108`)

```
POST /api/search {query, mode:fast|deep, top_k, filters:{type,status,document_id}} → {answer, results, took_ms}
GET  /api/search?q=...&mode=fast&top_k=10
GET  /api/documents?status=active&skip=0&limit=50
GET  /api/documents/{id}
GET  /api/documents/{id}/pdf → FileResponse
GET  /api/documents/{id}/chunks
GET  /api/stats
GET  /api/health → {status:ok, db:bool, mode:no_db?}
POST /api/admin/documents/upload (multipart file, doc_number, title, doc_type)
POST /api/admin/collector/run
GET  /api/admin/collector/logs
POST /api/auth/register {email,password,full_name} 5/hour
POST /api/auth/login (OAuth2 form) 10/min
GET  /api/auth/me
POST /api/auth/api-key/regenerate (sk-)
GET/POST/DELETE /api/pins (до 50)
```

`X-Quota-Remaining/Limit` + `X-Device-Id` `frontend/src/utils/api.ts:31`, `Authorization Bearer JWT / X-API-Key sk-` `backend/app/core/deps.py:42`.

---

## 10. Демоданные (`README.md:162`)

* `СНиП 1.02.01-85` 51 стр 158 чанков (PDF в корне)
* `СН РК 3.02-43-2011` 4 чанка (п.5.8 коридор 1.4м стр42)
* `СП РК 3.02-101-2012` 4 чанка
* `СН РК 2.02-01-2014` 3 чанка (пожарка МГН)
* `СТ РК 21.01-2019` 1 чанк `replaced` → `Заменён: СН РК 2.02-01-2014`

Поиск тест: `ширина коридора`, `лестничная клетка`, `марш` → `relevance 87-91%` + цитата.

---

## 11. Ограничения MVP (`README.md:172`)

* [ ] Reranker `bge-reranker-v2-m3` (сейчас RRF)
* [ ] Таблицы `camelot/tabula` `type=table`
* [ ] OCR `tesseract rus/kaz` уже в `backend/Dockerfile:11`
* [ ] Кэш embeddings Redis
* [ ] Пагинация чанков с bbox
* [ ] i18n kz
* Техдолг: `frontend/src/App.tsx:1` `// @ts-nocheck` + `as any`, `App` God-component, нет `React.lazy`, нет `ErrorBoundary`, `quota` in-memory (нужен Redis), `create_all` без Alembic, `torch 2.7` тяжелый образ ~3GB.

---

## 12. Логи и дебаг (`README.md:183`)

```bash
tail -f /tmp/snip_backend.log /tmp/snip_frontend.log /opt/homebrew/var/log/postgresql@17.log
curl -s http://localhost:11434/api/tags | jq  # ollama
curl -s http://localhost:8001/api/health | jq
docker compose logs -f backend db caddy
npx wrangler pages deployment list --project-name snippy-llm
```

---

**No source → No claim. Если `relevance <55%` или нет фрагмента — «В доступной нормативной базе точного требования не найдено.»**
