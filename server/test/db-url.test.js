// ── Две копии одной формулы обязаны совпадать ──
// Адрес подключения к схеме считают в двух местах: scripts/db-url.mjs (его берёт
// скрипт миграций — обычный .mjs, работающий до сборки) и src/common/db-url.ts
// (его берёт сам сервер). Одну на двоих сделать не вышло: скрипт запускается
// раньше, чем появляется dist, а сервер собран в CommonJS и .mjs синхронно
// подключить не может.
//
// Разойдясь, они дадут худшую из возможных поломок: миграции применятся в одну
// схему, а сервер пойдёт в другую. Снаружи это выглядит как «таблицы пропали».
// Поэтому здесь обе прогоняются на одних данных и сравниваются.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ts = require('../dist/common/db-url')
const mjsPath = pathToFileURL(path.join(__dirname, '..', 'scripts', 'db-url.mjs')).href

const URLS = [
  'postgresql://user:pass@localhost:5432/apteka',
  'postgresql://user:pass@localhost:5432/apteka?schema=public',
  'postgresql://u:p@db.railway.internal:5432/railway?sslmode=require&connection_limit=5',
  'postgresql://u:p%40word@host:5432/db?schema=admin',
]

const CODES = ['shifo', 'Аптека Салом', 'shifo-2', '  ', 'ОЧЕНЬ-длинный-код-аптеки-который-никто-не-станет-набирать-руками']

test('обе копии формулы дают одинаковый адрес схемы', async () => {
  const mjs = await import(mjsPath)
  for (const url of URLS) {
    assert.equal(mjs.adminUrl(url), ts.adminUrl(url), `adminUrl разошлись на ${url}`)
    assert.equal(mjs.withSchema(url, 'tenant_x'), ts.withSchema(url, 'tenant_x'), `withSchema разошлись на ${url}`)
  }
  assert.equal(mjs.ADMIN_SCHEMA, ts.ADMIN_SCHEMA, 'разные имена схемы панели')
})

test('обе копии одинаково превращают код аптеки в имя схемы', async () => {
  const mjs = await import(mjsPath)
  for (const code of CODES) {
    assert.equal(mjs.schemaNameFor(code), ts.schemaNameFor(code), `schemaNameFor разошлись на «${code}»`)
  }
})

test('схема подставляется, а остальные параметры адреса не теряются', () => {
  const url = ts.adminUrl('postgresql://u:p@host:5432/db?sslmode=require&connection_limit=5')
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('schema'), 'admin', 'схема не подставилась')
  assert.equal(parsed.searchParams.get('sslmode'), 'require', 'потерян sslmode — хостинг задаёт его не просто так')
  assert.equal(parsed.searchParams.get('connection_limit'), '5', 'потерян connection_limit')
})

test('уже указанная схема заменяется, а не добавляется второй', () => {
  const url = ts.withSchema('postgresql://u:p@host:5432/db?schema=public', 'tenant_shifo')
  const all = new URL(url).searchParams.getAll('schema')
  assert.deepEqual(all, ['tenant_shifo'], 'в адресе оказалось несколько схем: ' + all.join(', '))
})

test('имя схемы аптеки безопасно для Postgres', () => {
  // Кириллица, пробелы и дефисы в имени схемы пришлось бы экранировать в каждом
  // запросе — включая те шесть мест, где в проекте написан сырой SQL
  for (const code of CODES) {
    const name = ts.schemaNameFor(code)
    assert.match(name, /^tenant_[a-z0-9_]*$/, `небезопасное имя схемы «${name}» из кода «${code}»`)
    assert.ok(name.length <= 47, `слишком длинное имя схемы: ${name}`)
  }
})

test('пустой адрес не превращается в строку «undefined»', () => {
  assert.equal(ts.adminUrl(''), '', 'пустой адрес должен остаться пустым — иначе Prisma получит мусор')
})
