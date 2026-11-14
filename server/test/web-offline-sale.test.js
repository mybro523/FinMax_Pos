// ── Чеки сайта, проданные без интернета (POST /sales/offline) ──
//
// Касса сайта без связи кладёт чек в очередь браузера и присылает его, когда связь
// вернулась. Принимается тем же путём, что чеки программы для Windows (SyncService.applyOne):
// повтор по номеру — тем же ответом, время — своё, нехватка — в «Расхождения». Здесь —
// то, что отличает сайт: условная «касса» WEB_DEVICE, общая смена сайта, права «в долг»
// и «скидка», чужой кассир, выключенный модуль. Запись в базу проверяет живой прогон.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateSync } = require('class-validator')
const { plainToInstance } = require('class-transformer')
const { SyncService, WEB_DEVICE, requiredPermissions, deviceNameOf } = require('../dist/sync/sync.service')
const { WebSaleDto } = require('../dist/sync/dto')
const { WebSalesController } = require('../dist/sync/sync.controller')
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants')

const sale = (over = {}) => ({
  sale: {
    id: 'sale-1',
    clientId: 'sale-1',
    date: '2026-11-14T10:00:00.000Z',
    payment: 'cash',
    payVia: null,
    customerId: null,
    shiftId: 'shift-web',
    total: 15,
    cost: 10,
    profit: 5,
    items: [{ id: 'line-1', productId: 'p1', name: 'Мыло', qty: 1, pieces: 0, unitsPerPack: 1, price: 15, piecePrice: null, unit: null, cost: 10, discount: 0 }],
    ...over,
  },
})

// Сервис без базы: запись отказов и «уже принято» — в памяти
function makeService({ seen = null } = {}) {
  const created = []
  const changed = []
  const prisma = {
    syncOp: {
      findUnique: async () => seen,
      create: async ({ data }) => {
        created.push(data)
        return data
      },
    },
    $transaction: async () => {
      throw new Error('в этих проверках до записи чека дойти не должно')
    },
  }
  const events = { changed: (...k) => changed.push(...k) }
  const accounts = { get: async (id) => ({ id, pharmacyId: 'ph1', role: 'cashier', tenantUserId: 'u-' + id, roleRef: { permissions: ['pos.sell'] } }) }
  const svc = new SyncService(prisma, accounts, {}, events, {}, {})
  return { svc, created, changed }
}

const cashier = { sub: 'acc-kassir', role: 'cashier', tenantUserId: 'u1', pharmacyId: 'ph1', permissions: ['pos.sell'], modulesOff: [] }
const owner = { sub: 'acc-owner', role: 'founder', tenantUserId: 'u0', pharmacyId: 'ph1', permissions: [], modulesOff: [] }

test('адрес: POST /sales/offline', () => {
  assert.equal(Reflect.getMetadata(PATH_METADATA, WebSalesController), 'sales')
  const handler = WebSalesController.prototype.offline
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'offline')
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 1) // RequestMethod.POST
})

test('тело запроса: чек проходит, чужой тип операции и кривой номер — нет', () => {
  const ok = plainToInstance(WebSaleDto, { id: 'op-1', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() })
  assert.deepEqual(validateSync(ok), [])
  const withType = plainToInstance(WebSaleDto, { id: 'op-1', type: 'sale', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() })
  assert.deepEqual(validateSync(withType), [])
  const other = plainToInstance(WebSaleDto, { id: 'op-1', type: 'return', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() })
  assert.ok(validateSync(other).length > 0, 'возврат этим адресом не принимается')
  const bad = plainToInstance(WebSaleDto, { id: 'op 1; drop', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() })
  assert.ok(validateSync(bad).length > 0)
})

test('приём идёт через общий путь чеков: тип всегда «чек», касса — WEB_DEVICE, разделы — тем, кто смотрит', async () => {
  const { svc, changed } = makeService()
  let got = null
  svc.applyOne = async (op, deviceId, user, touched) => {
    got = { op, deviceId, user }
    touched.add('sales')
    touched.add('products')
    return { id: op.id, status: 'ok', docId: 'sale-1' }
  }
  const r = await svc.pushWeb({ id: 'op-1', type: 'return', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() }, cashier)
  assert.deepEqual(r, { id: 'op-1', status: 'ok', docId: 'sale-1' })
  assert.equal(got.op.type, 'sale', 'тип из запроса не важен — только чек')
  assert.equal(got.deviceId, WEB_DEVICE)
  assert.equal(WEB_DEVICE, 'web')
  assert.deepEqual(changed.sort(), ['products', 'sales'])
})

test('повтор того же номера — тем же ответом, без второй продажи', async () => {
  const { svc } = makeService({ seen: { id: 'op-1', status: 'ok', error: '', docId: 'sale-1' } })
  const r = await svc.pushWeb({ id: 'op-1', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() }, cashier)
  assert.equal(r.status, 'duplicate')
  assert.equal(r.docId, 'sale-1')
  const { svc: svc2 } = makeService({ seen: { id: 'op-2', status: 'rejected', error: 'Недостаточно прав', docId: null } })
  const r2 = await svc2.pushWeb({ id: 'op-2', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() }, cashier)
  assert.deepEqual(r2, { id: 'op-2', status: 'rejected', error: 'Недостаточно прав' })
})

test('чек в долг без права «в долг» — отказ, записанный (браузер не шлёт его по кругу)', async () => {
  const { svc, created } = makeService()
  const r = await svc.pushWeb({ id: 'op-3', createdAt: '2026-11-14T10:00:00.000Z', payload: sale({ payment: 'debt', customerId: 'c1' }) }, cashier)
  assert.equal(r.status, 'rejected')
  assert.equal(r.error, 'Недостаточно прав')
  assert.equal(created.length, 1)
  assert.equal(created[0].deviceId, 'web')
  assert.equal(created[0].status, 'rejected')
})

test('скидка без права «скидка» — отказ', async () => {
  const { svc } = makeService()
  const p = sale()
  p.sale.items[0].discount = 2
  const r = await svc.pushWeb({ id: 'op-4', createdAt: '2026-11-14T10:00:00.000Z', payload: p }, cashier)
  assert.equal(r.status, 'rejected')
})

test('кассир прислал чек другого сотрудника — отказ', async () => {
  const { svc } = makeService()
  const r = await svc.pushWeb({ id: 'op-5', accountId: 'acc-other', createdAt: '2026-11-14T10:00:00.000Z', payload: sale() }, cashier)
  assert.equal(r.status, 'rejected')
  assert.match(r.error, /другого сотрудника/)
})

test('выключенный модуль «Долги клиентов» — чек в долг не принимается даже от владельца, с понятной причиной', async () => {
  const { svc } = makeService()
  const r = await svc.pushWeb({ id: 'op-6', createdAt: '2026-11-14T10:00:00.000Z', payload: sale({ payment: 'debt', customerId: 'c1' }) }, { ...owner, modulesOff: ['debts'] })
  assert.equal(r.status, 'rejected')
  assert.equal(r.error, 'Модуль выключен у магазина')
})

test('права операции «чек» читаются из самого чека (payload.sale), приход — из payload.arrival', () => {
  assert.deepEqual(requiredPermissions('sale', sale()), [['pos.sell']])
  assert.deepEqual(requiredPermissions('sale', sale({ payment: 'debt' })), [['pos.sell'], ['pos.debt']])
  const disc = sale()
  disc.sale.items[0].discount = 1
  assert.deepEqual(requiredPermissions('sale', disc), [['pos.sell'], ['pos.discount']])
  assert.deepEqual(requiredPermissions('arrival', { arrival: { debt: 50 } }), [['arrivals.create'], ['arrivals.debt']])
  assert.deepEqual(requiredPermissions('arrival', { arrival: { debt: 0 } }), [['arrivals.create']])
})

test('смена: чек сайта ищет общую смену сайта (deviceId пуст), чек кассы — смену своей кассы', async () => {
  const { svc } = makeService()
  const sql = []
  const tx = {
    $queryRaw: async (strings, ...values) => {
      sql.push({ text: strings.join('?'), values })
      return [{ id: values[0] }]
    },
  }
  assert.equal(await svc.shiftRef(tx, 'shift-web', { deviceId: WEB_DEVICE }), 'shift-web')
  assert.match(sql[0].text, /"deviceId" IS NULL/)
  assert.deepEqual(sql[0].values, ['shift-web'])
  assert.equal(await svc.shiftRef(tx, 'shift-dev', { deviceId: 'dev-1' }), 'shift-dev')
  assert.match(sql[1].text, /"deviceId" = \?/)
  assert.deepEqual(sql[1].values, ['shift-dev', 'dev-1'])
  // Без смены — без запроса
  assert.equal(await svc.shiftRef(tx, null, { deviceId: WEB_DEVICE }), null)
  assert.equal(sql.length, 2)
})

test('«Расхождения»: у чеков сайта вместо номера кассы — «Сайт»', () => {
  const names = new Map([['dev-1', 'Касса 1']])
  assert.equal(deviceNameOf('web', names), 'Сайт')
  assert.equal(deviceNameOf('dev-1', names), 'Касса 1')
  assert.equal(deviceNameOf('dev-x', names), '')
  assert.equal(deviceNameOf(null, names), '')
})
