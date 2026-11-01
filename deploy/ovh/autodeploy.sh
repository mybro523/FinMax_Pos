#!/usr/bin/env bash
# ── Новая версия сервера — сама, как было на Railway ──
# Раз в 2 минуты (finmax-autodeploy.timer) смотрим ветку main на GitHub. Появился новый
# коммит — берём его; если он трогает server/ или deploy/ovh/ — пересобираем сервер программы.
# --force — пересобрать в любом случае. /api/health показывает последний коммит, менявший сервер.
set -euo pipefail
# Одна выкладка за раз: таймер и ручной запуск, пришедшие вместе, иначе ломают друг другу контейнеры
exec 9> /srv/finmax/autodeploy.lock
flock 9
cd /srv/finmax/repo
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ "${1:-}" != "--force" ] && [ -s /srv/finmax/commit.env ]; then
  exit 0
fi
# Что поменялось для сервера: сам сервер и его настройки. Правка только сайта или программы —
# код берём, но сервер не перезапускаем (каждый перезапуск — секунды без связи у касс)
SERVER_CHANGED=1
git diff --quiet "$LOCAL" "$REMOTE" -- server deploy/ovh && SERVER_CHANGED=
git reset -q --hard origin/main
if [ -z "$SERVER_CHANGED" ] && [ "${1:-}" != "--force" ] && [ -s /srv/finmax/commit.env ]; then
  echo "$(date -Is) ${REMOTE:0:7}: сервер не менялся — без перезапуска"
  exit 0
fi
echo "GIT_COMMIT_SHA=$REMOTE" > /srv/finmax/commit.env
docker compose -f deploy/ovh/docker-compose.yml up -d --build --remove-orphans
# Caddyfile мог поменяться — Caddy перечитывает его без остановки
docker compose -f deploy/ovh/docker-compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /dev/null 2>&1 || true
docker image prune -f > /dev/null
echo "$(date -Is) выложено ${REMOTE:0:7}"
