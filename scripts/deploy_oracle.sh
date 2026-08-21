#!/bin/bash
set -e
# Деплой на Oracle Always Free (Ubuntu 24.04, Docker)
# Запуск на локальной машине: ./scripts/deploy_oracle.sh ubuntu@X.Y.Z.W
# или вручную на VPS: git pull && docker compose up -d --build

REMOTE=${1:-""}
if [ -z "$REMOTE" ]; then
  echo "Usage: $0 ubuntu@<oracle-ip>"
  echo "  или запустите на самом VPS: cd ~/SNIP_pro && docker compose up -d --build"
  exit 1
fi

echo "Deploy to $REMOTE ..."
ssh "$REMOTE" bash -s <<'EOS'
set -e
cd ~/SNIP_pro
echo "[*] git pull"
git pull
echo "[*] generate SECRET_KEY if not set"
if ! grep -q "SECRET_KEY=" .env 2>/dev/null; then
  echo "SECRET_KEY=$(openssl rand -hex 32)" >> .env
  echo "Generated SECRET_KEY"
fi
echo "[*] docker compose build & up"
docker compose up -d --build
sleep 5
docker compose ps
curl -s http://localhost:8001/api/health | head -c 200; echo ""
echo "✅ Done. Check https://snip.pp.ua/api/health"
EOS
echo "Deploy finished"
