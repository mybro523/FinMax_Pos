#!/usr/bin/env bash
# ── Один раз на чистом сервере (Ubuntu 26.04): sudo bash setup.sh ──
# Docker, стена (снаружи только SSH и https), папки, код с GitHub, секреты и таймеры.
# Повторный запуск ничего не ломает: секреты и код, если уже есть, остаются.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get -yq upgrade
apt-get -yq install docker.io docker-compose-v2 git ufw unattended-upgrades openssl
systemctl enable --now docker

# Стена: снаружи — только вход по SSH и https (80 — для получения сертификата и переадресации)
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

install -d -m 700 /srv/finmax
install -d /srv/finmax/pgdata /srv/finmax/backups/app /srv/finmax/backups/db /srv/finmax/caddy/data /srv/finmax/caddy/config
[ -d /srv/finmax/repo/.git ] || git clone -q https://github.com/mybro523/FinMax_Pos.git /srv/finmax/repo

# Секреты — заводятся здесь же, на сервере, и никуда не уходят: пароль базы и ключ входа
if [ ! -f /srv/finmax/db.env ]; then
  umask 077
  DB_PW=$(openssl rand -hex 24)
  echo "POSTGRES_PASSWORD=$DB_PW" > /srv/finmax/db.env
  {
    echo "DATABASE_URL=postgresql://finmax:$DB_PW@db:5432/finmax"
    echo "AUTH_SECRET=$(openssl rand -hex 48)"
  } > /srv/finmax/finmax.env
fi
[ -f /srv/finmax/commit.env ] || echo "GIT_COMMIT_SHA=$(git -C /srv/finmax/repo rev-parse HEAD)" > /srv/finmax/commit.env

# Таймеры: ночная копия базы сразу; новые версии с GitHub — включаются после первого запуска
cp /srv/finmax/repo/deploy/ovh/systemd/finmax-*.service /srv/finmax/repo/deploy/ovh/systemd/finmax-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now finmax-backup.timer
echo 'готово: теперь import-railway.sh (перенос базы) или сразу docker compose up'
