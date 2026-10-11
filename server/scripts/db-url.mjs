// ── Адрес подключения к нужной схеме ──
// База одна, а схем в ней много: «admin» — панель управления, «tenant_…» — данные
// каждой аптеки. Отдельную переменную окружения на каждую схему заводить нельзя:
// аптеки появляются и исчезают, а переменные задаются руками при развёртывании.
// Поэтому адрес один — DATABASE_URL, — а схема подставляется в него на ходу.
//
// ⚠️ Эта же формула повторена в src/common/db-url.ts: сюда её тянет скрипт миграций
// (обычный .mjs, работает до сборки), туда — сам сервер (TypeScript). Разъехаться
// им не даёт проверка в test/db-url.test.js: она сравнивает обе на одних данных.

export const ADMIN_SCHEMA = 'admin'

// Подставить схему в адрес базы. Прочие параметры (sslmode, connection_limit)
// сохраняются: их задаёт хостинг, и терять их нельзя.
export function withSchema(url, schema) {
  if (!url) return url
  const u = new URL(url)
  u.searchParams.set('schema', schema)
  return u.toString()
}

// Адрес базы панели управления
export function adminUrl(url) {
  return withSchema(url, ADMIN_SCHEMA)
}

// Имя схемы аптеки по её коду. Код задаёт владелец сервиса, поэтому приводим его
// к безопасному виду: в имени схемы Postgres не должно быть ничего, кроме букв,
// цифр и подчёркиваний, иначе имя пришлось бы экранировать в каждом запросе.
export function schemaNameFor(code) {
  const safe = String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return 'tenant_' + (safe || 'bez_koda')
}
