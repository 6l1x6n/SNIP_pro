#!/bin/bash
# norms_refresh.sh — полуавтомат обновления нормативной базы (план G2d).
#
# Шаги:  1) dry-run diff с adilet (check_updates.py) → отчёт
#        2) ТВОЙ АППРУВ (полного автомата нет специально: кривой парсинг отравит индекс)
#        3) ручная раскладка PDF по папкам norms/ (+ meta.json при дублях)
#        4) пересборка индекса (--reuse-vectors: эмбеддинги только новых чанков)
#        5) гейты: verify_values (шум <2%), чанки не ужались
#        6) шардирование → замена public/index → деплой Pages + Worker
#        7) пост-гейты: manifest v2, verify_search
#
# Использование:  ./scripts/norms_refresh.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY=/opt/homebrew/bin/python3
NEW=/tmp/idx_new

echo "=== 1/7 diff с adilet ==="
$PY scripts/check_updates.py --report /tmp/norms_diff.txt || {
  echo "⚠️ diff не удался (сеть/adilet) — останавливаюсь"; exit 1; }

echo
echo "=== 2/7 аппрув ==="
read -r -p "Скачал новые PDF сам и разложил по norms/? Обновил norms/meta.json? [y/N] " ans
[[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "ок, выходи — файлы не трогаю"; exit 0; }

echo
echo "=== 3/7 пропуск (ручной шаг уже сделан) ==="

echo
echo "=== 4/7 пересборка индекса (только новые чанки эмбеддятся) ==="
rm -rf "$NEW"
$PY scripts/build_index.py --out "$NEW" --reuse-vectors

echo
echo "=== 5/7 гейты ==="
$PY scripts/verify_values.py --index "$NEW" --samples 0 > /tmp/values_gate.txt 2>&1 || {
  echo "❌ verify_values упал"; tail -20 /tmp/values_gate.txt; exit 1; }
SUSP_PCT=$(grep -o 'подозрительных: [0-9]* ([0-9.]*%' /tmp/values_gate.txt | grep -o '([0-9.]*' | tr -d '(' || echo 100)
if python3 -c "import sys; sys.exit(0 if float('$SUSP_PCT') < 2.0 else 1)"; then
  echo "✅ шум values: ${SUSP_PCT}% (<2%)"
else
  echo "❌ шум values: ${SUSP_PCT}% — смотри /tmp/values_gate.txt"; exit 1
fi
OLD_COUNT=$(python3 -c "import json;print(json.load(open('frontend/public/index/manifest.json'))['count'])")
NEW_COUNT=$(python3 -c "import json;print(json.load(open('$NEW/manifest.json'))['count'])")
echo "чанков: было $OLD_COUNT → стало $NEW_COUNT"
if [ "$NEW_COUNT" -lt "$OLD_COUNT" ]; then
  echo "❌ индекс ужался — разбирайся вручную"; exit 1
fi
echo "✅ гейты пройдены"

echo
echo "=== 6/7 шардирование + замена + деплой ==="
$PY scripts/shard_index.py "$NEW"
read -r -p "Залить новый индекс в прод (Pages) и задеплоить воркер? [y/N] " ans2
[[ "$ans2" == "y" || "$ans2" == "Y" ]] || { echo "ок — новый индекс остался в $NEW"; exit 0; }
cp "$NEW"/values.json "$NEW"/manifest.json "$NEW"/docs.json "$NEW"/bm25.json "$NEW"/synonyms.json frontend/public/index/
rm -f frontend/public/index/chunks_*.json frontend/public/index/vectors_*.bin
cp "$NEW"/chunks_*.json "$NEW"/vectors_*.bin frontend/public/index/
(cd frontend && npm run build)
$PY scripts/pages_deploy.py frontend/dist
(cd worker && npx wrangler deploy)

echo
echo "=== 7/7 пост-гейты ==="
curl -s -m 30 https://snippy-llm.pages.dev/index/manifest.json | $PY -c "import json,sys; m=json.load(sys.stdin); assert m['version']==2 and 'values' in m, m; print('✅ manifest v2 + values:', m['values'])"
$PY scripts/verify_search.py 2>&1 | tail -3
echo "🎉 готово"
