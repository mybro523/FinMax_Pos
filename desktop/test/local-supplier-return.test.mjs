// ── Возврат товара поставщику без интернета ──
//
// Поставщик приехал, забрал просрочку и брак — а связи нет. Касса оформляет возврат
// сама: товар уходит со склада сразу (первой — партия с ближайшим сроком, просроченная
// тоже), деньги — одним из четырёх способов. Самое тонкое — два из них:
//   • «в счёт долга»: долг поставщику уменьшается сразу, пока возврат ждёт отправки,
//     когда сервер его принял и когда пришёл свежий долг от сервера — ни в одном из
//     этих состояний вычет не должен потеряться или посчитаться дважды;
//   • «в кассу»: деньги легли в ящик открытой смены — «ожидается в кассе» растёт сразу.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal } from '../src/local/api.mjs'
import { listDocs, listShifts } from '../src/local/docs.mjs'
import { closeShift, openShift, shiftView } from '../src/local/ops/shift.mjs'
import { createSupplierReturn, DEBT_UNKNOWN, NO_TILL_FOR_REFUND } from '../src/local/ops/supplierreturn.mjs'
import { ackOp, describeOp, pendingOps, rejectOp, touchedBy } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { productsList } from '../src/local/catalog.mjs'
import { suppliersDebts, suppliersList } from '../src/local/suppliers.mjs'
import { ctx, day, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

// Нурофен: 10 упаковок, из них 3 просрочены. Бинт: по 10 штук в упаковке
const apteka = (snap = {}) =>
  pharmacy({
    products: [
      product({ id: 'nur', name: 'Нурофен', cost: 100, price: 150, stock: 10, expiredUnits: 3, expiryDate: day('2026-09-01') }),
      product({ id: 'bint', name: 'Бинт', cost: 50, price: 80, stock: 4, unitsPerPack: 10, looseUnits: 5, expiryDate: null }),
    ],
    ...snap,
  })
const ops = (db) => pendingOps(db, 100)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const up = (...list) => ({ upsert: list, remove: [] })
const delta = (db, data, cursor = '100') => applyPull(db, { full: false, cursor, data }, { now: NOW })
const stockOf = (db, id) => productsList(db, NOW).find((p) => p.id === id)
const debtOf = (db, id) => suppliersList(db, true).find((s) => s.id === id).debt
const ret = (over = {}) => ({ supplierId: 'sup-1', refund: 'debt', note: 'просрочка', items: [{ productId: 'nur', qty: 4, price: 90 }], ...over })

test('возврат в счёт долга: товар ушёл со склада, долг уменьшился, документ — как у сервера', () => {
  const db = apteka()
  const r = createSupplierReturn(ctx(db), ret())
  assert.deepEqual(r, {
    id: r.id,
    date: new Date(NOW).toISOString(),
    supplierId: 'sup-1',
    supplier: 'Опт-Маркет',
    total: 360,
    refund: 'debt',
    shiftId: null,
    note: 'просрочка',
    userId: 'user-1',
    user: { id: 'user-1', name: 'kassir' },
    createdAt: new Date(NOW).toISOString(),
    items: [
      {
        id: r.items[0].id,
        returnId: r.id,
        productId: 'nur',
        name: 'Нурофен',
        qty: 4,
        pieces: 0,
        price: 90,
        // Закупочная из карточки — снимок, как у сервера
        cost: 100,
        // Первой ушла просрочка (3), потом одна годная
        batches: [
          { units: 3, cost: '100', expiryDate: r.items[0].batches[0].expiryDate },
          { units: 1, cost: '100', expiryDate: null },
        ],
      },
    ],
  })
  assert.ok(r.items[0].batches[0].expiryDate < new Date(NOW).toISOString(), 'первой уходит просроченная партия')

  // Склад: было 10 (3 просрочено) — осталось 6, и все годные
  const nur = stockOf(db, 'nur')
  assert.deepEqual([nur.stock, nur.expiredUnits], [6, 0])
  // Долг: 500 − 360
  assert.equal(debtOf(db, 'sup-1'), 140)
  assert.deepEqual(suppliersDebts(db).suppliers.find((s) => s.id === 'sup-1').debt, 140)
  // Журнал и очередь
  assert.deepEqual(listDocs(db, 'supplierreturn'), [r])
  const op = opOf(db, 'supplier.return')
  assert.deepEqual(op.payload, {
    ret: { id: r.id, date: r.date, supplierId: 'sup-1', supplier: 'Опт-Маркет', refund: 'debt', shiftId: null, note: 'просрочка', total: 360, items: [{ id: r.items[0].id, productId: 'nur', name: 'Нурофен', qty: 4, pieces: 0, price: 90 }] },
    deviceId: 'kassa-1',
  })
  // Закупочная цена в карточке не меняется
  assert.equal(row(db, "SELECT costC FROM products WHERE id = 'nur'").costC, 10000)
})

test('возврат: упаковки и штуки, цена за упаковку — штуки оплачиваются долей, сумма как у сервера', () => {
  const db = apteka()
  // Бинт: 1 упаковка и 5 штук по 50 за упаковку = 75
  const r = createSupplierReturn(ctx(db), ret({ refund: 'card', items: [{ productId: 'bint', qty: 1, pieces: 5, price: 50 }] }))
  assert.equal(r.total, 75)
  assert.deepEqual([r.items[0].qty, r.items[0].pieces], [1, 5])
  // Было 4 уп + 5 шт = 45 шт; ушло 15 — осталось 30 шт = 3 уп
  const bint = stockOf(db, 'bint')
  assert.deepEqual([bint.stock, bint.looseUnits], [3, 0])
  // На карту — долг не трогаем, смены нет
  assert.equal(debtOf(db, 'sup-1'), 500)
  assert.equal(r.shiftId, null)
  // Цену сервер получает как ввели — сумму он пересчитает сам
  const op = opOf(db, 'supplier.return')
  assert.equal(op.payload.ret.items[0].price, 50)
  assert.equal(op.payload.ret.total, 75)
})

test('возврат: цена с долями дирама уходит на сервер как ввели, а в документе — до дирама', () => {
  const db = apteka()
  // 3 × 33,333 = 99,999 → 100.00, как у сервера
  const r = createSupplierReturn(ctx(db), ret({ refund: 'own', items: [{ productId: 'nur', qty: 3, price: 33.333 }] }))
  assert.equal(r.total, 100)
  assert.equal(r.items[0].price, 33.33)
  assert.equal(opOf(db, 'supplier.return').payload.ret.items[0].price, 33.333)
})

test('возврат: отказы — словами сервера, и ничего не записано', () => {
  const db = apteka()
  const nothing = () => {
    assert.equal(listDocs(db, 'supplierreturn').length, 0)
    assert.equal(ops(db).length, 0)
    assert.equal(rows(db, 'SELECT * FROM stock_moves').length, 0)
    assert.equal(stockOf(db, 'nur').stock, 10)
  }
  // Долга меньше суммы возврата
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 6, price: 90 }] })), 400, 'Долг поставщику (500.00) меньше суммы возврата (540.00) — выберите, как поставщик вернул деньги')
  nothing()
  // Поставщику Авиценна ничего не должны
  refused(() => createSupplierReturn(ctx(db), ret({ supplierId: 'sup-2' })), 400, 'Долг поставщику (0.00) меньше суммы возврата (360.00) — выберите, как поставщик вернул деньги')
  // Товара меньше, чем отдаём (просрочку отдавать можно — она в счёт)
  refused(() => createSupplierReturn(ctx(db), ret({ refund: 'own', items: [{ productId: 'nur', qty: 11, price: 90 }] })), 400, 'Недостаточно «Нурофен» на складе (есть 10 шт)')
  nothing()
  // В кассу — нужна открытая смена этой кассы
  refused(() => createSupplierReturn(ctx(db), ret({ refund: 'cash' })), 400, NO_TILL_FOR_REFUND)
  nothing()
  refused(() => createSupplierReturn(ctx(db), ret({ supplierId: 'нет-такого' })), 400, 'Поставщик не найден')
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'нет-такого', qty: 1, price: 1 }] })), 400, 'Товар не найден')
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 0, price: 1 }] })), 400, 'Укажите количество: Нурофен')
  refused(() => createSupplierReturn(ctx(db), ret({ refund: 'barter' })), 400, 'Возврат денег: допустимо только — debt, cash, own, card')
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 1.5, price: 1 }] })), 400, 'items.0.qty: только целое число')
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 1, price: -1 }] })), 400, 'items.0.price: не меньше 0')
  refused(() => createSupplierReturn(ctx(db), ret({ items: [] })), 400, 'Позиции: нужна хотя бы 1 позиция')
  refused(() => createSupplierReturn(ctx(db), ret({ note: 'x'.repeat(501) })), 400, 'Примечание: не длиннее 500 символов')
  nothing()
})

test('возврат в счёт долга, когда долг на кассе неизвестен (запись получал кассир), — отказ', () => {
  // Кассиру сервер отдаёт поставщиков без долгов
  const db = apteka({ suppliers: [{ id: 'sup-1', name: 'Опт-Маркет', phone: '', note: '', createdAt: '2026-09-01T08:00:00.000Z' }] })
  refused(() => createSupplierReturn(ctx(db), ret()), 400, DEBT_UNKNOWN)
  // Другими способами — можно
  assert.equal(createSupplierReturn(ctx(db), ret({ refund: 'own' })).total, 360)
})

test('долг поставщику: вычет держится, пока возврат не отправлен, и не задваивается после приёма', () => {
  const db = apteka()
  createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 2, price: 100 }] }))
  assert.equal(debtOf(db, 'sup-1'), 300)
  // Второй возврат проверяется по долгу уже с первым: осталось 300
  refused(() => createSupplierReturn(ctx(db), ret({ items: [{ productId: 'nur', qty: 4, price: 100 }] })), 400, 'Долг поставщику (300.00) меньше суммы возврата (400.00) — выберите, как поставщик вернул деньги')

  // Сервер принял: вычет переходит в долг, известный от сервера, — долг тот же
  const op = opOf(db, 'supplier.return')
  ackOp(db, op)
  assert.equal(debtOf(db, 'sup-1'), 300)
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'supplierreturn'").sync, 'synced')
  // Пришёл свежий долг от сервера — тот же самый
  delta(db, { suppliers: up({ id: 'sup-1', name: 'Опт-Маркет', phone: '', note: '', openingDebt: 500, debt: 300, createdAt: '2026-09-01T08:00:00.000Z' }) })
  assert.equal(debtOf(db, 'sup-1'), 300)
  // И серверная копия возврата заменила свою
  const r = op.payload.ret
  delta(db, { supplierReturns: up({ ...r, items: r.items.map((i) => ({ ...i, returnId: r.id, cost: 100, batches: [] })), server: true }) })
  assert.equal(listDocs(db, 'supplierreturn')[0].server, true)
  assert.equal(debtOf(db, 'sup-1'), 300)
})

test('сервер отверг возврат: товар вернулся на склад, долг — к прежнему, документ виден отвергнутым', () => {
  const db = apteka()
  createSupplierReturn(ctx(db), ret())
  assert.deepEqual([stockOf(db, 'nur').stock, debtOf(db, 'sup-1')], [6, 140])
  const op = opOf(db, 'supplier.return')
  rejectOp(db, op, 'Поставщик не найден')
  // Остаток пересчитается при ближайшем обмене — от того, что знает сервер
  delta(db, {})
  assert.deepEqual([stockOf(db, 'nur').stock, stockOf(db, 'nur').expiredUnits], [10, 3])
  assert.equal(debtOf(db, 'sup-1'), 500)
  assert.deepEqual(listDocs(db, 'supplierreturn'), [])
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'supplierreturn'").sync, 'rejected')
})

test('возврат «в кассу»: деньги в ящике открытой смены — «ожидается в кассе» растёт сразу и при закрытии', () => {
  const db = apteka()
  const shift = openShift(ctx(db), { openingCash: 100 })
  const r = createSupplierReturn(ctx(db), ret({ refund: 'cash', shiftId: 'чужая-смена', items: [{ productId: 'nur', qty: 2, price: 90 }] }))
  // Деньги — в ящик своей смены, что бы ни прислало окно
  assert.equal(r.shiftId, shift.id)
  // Долг поставщику не трогаем: он отдал деньги
  assert.equal(debtOf(db, 'sup-1'), 500)
  const open = shiftView(db, listShifts(db, 'kassa-1').find((s) => !s.closedAt))
  assert.equal(open.supplierRefund, 180)

  // Возврат на карту в ящик не попадает
  createSupplierReturn(ctx(db), ret({ refund: 'card', items: [{ productId: 'nur', qty: 1, price: 90 }] }))
  const closed = closeShift({ ...ctx(db), now: NOW + 3600_000 }, { countedCash: 280 })
  assert.equal(closed.supplierRefund, 180)
  // 100 на начало + 180 от поставщика
  assert.deepEqual([closed.expectedCash, closed.difference], [280, 0])
  assert.equal(opOf(db, 'shift.close').payload.shift.supplierRefund, 180)
})

test('возврат «в кассу», оформленный на сайте в смену этой кассы, тоже в её ящике', () => {
  const db = apteka()
  const shift = openShift(ctx(db), { openingCash: 0 })
  ackOp(db, opOf(db, 'shift.open'))
  delta(db, {
    supplierReturns: up({ id: 'web-ret', date: new Date(NOW).toISOString(), supplierId: 'sup-1', supplier: 'Опт-Маркет', total: 55, refund: 'cash', shiftId: shift.id, note: '', items: [] }),
  })
  assert.equal(shiftView(db, listShifts(db, 'kassa-1').find((s) => !s.closedAt)).supplierRefund, 55)
})

test('возврат поставщику: адреса, права и описание для списка «не принято»', () => {
  assert.ok(matchLocal('GET', '/supplier-returns?days=180'))
  assert.ok(matchLocal('POST', '/supplier-returns'))
  // Удалить возврат касса с версии 1.4.14 умеет и сама — по праву «изменить и удалить приход»
  assert.ok(matchLocal('DELETE', '/supplier-returns/abc'))

  const db = apteka()
  const cashier = { accountId: 'acc-2', id: 'user-2', name: 'kassa', role: 'cashier', permissions: ['pos.sell'] }
  const call = (method, path, body, user) => {
    const found = matchLocal(method, path)
    return () => found.handler({ ...ctx(db), user, body, query: found.query, params: found.params })
  }
  refused(call('POST', '/supplier-returns', ret(), cashier), 403, 'Недостаточно прав')
  refused(call('GET', '/supplier-returns', null, cashier), 403, 'Недостаточно прав')
  // С правом на возврат — оформляет; журнал — по праву на приход
  const storekeeper = { ...cashier, permissions: ['arrivals.return', 'arrivals.view'] }
  const r = call('POST', '/supplier-returns', ret({ refund: 'own' }), storekeeper)()
  assert.equal(r.user.name, 'kassa')
  assert.deepEqual(call('GET', '/supplier-returns', null, storekeeper)().map((x) => x.id), [r.id])

  // Удалить — только с правом на правку прихода
  refused(call('DELETE', '/supplier-returns/' + r.id, null, storekeeper), 403, 'Недостаточно прав')

  const op = opOf(db, 'supplier.return')
  assert.deepEqual(touchedBy(op), ['supplierReturns', 'products', 'suppliers', 'shifts'])
  assert.deepEqual(describeOp(op), {
    sum: 360,
    title: 'Опт-Маркет',
    detail: { supplier: 'Опт-Маркет', refund: 'own', note: 'просрочка', lines: [{ name: 'Нурофен', qty: 4, pieces: 0, price: 90 }] },
  })
})
