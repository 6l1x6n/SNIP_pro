#!/bin/bash
# build_when_ready.sh — дозорный цикл: ждёт сброса дневной квоты Gemini,
# затем пересобирает индекс из «СНиП РК» и деплоит на Cloudflare Pages.
# Лог: /tmp/snip_build.log   Остановить: pkill -f build_when_ready.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-/opt/homebrew/bin/python3}"
cd "$ROOT"

attempt=0
PROVIDER="${PROVIDER:-}"  # можно форсировать: PROVIDER=jina ./scripts/build_when_ready.sh
while true; do
  attempt=$((attempt + 1))
  echo "── попытка $attempt${PROVIDER:+ [$PROVIDER]} ($(date '+%d.%m %H:%M:%S'))" | tee -a /tmp/snip_build.log
  if "$PY" -u scripts/build_index.py --batch 16 ${PROVIDER:+--provider "$PROVIDER"} >> /tmp/snip_build.log 2>&1; then
    echo "✅ Индекс собран ($(date '+%H:%M:%S')) — деплой на Pages…" | tee -a /tmp/snip_build.log
    if ./scripts/rebuild.sh --skip-build >> /tmp/snip_build.log 2>&1; then
      echo "🚀 ГОТОВО ($(date '+%d.%m %H:%M:%S')) — проверяйте https://snippy-llm.pages.dev" | tee -a /tmp/snip_build.log
      osascript -e 'display notification "Индекс «СНиП РК» собран и задеплоен!" with title "SNIP_pro"' 2>/dev/null
      exit 0
    fi
    echo "⚠️ Деплой упал — см. конец /tmp/snip_build.log" | tee -a /tmp/snip_build.log
    exit 1
  fi
  echo "…квота ещё не ожила, следующая попытка через 30 мин" | tee -a /tmp/snip_build.log
  sleep 1800
done
