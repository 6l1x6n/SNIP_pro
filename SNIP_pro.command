#!/bin/bash
# SNIP.pro Launcher — двойной клик в Finder → запускает всё и открывает браузер
# Путь: /Users/alikhan/Desktop/Sud/Project web ui/SNIP_pro/SNIP_pro.command
# Делает: Postgres 17 + Ollama + Backend :8001 + Frontend :5173 → open http://localhost:5173

set -e

# --- cd в папку проекта (важно для пробелов в пути) ---
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
echo "== SNIP.pro Launcher =="
echo "ROOT: $ROOT"
echo ""

# Цвета
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# Проверка brew python
PY="/opt/homebrew/bin/python3"
if [ ! -x "$PY" ]; then PY="$(which python3)"; fi
echo "Python: $PY ($($PY --version 2>&1))"

# 1. Postgres 17
echo ""
echo -e "${YELLOW}[1/4] PostgreSQL 17${NC}"
if pg_isready -h /tmp -U alikhan -d postgres >/dev/null 2>&1; then
  echo "  ✓ уже запущен ($(psql -h /tmp -U alikhan -d postgres -c 'select version()' -t 2>&1 | xargs | cut -c1-60))"
else
  echo "  → запускаю..."
  # чистим stale pid если был краш
  rm -f /tmp/.s.PGSQL.5432* /opt/homebrew/var/postgresql@17/postmaster.pid 2>/dev/null || true
  /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /tmp/pg17.log start 2>&1 | tail -3 || true
  sleep 3
  if pg_isready -h /tmp >/dev/null 2>&1; then echo "  ✓ запущен"; else echo "  ✗ не удалось, смотри /tmp/pg17.log"; tail -20 /tmp/pg17.log; fi
fi
# проверка расширений
psql -h /tmp -U alikhan -d snip_pro -c "SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm');" 2>&1 | grep -E "vector|pg_trgm" | sed 's/^/  ext: /' || echo "  (БД snip_pro будет создана при старте backend)"

# 2. Ollama
echo ""
echo -e "${YELLOW}[2/4] Ollama${NC}"
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "  ✓ уже запущен"
else
  echo "  → запускаю ollama serve..."
  nohup ollama serve > /tmp/ollama.log 2>&1 &
  sleep 4
  if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then echo "  ✓ запущен"; else echo "  ✗ не удалось, смотри /tmp/ollama.log"; fi
fi
echo "  модели:"; ollama list 2>&1 | head -6 | sed 's/^/    /'

# 3. Backend
echo ""
echo -e "${YELLOW}[3/4] Backend :8001${NC}"
# убиваем старый если висит
if pgrep -f "uvicorn app.main:app" >/dev/null 2>&1; then
  echo "  → останавливаю старый..."
  pkill -f "uvicorn app.main:app" 2>/dev/null || true
  sleep 2
fi
echo "  → запускаю uvicorn..."
# гарантируем BUILD frontend если нет dist (backend отдаст 404 иначе)
if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "  → frontend/dist не найден, делаю build..."
  /opt/homebrew/bin/npm --prefix "$ROOT/frontend" run build 2>&1 | tail -5 || echo "  ! build failed, будет только API"
fi
nohup "$PY" -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --app-dir "$ROOT/backend" > /tmp/snip_backend.log 2>&1 &
sleep 4
if curl -s http://localhost:8001/api/health | grep -q "ok"; then
  echo -e "  ${GREEN}✓ backend ok${NC} http://localhost:8001/docs"
  curl -s http://localhost:8001/api/stats 2>&1 | head -c 200; echo ""
else
  echo -e "  ${RED}✗ backend не отвечает${NC}, лог:"
  tail -30 /tmp/snip_backend.log | sed 's/^/    /'
fi

# 4. Frontend
echo ""
echo -e "${YELLOW}[4/4] Frontend :5173${NC}"
if pgrep -f "vite --host 0.0.0.0 --port 5173" >/dev/null 2>&1; then
  echo "  → останавливаю старый..."
  pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null || true
  sleep 2
fi
echo "  → запускаю vite dev..."
nohup /opt/homebrew/bin/npm --prefix "$ROOT/frontend" run dev -- --host 0.0.0.0 --port 5173 > /tmp/snip_frontend.log 2>&1 &
sleep 4
if curl -s http://localhost:5173/ | grep -q "<!doctype"; then
  echo -e "  ${GREEN}✓ frontend ok${NC} http://localhost:5173"
else
  echo "  ! frontend ещё стартует, лог:"; tail -10 /tmp/snip_frontend.log | sed 's/^/    /'
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ SNIP.pro запущен${NC}"
echo "   Frontend: http://localhost:5173  ← основной UI"
echo "   Backend:  http://localhost:8001/docs  (Swagger)"
echo "   Stats:    http://localhost:8001/api/stats"
echo "   Health:   http://localhost:8001/api/health"
echo ""
echo "Логи:"
echo "  tail -f /tmp/snip_backend.log"
echo "  tail -f /tmp/snip_frontend.log"
echo "  tail -f /tmp/pg17.log"
echo "  tail -f /tmp/ollama.log"
echo ""
echo "Остановить: двойной клик STOP.command или ./stop.sh"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Открыть браузер (macOS)
if command -v open >/dev/null 2>&1; then
  echo "→ открываю браузер..."
  sleep 1
  open "http://localhost:5173" 2>/dev/null || true
  # также открыть docs в фоне
  # open "http://localhost:8001/docs" 2>/dev/null || true
fi

# Уведомление macOS (если osascript есть)
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Frontend http://localhost:5173\nBackend http://localhost:8001/docs" with title "SNIP.pro запущен" subtitle "Готов к поиску"' 2>/dev/null || true
fi

echo "Нажми Enter чтобы закрыть окно..."
read -r
