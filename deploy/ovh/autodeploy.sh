#!/usr/bin/env bash
# ── Новая версия сервера — сама, как было на Railway ──
# Раз в 2 минуты (finmax-autodeploy.timer) смотрим ветку main на GitHub. Появился новый
# коммит — берём его и пересобираем сервер программы. --force — пересобрать и без нового коммита.
set -euo pipefail
cd /srv/finmax/repo
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ "${1:-}" != "--force" ] && [ -s /srv/finmax/commit.env ]; then
  exit 0
fi
git reset -q --hard origin/main
echo "GIT_COMMIT_SHA=$REMOTE" > /srv/finmax/commit.env
docker compose -f deploy/ovh/docker-compose.yml up -d --build --remove-orphans
# Caddyfile мог поменяться — Caddy перечитывает его без остановки
docker compose -f deploy/ovh/docker-compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1 || true
docker image prune -f > /dev/null
echo "$(date -Is) выложено ${REMOTE:0:7}"
