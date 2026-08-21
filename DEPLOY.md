# Деплой SNIP.pro на snip.pp.ua — полностью бесплатно, онлайн, с запасом

## Вариант А (рекомендуется): Oracle Always Free — 0₸/мес навсегда, 4 OCPU/24GB/200GB/10TB

### 1. Домен snip.pp.ua (15 мин, 0₸)

1. https://nic.ua → Регистрация → поиск `snip` → зона `.pp.ua` → в корзину → 0₸
2. Подтверждение по SMS: `pp.ua` → ввести код или бот `@ppuabot` в Telegram
3. NIC.UA → Мои домены → `snip.pp.ua` → NS → вставить Cloudflare NS `*.ns.cloudflare.com` (см. шаг 2)
4. Продление раз в год за 60 дней до истечения → 0₸ (календарь!)

### 2. Cloudflare (5 мин, бесплатно)

1. https://dash.cloudflare.com → Add site `snip.pp.ua` → Free план → скопировать 2 NS
2. DNS → `A snip.pp.ua → X.Y.Z.W` (IP Oracle VM), `CNAME www → snip.pp.ua`, Proxy 🟠 ON
3. SSL/TLS → Full (strict) — Cloudflare → Origin (Caddy) auto Let's Encrypt

### 3. Oracle Cloud VM (30 мин, карта холд $1, списаний 0)

1. https://cloud.oracle.com → Sign Up → Home Region **eu-frankfurt-1** (ближе к KZ, 80ms) → Free Tier
2. Через 2д → Upgrade to Pay As You Go (оставляет Always Free, убирает риск удаления idle)
3. Networking → VCN → Create `snip-vcn` 10.0.0.0/16 → public subnet + IGW
4. Security List → Ingress: 22,80,443 → 0.0.0.0/0
5. Compute → Create Instance → Image Ubuntu 24.04 Minimal aarch64 (Always Free) → Shape VM.Standard.A1.Flex **4 OCPU / 24GB** → Boot 50GB → SSH key `~/.ssh/id_rsa.pub` → Public IP

> Если `Out of host capacity` → пробуйте AD-2/AD-3 или `2 OCPU/12GB` ×2 или Stockholm регион.

### 4. Деплой (10 мин, SSH)

```bash
ssh ubuntu@X.Y.Z.W
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && newgrp docker
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT

git clone https://github.com/<you>/SNIP_pro.git ~/SNIP_pro
cd ~/SNIP_pro

# .env — сгенерируйте секрет!
openssl rand -hex 32  # → в SECRET_KEY
cp .env.example .env
nano .env  # POSTGRES_PASSWORD, SECRET_KEY, ADMIN_EMAIL=ваш@email, CORS_ORIGINS=https://snip.pp.ua
# ОБЯЗАТЕЛЬНО задайте VITE_API_BASE=https://snip.pp.ua (фронт собирается с ним внутри образа)

docker compose up -d --build
docker compose logs -f backend  # ждите "ready"
docker compose exec backend python -c "from scripts.seed import main; import asyncio; asyncio.run(main())"  # опционально seed

# Keep alive от удаления idle (Oracle удаляет если CPU<20% 7д)
(crontab -l 2>/dev/null; echo "*/10 * * * * curl -s https://snip.pp.ua/api/health >/dev/null") | crontab -
```

Проверка: `curl https://snip.pp.ua/api/health` → `{"status":"ok"}`

### 5. Обновления

```bash
cd ~/SNIP_pro && git pull && docker compose up -d --build
```

### 6. Прод-заметки (compose уже заточен под прод)

* `docker-compose.yml` **не публикует** порты `db` (5432), `backend` (8001) и `frontend` (80): все они доступны только внутри docker-сети, а наружу ходит только **Caddy** (80/443). Снаружи БД и API недостижимы напрямую.
* Код бэкенда **запечатан в образ** (bind-mount `./backend/app` убран) — локальные правки не перезапишут прод случайно. Для обновления кода: `git pull && docker compose up -d --build`.
* Загрузки хранятся в `./backend/storage` (монтируется как volume) — не потеряются при пересборке образа.
* `VITE_API_BASE` подставляется **на этапе сборки** фронта (build arg). Менять адрес API после сборки нельзя — только через `--build` с новым `.env`.
* Точка входа TLS: Cloudflare (Full strict) → Caddy (auto Let's Encrypt) → сервисы. Прямой HTTP на IP отвечает заглушкой.

---

## Вариант B (без карты): Vercel + Supabase Free (до 20 DAU, потом $35)

1. Supabase → New project → enable `vector` → `DATABASE_URL` → Vercel env
2. Vercel → Import `frontend` → `VITE_API_BASE=https://<render>.onrender.com`
3. Render → Web Service `backend` → Docker → `DATABASE_URL` → free (спит 15м, 30д удаление — не для продакшн норм)

> Для headroom 500 DAU — только Oracle подходит.

## Env для продакшн

```
POSTGRES_USER=snip
POSTGRES_PASSWORD=сгенерить_32
POSTGRES_DB=snip_pro
SECRET_KEY=openssl_rand_hex_32
CORS_ORIGINS=https://snip.pp.ua,https://www.snip.pp.ua
VITE_API_BASE=https://snip.pp.ua
ADMIN_EMAIL=admin@snip.pp.ua
ENABLE_COLLECTOR=1
```

## Бэкап (бесплатно)

```bash
docker compose exec db pg_dump -U snip snip_pro | gzip > /home/ubuntu/backup-$(date +%F).sql.gz
# + Oracle Object Storage free 20GB → rclone
```

## Защита

* Cloudflare WAF free, Caddy auto TLS, `allow_origins` без `*`, JWT HS256, `slowapi 30/min`, `hashed_password bcrypt`, `pgvector` внутри docker сети.

---

## Вариант C (самый бесплатный фронтенд): Cloudflare Pages — 0₸, без лимита запросов

Cloudflare Pages — щедрый бесплатный хостинг статических сайтов: неограниченный трафик и запросы, глобальный CDN, бесплатные SSL. Идеально для SPA-фронтенда SNIP.pro. Бэкенд (FastAPI + Postgres/pgvector) требует сервера и в этом варианте либо уже крутится на snip.pp.ua, либо докручивается бесплатно отдельно.

### Сценарий 1 — только фронтенд (рекомендуется, если бэкенд уже работает)

Фронтенд общается с API через переменную `VITE_API_BASE`, поэтому достаточно собрать SPA и отдать её с Cloudflare, а запросы пускать на уже существующий бэкенд.

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → подключить Git** (GitHub/GitLab) → выбрать репозиторий `SNIP_pro`.
2. Настройки сборки:
   - **Build command:** `npm install && npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `frontend`
3. **Environment variables (Production):** `VITE_API_BASE=https://snip.pp.ua` (или адрес вашего бэкенда). Для Preview тоже задайте `VITE_API_BASE`.
4. **SPA-роутинг:** в репозиторий уже добавлен `frontend/public/_redirects` (`/*  /index.html 200`), Vite копирует его в `dist`. Он перенаправляет все пути на `index.html`.
5. **Deploy** → через ~1 минуту сайт на `*.pages.dev`. В `wrangler.toml` (в `frontend/`) прописан проект для CLI-деплоя: `wrangler pages deploy dist`.
6. (Опц.) Свой домен: Cloudflare → DNS → добавить сайт вашего домена → CNAME `snip.pp.ua` (или поддомен) → Pages → Custom domains.

> Бесплатный лимит Pages: 500 сборок/мес, файлы до 100 МБ, трафик и запросы — безлимит на Free. Этого хватает с запасом.

### Сценарий 2 — полностью бесплатный стек (фронт + бэкенд)

Если бэкенда ещё нет или хотите всё на бесплатном:

* **Фронтенд:** Cloudflare Pages (сценарий 1), `VITE_API_BASE` → адрес бэкенда ниже.
* **База:** [Neon](https://neon.tech) Free — Postgres с pgvector, 0.5 ГБ, до 10 проектов (бесплатно). Включите расширение `vector`.
* **Бэкенд (FastAPI + Docker):** [Render](https://render.com) Free Web Service (сборка из Dockerfile, спит после 15 мин простоя, 30 дней удаление — для демо/теста ок) **ИЛИ** [Fly.io](https://fly.io) Free (3 shared-1x VM, не спят). Прокиньте `DATABASE_URL` от Neon, `CORS_ORIGINS=https://<ваш>.pages.dev`, `SECRET_KEY`.
* **LLM/эмбеддинги:** [Groq](https://groq.com) бесплатно (`OLLAMA_HOST=https://api.groq.com/openai/v1`, `GROQ_API_KEY`). Для эмбеддингов либо лёгкая модель на хосте бэкенда (Render 512 МБ — впритык, Fly — комфортнее), либо бесплатный HF Inference. Это единственный заметный «вес» стека.

### Переменные окружения (итог)

| Где | Переменная | Значение |
|---|---|---|
| Cloudflare Pages | `VITE_API_BASE` | `https://<бэкенд>` |
| Бэкенд | `DATABASE_URL` | Neon Postgres + pgvector |
| Бэкенд | `CORS_ORIGINS` | `https://<ваш>.pages.dev` |
| Бэкенд | `SECRET_KEY` | `openssl rand -hex 32` |
| Бэкенд | `GROQ_API_KEY` | ключ Groq (бесплатно) |

### Быстрый деплой через CLI

```bash
cd frontend
npm install && npm run build        # локальная проверка
npx wrangler pages deploy dist --project-name snippy-llm --branch main
```

> Примечание: сам фронтенд абсолютно бесплатен на Cloudflare Pages. Бэкенд бесплатен на Render/Fly+Neon в рамках free-квот; при росте (сотни DAU) переходите на Вариант А (Oracle Always Free) — там и фронт, и бэкенд на одной машине.

