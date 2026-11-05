# Сервер FinMax POS на OVH

Сервер программы (бэкенд) и база данных — на своём сервере OVH (с 01.11.2026 вместо Railway).
Сайт остаётся на Vercel.

- Сервер: VPS-2 (4 ядра, 8 ГБ, 75 ГБ), Франция (Гравлин), Ubuntu 26.04, оплачен до 31.10.2027.
- Адрес: **`https://api.finmaxpos.tj/api`** (домен finmaxpos.tj — у Navju Cloud, запись `api` → A 159.173.136.216);
  прежний `https://vps-04688c58.vps.ovh.net/api` тоже работает (программа 1.6.2).
- Сайт: `https://www.finmaxpos.tj` (Vercel; `finmaxpos.tj` перекидывает на www).
- Вход на сервер: пользователь `ubuntu`, по SSH-ключу; запасной вход — KVM в панели OVH.
- **Панель сервера (как на Railway): `https://vps-04688c58.vps.ovh.net/panel`** — Portainer:
  части проекта (база, сервер программы, вход https), их состояние, нагрузка, журналы,
  перезапуск. Вход `admin`, пароль — в `/srv/finmax/portainer.pw` (у владельца — в файле).
  Панель управляет всем сервером: пароль никому не давать. Проект — Stacks → finmax
  (или Containers: finmax-api-1, finmax-db-1, finmax-caddy-1).

## Что где

| Что | Где |
|---|---|
| Код (клон GitHub, ветка main) | `/srv/finmax/repo` |
| База PostgreSQL 18 (как была на Railway) | `/srv/finmax/pgdata` (наружу не открыта) |
| Секреты: пароль базы, ключ входа | `/srv/finmax/db.env`, `/srv/finmax/finmax.env` (права 600) |
| Копии базы целиком (каждую ночь, 14 шт.) | `/srv/finmax/backups/db` |
| Копии магазинов от самого сервера | `/srv/finmax/backups/app` |
| Сертификат https | `/srv/finmax/caddy` |

Плюс OVH каждый день копирует весь сервер (Automated Backup, панель OVH → VPS → Backup).

## Обновление

Как на Railway: отправили коммит в `main` — через 2 минуты сервер собирает и запускает новую
версию сам (`finmax-autodeploy.timer`). Проверка: `GET /api/health` — поле `commit`.
Вручную: `sudo bash /srv/finmax/repo/deploy/ovh/autodeploy.sh --force`.

## Частые команды (на сервере)

```bash
cd /srv/finmax/repo/deploy/ovh
sudo docker compose ps                      # что запущено
sudo docker compose logs -f --tail 100 api  # журнал сервера программы
sudo docker compose restart api             # перезапуск
sudo systemctl list-timers 'finmax-*'       # когда следующая копия и проверка версии
sudo bash backup-db.sh                      # копия базы прямо сейчас
```

## Восстановить базу из копии

```bash
cd /srv/finmax/repo/deploy/ovh
sudo docker compose stop api
sudo docker compose exec -T db psql -U finmax -d postgres -c 'DROP DATABASE finmax WITH (FORCE)' -c 'CREATE DATABASE finmax OWNER finmax'
sudo docker compose exec -T db pg_restore -U finmax -d finmax --no-owner --no-acl < /srv/finmax/backups/db/finmax-ГГГГ-ММ-ДД.dump
sudo docker compose start api
```

## Как ставили (01.11.2026)

1. `sudo bash setup.sh` — Docker, стена (снаружи только 22, 80, 443), папки, код, секреты, таймеры.
2. В `/srv/finmax/finmax.env` дописаны настройки с Railway (CORS_ORIGIN и прочие), ключ входа
   (AUTH_SECRET) — новый: при переезде все один раз вошли заново.
3. `sudo bash import-railway.sh` — вся база с Railway (с таблицей `admin."LicenceKey"` — ключ
   кодов активации, его не терять никогда).
4. `sudo docker compose up -d --build`, затем `systemctl enable --now finmax-autodeploy.timer`.
5. Сайт (Vercel, VITE_API_URL) и программа (1.6.2, APTEKA_API_URL) — на новый адрес; Railway удалён.
