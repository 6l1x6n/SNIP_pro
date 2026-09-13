#!/bin/bash
# rebuild.sh — полный цикл обновления нормативной базы snippy.llm
# 1) сборка индекса из norms/   2) PDF в статику Pages (+ в R2, если бакет включён)
# 3) деплой фронта на Cloudflare Pages
# Использование: ./scripts/rebuild.sh [--skip-r2] [--skip-pages]

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-/opt/homebrew/bin/python3}"
SKIP_R2=0; SKIP_PAGES=0; SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-r2) SKIP_R2=1 ;;
    --skip-pages) SKIP_PAGES=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
  *) echo "Неизвестный флаг: $arg"; exit 1 ;;
esac
done

cd "$ROOT"
IDX="frontend/public/index"

if [ "$SKIP_BUILD" -eq 0 ]; then
  OLD_COUNT=$("$PY" -c "import json;print(json.load(open('$IDX/manifest.json'))['count'])" 2>/dev/null || echo 0)
  echo "── 1/5 Сборка поискового индекса из norms/"
  "$PY" scripts/build_index.py
else
  echo "── 1/5 Сборка пропущена (--skip-build — использую готовый индекс)"
fi

echo "── 2/5 Шардирование индекса (лимит Pages 25 МиБ на файл)"
"$PY" scripts/shard_index.py "$IDX"

echo "── 3/5 Гейты качества"
"$PY" scripts/verify_values.py --index "$IDX" --samples 0 > /tmp/rebuild_values_gate.txt 2>&1 || {
  echo "❌ verify_values упал — смотри /tmp/rebuild_values_gate.txt"; exit 1; }
SUSP_PCT=$(grep -o 'подозрительных: [0-9]* ([0-9.]*%' /tmp/rebuild_values_gate.txt | grep -o '([0-9.]*' | tr -d '(' || echo 100)
if "$PY" -c "import sys; sys.exit(0 if float('$SUSP_PCT') < 2.0 else 1)"; then
  echo "✅ шум values: ${SUSP_PCT}% (<2%)"
else
  echo "❌ шум values: ${SUSP_PCT}% — смотри /tmp/rebuild_values_gate.txt"; exit 1
fi
if [ "$SKIP_BUILD" -eq 0 ] && [ "$OLD_COUNT" != "0" ]; then
  NEW_COUNT=$("$PY" -c "import json;print(json.load(open('$IDX/manifest.json'))['count'])")
  echo "чанков: было $OLD_COUNT → стало $NEW_COUNT"
  if [ "$NEW_COUNT" -lt "$OLD_COUNT" ]; then
    echo "❌ индекс ужался — разбирайся вручную"; exit 1
  fi
fi
echo "✅ гейты пройдены"

echo "── 4/5 Копирование PDF в статику (frontend/public/norms)"
mkdir -p frontend/public/norms
find norms -type f -iname '*.pdf' -not -name '.DS_Store' | while IFS= read -r pdf; do
  name="$(basename "$pdf")"
  size_mb="$(du -m "$pdf" | cut -f1)"
  # Лимит Cloudflare Pages — 25 МиБ на файл: большие PDF пересжимаем (deflate+garbage)
  if [ "$size_mb" -ge 25 ]; then
    "$PY" - "$pdf" "frontend/public/norms/$name" <<'PYEOF'
import sys, os, fitz
src, dst = sys.argv[1], sys.argv[2]
d = fitz.open(src)
d.save(dst + ".tmp", deflate=True, deflate_images=True, deflate_fonts=True, garbage=4, clean=True)
d.close()
os.replace(dst + ".tmp", dst)
print(f"    recompressed: {os.path.getsize(src)/1e6:.0f}MB -> {os.path.getsize(dst)/1e6:.0f}MB")
PYEOF
  else
    cp "$pdf" "frontend/public/norms/$name"
  fi
done

R2_AVAILABLE=0
if [ "$SKIP_R2" -eq 0 ]; then
  if npx wrangler r2 bucket list >/dev/null 2>&1; then R2_AVAILABLE=1; fi
fi

if [ "$SKIP_R2" -eq 0 ] && [ "$R2_AVAILABLE" -eq 1 ]; then
  echo "── 4/5 (R2) Загрузка PDF в snip-norms"
  find norms -type f -iname '*.pdf' -not -name '.DS_Store' | while IFS= read -r pdf; do
    name="$(basename "$pdf")"
    echo "   ↑ $name"
    npx wrangler r2 object put "snip-norms/$name" --file "$pdf" --remote --content-type application/pdf >/dev/null
  done
else
  echo "── 4/5 (R2) пропущен ($([ "$SKIP_R2" -eq 1 ] && echo '--skip-r2' || echo 'бакет не активирован: Cloudflare Dashboard → R2 → Enable'))"
fi

if [ "$SKIP_PAGES" -eq 0 ]; then
  echo "── 5/5 Деплой фронта"
  (cd frontend && npm run build >/dev/null && npx wrangler pages deploy dist --project-name snippy-llm --branch master --commit-dirty=true)
else
  echo "── 5/5 Pages пропущен (--skip-pages)"
fi

echo "✅ Готово. Поиск обновится на проде в течение минуты."
