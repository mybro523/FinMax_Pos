// ── Имя схемы попадает в SQL напрямую ──
// Подставить имя схемы параметром запроса нельзя — так устроен сам язык. Значит,
// оно склеивается со строкой SQL, и это единственное место в проекте, где такое
// происходит. Цена ошибки здесь предельная: команда DROP SCHEMA с чужим именем
// стирает аптеку целиком, а с именем «public» — вообще всё.
//
// Поэтому имя не «экранируется», а проверяется целиком: буквы, цифры, подчёркивания
// и обязательная приставка tenant_. Всё остальное отвергается, даже если выглядит
// безобидно. Здесь это и проверяется.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')

const { TenantSchemaService } = require('../dist/admin/tenant-schema.service')
const { PharmaciesService } = require('../dist/admin/pharmacies.service')
const { schemaNameFor } = require('../dist/common/db-url')

// Подставная база: запоминает выполненный SQL, никуда не подключается
function fakeAdmin() {
  const sql = []
  return { sql, $executeRawUnsafe: async (q) => void sql.push(q) }
}

const ОПАСНЫЕ = [
  'public', // без приставки — и это та самая схема, где лежит всё остальное
  'admin', // схема панели управления
  'tenant_x"; DROP SCHEMA "public',
  'tenant_x; DROP SCHEMA public CASCADE',
  'tenant_-',
  'tenant_ x',
  'tenant_Шифо',
  'tenant_', // приставка есть, имени нет
  '',
  'TENANT_SHIFO', // заглавные Postgres воспримет иначе, чем строит schemaNameFor
]

test('опасное имя схемы не доходит до базы', async () => {
  for (const name of ОПАСНЫЕ) {
    const db = fakeAdmin()
    const svc = new TenantSchemaService(db)
    await assert.rejects(() => svc.ensureSchema(name), /Недопустимое имя схемы/, `создание пропустило «${name}»`)
    await assert.rejects(() => svc.dropSchema(name), /Недопустимое имя схемы/, `удаление пропустило «${name}»`)
    assert.deepEqual(db.sql, [], `до базы дошёл запрос с именем «${name}»: ${db.sql.join(' | ')}`)
  }
})

test('обычное имя проходит и попадает в запрос в кавычках', async () => {
  const db = fakeAdmin()
  const svc = new TenantSchemaService(db)
  await svc.ensureSchema('tenant_shifo')
  await svc.dropSchema('tenant_shifo')
  assert.deepEqual(db.sql, [
    'CREATE SCHEMA IF NOT EXISTS "tenant_shifo"',
    'DROP SCHEMA IF EXISTS "tenant_shifo" CASCADE',
  ])
})

// Имена строит schemaNameFor из кода аптеки, который задаёт владелец сервиса.
// Проверяем, что через код нельзя протащить ничего опасного.
test('любой код аптеки превращается в безопасное имя схемы', async () => {
  const коды = ['shifo', 'Аптека Салом', 'x"; DROP SCHEMA "public', 'public', '../../etc', '', '  ', 'ШИФО-2']
  const db = fakeAdmin()
  const svc = new TenantSchemaService(db)
  for (const code of коды) {
    const name = schemaNameFor(code)
    await svc.ensureSchema(name) // не должно бросить
    assert.match(name, /^tenant_[a-z0-9_]+$/, `код «${code}» дал имя «${name}»`)
  }
  assert.equal(db.sql.length, коды.length, 'какое-то имя не дошло до базы')
})

// ── Код аптеки ──
// Его диктуют по телефону и набирают с любой клавиатуры, поэтому только латиница,
// цифры и дефис. Проверка стоит до любых обращений к базе, поэтому подставные
// зависимости здесь пустые.
const pharmacies = () => new PharmaciesService({}, {}, {}, {})

test('негодный код аптеки отвергается до обращения к базе', async () => {
  for (const code of ['', 'x', 'Шифо', 'shifo shifo', 'shifo!', '-shifo', 'ОЧЕНЬ'.repeat(20)]) {
    await assert.rejects(
      () => pharmacies().create({ code, name: 'Аптека' }),
      /Код аптеки/,
      `код «${code}» приняли`,
    )
  }
})

test('аптека без названия не заводится', async () => {
  await assert.rejects(() => pharmacies().create({ code: 'shifo', name: '   ' }), /название/i)
})
