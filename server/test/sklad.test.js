// ── Склад (1.8.0) ──
//
// Правила, которые нельзя нарушить молча:
//   • со склада товар уходит по сроку: сначала ближайший, бессрочные — последними;
//   • не хватает — отказ, и склад остаётся как был;
//   • перенос кладёт в магазин партию с ценой и сроком складской и сдвигает среднюю
//     закупочную, как приход;
//   • правка остатка ставит ровно столько, сколько сказали;
//   • операции склада с кассы разбираются строго, права — как на сайте.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')

const { planTake, unitsText, skladToShopIn, skladEditIn } = require('../dist/sklad/sklad.service')
const { parseSkladToShop, parseSkladEdit, parseArrival, OP_TYPES, Reject } = require('../dist/sync/payload')
const { OP_PERMISSIONS, ALL_PERMISSIONS, ROLE_PRESETS } = require('../dist/auth/permissions')
const { collectionsFor } = require('../dist/events/change-events.interceptor')

const D = (x) => new Prisma.Decimal(x)
const day = (s) => new Date(s + 'T00:00:00.000Z')

// ── База в памяти: ровно то, что трогают перенос и правка склада ──
function fakeDb({ products = [], batches = [], sklad = [] } = {}) {
  let n = 0
  const nid = (p) => `${p}${++n}`
  const db = {
    products: products.map((p) => ({ unitsPerPack: 1, looseUnits: 0, stock: 0, cost: D(0), price: D(0), expiryDate: null, unit: 'уп', ...p })),
    batches: batches.map((b) => ({ id: nid('b'), arrivalId: null, note: '', createdAt: new Date(2026, 0, 1), ...b })),
    sklad: sklad.map((b, i) => ({ id: nid('s'), arrivalId: null, createdAt: new Date(2026, 0, 1 + i), expiryDate: null, ...b })),
    moves: [],
  }
  const byWhere = (rows, where = {}) =>
    rows.filter((r) =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && 'in' in v) return v.in.includes(r[k])
        if (v && typeof v === 'object' && 'gt' in v) return r[k] > v.gt
        return r[k] === v
      }),
    )
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    product: {
      findMany: async ({ where } = {}) => byWhere(db.products, where).map((p) => ({ ...p })),
      findUnique: async ({ where, include }) => {
        const p = db.products.find((x) => x.id === where.id)
        if (!p) return null
        return include?.batches ? { ...p, batches: db.batches.filter((b) => b.productId === p.id).map((b) => ({ ...b })) } : { ...p }
      },
      update: async ({ where, data }) => {
        const p = db.products.find((x) => x.id === where.id)
        Object.assign(p, data)
        return { ...p }
      },
    },
    batch: {
      create: async ({ data }) => {
        const b = { id: nid('b'), arrivalId: null, note: '', createdAt: new Date(), expiryDate: null, ...data, cost: D(data.cost) }
        db.batches.push(b)
        return { ...b }
      },
      update: async ({ where, data }) => {
        const b = db.batches.find((x) => x.id === where.id)
        Object.assign(b, data)
        return { ...b }
      },
    },
    skladBatch: {
      findMany: async ({ where } = {}) => byWhere(db.sklad, where).map((b) => ({ ...b })),
      create: async ({ data }) => {
        const b = { id: nid('s'), arrivalId: null, createdAt: new Date(), expiryDate: null, ...data }
        db.sklad.push(b)
        return { ...b }
      },
      update: async ({ where, data }) => {
        const b = db.sklad.find((x) => x.id === where.id)
        Object.assign(b, data)
        return { ...b }
      },
      delete: async ({ where }) => {
        db.sklad = db.sklad.filter((x) => x.id !== where.id)
      },
    },
    skladMove: {
      findUnique: async ({ where }) => db.moves.find((m) => (where.clientId ? m.clientId === where.clientId : m.id === where.id)) || null,
      create: async ({ data }) => {
        const m = { id: data.id || nid('m'), ...data, user: null }
        db.moves.push(m)
        return m
      },
    },
  }
  return { db, tx }
}

const skladUnits = (db, pid) => db.sklad.filter((b) => b.productId === pid).reduce((s, b) => s + b.units, 0)
const shopUnits = (db, pid) => db.batches.filter((b) => b.productId === pid).reduce((s, b) => s + b.units, 0)

test('со склада — сначала ближайший срок, бессрочные последними, при равных — старые', () => {
  const rows = [
    { id: 'none', units: 5, cost: 1, expiryDate: null, createdAt: new Date(2026, 0, 1) },
    { id: 'late', units: 5, cost: 1, expiryDate: day('2027-06-01'), createdAt: new Date(2026, 0, 1) },
    { id: 'soon-new', units: 5, cost: 1, expiryDate: day('2026-12-01'), createdAt: new Date(2026, 5, 1) },
    { id: 'soon-old', units: 5, cost: 1, expiryDate: day('2026-12-01'), createdAt: new Date(2026, 0, 1) },
    { id: 'empty', units: 0, cost: 1, expiryDate: day('2026-01-01'), createdAt: new Date(2026, 0, 1) },
  ]
  const { parts, have } = planTake(rows, 13)
  assert.equal(have, 20)
  assert.deepEqual(parts.map((p) => [p.row.id, p.units]), [['soon-old', 5], ['soon-new', 5], ['late', 3]])
  // Не хватает — берём сколько есть и говорим, сколько было
  const short = planTake(rows, 50)
  assert.equal(short.have, 20)
  assert.equal(short.parts.reduce((s, p) => s + p.units, 0), 20)
})

test('остаток словами: упаковки и штуки, килограммы у весового', () => {
  assert.equal(unitsText(7, { unitsPerPack: 1 }), '7 шт')
  assert.equal(unitsText(26, { unitsPerPack: 10 }), '2 уп + 6 шт')
  assert.equal(unitsText(30, { unitsPerPack: 10 }), '3 уп')
  assert.equal(unitsText(1500, { unit: 'кг', unitsPerPack: 1000 }), '1,5 кг')
})

test('перенос в магазин: по сроку, партиями склада, средняя закупочная сдвигается', async () => {
  const { db, tx } = fakeDb({
    // В магазине 10 шт по 100 за упаковку (по 10 шт)
    products: [{ id: 'p1', name: 'Мука', unitsPerPack: 10, stock: 1, looseUnits: 0, cost: D(100) }],
    batches: [{ productId: 'p1', units: 10, cost: D(100), expiryDate: null }],
    sklad: [
      { productId: 'p1', units: 20, cost: D(130), expiryDate: day('2027-01-01') },
      { productId: 'p1', units: 20, cost: D(120), expiryDate: day('2026-12-01') },
    ],
  })
  const move = await skladToShopIn(tx, { items: [{ productId: 'p1', units: 30 }] }, 'u1')
  assert.equal(move.kind, 'toShop')
  // Взяли 20 по 120 (ближайший срок) и 10 по 130
  assert.deepEqual(move.items.map((i) => [i.units, i.cost]), [[20, 120], [10, 130]])
  assert.equal(skladUnits(db, 'p1'), 10)
  assert.equal(db.sklad.length, 1, 'пустая партия склада удаляется')
  assert.equal(shopUnits(db, 'p1'), 40)
  // Средняя: (10·10 + 20·12 + 10·13) / 40 штук = 11,75 за штуку → 117,5 за упаковку
  assert.equal(db.products[0].cost.toString(), '117.5')
  assert.equal(db.products[0].stock, 4)
  // Сумма документа по закупке: 2·120 + 1·130
  assert.equal(move.total.toString(), '370')
  // Партия в магазине — со сроком складской
  assert.ok(db.batches.some((b) => b.units === 20 && b.expiryDate?.getTime() === day('2026-12-01').getTime()))
})

test('не хватает на складе — отказ, склад и магазин как были', async () => {
  const { db, tx } = fakeDb({
    products: [{ id: 'p1', name: 'Сахар', unitsPerPack: 1, cost: D(10) }],
    sklad: [{ productId: 'p1', units: 5, cost: D(10) }],
  })
  await assert.rejects(skladToShopIn(tx, { items: [{ productId: 'p1', units: 6 }] }, null), /На складе не хватает: Сахар \(есть 5 шт\)/)
  assert.equal(skladUnits(db, 'p1'), 5)
  assert.equal(shopUnits(db, 'p1'), 0)
  assert.equal(db.moves.length, 0)
})

test('касса без связи: перенос уже сделан руками — берём сколько есть, нехватка по нынешней цене', async () => {
  const { db, tx } = fakeDb({
    products: [{ id: 'p1', name: 'Сахар', unitsPerPack: 1, cost: D(10) }],
    sklad: [{ productId: 'p1', units: 5, cost: D(10) }],
  })
  const move = await skladToShopIn(tx, { id: 'mv-1', clientId: 'mv-1', items: [{ productId: 'p1', units: 8 }] }, null, { tolerant: true })
  assert.equal(move.id, 'mv-1')
  assert.equal(skladUnits(db, 'p1'), 0)
  assert.equal(shopUnits(db, 'p1'), 8)
  // Повтор той же операции — тот же документ, второй раз не переносится
  const again = await skladToShopIn(tx, { id: 'mv-1', clientId: 'mv-1', items: [{ productId: 'p1', units: 8 }] }, null, { tolerant: true })
  assert.equal(again.id, 'mv-1')
  assert.equal(shopUnits(db, 'p1'), 8)
  assert.equal(db.moves.length, 1)
})

test('правка остатка склада: прибавка — новой партией, убавка — по сроку, без изменения — отказ', async () => {
  const { db, tx } = fakeDb({
    products: [{ id: 'p1', name: 'Рис', unitsPerPack: 1, cost: D(15) }],
    sklad: [
      { productId: 'p1', units: 4, cost: D(15), expiryDate: day('2027-01-01') },
      { productId: 'p1', units: 4, cost: D(14), expiryDate: day('2026-11-30') },
    ],
  })
  const up = await skladEditIn(tx, { productId: 'p1', units: 10, cost: 16, expiryDate: '2027-05-01' }, 'u1')
  assert.equal(up.kind, 'edit')
  assert.deepEqual(up.items.map((i) => [i.units, i.cost]), [[2, 16]])
  assert.equal(skladUnits(db, 'p1'), 10)
  const down = await skladEditIn(tx, { productId: 'p1', units: 3 }, 'u1')
  // Сначала уходит ближайший срок (4 по 14), затем 3 из следующего (по 15)
  assert.deepEqual(down.items.map((i) => [i.units, i.cost]), [[-4, 14], [-3, 15]])
  assert.equal(skladUnits(db, 'p1'), 3)
  await assert.rejects(skladEditIn(tx, { productId: 'p1', units: 3 }, 'u1'), /Остаток не изменился/)
  // С кассы без связи остаток уже такой — не отказ, просто нет документа
  assert.equal(await skladEditIn(tx, { productId: 'p1', units: 3 }, 'u1', { quiet: true }), null)
  // Прибавка без цены — по нынешней закупочной товара
  const plain = await skladEditIn(tx, { productId: 'p1', units: 5 }, 'u1')
  assert.deepEqual(plain.items.map((i) => [i.units, i.cost]), [[2, 15]])
})

test('операции склада с кассы: разбор и отказы по существу', () => {
  assert.ok(OP_TYPES.includes('sklad.toShop'))
  assert.ok(OP_TYPES.includes('sklad.edit'))
  // Тело — как у POST: clientId — номер документа
  const t = parseSkladToShop({ clientId: 'mv-1', items: [{ productId: 'cmproduct1', units: 12 }], note: 'на полку' })
  assert.equal(t.id, 'mv-1')
  assert.deepEqual(t.items, [{ productId: 'cmproduct1', units: 12 }])
  // И в обёртке { move: … } с датой
  const w = parseSkladToShop({ move: { id: 'mv-2', date: '2026-11-14T08:00:00.000Z', items: [{ productId: 'cmproduct1', units: 1 }] } }, Date.parse('2026-11-14T09:00:00Z'))
  assert.equal(w.id, 'mv-2')
  assert.equal(w.date.toISOString(), '2026-11-14T08:00:00.000Z')
  assert.throws(() => parseSkladToShop({ clientId: 'mv-3', items: [{ productId: 'cmproduct1', units: 0 }] }), Reject)
  assert.throws(() => parseSkladToShop({ clientId: 'mv-3', items: [] }), Reject)
  assert.throws(() => parseSkladToShop({ items: [{ productId: 'cmproduct1', units: 1 }] }), Reject, 'без номера документа нельзя')
  const e = parseSkladEdit({ clientId: 'ed-1', productId: 'cmproduct1', units: 0, cost: 15.5, expiryDate: '2027-01-01' })
  assert.deepEqual([e.id, e.units, e.cost, e.expiryDate.toISOString().slice(0, 10)], ['ed-1', 0, 15.5, '2027-01-01'])
  assert.equal(parseSkladEdit({ clientId: 'ed-2', productId: 'cmproduct1', units: 4 }).cost, null)
  assert.throws(() => parseSkladEdit({ clientId: 'ed-3', productId: 'cmproduct1', units: -1 }), Reject)
})

test('приход с кассы: куда пришёл товар — склад или магазин (прежние кассы — магазин)', () => {
  const base = {
    arrival: { id: 'arr-1', date: '2026-11-14T08:00:00.000Z', supplier: 'ООО', total: 100, items: [{ id: 'arr-1-a', productId: 'cmproduct1', name: 'Мука', qty: 1, cost: 100 }] },
    expiry: [null],
  }
  const now = Date.parse('2026-11-14T09:00:00Z')
  assert.equal(parseArrival(base, now).place, 'shop')
  assert.equal(parseArrival({ ...base, arrival: { ...base.arrival, place: 'sklad' } }, now).place, 'sklad')
  assert.throws(() => parseArrival({ ...base, arrival: { ...base.arrival, place: 'kuda-to' } }, now), Reject)
})

test('права склада: свои ключи, операции кассы — по праву «перенос», заведующий получает', () => {
  assert.ok(ALL_PERMISSIONS.includes('sklad.view'))
  assert.ok(ALL_PERMISSIONS.includes('sklad.move'))
  assert.deepEqual(OP_PERMISSIONS['sklad.toShop'], ['sklad.move'])
  assert.deepEqual(OP_PERMISSIONS['sklad.edit'], ['sklad.move'])
  const zav = ROLE_PRESETS.find((r) => r.name === 'Заведующий')
  assert.ok(zav.permissions.includes('sklad.move'))
  const nab = ROLE_PRESETS.find((r) => r.name === 'Наблюдатель')
  assert.ok(nab.permissions.includes('sklad.view') && !nab.permissions.includes('sklad.move'))
})

test('после записи склада сайт перечитывает склад и товары', () => {
  assert.deepEqual(collectionsFor('POST', '/api/sklad/to-shop'), ['skladBatches', 'skladMoves', 'products'])
  assert.deepEqual(collectionsFor('POST', '/api/sklad/edit'), ['skladBatches', 'skladMoves', 'products'])
  assert.ok(collectionsFor('POST', '/api/arrivals').includes('skladBatches'))
  assert.deepEqual(collectionsFor('GET', '/api/sklad'), [])
})
