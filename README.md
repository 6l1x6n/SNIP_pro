# SNIP.pro — Интеллектуальный справочник СНиП / СП / СН РК

Профессиональный AI-поиск по действующим строительным нормам Казахстана для архитекторов, ГИПов, конструкторов, инженеров.

> **Пользователь пишет вопрос своими словами → ИИ понимает смысл → находит релевантный пункт → показывает первым → даёт цитату, пункт, страницу, статус и ссылку.**

**Стек:** Python + FastAPI + PostgreSQL 17 + pgvector + tsvector/pg_trgm + sentence-transformers + Ollama (gemma/qwen) + React + Vite + Tailwind

---

## Архитектура

```
Официальный источник → актуальный PDF → PyMuPDF → текст/OCR → chunker → embeddings (paraphrase-multilingual-MiniLM-L12-v2 384d, легко заменить на BGE-M3 1024d) → PostgreSQL(pgvector + gin tsvector + hnsw) → Hybrid search (BM25 + vector + RRF) → LLM (Ollama gemma4:e2b) → ответ с доказательством

Принцип: No source → No claim. Цитата проверяется дословно.
```

**Гибридный поиск:**

- `BM25` via `ts_rank_cd(to_tsvector('russian', text), plainto_tsquery('russian', :q))` — точный полнотекстовый
- `Vector` via `pgvector <=> CAST(:q_emb AS vector)` cosine — семантика, синонимы (`коридор=проход=эвакуационный путь`, `лестница=марш=клетка`)
- `Trigram` + `ILIKE` fallback для опечаток
- `Reciprocal Rank Fusion (k=60)` + взвешивание `0.6*rrf + 0.4*vector_score` → ` релевантность %` + label
- Режимы: **Быстрый** (топ-3 в LLM) ~4-6с, **Глубокий** (топ-5, анализ нескольких документов) ~8-12с

**LLM:** Ollama OpenAI-совместимый `/v1/chat/completions` → `/api/chat` → `/api/generate` fallback, модель `gemma4:e2b` (9GB, ru/kz лучше) / `qwen2.5-coder` fallback, temp 0.1, strict grounding prompt, проверка `quote in context` fuzzy.

**Collector:** `app/collector/sources/adilet.py` — парсит `adilet.zan.kz` (BeautifulSoup), ищет `СН РК/СНиП/СП РК`, определяет статус `действует/утратил силу/заменён` по тексту, скачивает PDF, checksum, ставит `replaced_by_id`. APScheduler ежедневно 02:00 Asia/Almaty.

**PDF Pipeline:** `PyMuPDF` → `PageText` (is_scanned эвристика `scanned_ratio<0.3`), fallback `pytesseract rus+kaz+eng`, `SNIPChunker` по regex `^\d+(\.\d+)*`, `Глава|Раздел|Таблица`, не режет пункт, sliding window 2000 chars overlap 400, сохраняет `paragraph/page/chapter`.

---

## Быстрый старт (macOS M3)

### 1. PostgreSQL 17 + pgvector

```bash
brew install postgresql@17 pgvector
# запустить вручную (brew services может падать из-за SDK):
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /opt/homebrew/var/log/postgresql@17.log start
psql -h /tmp -U alikhan -d postgres -c "CREATE DATABASE snip_pro;"
psql -h /tmp -U alikhan -d snip_pro -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;"
```

### 2. Backend

```bash
cd backend
/opt/homebrew/bin/python3 -m pip install --break-system-packages -r requirements.txt
# альтернативно: /Library/Frameworks/Python.framework/Versions/3.13/bin/pip install ...

# проиндексировать демо-PDF (СНиП_1.02.01-85) + синтетические СН РК/СП РК:
/opt/homebrew/bin/python3 -c "import sys; sys.path.insert(0,'.'); import asyncio; from app.core.db import async_engine, Base; from app.models.document import *; from sqlalchemy import text; asyncio.run(...))"  # см. scripts/seed.py
# или просто запустить — таблицы создаются автоматом:
nohup /opt/homebrew/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8001 > /tmp/snip_backend.log 2>&1 &
curl http://localhost:8001/api/stats
```

### 3. Frontend

```bash
cd frontend
/opt/homebrew/bin/npm --prefix . install
/opt/homebrew/bin/npm --prefix . run dev -- --host 0.0.0.0 --port 5173
# открыть http://localhost:5173
# build для продакшена (отдаётся backend’ом если dist существует):
/opt/homebrew/bin/npm --prefix . run build
```

### 4. Ollama

```bash
brew install ollama
ollama serve &
ollama pull gemma4:e2b        # 7GB, лучший ru
# альтернативы: gemma4:12b-mlx, qwen2.5-coder:latest (уже есть)
curl http://localhost:11434/api/tags
```

---

## Использование

**Поиск:**
- Введите: `минимальная ширина коридора`, `какой должен быть коридор по ширине`, `ширина прохода в общественном здании`, `сколько метров должен быть коридор`, `минимальный проход`, `ширина эвакуационного пути` — все найдут один пункт с ранжированием 87-91% (demo: СН РК 3.02-43-2011 п.5.8 стр.42, СП РК 3.02-101-2012 п.4.15)
- `лестница`, `лестничная клетка`, `марш`, `эвакуационная лестница` — семантически связаны, находят п.6.12, 8.2.1, 5.22
- Фильтры: тип (СНиП/СН РК/СП РК), статус (действует по умолчанию), язык, документ

**Ответ ИИ:**
```
Ответ: краткое объяснение
Нормативное основание: СН РК 3.02-43-2011
Пункт: 5.8
Страница: 42
Цитата: “Ширина коридоров в жилых зданиях должна быть не менее 1,4 м...”
Статус: действует
Дата актуальности: 19.08.2026
```

**Документы:** вкладка Документы — список с пагинацией, бейдж статуса, PDF по клику (`/api/documents/{id}/pdf` → FileResponse)

**Админ:** вкладка Админ — загрузка PDF (multipart) → индексация, кнопка запуска Collector, логи `collector_logs`.

---

## API

```
POST /api/search {query, mode:fast|deep, top_k, filters:{type,status,document_id}}
→ {answer:{answer, normative_basis, paragraph, page, quote, status, date_actual, is_grounded}, results:[{... relevance_percent, relevance_label }], took_ms}

GET  /api/search?q=...&mode=fast&top_k=10
GET  /api/documents?status=active&skip=0&limit=50
GET  /api/documents/{id}
GET  /api/documents/{id}/pdf
GET  /api/documents/{id}/chunks
GET  /api/stats
GET  /api/health
POST /api/admin/documents/upload (multipart: file, doc_number, title, doc_type, source_url)
POST /api/admin/collector/run
GET  /api/admin/collector/logs
```

---

## Структура

```
backend/
  app/
    main.py              # FastAPI + CORS + статика frontend/dist
    config.py            # Settings (embedding_model, ollama, top_k)
    core/db.py           # async_engine + sync_engine (/tmp socket)
    models/document.py   # Document, Chunk(vector 384), Versions, Logs
    schemas/search.py
    embeddings/provider.py # SentenceTransformer + Ollama fallback
    pipeline/extractor.py, chunker.py, indexer.py
    search/hybrid.py     # BM25 + vector + RRF
    llm/provider.py, answer.py
    collector/sources/adilet.py, scheduler.py
    api/search.py, documents.py, admin.py
frontend/
  src/App.tsx            # поиск + фильтры + доки + админ
  vite.config.ts (proxy /api → 8001)
scripts/seed.py
```

---

## Замена компонентов (модульность)

- **LLM:** `app/config.py: ollama_model` → любая Ollama/vLLM OpenAI-совместимая
- **Embedding:** `embedding_model` → `BAAI/bge-m3` (1024d, нужно изменить `Vector(384)` → `Vector(1024)` и пересоздать индекс) или `ollama:nomic-embed-text`
- **Vector DB:** заменить `search/hybrid.py` vector_sql → Qdrant/Chroma, интерфейс `EmbeddingProvider`
- **OCR:** `extractor.py: extract_with_ocr` → заменить `pytesseract` на `RapidOCR/PaddleOCR`
- **Источник:** `collector/sources/adilet.py` → добавить новый класс с тем же интерфейсом `search_snip/download_pdf`

---

## Демоданные

- `СНиП 1.02.01-85` — 51 стр, 158 чанков, реальный PDF из `SNIP_pro/`
- `СН РК 3.02-43-2011` — 4 чанка (коридор/эвакуация/лестница/высота)
- `СП РК 3.02-101-2012` — 4 чанка (коридоры общественные, расстояние между зданиями)
- `СН РК 2.02-01-2014` — 3 чанка (пожарка, МГН)
- `СТ РК 21.01-2019` — 1 чанк статус `replaced` → показывает `Заменён: СН РК 2.02-01-2014`

---

## TODO / ограничения MVP

- [ ] Reranker `bge-reranker-v2-m3` cross-encoder (сейчас RRF + вектор)
- [ ] Таблицы (`camelot`/`tabula`) — отдельный `type=table` чанк
- [ ] OCR для сканов (требует `brew install tesseract tesseract-lang`)
- [ ] Кэш embeddings (redis уже стоит)
- [ ] Пагинация чанков в PDF viewer с подсветкой bbox
- [ ] i18n kz (сейчас ru + понимает kz запросы через multilingual embeddings)

---

## Логи

```bash
tail -f /tmp/snip_backend.log
tail -f /tmp/snip_frontend.log
tail -f /opt/homebrew/var/log/postgresql@17.log
curl -s http://localhost:11434/api/tags | jq
```

---

**No source → No claim. Если `relevance <55%` или нет фрагмента — ответ: «В доступной нормативной базе точного требования не найдено.»**
