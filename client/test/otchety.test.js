// ── Отчёты: продажи, закупки, сверка с поставщиками, зарплата ──
//
// Эти числа владелец показывает бухгалтеру и поставщику, поэтому проверяется
// главное: итоги сходятся с документами до дирама, оплата прихода из кассы не
// считается дважды, долг на начало и конец периода сходится с нынешним долгом.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  qtyText, prodazhiPoTovaram, vseProdazhi, zakupkiIOplaty, sverkaPostavshikov,
  prodazhiSotrudnika, zarplataKVydache, mesyac, poslednieMesyacy, vPeriode,
  mesyacKluch, mesyacZarplaty, vydachiZaMesyac, vydanoZaMesyac, ostatokZarplaty,
} from '../src/lib/otchety.js'
import { priceFromMarkup, markupOf } from '../src/lib/pricing.js'
import { isVesovoy, isKg, edinica } from '../src/lib/units.js'

const D = (s) => new Date(s)
const products = [
  { id: 'par', name: 'Парацетамол', unitsPerPack: 20, unit: 'уп', category: 'Анальгетики' },
  { id: 'sah', name: 'Сахар', unitsPerPack: 1000, unit: 'кг', category: 'Продукты' },
  { id: 'mas', name: 'Масло на разлив', unitsPerPack: 1000, unit: 'л' },
  { id: 'rul', name: 'Обои', unitsPerPack: 1, unit: 'рулон' },
]

// ── Единицы ──
test('дробные единицы: кг, л, м, м²; весы — только килограммы', () => {
  assert.ok(isVesovoy({ unit: 'кг' }) && isVesovoy({ unit: 'л' }) && isVesovoy({ unit: 'м' }) && isVesovoy({ unit: 'м²' }))
  assert.ok(!isVesovoy({ unit: 'рулон' }) && !isVesovoy({ unit: 'уп' }) && !isVesovoy({}))
  assert.ok(isKg({ unit: 'кг' }) && !isKg({ unit: 'л' }))
  assert.equal(edinica({}), 'уп')
  assert.equal(edinica({ unit: 'рулон' }), 'рулон')
})

test('количество текстом в своей единице', () => {
  assert.equal(qtyText(43, products[0]), '2 уп + 3 шт')
  assert.equal(qtyText(2500, products[1]), '2,5 кг')
  assert.equal(qtyText(1500, products[2]), '1,5 л')
  assert.equal(qtyText(4, products[3]), '4 рулон')
  assert.equal(qtyText(0, products[0]), '0 уп')
})

// ── Наценка ──
test('цена от наценки — до дирама; наценка от цены — до сотых процента', () => {
  assert.equal(priceFromMarkup(100, 25), 125)
  assert.equal(priceFromMarkup('13.37', '25'), 16.71)
  assert.equal(priceFromMarkup('10,5', '10'), 11.55)
  assert.equal(priceFromMarkup(0, 25), null, 'без закупки процент не от чего считать')
  assert.equal(priceFromMarkup(100, ''), null, 'пустой процент цену не трогает')
  assert.equal(markupOf(100, 125), '25')
  assert.equal(markupOf(80, 100), '25')
  assert.equal(markupOf(3, 4), '33.33')
  assert.equal(markupOf(0, 100), '')
  assert.equal(markupOf(100, 0), '')
})

// ── Продажи ──
const sales = [
  {
    id: 's1', date: '2026-10-05T07:00:00Z', total: 230, payment: 'cash', userId: 'u1', user: { id: 'u1', name: 'farhod' },
    items: [
      { productId: 'par', name: 'Парацетамол', qty: 1, pieces: 5, unitsPerPack: 20, price: 200, cost: 120, discount: 20 },
      { productId: 'sah', name: 'Сахар', qty: 0, pieces: 500, unitsPerPack: 1000, price: 10, cost: 6, discount: 0 },
    ],
  },
  {
    id: 's2', date: '2026-10-06T07:00:00Z', total: 200, payment: 'card', userId: 'u2', user: { id: 'u2', name: 'kassir' },
    items: [{ productId: 'par', name: 'Парацетамол', qty: 1, pieces: 0, unitsPerPack: 20, price: 200, cost: 120, discount: 0 }],
  },
  {
    id: 's0', date: '2026-09-20T07:00:00Z', total: 999, payment: 'cash', userId: 'u1',
    items: [{ productId: 'par', name: 'Парацетамол', qty: 5, pieces: 0, unitsPerPack: 20, price: 200, cost: 120, discount: 1 }],
  },
]
const okt = mesyac('2026-10')

test('продажи по товарам: количество, выручка после скидки, себестоимость, прибыль', () => {
  const r = prodazhiPoTovaram({ sales, products, from: okt.from, to: okt.to })
  const par = r.rows.find((x) => x.productId === 'par')
  // 1 уп + 5 шт = 25 шт по 10 = 250 − 20 скидки = 230; и ещё 1 уп = 200 → 430
  assert.equal(par.revenue, 430)
  assert.equal(par.cost, 270) // 25 × 6 + 20 × 6
  assert.equal(par.profit, 160)
  assert.equal(par.qty, '2 уп + 5 шт')
  const sah = r.rows.find((x) => x.productId === 'sah')
  assert.equal(sah.revenue, 5)
  assert.equal(sah.qty, '0,5 кг')
  assert.equal(r.itogo.revenue, 435)
  assert.equal(r.rows[0].productId, 'par', 'первым — товар с наибольшей выручкой')
})

test('все продажи построчно: строка на каждую позицию, новые сверху, итоги', () => {
  const r = vseProdazhi({ sales, products, from: okt.from, to: okt.to })
  assert.equal(r.rows.length, 3)
  assert.equal(r.rows[0].saleId, 's2')
  assert.equal(r.itogo.sum, 435)
  assert.equal(r.itogo.discount, 20)
  assert.equal(r.itogo.cheki, 2)
})

// ── Закупки и оплаты ──
const arrivals = [
  {
    id: 'a1', date: '2026-10-03T08:00:00Z', supplier: 'Опт-Маркет', supplierId: 'sup1', total: 300, debt: 100, user: { name: 'farhod' },
    items: [
      { productId: 'par', name: 'Парацетамол', qty: 2, pieces: 0, cost: 100 },
      { productId: 'sah', name: 'Сахар', qty: 2, pieces: 500, cost: 40 },
    ],
  },
  { id: 'a2', date: '2026-10-08T08:00:00Z', supplier: 'Опт-Маркет', supplierId: 'sup1', total: 400, debt: 400, items: [{ productId: 'rul', name: 'Обои', qty: 10, pieces: 0, cost: 40 }] },
  { id: 'a3', date: '2026-10-09T08:00:00Z', supplier: '—', supplierId: null, total: 50, debt: 0, items: [{ productId: 'rul', name: 'Обои', qty: 1, pieces: 0, cost: 50 }] },
]
const supplierPayments = [
  { id: 'p1', clientId: 'a1:pay', supplierId: 'sup1', amount: 200, date: '2026-10-03T08:00:00Z', supplier: { name: 'Опт-Маркет' } },
  { id: 'p2', supplierId: 'sup1', amount: 150, date: '2026-10-10T08:00:00Z', supplier: { name: 'Опт-Маркет' }, note: 'накладная 7' },
]

test('закупки: оплата и долг прихода делятся по строкам и сходятся с приходом до дирама', () => {
  const r = zakupkiIOplaty({ arrivals, supplierPayments, products, from: okt.from, to: okt.to })
  const a1 = r.rows.filter((x) => x.arrivalId === 'a1')
  assert.equal(a1.length, 2)
  assert.equal(a1.reduce((s, x) => s + x.sum, 0), 300)
  assert.equal(Math.round(a1.reduce((s, x) => s + x.debt, 0) * 100) / 100, 100)
  assert.equal(Math.round(a1.reduce((s, x) => s + x.paid, 0) * 100) / 100, 200)
  assert.equal(a1.find((x) => x.name === 'Сахар').qty, '2,5 кг')
  assert.equal(a1.find((x) => x.name === 'Сахар').sum, 100)
})

test('закупки: оплата прихода из кассы не задваивается, погашение долга — отдельной строкой', () => {
  const r = zakupkiIOplaty({ arrivals, supplierPayments, products, from: okt.from, to: okt.to })
  const pays = r.rows.filter((x) => x.kind === 'pay')
  assert.equal(pays.length, 1, 'оплата «a1:pay» уже учтена в строках прихода')
  assert.equal(pays[0].paid, 150)
  assert.equal(pays[0].debt, -150)
  assert.match(pays[0].name, /накладная 7/)
  // Итоги: закуплено 750, оплачено 200 + 0 + 50 + 150 = 400, долг 100 + 400 − 150 = 350
  assert.equal(r.itogo.sum, 750)
  assert.equal(r.itogo.paid, 400)
  assert.equal(r.itogo.debt, 350)
})

test('закупки: фильтр по поставщику и по периоду', () => {
  const r = zakupkiIOplaty({ arrivals, supplierPayments, products, from: D('2026-10-08T00:00:00Z'), to: okt.to, supplierId: 'sup1' })
  assert.deepEqual(r.rows.map((x) => x.id), ['pay:p2', 'a2:0'])
})

// ── Сверка ──
test('сверка: долг на начало и конец сходится с нынешним долгом поставщика', () => {
  // Нынешний долг sup1: начальный 50 + 100 (a1) + 400 (a2) − 150 (p2) = 400
  const suppliers = [{ id: 'sup1', name: 'Опт-Маркет', debt: 400 }]
  const r = sverkaPostavshikov({ suppliers, arrivals, supplierPayments, from: okt.from, to: okt.to })
  const s = r.rows.find((x) => x.supplierId === 'sup1')
  assert.equal(s.nachalo, 50)
  assert.equal(s.zakupleno, 700)
  assert.equal(s.oplacheno, 350) // 200 сразу + 150 долга
  assert.equal(s.konec, 400)
  assert.equal(s.konec, s.nachalo + s.zakupleno - s.oplacheno)
  const bez = r.rows.find((x) => !x.supplierId)
  assert.equal(bez.zakupleno, 50)
  assert.equal(bez.konec, 0, 'у прихода без поставщика долга нет')
})

test('сверка: период в прошлом — движения после него не попадают, но конец считается верно', () => {
  const suppliers = [{ id: 'sup1', name: 'Опт-Маркет', debt: 400 }]
  // Период до 09.10: a2 (08.10) внутри, p2 (10.10) — после
  const r = sverkaPostavshikov({ suppliers, arrivals, supplierPayments, from: okt.from, to: D('2026-10-09T00:00:00Z') })
  const s = r.rows.find((x) => x.supplierId === 'sup1')
  assert.equal(s.konec, 550) // 400 сейчас + 150 оплачено после периода
  assert.equal(s.nachalo, 50)
  assert.equal(s.oplacheno, 200)
})

// ── Зарплата ──
test('зарплата: оклад + процент от продаж сотрудника за месяц', () => {
  const s = prodazhiSotrudnika(sales, 'u1', okt.from, okt.to)
  assert.equal(s, 230, 'чек сентября в октябрьский бонус не входит')
  assert.deepEqual(zarplataKVydache({ salary: 3000, bonusPercent: 2, salesSum: 45000 }), { salary: 3000, bonus: 900, total: 3900 })
  assert.deepEqual(zarplataKVydache({ salary: 0, bonusPercent: 2.5, salesSum: 333 }), { salary: 0, bonus: 8.33, total: 8.33 })
  assert.equal(prodazhiSotrudnika(sales, '', okt.from, okt.to), 0)
})

test('месяцы по таджикскому времени', () => {
  const m = mesyac('2026-10')
  assert.equal(m.from.toISOString(), '2026-09-30T19:00:00.000Z')
  assert.equal(m.to.toISOString(), '2026-10-31T19:00:00.000Z')
  assert.ok(vPeriode('2026-10-31T18:59:59Z', m.from, m.to))
  assert.ok(!vPeriode('2026-10-31T19:00:00Z', m.from, m.to))
  assert.deepEqual(poslednieMesyacy(3, D('2026-01-15T10:00:00Z')), ['2026-01', '2025-12', '2025-11'])
})

// ── Зарплата частями ──
const vydachi = [
  { id: 'e1', employeeId: 'u1', amount: 1000, salaryMonth: '2026-10', date: '2026-10-15T06:00:00Z' },
  // Остаток за октябрь выдан уже в ноябре — это всё равно октябрьская зарплата
  { id: 'e2', employeeId: 'u1', amount: 800, salaryMonth: '2026-10', date: '2026-11-03T06:00:00Z' },
  // Старая выдача, месяц не записан: 1 октября 01:00 по Душанбе — октябрь
  { id: 'e3', employeeId: 'u1', amount: 500, salaryMonth: '', date: '2026-09-30T20:00:00Z' },
  { id: 'e4', employeeId: 'u2', amount: 700, salaryMonth: '2026-10', date: '2026-10-15T06:00:00Z' },
  { id: 'e5', employeeId: null, amount: 300, salaryMonth: '', date: '2026-10-15T06:00:00Z' },
]

test('зарплата частями: месяц выдачи — записанный, а у старых выдач — месяц их даты', () => {
  assert.equal(mesyacKluch('2026-09-30T19:00:00Z'), '2026-10', 'полночь по Душанбе — уже октябрь')
  assert.equal(mesyacKluch('2026-09-30T18:59:00Z'), '2026-09')
  assert.equal(mesyacZarplaty(vydachi[1]), '2026-10', 'выдача в ноябре за октябрь')
  assert.equal(mesyacZarplaty(vydachi[2]), '2026-10')
  assert.equal(mesyacZarplaty({ salaryMonth: 'октябрь', date: '2026-11-03T06:00:00Z' }), '2026-11', 'непонятный месяц — месяц даты')
})

test('зарплата частями: сколько уже выдано за месяц', () => {
  assert.equal(vydanoZaMesyac(vydachi, 'u1', '2026-10'), 2300)
  assert.equal(vydanoZaMesyac(vydachi, 'u1', '2026-11'), 0, 'выдача в ноябре за октябрь в ноябрь не попадает')
  assert.equal(vydanoZaMesyac(vydachi, 'u2', '2026-10'), 700)
  assert.equal(vydanoZaMesyac(vydachi, 'u1', '2026-10', 'e2'), 1500, 'выдачу, которую правят, в «уже выдано» не считаем')
  assert.equal(vydanoZaMesyac(vydachi, '', '2026-10'), 0)
  assert.deepEqual(vydachiZaMesyac(vydachi, 'u1', '2026-10').map((e) => e.id), ['e3', 'e1', 'e2'], 'старые сверху')
  assert.equal(vydanoZaMesyac([{ employeeId: 'u1', amount: 0.1, salaryMonth: '2026-10' }, { employeeId: 'u1', amount: 0.2, salaryMonth: '2026-10' }], 'u1', '2026-10'), 0.3, 'до дирама')
})

test('зарплата частями: осталось выдать или выдано сверх', () => {
  assert.deepEqual(ostatokZarplaty(2000, 1800), { ostalos: 200, pereplata: 0 })
  assert.deepEqual(ostatokZarplaty(2000, 2000), { ostalos: 0, pereplata: 0 })
  assert.deepEqual(ostatokZarplaty(2000, 2100.5), { ostalos: 0, pereplata: 100.5 })
  assert.deepEqual(ostatokZarplaty(0, 0), { ostalos: 0, pereplata: 0 })
  assert.deepEqual(ostatokZarplaty(3900.33, 0.33), { ostalos: 3900, pereplata: 0 })
})
