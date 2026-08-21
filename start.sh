#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "== SNIP.pro launcher =="

# Postgres
if ! pg_isready -h /tmp -U alikhan -d postgres >/dev/null 2>&1; then
  echo "[*] starting postgres 17..."
  /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /tmp/pg17.log start || true
  sleep 2
fi
pg_isready -h /tmp

# Ollama
if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "[*] starting ollama..."
  nohup ollama serve > /tmp/ollama.log 2>&1 &
  sleep 3
fi
echo "[*] ollama models:"; ollama list | head -5

# Backend
echo "[*] starting backend on :8001..."
pkill -f "uvicorn app.main:app" 2>/dev/null || true
sleep 1
nohup /opt/homebrew/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --app-dir "$ROOT/backend" > /tmp/snip_backend.log 2>&1 &
sleep 3
curl -s http://localhost:8001/api/health | head -c 200; echo ""

# Frontend
echo "[*] starting frontend on :5173..."
pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null || true
nohup /opt/homebrew/bin/npm --prefix "$ROOT/frontend" run dev -- --host 0.0.0.0 --port 5173 > /tmp/snip_frontend.log 2>&1 &
sleep 3

echo ""
echo "✅ Ready:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:8001/docs"
echo "   Stats:    http://localhost:8001/api/stats"
echo ""
echo "Logs:"
echo "  tail -f /tmp/snip_backend.log"
echo "  tail -f /tmp/snip_frontend.log"
echo "  tail -f /tmp/pg17.log"
