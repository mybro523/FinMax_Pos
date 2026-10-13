// ── Операции кассы без интернета ──
//
// Продажа, возврат, списание, приход, смена, долг. Каждая считает и отказывает так
// же, как сервер: суммы — до дирама, тексты отказов — слово в слово. Кассир не
// должен замечать, откуда пришёл ответ, а чек, пробитый без связи, обязан сойтись
// с сервером, когда до него дойдёт.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { customersList, deferredList, productsList } from '../src/local/catalog.mjs'
import { listDocs, listShifts } from '../src/local/docs.mjs'
import { createArrival } from '../src/local/ops/arrival.mjs'
import { createCustomer, payDebt } from '../src/local/ops/customer.mjs'
import { addDeferred, removeDeferred } from '../src/local/ops/deferred.mjs'
import { createReturn } from '../src/local/ops/return.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { closeShift, openShift } from '../src/local/ops/shift.mjs'
import { createWriteOff } from '../src/local/ops/writeoff.mjs'
import { applySnapshot } from '../src/local/snapshot.mjs'
import { SUPPLIERS, ctx, customer, day, NOW, pharmacy, product, refused, row, rows } from '../test-support/pharmacy.mjs'

// Аптека с тремя товарами: делимый (20 таблеток в пачке), неделимый и бинт без срока
function apteka(extra = {}) {
  const par = product({ id: 'par', name: 'Парацетамол', unitsPerPack: 20, price: 200, cost: 120, stock: 9 })
  const nur = product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })
  const bint = product({ id: 'bint', name: 'Бинт', category: 'Перевязка', price: 10, cost: 6, stock: 20, expiryDate: null })
  const ivan = customer({ id: 'ivan', name: 'Иван', debt: 10 })
  const db = pharmacy({ products: [par, nur, bint], customers: [ivan], ...extra })
  return { db, par, nur, bint, ivan }
}

const stockOf = (db, id) => {
  const p = productsList(db, NOW).find((x) => x.id === id)
  return [p.stock, p.looseUnits]
}
const outbox = (db) => rows(db, 'SELECT type, accountId, state, payload FROM outbox ORDER BY seq').map((r) => ({ ...r, payload: JSON.parse(r.payload) }))

// ── Продажа ──

test('продажа: суммы, скидка, остаток в штуках, запись в очередь на отправку', () => {
  const { db } = apteka()
  const sale = checkout(ctx(db), {
    payment: 'cash',
    clientId: 'tmp_1',
    items: [
      { productId: 'par', qty: 1, pieces: 5, discount: 10 },
      { productId: 'nur', qty: 2 },
    ],
  })
  // Пачка и пять таблеток: 200/20 × 25 = 250, минус скидка 10. Две пачки нурофена — 300
  assert.equal(sale.total, 540)
  assert.equal(sale.cost, 350)
  assert.equal(sale.profit, 190)
  assert.equal(sale.payment, 'cash')
  assert.equal(sale.customerId, null)
  assert.equal(sale.customer, null)
  assert.equal(sale.shiftId, null)
  assert.equal(sale.clientId, 'tmp_1')
  assert.equal(sale.date, new Date(NOW).toISOString())
  assert.deepEqual(sale.user, { id: 'user-1', name: 'kassir' })
  assert.deepEqual(
    sale.items.map((i) => [i.name, i.qty, i.pieces, i.unitsPerPack, i.price, i.cost, i.discount, i.saleId === sale.id]),
    [
      ['Парацетамол', 1, 5, 20, 200, 120, 10, true],
      ['Нурофен', 2, 0, 1, 150, 100, 0, true],
    ],
  )
  // Вид чека — как у сервера: те же поля в том же порядке
  assert.deepEqual(Object.keys(sale), ['id', 'clientId', 'date', 'total', 'cost', 'profit', 'payment', 'payVia', 'customerId', 'shiftId', 'userId', 'items', 'customer', 'user'])
  assert.deepEqual(Object.keys(sale.items[0]), ['id', 'saleId', 'productId', 'name', 'qty', 'pieces', 'unitsPerPack', 'unit', 'price', 'cost', 'discount'])

  assert.deepEqual(stockOf(db, 'par'), [7, 15])
  assert.deepEqual(stockOf(db, 'nur'), [3, 0])

  // Чек лежит в журнале и ждёт отправки; в очереди — одна операция со всем нужным серверу
  assert.deepEqual(listDocs(db, 'sale'), [sale])
  assert.equal(row(db, "SELECT sync FROM docs WHERE kind = 'sale'").sync, 'pending')
  const [op] = outbox(db)
  assert.equal(op.type, 'sale')
  assert.equal(op.state, 'pending')
  assert.equal(op.accountId, 'acc-1')
  assert.deepEqual(op.payload.sale, sale)
  assert.equal(op.payload.deviceId, 'kassa-1')
})

test('продажа: повтор с тем же ключом не списывает товар второй раз', () => {
  const { db } = apteka()
  const dto = { payment: 'card', clientId: 'tmp_x', items: [{ productId: 'nur', qty: 1 }] }
  const first = checkout(ctx(db), dto)
  const again = checkout(ctx(db), dto)
  assert.deepEqual(again, first)
  assert.deepEqual(stockOf(db, 'nur'), [4, 0])
  assert.equal(listDocs(db, 'sale').length, 1)
  assert.equal(outbox(db).length, 1)
})

test('продажа: копейки сходятся с сервером даже там, где «точный» счёт дал бы другое', () => {
  // 3 таблетки из пачки в 12 штук по 2,50: сервер получает 0,62, а не 0,63
  const melok = product({ id: 'melok', unitsPerPack: 12, price: 2.5, cost: 1, stock: 1 })
  const db = pharmacy({ products: [melok] })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'melok', qty: 0, pieces: 3 }] })
  assert.equal(sale.total, 0.62)
  assert.equal(sale.cost, 0.25)
  assert.equal(sale.profit, 0.37)
})

test('продажа: скидка не бывает больше суммы позиции и меньше нуля', () => {
  const { db } = apteka()
  const big = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1, discount: 1000 }] })
  assert.equal(big.items[0].discount, 150)
  assert.equal(big.total, 0)
  assert.equal(big.profit, -100)
})

test('продажа в долг: долг клиента растёт, чек помнит клиента', () => {
  const { db } = apteka()
  refused(() => checkout(ctx(db), { payment: 'debt', items: [{ productId: 'nur', qty: 1 }] }), 400, 'Для продажи в долг укажите клиента')
  refused(
    () => checkout(ctx(db), { payment: 'debt', customerId: 'нет-такого', items: [{ productId: 'nur', qty: 1 }] }),
    404,
    'Клиент не найден',
  )
  // Отказ откатил всё: товар на месте
  assert.deepEqual(stockOf(db, 'nur'), [5, 0])

  const sale = checkout(ctx(db), { payment: 'debt', customerId: 'ivan', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(sale.customerId, 'ivan')
  assert.deepEqual(sale.customer, { id: 'ivan', name: 'Иван', phone: '', debt: 160, createdAt: '2026-09-01T08:00:00.000Z' })
  assert.equal(customersList(db)[0].debt, 160)

  // Оплата наличными с указанным клиентом долг не меняет и клиента в чек не пишет
  const cash = checkout(ctx(db), { payment: 'cash', customerId: 'ivan', items: [{ productId: 'nur', qty: 1 }] })
  assert.equal(cash.customerId, null)
  assert.equal(customersList(db)[0].debt, 160)
})

test('продажа: отказы — теми же словами, что у сервера, и без следов в базе', () => {
  const { db } = apteka()
  const c = ctx(db)
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 6 }] }), 400, 'Недостаточно «Нурофен» на складе (есть 5 шт)')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'нет', qty: 1 }] }), 400, 'Товар не найден')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 0, pieces: 0 }] }), 400, 'Укажите количество (упаковки или штуки)')
  // Один товар двумя строками считается вместе: 3 + 3 > 5
  refused(
    () =>
      checkout(c, {
        payment: 'cash',
        items: [
          { productId: 'nur', qty: 3 },
          { productId: 'nur', qty: 3 },
        ],
      }),
    400,
    'Недостаточно «Нурофен» на складе (есть 5 шт)',
  )
  assert.equal(listDocs(db, 'sale').length, 0)
  assert.equal(outbox(db).length, 0)
  assert.equal(rows(db, 'SELECT * FROM stock_moves').length, 0)
  assert.deepEqual(stockOf(db, 'nur'), [5, 0])
})

test('продажа: окно не может прислать что попало', () => {
  const { db } = apteka()
  const c = ctx(db)
  refused(() => checkout(c, { payment: 'cash', items: [] }), 400, 'Позиции: нужна хотя бы 1 позиция')
  refused(() => checkout(c, { payment: 'cash' }), 400, 'Позиции: ожидается список')
  refused(() => checkout(c, { payment: 'биткоин', items: [{ productId: 'nur', qty: 1 }] }), 400, 'Оплата: допустимо только — cash, card, debt, transfer')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 1.5 }] }), 400, 'items.0.qty: только целое число')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: -1 }] }), 400, 'items.0.qty: не меньше 0')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 'nur', qty: 1, discount: -5 }] }), 400, 'items.0.discount: не меньше 0')
  refused(() => checkout(c, { payment: 'cash', items: [{ productId: 7, qty: '1' }] }), 400, 'items.0.productId: только текст, items.0.qty: только целое число')
  refused(() => checkout(c, null), 400, 'Позиции: ожидается список, Оплата: допустимо только — cash, card, debt, transfer')
})

test('продажа: просроченное не продаётся, сколько бы его ни лежало', () => {
  const stary = product({ id: 'stary', name: 'Старый', stock: 3, expiredUnits: 3, expiryDate: day('2026-09-01') })
  const db = pharmacy({ products: [stary] })
  refused(
    () => checkout(ctx(db), { payment: 'cash', items: [{ productId: 'stary', qty: 1 }] }),
    400,
    '«Старый»: годных 0 шт, просрочено 3 шт. Просроченное продавать нельзя — уберите его с полки и спишите.',
  )
})

// ── Возврат ──

function sold(payment = 'cash', customerId) {
  const a = apteka()
  const sale = checkout(ctx(a.db), {
    payment,
    customerId,
    items: [
      { productId: 'par', qty: 1, pieces: 5, discount: 10 },
      { productId: 'nur', qty: 2 },
    ],
  })
  return { ...a, sale }
}

test('возврат: деньги — сколько реально заплатили за штуку, товар — обратно на полку', () => {
  const { db, sale } = sold()
  const ret = createReturn(ctx(db), { saleId: sale.id, clientId: 'ret_1', items: [{ productId: 'par', units: 5 }] })
  // За 25 таблеток заплатили 240 (со скидкой): 9,60 за штуку, пять штук — 48
  assert.equal(ret.total, 48)
  assert.equal(ret.refund, 'cash', 'деньги возвращаются тем же способом, каким платили')
  assert.equal(ret.saleId, sale.id)
  assert.equal(ret.note, '')
  assert.deepEqual(
    ret.items.map((i) => [i.name, i.units, i.unitsPerPack, i.price, i.cost, i.amount, i.restock, i.returnId === ret.id]),
    [['Парацетамол', 5, 20, 200, 120, 48, true, true]],
  )
  assert.deepEqual(Object.keys(ret), ['id', 'clientId', 'date', 'saleId', 'userId', 'shiftId', 'refund', 'refundVia', 'total', 'note', 'items', 'user'])
  assert.deepEqual(stockOf(db, 'par'), [8, 0], 'пять таблеток вернулись: 155 + 5 = 160 штук')
  // Возвращённое легло в ту же партию — новых партий не появилось
  assert.equal(rows(db, "SELECT * FROM batches WHERE productId = 'par'").length, 1)

  const ops = outbox(db)
  assert.deepEqual(ops.map((o) => o.type), ['sale', 'return'])
  assert.deepEqual(ops[1].payload.ret, ret)
  assert.equal(ops[1].payload.writeOff, null)

  // Повтор с тем же ключом — тот же возврат, без второго захода
  assert.deepEqual(createReturn(ctx(db), { saleId: sale.id, clientId: 'ret_1', items: [{ productId: 'par', units: 5 }] }), ret)
  assert.deepEqual(stockOf(db, 'par'), [8, 0])
  assert.equal(listDocs(db, 'return').length, 1)
})

test('возврат: больше купленного вернуть нельзя, чужой товар по чеку — тоже', () => {
  const { db, sale } = sold()
  createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'par', units: 5 }] })
  refused(
    () => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'par', units: 21 }] }),
    400,
    'По «Парацетамол» уже возвращено 5 из 25 шт',
  )
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'bint', units: 1 }] }), 400, '«Бинт» нет в этом чеке')
  refused(() => createReturn(ctx(db), { saleId: 'нет', items: [{ productId: 'par', units: 1 }] }), 400, 'Чек не найден')
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'нет', units: 1 }] }), 400, 'Товар не найден')
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'par', units: 0 }] }), 400, 'items.0.units: не меньше 1')
  // Ровно остаток вернуть можно
  assert.equal(createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'par', units: 20 }] }).total, 192)
})

test('возврат без возврата в продажу: товар на полку не идёт, оформляется списание', () => {
  const { db, sale } = sold()
  const ret = createReturn(ctx(db), { saleId: sale.id, refund: 'card', note: 'вскрыта', items: [{ productId: 'nur', units: 1, restock: false }] })
  assert.equal(ret.total, 150)
  assert.equal(ret.refund, 'card')
  assert.equal(ret.note, 'вскрыта')
  assert.equal(ret.items[0].restock, false)
  assert.deepEqual(stockOf(db, 'nur'), [3, 0], 'списанный при возврате товар попал на полку')

  const [wo] = listDocs(db, 'writeoff')
  assert.equal(wo.source, 'return')
  assert.equal(wo.reason, 'damaged')
  assert.equal(wo.note, 'Возврат покупателя без возврата в продажу')
  assert.equal(wo.totalCost, 100)
  assert.deepEqual(wo.items.map((i) => [i.name, i.units, i.cost, i.writeOffId === wo.id]), [['Нурофен', 1, 100, true]])
  // Списание едет на сервер вместе с возвратом, одной операцией
  const op = outbox(db).at(-1)
  assert.equal(op.type, 'return')
  assert.deepEqual(op.payload.writeOff, wo)
})

test('возврат по чеку в долг уменьшает долг, но не уводит его в минус', () => {
  const { db, sale } = sold('debt', 'ivan')
  assert.equal(customersList(db)[0].debt, 550)
  const ret = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'par', units: 5 }] })
  assert.equal(ret.refund, 'debt')
  assert.equal(customersList(db)[0].debt, 502)

  // Долг погасили, а товар принесли позже: списывать не с чего
  payDebt(ctx(db), 'ivan', { amount: 500 })
  assert.equal(customersList(db)[0].debt, 2)
  refused(
    () => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'nur', units: 1 }] }),
    400,
    'Долг клиента 2.00 меньше суммы возврата 150.00 — верните деньги наличными или картой',
  )
  // Наличными — можно
  assert.equal(createReturn(ctx(db), { saleId: sale.id, refund: 'cash', items: [{ productId: 'nur', units: 1 }] }).refund, 'cash')
  assert.equal(customersList(db)[0].debt, 2)
})

test('возврат «в долг» по чеку без клиента невозможен', () => {
  const { db, sale } = sold('cash')
  refused(
    () => createReturn(ctx(db), { saleId: sale.id, refund: 'debt', items: [{ productId: 'nur', units: 1 }] }),
    400,
    'Возврат в долг возможен только по чеку, оформленному на клиента',
  )
})

test('возврат без чека: по нынешней цене товара', () => {
  const { db } = apteka()
  const ret = createReturn(ctx(db), { items: [{ productId: 'par', units: 3 }] })
  assert.equal(ret.saleId, null)
  assert.equal(ret.refund, 'cash')
  assert.equal(ret.total, 30)
  assert.deepEqual(stockOf(db, 'par'), [9, 3])
})

// ── Срок годности возвращённого ──

const cardOf = (db, id) => productsList(db, NOW).find((x) => x.id === id)

test('возврат в продажу при пустом складе: товар получает срок партии, из которой продан, а не остаётся без срока', () => {
  const p = product({ id: 'last', name: 'Последняя пачка', price: 50, cost: 30, stock: 1, expiryDate: day('2027-03-31') })
  const db = pharmacy({ products: [p] })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'last', qty: 1 }] })
  assert.deepEqual([cardOf(db, 'last').stock, cardOf(db, 'last').expiryDate], [0, null], 'на полке пусто — срока в карточке нет')

  // Раньше возвращённое получало срок из карточки — то есть никакого: товар без срока
  // выпадал из контроля сроков и продавался бы сколько угодно
  const ret = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'last', units: 1 }] })
  assert.deepEqual([cardOf(db, 'last').stock, cardOf(db, 'last').expiryDate], [1, day('2027-03-31')])
  // Кассир срок не вписывал — на сервер он не уходит: сервер знает больше партий и
  // поставит срок сам
  assert.equal('expiryDate' in ret.items[0], false)
  assert.equal('expiryDate' in outbox(db).at(-1).payload.ret.items[0], false)
})

test('возврат в продажу: партию, из которой продали, уже распродали — срок берётся её, ранний, а не оставшейся', () => {
  const p = product({ id: 'two', name: 'Две партии', stock: 0, looseUnits: 0, cost: 10, price: 20 })
  const db = pharmacy({
    products: [p],
    batches: [
      { id: 'b-near', productId: 'two', units: 1, cost: 10, expiryDate: day('2026-12-31'), createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'b-far', productId: 'two', units: 3, cost: 10, expiryDate: day('2027-08-31'), createdAt: '2026-09-15T00:00:00.000Z' },
    ],
  })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'two', qty: 1 }] })
  assert.equal(cardOf(db, 'two').expiryDate, day('2027-08-31'), 'ближняя партия продана — в карточке срок дальней')
  createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'two', units: 1 }] })
  // Раньше пачка получала срок оставшейся партии — на восемь месяцев позже настоящего
  assert.deepEqual([cardOf(db, 'two').stock, cardOf(db, 'two').expiryDate], [4, day('2026-12-31')])
  assert.deepEqual(
    rows(db, "SELECT units, expiryDate FROM batches WHERE productId = 'two' AND units > 0 ORDER BY expiryDate").map((b) => [b.units, b.expiryDate]),
    [[1, day('2026-12-31')], [3, day('2027-08-31')]],
  )
})

test('возврат в продажу: срок с упаковки, вписанный кассиром, берётся как есть и уходит на сервер', () => {
  const p = product({ id: 'box', name: 'С коробки', price: 50, cost: 30, stock: 2, expiryDate: day('2027-03-31') })
  const db = pharmacy({ products: [p] })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'box', qty: 2 }] })
  const ret = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: '2027-09-30' }] })
  assert.deepEqual([cardOf(db, 'box').stock, cardOf(db, 'box').expiryDate], [1, day('2027-09-30')])
  assert.equal(ret.items[0].expiryDate, day('2027-09-30'))
  assert.equal(outbox(db).at(-1).payload.ret.items[0].expiryDate, day('2027-09-30'))

  // Истёкший срок: такой товар в продажу не возвращают — и возврат не оформляется вовсе
  const before = outbox(db).length
  refused(
    () => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: '2026-10-03' }] }),
    400,
    'Срок на упаковке уже истёк — такой товар в продажу не возвращают. Выберите «Списать».',
  )
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: 'не дата' }] }), 400, 'Срок годности: неверная дата')
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: '20266-01-01' }] }), 400, 'Срок годности: проверьте год')
  refused(() => createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: 20270930 }] }), 400, 'items.0.expiryDate: только текст')
  assert.equal(outbox(db).length, before, 'ни один отказ не оставил после себя операции')
  assert.equal(cardOf(db, 'box').stock, 1)
  // «Годен до сегодня» — ещё годен: сегодня его продают
  assert.equal(createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'box', units: 1, expiryDate: '2026-10-04' }] }).items[0].expiryDate, day('2026-10-04'))
})

test('возврат со списанием: истёкший срок с упаковки — не помеха, он попадает в списание', () => {
  const p = product({ id: 'old', name: 'Просрочка', price: 50, cost: 30, stock: 1, expiryDate: day('2027-03-31') })
  const db = pharmacy({ products: [p] })
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'old', qty: 1 }] })
  const ret = createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'old', units: 1, restock: false, expiryDate: '2026-10-01' }] })
  assert.equal(ret.items[0].restock, false)
  assert.equal('expiryDate' in ret.items[0], false, 'срок с упаковки нужен только тому, что идёт на полку')
  assert.equal(cardOf(db, 'old').stock, 0)
  assert.equal(listDocs(db, 'writeoff')[0].items[0].expiryDate, day('2026-10-01'))
})

test('возврат товара без срока (бинты, приборы): срока как не было, так и нет', () => {
  const { db } = apteka()
  const sale = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'bint', qty: 20 }] })
  assert.equal(cardOf(db, 'bint').stock, 0)
  createReturn(ctx(db), { saleId: sale.id, items: [{ productId: 'bint', units: 2 }] })
  assert.deepEqual([cardOf(db, 'bint').stock, cardOf(db, 'bint').expiryDate], [2, null])
})

test('возврат без чека: срок — самый ранний из годных сегодня', () => {
  const p = product({ id: 'nochek', name: 'Без чека', stock: 0, looseUnits: 0, cost: 10, price: 20 })
  const db = pharmacy({
    products: [p],
    batches: [
      { id: 'b-dead', productId: 'nochek', units: 0, cost: 10, expiryDate: day('2026-10-01'), createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'b-live', productId: 'nochek', units: 0, cost: 10, expiryDate: day('2027-02-28'), createdAt: '2026-09-01T00:00:00.000Z' },
    ],
  })
  createReturn(ctx(db), { items: [{ productId: 'nochek', units: 1 }] })
  // Партия «до 1 октября» к сегодняшнему дню просрочена — продать из неё сегодня не могли
  assert.deepEqual([cardOf(db, 'nochek').stock, cardOf(db, 'nochek').expiryDate], [1, day('2027-02-28')])
})

// ── Списание ──

test('списание: строки по партиям со своим сроком, убыток по закупочной цене', () => {
  const p = product({ id: 'mix', name: 'Микс', unitsPerPack: 10, cost: 50, price: 80, stock: 3, expiredUnits: 12, expiryDate: day('2026-09-01') })
  const db = pharmacy({ products: [p] })
  const wo = createWriteOff(ctx(db), { reason: 'expired', note: 'сентябрь', items: [{ productId: 'mix', units: 15 }] })
  // 12 просроченных и 3 годных: первой уходит партия с ближайшим сроком
  assert.deepEqual(
    wo.items.map((i) => [i.units, i.cost, i.expiryDate]),
    [
      [12, 50, day('2026-09-01')],
      [3, 50, null],
    ],
  )
  assert.equal(wo.totalCost, 75)
  assert.equal(wo.reason, 'expired')
  assert.equal(wo.source, 'manual')
  assert.equal(wo.note, 'сентябрь')
  assert.deepEqual(Object.keys(wo), ['id', 'date', 'userId', 'reason', 'note', 'totalCost', 'source', 'items', 'user'])
  const [v] = productsList(db, NOW)
  assert.deepEqual([v.stock, v.looseUnits, v.expiredUnits], [1, 5, 0])

  const [op] = outbox(db)
  assert.equal(op.type, 'writeoff')
  assert.deepEqual(op.payload.ask, [{ productId: 'mix', units: 15 }])

  refused(() => createWriteOff(ctx(db), { items: [{ productId: 'mix', units: 16 }] }), 400, 'Недостаточно «Микс» на складе (есть 15 шт)')
  refused(() => createWriteOff(ctx(db), { items: [{ productId: 'нет', units: 1 }] }), 400, 'Товар не найден')
  refused(() => createWriteOff(ctx(db), { reason: 'надоело', items: [{ productId: 'mix', units: 1 }] }), 400, 'Причина: допустимо только — expired, damaged, lost, other')
  // Причина по умолчанию — просрочка
  assert.equal(createWriteOff(ctx(db), { items: [{ productId: 'mix', units: 1 }] }).reason, 'expired')
})

// ── Приход ──

test('приход: партия со сроком, средневзвешенная цена, итог', () => {
  const { db } = apteka()
  // На полке 9 пачек парацетамола по 120. Привезли 3 по 130 и ещё 1 по 150 с другим сроком
  const arrival = createArrival(ctx(db), {
    supplier: 'Фарм-Опт',
    items: [
      { productId: 'par', qty: 3, cost: 130, expiryDate: '2028-01-31' },
      { productId: 'par', qty: 1, cost: 150, expiryDate: '2028-06-30' },
      { productId: 'bint', qty: 10, cost: 5 },
    ],
  })
  assert.equal(arrival.supplier, 'Фарм-Опт')
  assert.equal(arrival.total, 590)
  assert.deepEqual(
    arrival.items.map((i) => [i.name, i.qty, i.cost, i.arrivalId === arrival.id]),
    [
      ['Парацетамол', 3, 130, true],
      ['Парацетамол', 1, 150, true],
      ['Бинт', 10, 5, true],
    ],
  )
  assert.deepEqual(Object.keys(arrival), ['id', 'date', 'supplier', 'supplierId', 'debt', 'payMethod', 'paidCash', 'shiftId', 'userId', 'user', 'total', 'items'])

  const list = productsList(db, NOW)
  const par = list.find((p) => p.id === 'par')
  assert.deepEqual([par.stock, par.looseUnits], [13, 0])
  // (9 × 120 + 3 × 130 + 150) / 13 = 124,615… → 124,62. Обе строки — одним пересчётом
  assert.equal(par.cost, 124.62)
  const bint = list.find((p) => p.id === 'bint')
  assert.equal(bint.stock, 30)
  // (20 × 6 + 10 × 5) / 30 = 5,666… → 5,67
  assert.equal(bint.cost, 5.67)

  // Каждая строка — своя партия со своим сроком и ценой
  assert.deepEqual(
    rows(db, 'SELECT productId, units, costC, expiryDate FROM batches WHERE arrivalId = ? ORDER BY productId DESC, expiryDate', arrival.id),
    [
      { productId: 'par', units: 60, costC: 13000, expiryDate: day('2028-01-31') },
      { productId: 'par', units: 20, costC: 15000, expiryDate: day('2028-06-30') },
      { productId: 'bint', units: 10, costC: 500, expiryDate: null },
    ],
  )

  const [op] = outbox(db)
  assert.equal(op.type, 'arrival')
  assert.deepEqual(op.payload.arrival, arrival)
  assert.deepEqual(op.payload.expiry, [day('2028-01-31'), day('2028-06-30'), null])
})

test('приход: у лекарства срок годности обязателен, у бинта — нет', () => {
  const { db } = apteka()
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 90 }] }), 400, 'Укажите срок годности: Нурофен')
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 90, expiryDate: '' }] }), 400, 'Укажите срок годности: Нурофен')
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: 90, expiryDate: 'завтра' }] }), 400, 'Некорректные данные запроса')
  refused(() => createArrival(ctx(db), { items: [{ productId: 'нет', qty: 1, cost: 90 }] }), 400, 'Товар не найден')
  // Ноль упаковок допустим, только когда есть штуки (граммы): пустая строка — отказ
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 0, cost: 90 }] }), 400, 'Укажите количество: Нурофен')
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 0, pieces: -1, cost: 90 }] }), 400, 'items.0.pieces: не меньше 0')
  refused(() => createArrival(ctx(db), { items: [{ productId: 'nur', qty: 1, cost: -1 }] }), 400, 'items.0.cost: не меньше 0')
  assert.equal(outbox(db).length, 0)
  // Поставщик не указан — прочерк, как на сервере
  assert.equal(createArrival(ctx(db), { items: [{ productId: 'bint', qty: 1, cost: 5 }] }).supplier, '—')
})

test('приход весового товара: граммы сверх целых килограммов, цена долей, долг поставщику', () => {
  // Сахар: 5 кг по 10 с/кг на полке. Привезли 12,350 кг по 8 сомони за килограмм
  const sahar = product({ id: 'sahar', name: 'Сахар', category: 'Перевязка', unit: 'кг', unitsPerPack: 1000, price: 12, cost: 10, stock: 5, expiryDate: null })
  const db = pharmacy({ products: [sahar], suppliers: SUPPLIERS.map((s) => ({ ...s })) })
  const arrival = createArrival(ctx(db), {
    supplierId: 'sup-1',
    debt: 50,
    items: [{ productId: 'sahar', qty: 12, pieces: 350, cost: 8 }],
  })
  // 12,35 кг × 8 = 98,80; в долг — 50
  assert.equal(arrival.total, 98.8)
  assert.equal(arrival.debt, 50)
  assert.deepEqual(arrival.items.map((i) => [i.qty, i.pieces]), [[12, 350]])
  const p = productsList(db, NOW).find((x) => x.id === 'sahar')
  // Остаток: 5 кг + 12,350 кг = 17 кг и 350 г
  assert.deepEqual([p.stock, p.looseUnits], [17, 350])
  // Средняя цена килограмма: (5 × 10 + 98,8) / 17,35 = 8,576… → 8,58
  assert.equal(p.cost, 8.58)
  // Серверу уходит та же строка с граммами
  const op = outbox(db).at(-1)
  assert.deepEqual(op.payload.arrival.items.map((i) => [i.qty, i.pieces]), [[12, 350]])
})

test('приход «из кассы»: деньги уходят из открытой смены, без смены и поставщика — отказ', () => {
  const { db } = apteka({ suppliers: SUPPLIERS.map((s) => ({ ...s })) })
  // Без открытой смены из кассы взять нечего
  refused(
    () => createArrival(ctx(db), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 105, items: [{ productId: 'bint', qty: 21, cost: 5 }] }),
    400,
    'Нет открытой смены — из кассы взять нечего.',
  )
  // Без поставщика из справочника оплату записать некому
  openShift(ctx(db), { openingCash: 500 })
  refused(
    () => createArrival(ctx(db), { payMethod: 'cash', paidCash: 105, items: [{ productId: 'bint', qty: 21, cost: 5 }] }),
    400,
    'Для оплаты из кассы выберите поставщика из справочника',
  )
  // Больше стоимости прихода из ящика не взять
  refused(
    () => createArrival(ctx(db), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 200, items: [{ productId: 'bint', qty: 21, cost: 5 }] }),
    400,
    'Из кассы оплачено больше, чем стоит приход без долга',
  )

  const arrival = createArrival(ctx(db), { supplierId: 'sup-1', payMethod: 'cash', paidCash: 105, items: [{ productId: 'bint', qty: 21, cost: 5 }] })
  assert.equal(arrival.payMethod, 'cash')
  assert.equal(arrival.paidCash, 105)
  assert.ok(arrival.shiftId, 'оплата привязана к открытой смене')
  // Серверу уходит та же оплата — он запишет её оплатой поставщику
  const op = outbox(db).at(-1)
  assert.equal(op.payload.arrival.paidCash, 105)
  assert.equal(op.payload.arrival.shiftId, arrival.shiftId)

  // Закрытие смены: 500 на старте − 105 поставщику = 395 ожидается
  const closed = closeShift(ctx(db), { countedCash: 395 })
  assert.equal(closed.supplierCash, 105)
  assert.equal(closed.expectedCash, 395)
  assert.equal(closed.difference, 0)
})

test('приход: товар с новым сроком сразу продаётся, а ближайший срок в карточке обновляется', () => {
  const { db } = apteka()
  createArrival(ctx(db), { items: [{ productId: 'nur', qty: 2, cost: 100, expiryDate: '2026-12-01' }] })
  const nur = productsList(db, NOW).find((p) => p.id === 'nur')
  assert.equal(nur.stock, 7)
  assert.equal(nur.expiryDate, day('2026-12-01'), 'в карточке должен стоять ближайший срок')
  // Первой продаётся только что пришедшая партия — у неё срок ближе
  checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 2 }] })
  assert.equal(productsList(db, NOW).find((p) => p.id === 'nur').expiryDate, day('2027-06-30'))
})

// ── Смена ──

test('смена: открытие, привязка чеков, итоги при закрытии', () => {
  const { db } = apteka()
  const c = ctx(db)
  refused(() => closeShift(c, { countedCash: 0 }), 400, 'Нет открытой смены')

  const shift = openShift(c, { openingCash: 100 })
  assert.equal(shift.openingCash, 100)
  assert.equal(shift.closedAt, null)
  assert.equal(shift.countedCash, null)
  assert.deepEqual(shift.user, { id: 'user-1', name: 'kassir' })
  refused(() => openShift(c, { openingCash: 0 }), 400, 'Смена уже открыта')

  const s1 = checkout(c, {
    payment: 'cash',
    items: [
      { productId: 'par', qty: 1, pieces: 5, discount: 10 },
      { productId: 'nur', qty: 2 },
    ],
  })
  checkout(c, { payment: 'card', items: [{ productId: 'nur', qty: 1 }] })
  checkout(c, { payment: 'debt', customerId: 'ivan', items: [{ productId: 'bint', qty: 2 }] })
  assert.equal(s1.shiftId, shift.id)

  payDebt(c, 'ivan', { amount: 15 })
  createReturn(c, { saleId: s1.id, items: [{ productId: 'par', units: 5 }] })

  const closed = closeShift({ ...c, now: NOW + 3600_000 }, { countedCash: 600 })
  assert.equal(closed.id, shift.id)
  assert.equal(closed.closedAt, new Date(NOW + 3600_000).toISOString())
  assert.deepEqual(
    {
      countedCash: closed.countedCash,
      totalSales: closed.totalSales,
      salesCash: closed.salesCash,
      salesCard: closed.salesCard,
      salesDebt: closed.salesDebt,
      debtPaid: closed.debtPaid,
      refundCash: closed.refundCash,
      refundTotal: closed.refundTotal,
      refundCost: closed.refundCost,
      profit: closed.profit,
      discount: closed.discount,
      count: closed.count,
      expectedCash: closed.expectedCash,
      difference: closed.difference,
    },
    {
      countedCash: 600,
      totalSales: 710,
      salesCash: 540,
      salesCard: 150,
      salesDebt: 20,
      debtPaid: 15,
      // Наличный возврат ушёл ИЗ кассы; вернувшийся на полку товар прибыль не уменьшает
      refundCash: 48,
      refundTotal: 48,
      refundCost: 30,
      profit: 248,
      discount: 10,
      count: 3,
      // 100 на начало + 540 наличными + 15 погашение − 48 возврат
      expectedCash: 607,
      difference: -7,
    },
  )
  assert.deepEqual(Object.keys(closed), [
    'id', 'openedAt', 'closedAt', 'openingCash', 'countedCash', 'totalSales', 'salesCash', 'salesCard', 'salesDebt', 'debtPaid',
    'refundCash', 'refundTotal', 'refundCost', 'expenseCash', 'cashIn', 'cashOut', 'supplierCash', 'salesTransfer', 'transferBy', 'profit',
    'discount', 'count', 'expectedCash', 'difference', 'userId', 'user',
  ])
  // Расходов из кассы за смену не было
  assert.equal(closed.expenseCash, 0)

  // Закрытая смена остаётся в истории; новая открывается заново, чеки идут уже в неё
  assert.deepEqual(listShifts(db, 'kassa-1'), [closed])
  const next = openShift({ ...c, now: NOW + 7200_000 }, { openingCash: 0 })
  assert.equal(checkout({ ...c, now: NOW + 7300_000 }, { payment: 'cash', items: [{ productId: 'bint', qty: 1 }] }).shiftId, next.id)
  assert.deepEqual(outbox(db).map((o) => o.type), ['shift.open', 'sale', 'sale', 'sale', 'debt.pay', 'return', 'shift.close', 'shift.open', 'sale'])
})

test('смена: у каждой кассы своя, чужую открытую касса не видит', () => {
  const { db } = apteka()
  const first = ctx(db, { deviceId: 'kassa-1' })
  const second = ctx(db, { deviceId: 'kassa-2' })
  const mine = openShift(first, { openingCash: 10 })
  // Вторая касса на том же… на той же базе не бывает, но так проще показать правило:
  // открытая смена ищется по номеру кассы
  const other = openShift(second, { openingCash: 20 })
  assert.notEqual(mine.id, other.id)
  assert.deepEqual(listShifts(db, 'kassa-1').map((s) => s.id), [mine.id])
  assert.equal(checkout(first, { payment: 'cash', items: [{ productId: 'bint', qty: 1 }] }).shiftId, mine.id)
  assert.equal(checkout(second, { payment: 'cash', items: [{ productId: 'bint', qty: 1 }] }).shiftId, other.id)

  // Смена, открытая на сайте или другой кассе, приходит с сервера без номера кассы:
  // открытой её здесь не показываем, закрытой — показываем
  applySnapshot(
    db,
    {
      shifts: [
        { id: 'web-open', openedAt: '2026-10-04T05:00:00.000Z', closedAt: null, openingCash: 0, user: null },
        { id: 'web-closed', openedAt: '2026-10-03T05:00:00.000Z', closedAt: '2026-10-03T15:00:00.000Z', openingCash: 0, user: null },
      ],
    },
    { now: NOW },
  )
  assert.deepEqual(listShifts(db, 'kassa-1').map((s) => s.id), [mine.id, 'web-closed'])
})

// ── Клиенты и долги ──

test('погашение долга: не больше долга, с записью в журнал и привязкой к смене', () => {
  const { db } = apteka()
  const c = ctx(db)
  const shift = openShift(c, { openingCash: 0 })
  assert.equal(payDebt(c, 'ivan', { amount: 4 }).debt, 6)
  // Переплата в минус не уходит: гасится ровно остаток долга
  assert.equal(payDebt(c, 'ivan', { amount: 100 }).debt, 0)
  const payments = listDocs(db, 'payment')
  assert.deepEqual(payments.map((p) => p.amount).sort(), [4, 6])
  assert.ok(payments.every((p) => p.shiftId === shift.id && p.customerId === 'ivan' && p.customer.name === 'Иван'))
  assert.deepEqual(Object.keys(payments[0]), ['id', 'customerId', 'amount', 'shiftId', 'createdAt', 'customer'])

  // Долга нет — ничего не происходит: ни записи, ни операции
  const before = outbox(db).length
  assert.equal(payDebt(c, 'ivan', { amount: 5 }).debt, 0)
  assert.equal(listDocs(db, 'payment').length, 2)
  assert.equal(outbox(db).length, before)

  refused(() => payDebt(c, 'нет', { amount: 5 }), 404, 'Клиент не найден')
  refused(() => payDebt(c, 'ivan', { amount: 0 }), 400, 'Сумма: не меньше 0.01')
  refused(() => payDebt(c, 'ivan', {}), 400, 'Сумма: только число')
})

test('новый клиент, заведённый без связи, не пропадает после сверки с сервером', () => {
  const { db, ivan } = apteka()
  const c = ctx(db)
  const petr = createCustomer(c, { name: 'Пётр', phone: '900', debt: 25.5 })
  assert.deepEqual(Object.keys(petr), ['id', 'name', 'phone', 'debt', 'createdAt'])
  assert.equal(petr.debt, 25.5)
  checkout(c, { payment: 'debt', customerId: petr.id, items: [{ productId: 'nur', qty: 1 }] })
  checkout(c, { payment: 'debt', customerId: 'ivan', items: [{ productId: 'bint', qty: 1 }] })

  // Сервер присылает свой список: Петра в нём ещё нет, а у Ивана долг погасили на сайте
  applySnapshot(db, { customers: [{ ...ivan, debt: 0 }] }, { now: NOW })
  const list = customersList(db)
  assert.deepEqual(
    list.map((x) => [x.name, x.debt]),
    [
      ['Пётр', 175.5],
      ['Иван', 10],
    ],
    'долг = что сказал сервер + сделанное здесь и ещё не отправленное',
  )

  // Сервер узнал о Петре (операции приняты) — запись становится обычной
  db.prepare('UPDATE debt_moves SET synced = 1').run()
  applySnapshot(db, { customers: [{ ...ivan, debt: 10 }, { ...petr, debt: 175.5 }] }, { now: NOW })
  assert.equal(row(db, 'SELECT local FROM customers WHERE id = ?', petr.id).local, 0)
  assert.equal(customersList(db).find((x) => x.id === petr.id).debt, 175.5)

  refused(() => createCustomer(c, {}), 400, 'Название: только текст')
  assert.equal(createCustomer(c, { name: 'Без долга' }).debt, 0)
  assert.equal(createCustomer(c, { name: 'Минус', debt: 0 }).phone, '')
})

// ── Отложенные штрихкоды ──

test('отложенные штрихкоды: добавить, не задвоить, убрать — и не «воскресить» при сверке', () => {
  const { db } = apteka({ deferred: [{ id: 'd-srv', barcode: '4600000000001', createdAt: '2026-10-01T00:00:00.000Z' }] })
  const c = ctx(db)
  const added = addDeferred(c, { barcode: '  4607001234567 ' })
  assert.equal(added.barcode, '4607001234567')
  assert.deepEqual(Object.keys(added), ['id', 'barcode', 'createdAt'])
  // Повтор ничего не меняет
  assert.deepEqual(addDeferred(c, { barcode: '4607001234567' }), added)
  assert.equal(addDeferred(c, { barcode: '4600000000001' }).id, 'd-srv')
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['4607001234567', '4600000000001'])
  refused(() => addDeferred(c, { barcode: '12' }), 400, 'Штрихкод: не короче 3 символов')
  // Пробелы по краям в длину не идут — как у сервера: он такой штрихкод отверг бы
  refused(() => addDeferred(c, { barcode: '  12 ' }), 400, 'Штрихкод: не короче 3 символов')
  refused(() => addDeferred(c, { barcode: 4607001234567 }), 400, 'Штрихкод: только текст')
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['4607001234567', '4600000000001'])

  // Убрали штрихкод, который знает сервер. Сервер об удалении ещё не слышал и снова
  // присылает его — в списке он появляться не должен
  assert.deepEqual(removeDeferred(c, 'd-srv'), { ok: true })
  applySnapshot(db, { deferred: [{ id: 'd-srv', barcode: '4600000000001', createdAt: '2026-10-01T00:00:00.000Z' }] }, { now: NOW })
  assert.deepEqual(deferredList(db).map((d) => d.barcode), ['4607001234567'])

  // Другая касса отложила тот же штрихкод, что и мы: показываем один раз
  applySnapshot(db, { deferred: [{ id: 'd-other', barcode: '4607001234567', createdAt: '2026-10-04T09:00:00.000Z' }] }, { now: NOW })
  assert.deepEqual(deferredList(db).map((d) => d.id), ['d-other'])

  // Убрать то, чего нет, — не ошибка
  assert.deepEqual(removeDeferred(c, 'нет-такого'), { ok: true })
  assert.deepEqual(outbox(db).map((o) => o.type), ['deferred.add', 'deferred.remove'])
})

// ── Документы и сверка с сервером ──

test('сверка с сервером заменяет его документы, а неотправленные свои оставляет', () => {
  const { db } = apteka()
  const mine = checkout(ctx(db), { payment: 'cash', items: [{ productId: 'nur', qty: 1 }] })
  const fromServer = (id, date) => ({ id, clientId: null, date, total: 1, cost: 0, profit: 1, payment: 'cash', items: [], customer: null, user: null })
  applySnapshot(db, { sales: [fromServer('s1', '2026-10-01T00:00:00.000Z'), fromServer('s2', '2026-10-02T00:00:00.000Z')] }, { now: NOW })
  assert.deepEqual(listDocs(db, 'sale').map((s) => s.id), [mine.id, 's2', 's1'])

  // Следующая сверка: s1 на сервере удалили (откат копии) — у нас он тоже уходит,
  // а свой чек остаётся
  applySnapshot(db, { sales: [fromServer('s2', '2026-10-02T00:00:00.000Z')] }, { now: NOW })
  assert.deepEqual(listDocs(db, 'sale').map((s) => s.id), [mine.id, 's2'])

  // Сервер прислал наш же чек раньше, чем подтвердил операцию, — свою запись не
  // трогаем: вместе с ней в журнале лежат её движения
  applySnapshot(db, { sales: [{ ...fromServer(mine.id, mine.date), total: 999 }] }, { now: NOW })
  assert.equal(listDocs(db, 'sale').find((s) => s.id === mine.id).total, 150)
  assert.equal(row(db, 'SELECT sync FROM docs WHERE id = ?', mine.id).sync, 'pending')
})
