# Деплой SNIP.pro — бесплатно, Cloudflare Pages / Workers + Render

Текущий прод: **фронт** `https://snippy-llm.pages.dev` (Pages проект `snippy-llm`, `https://f7614645.snippy-llm.pages.dev`), **Git** `https://github.com/6l1x6n/SNIP_pro` `master` `538f202`. Бэк отдельно.

## Вариант C (рекомендуется, 0₸, без карты): Cloudflare Pages — фронт, Render/Fly — бэк

### 1. Cloudflare Pages — фронт SPA (0₸, безлимит трафик/запросы, глобальный CDN)

Фронт — статика `frontend/dist` (`Vite` 368kB, `_redirects /* /index.html 200`), бэк — отдельно.

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect Git** → `6l1x6n/SNIP_pro`
2. Настройки сборки:
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `frontend`
3. **Environment variables (Production + Preview):** `VITE_API_BASE=https://<ваш-бэк>.onrender.com` (URL бэка с Render/Fly, не `pages.dev`!). Для `workers.dev` алиаса тоже задайте.
4. **Deploy** → через минуту `https://<hash>.snippy-llm.pages.dev` + `https://snippy-llm.pages.dev` (прод). В `frontend/wrangler.toml:5` проект `snippy-llm`: `npx wrangler pages deploy frontend/dist --project-name snippy-llm --branch master --commit-dirty=true`
5. (Опц.) Custom domain: Pages → Custom domains → `CNAME` ваш домен → Pages. `workers.dev` алиас: Workers → `snippy-llm.workers.dev` через Workers Static Assets (тот же `dist`).

> Лимит Pages: 500 сборок/мес, файлы до 100МБ, трафик безлимит. `allow_origin_regex` в `backend/app/main.py:172` уже разрешает `https://*.pages.dev` и `https://*.workers.dev`.

### 2. База — Neon Free (pgvector)

1. https://neon.tech → New project → SQL: `CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;`
2. Скопировать `DATABASE_URL` `postgresql://...`

### 3. Бэк — Render Free (Docker) или Fly.io (не спит)

**Render Free** (спит 15м, 30д удаление — ок для демо):
1. https://render.com → New Web Service → Connect `6l1x6n/SNIP_pro` → Runtime `Docker` → `Dockerfile: backend/Dockerfile` → Root `backend` не нужен, build из корня
2. Env: `DATABASE_URL=<neon>`, `SYNC_DATABASE_URL=<neon>`, `SECRET_KEY=$(openssl rand -hex 32)`, `GROQ_API_KEY=gsk_...`, `OLLAMA_HOST=https://api.groq.com/openai/v1`, `GROQ_MODEL=qwen/qwen3.6-27b`, `CORS_ORIGINS=https://snippy-llm.pages.dev,https://snippy-llm.workers.dev,https://*.pages.dev,https://*.workers.dev`, `QUOTA_ENABLED=0`, `DISABLE_DB=0`, `ADMIN_EMAIL=...`
3. Deploy → `https://<ваш>.onrender.com` → `curl https://<ваш>.onrender.com/api/health` → `{"status":"ok","db":true}`
4. Keep-alive от сна: `*/10 * * * * curl -s https://<ваш>.onrender.com/api/health >/dev/null` (cron/UptimeRobot)

**Fly.io** (3 shared-1x VM free, не спит, 1GB — комфортнее для `torch`):
- `fly launch --dockerfile backend/Dockerfile` → тот же Env

**Проверка:** `curl -X POST https://<бэк>/api/search -H "Content-Type: application/json" -d '{"query":"ширина коридора","mode":"fast"}'`

### Env итог (Pages + бэк)

| Где | Переменная | Значение |
|---|---|---|
| Cloudflare Pages | `VITE_API_BASE` | `https://<бэк>.onrender.com` |
| Бэк (Render) | `DATABASE_URL` | `Neon Postgres + pgvector` |
| Бэк | `CORS_ORIGINS` | `https://snippy-llm.pages.dev,https://snippy-llm.workers.dev` |
| Бэк | `SECRET_KEY` | `openssl rand -hex 32` |
| Бэк | `GROQ_API_KEY` | `gsk_...` https://console.groq.com/keys |
| Бэк | `QUOTA_ENABLED` | `0` безлимит |
| Бэк | `DISABLE_DB` | `0` (1 только для демо без БД) |

### Быстрый CLI деплой фронта

```bash
cd frontend
npm install && npm run build        # проверка локально
npx wrangler pages deploy dist --project-name snippy-llm --branch master --commit-dirty=true
# workers.dev алиас (если мигрируете на Workers Static Assets):
# npx wrangler deploy --assets frontend/dist --name snippy-llm --compatibility-date 2024-09-23
```

---

## Вариант А: Oracle Always Free — 0₸/мес 4 OCPU/24GB/200GB/10TB (опционально, без домена)

Если нужен always-on без сна (500 DAU) — по IP + Caddy `:80` (без домена, фронт на `https://snippy-llm.pages.dev`).

1. https://cloud.oracle.com → EU Frankfurt 1 → VM.Standard.A1.Flex 4 OCPU/24GB Boot 50GB
2. Security List Ingress 22,80,443 → 0.0.0.0/0
3. SSH:
```bash
git clone https://github.com/6l1x6n/SNIP_pro.git ~/SNIP_pro
cd ~/SNIP_pro
cp .env.example .env
nano .env  # POSTGRES_PASSWORD, SECRET_KEY, CORS_ORIGINS=https://snippy-llm.pages.dev, VITE_API_BASE=https://<IP или pages.dev>
docker compose up -d --build
curl http://<IP>/api/health
# keep-alive
(crontab -l 2>/dev/null; echo "*/10 * * * * curl -s http://<IP>/api/health >/dev/null") | crontab -
```
`docker-compose.yml` не публикует `db/backend/frontend` наружу, только `caddy:80/443`. `VITE_API_BASE` вшивается на сборке фронту, менять — только `--build`.

---

## Вариант B: Vercel + Supabase (до 20 DAU)

Supabase `vector` → Vercel `frontend` `VITE_API_BASE` → Render `backend` — как C, но Vercel вместо Pages.

---

## Обновления

```bash
cd ~/SNIP_pro && git pull && docker compose up -d --build  # VM
# Pages: git push → авто redeploy; или wrangler pages deploy
```

## Бэкап

```bash
docker compose exec db pg_dump -U snip snip_pro | gzip > backup-$(date +%F).sql.gz
# или Neon → Dashboard → Backups
```

## Защита

Cloudflare WAF free, Caddy auto TLS (`:80`), `allow_origin_regex https://*.pages.dev|*.workers.dev|*.onrender.com`, JWT HS256 7д, `slowapi 1000/min` (безлимит), `bcrypt`, `pgvector` внутри docker сети.
