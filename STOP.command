#!/bin/bash
# STOP SNIP.pro — останавливает все сервисы
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "== STOP SNIP.pro =="
echo "ROOT: $ROOT"
echo ""

echo "[*] Останавливаю Frontend (vite :5173)..."
pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null && echo "  ✓ vite остановлен" || echo "  - vite не был запущен"

echo "[*] Останавливаю Backend (uvicorn :8001)..."
pkill -f "uvicorn app.main:app" 2>/dev/null && echo "  ✓ backend остановлен" || echo "  - backend не был запущен"

echo "[*] (опционально) Postgres остаётся запущенным."
echo "    Чтобы остановить Postgres: /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 stop"
echo "    Чтобы остановить Ollama: pkill ollama"

echo ""
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Backend :8001 и Frontend :5173 остановлены" with title "SNIP.pro остановлен"' 2>/dev/null || true
fi
echo "Готово. Нажми Enter..."
read -r
