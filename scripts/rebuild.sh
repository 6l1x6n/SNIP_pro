#!/bin/bash
# rebuild.sh — полный цикл обновления нормативной базы snippy.llm
# 1) сборка индекса из «СНиП РК»   2) PDF в статику Pages (+ в R2, если бакет включён)
# 3) деплой фронта на Cloudflare Pages
# Использование: ./scripts/rebuild.sh [--skip-r2] [--skip-pages]

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-/opt/homebrew/bin/python3}"
SKIP_R2=0; SKIP_PAGES=0
for arg in "$@"; do
  case "$arg" in
    --skip-r2) SKIP_R2=1 ;;
    --skip-pages) SKIP_PAGES=1 ;;
  *) echo "Неизвестный флаг: $arg"; exit 1 ;;
esac
done

cd "$ROOT"

echo "── 1/4 Сборка поискового индекса из «СНиП РК»"
"$PY" scripts/build_index.py

echo "── 2/4 Копирование PDF в статику (frontend/public/norms)"
mkdir -p frontend/public/norms
find "СНиП РК" -type f -iname '*.pdf' -not -name '.DS_Store' | while IFS= read -r pdf; do
  cp "$pdf" frontend/public/norms/
done

R2_AVAILABLE=0
if [ "$SKIP_R2" -eq 0 ]; then
  if npx wrangler r2 bucket list >/dev/null 2>&1; then R2_AVAILABLE=1; fi
fi

if [ "$SKIP_R2" -eq 0 ] && [ "$R2_AVAILABLE" -eq 1 ]; then
  echo "── 3/4 Загрузка PDF в R2 (snip-norms)"
  find "СНиП РК" -type f -iname '*.pdf' -not -name '.DS_Store' | while IFS= read -r pdf; do
    name="$(basename "$pdf")"
    echo "   ↑ $name"
    npx wrangler r2 object put "snip-norms/$name" --file "$pdf" --remote --content-type application/pdf >/dev/null
  done
else
  echo "── 3/4 R2 пропущен ($([ "$SKIP_R2" -eq 1 ] && echo '--skip-r2' || echo 'бакет не активирован: Cloudflare Dashboard → R2 → Enable'))"
fi

if [ "$SKIP_PAGES" -eq 0 ]; then
  echo "── 4/4 Деплой фронта"
  (cd frontend && npm run build >/dev/null && npx wrangler pages deploy dist --project-name snippy-llm --branch master --commit-dirty=true)
else
  echo "── 4/4 Pages пропущен (--skip-pages)"
fi

echo "✅ Готово. Поиск обновится на проде в течение минуты."
