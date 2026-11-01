#!/usr/bin/env bash
# ── Перенос базы с Railway — один раз, при переезде ──
# Адрес базы Railway (DATABASE_PUBLIC_URL сервиса Postgres) — в файле /srv/finmax/railway.url
# (права 600; после переноса файл удаляется). Запуск: sudo bash import-railway.sh
# Копия с Railway остаётся в /srv/finmax/backups/db/railway-*.dump.
set -euo pipefail
C=/srv/finmax/repo/deploy/ovh/docker-compose.yml
URL_FILE=/srv/finmax/railway.url
[ -s "$URL_FILE" ] || { echo "нет $URL_FILE"; exit 1; }
RAILWAY_URL=$(tr -d '\r\n' < "$URL_FILE")
PG=postgres:17

echo "Railway: $(docker run --rm --network host -e U="$RAILWAY_URL" $PG sh -c 'psql "$U" -tAc "show server_version"')"
F=/srv/finmax/backups/db/railway-$(date -u +%Y%m%d-%H%M).dump
docker run --rm --network host -e U="$RAILWAY_URL" $PG sh -c 'pg_dump "$U" -Fc --no-owner --no-acl' > "$F.tmp"
mv "$F.tmp" "$F"
echo "копия с Railway: $F ($(du -h "$F" | cut -f1))"

# База здесь — заново, и в неё вся копия
docker compose -f "$C" stop api 2> /dev/null || true
docker compose -f "$C" up -d db
for i in $(seq 1 30); do docker compose -f "$C" exec -T db pg_isready -U finmax -d finmax > /dev/null 2>&1 && break; sleep 2; done
docker compose -f "$C" exec -T db psql -v ON_ERROR_STOP=1 -U finmax -d postgres -c 'DROP DATABASE IF EXISTS finmax WITH (FORCE)' -c 'CREATE DATABASE finmax OWNER finmax'
docker compose -f "$C" exec -T db pg_restore -U finmax -d finmax --no-owner --no-acl --exit-on-error < "$F"

echo 'схемы и строки после переноса:'
docker compose -f "$C" exec -T db psql -U finmax -d finmax -tAc "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1" | tr '\n' ' '
echo
# Ключ кодов активации (таблица LicenceKey) обязан переехать как есть
docker compose -f "$C" exec -T db psql -U finmax -d finmax -tAc 'SELECT $$LicenceKey: $$ || count(*) FROM admin."LicenceKey"'
shred -u "$URL_FILE" 2> /dev/null || rm -f "$URL_FILE"
echo 'перенос готов'
