#!/usr/bin/env bash
# ── Копия всей базы раз в сутки (finmax-backup.timer, ночь по Душанбе) ──
# Полный pg_dump (все магазины и панель управления, в том числе ключ кодов активации) в
# /srv/finmax/backups/db; хранятся 14 последних. Плюс к этому OVH каждый день копирует
# весь сервер (Automated Backup), а сервер программы — каждый магазин отдельно (BACKUP_DIR).
set -euo pipefail
DIR=/srv/finmax/backups/db
mkdir -p "$DIR"
F="$DIR/finmax-$(date -u +%Y-%m-%d).dump"
docker compose -f /srv/finmax/repo/deploy/ovh/docker-compose.yml exec -T db pg_dump -U finmax -d finmax -Fc > "$F.tmp"
mv "$F.tmp" "$F"
find "$DIR" -name 'finmax-*.dump' -mtime +14 -delete
echo "$(date -Is) копия базы: $F ($(du -h "$F" | cut -f1))"
