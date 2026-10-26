// ── Долг клиента: история и выписка на руки ──
// Выписка должна сходиться: долг на начало + куплено − возвращено − погашено = текущий
// долг. Иначе клиент с бумагой в руках спросит, откуда взялась сумма, — и будет прав.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { istoriyaDolga, tovaryText } from '../src/lib/dolg.js'
import { OTMENA_CHEKA, isOtmena } from '../src/lib/otmena.js'
import { debtTicket } from '../src/lib/ticket.js'
import { setLang, translate as t } from '../src/lib/i18n.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString()
const money = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',') + ' с.'
const when = (d) => 'дата:' + new Date(d).toISOString().slice(0, 10)
const C = { id: 'c1', name: 'Бунёд', phone: '933625625', debt: 98.25 }

const items = [
  { productId: 'p1', name: 'Уголь', qty: 1, pieces: 0, unitsPerPack: 1, unit: 'уп', price: 18, discount: 0 },
  { productId: 'p2', name: 'Мука', qty: 1, pieces: 500, unitsPerPack: 1000, unit: 'кг', price: 10, discount: 0 },
]
const sales = [
  { id: 's1', date: day(1), payment: 'debt', customerId: 'c1', total: 148.25, items },
  { id: 's2', date: day(2), payment: 'debt', customer: { id: 'c1', name: 'Бунёд' }, total: 30, items: [items[0]] },
  { id: 's3', date: day(1), payment: 'debt', customerId: 'c2', total: 500, items }, // чужой клиент
  { id: 's4', date: day(1), payment: 'cash', customerId: null, total: 70, items }, // не в долг
]
const payments = [{ customerId: 'c1', amount: 50, createdAt: day(1) }, { customerId: 'c2', amount: 10, createdAt: day(1) }]
const returns = [
  { id: 'r1', saleId: 's2', refund: 'debt', total: 30, date: day(2), note: OTMENA_CHEKA, items: [{ name: 'Уголь', units: 1, unitsPerPack: 1, unit: 'уп' }] },
  { id: 'r2', saleId: 's4', refund: 'cash', total: 70, date: day(1), items: [] }, // деньгами из кассы — долг не трогает
  { id: 'r3', saleId: 's3', refund: 'debt', total: 100, date: day(1), items: [] }, // чек другого клиента
]

test('история: покупки в долг, отмены и возвраты в счёт долга, погашения — только этого клиента, новые сверху', () => {
  const h = istoriyaDolga({ customer: C, sales, payments, returns, now: NOW })
  // Новые сверху; в одну секунду покупка считается раньше своей отмены и погашения
  assert.deepEqual(h.events.map((e) => e.kind), ['pay', 'debt', 'return', 'debt'])
  assert.equal(h.totalCredit, 178.25)
  assert.equal(h.totalPaid, 50)
  assert.equal(h.totalReturned, 30)
  assert.equal(h.events.find((e) => e.kind === 'return').otmena, true, 'отмена чека отмечена')
  // Всё в пределах истории — долга на начало нет, и итог сходится сам
  assert.equal(h.opening, 0)
  assert.equal(h.debt, 98.25)
  assert.equal(h.opening + h.totalCredit - h.totalReturned - h.totalPaid, h.debt)
})

test('история старше устройства — одной строкой «Прежний долг до <даты>», выписка всё равно сходится', () => {
  const old = [...payments, { customerId: 'c1', amount: 999, createdAt: day(90) }] // старше 60 дней — не в истории
  const h = istoriyaDolga({ customer: { ...C, debt: 218.25 }, sales, payments: old, returns, now: NOW })
  assert.equal(h.events.length, 4)
  assert.equal(h.opening, 120)
  assert.equal(h.start.toISOString(), day(60))
  assert.equal(Math.round((h.opening + h.totalCredit - h.totalReturned - h.totalPaid) * 100) / 100, 218.25)
})

test('товары строкой: упаковки, штуки и дробные — в своей единице', () => {
  assert.equal(tovaryText(items, t), 'Уголь ×1\u00a0уп, Мука ×1,5\u00a0кг')
  assert.equal(tovaryText([{ name: 'Нурофен', units: 13, unitsPerPack: 10, unit: 'уп' }], t), 'Нурофен ×1\u00a0уп\u00a0+\u00a03\u00a0шт')
  assert.equal(tovaryText([], t), '')
  assert.equal(isOtmena({ note: ' Отмена чека ' }), true)
  assert.equal(isOtmena({ note: '' }), false)
})

test('выписка на руки: шапка, операции от старых к новым, итоги, внизу магазин', () => {
  setLang('ru')
  const h = istoriyaDolga({ customer: { ...C, debt: 218.25 }, sales, payments, returns, now: NOW })
  const tk = debtTicket({ ...C, debt: 218.25 }, h, {
    t, money, when, day: (d) => 'день:' + d.toISOString().slice(0, 10), pharmacy: 'Пайкар', now: NOW,
    tovary: (list) => tovaryText(list, t), nomer: (d) => 'N' + String(d).slice(8, 10),
  })
  assert.deepEqual(tk.head, ['Пайкар', 'Долг клиента', 'Бунёд', 'Тел. 933625625', 'дата:2026-10-26'])
  assert.equal(tk.head[tk.docAt], 'Долг клиента')
  // От старых к новым: покупка 2 дня назад, её отмена, покупка вчера, погашение
  assert.deepEqual(tk.rows.map((r) => r.name), ['Покупка в долг · Чек № N24', 'Отмена чека', 'Покупка в долг · Чек № N25', 'Погашение'])
  assert.deepEqual(tk.rows.map((r) => r.value), ['+30 с.', '−30 с.', '+148,25 с.', '−50 с.'])
  assert.equal(tk.rows[2].sub, 'дата:2026-10-25 · Уголь ×1\u00a0уп, Мука ×1,5\u00a0кг')
  assert.deepEqual(tk.totals, [
    { label: 'Прежний долг до день:2026-08-27', value: '120 с.' },
    { label: 'Куплено в долг', value: '178,25 с.' },
    { label: 'Возвращено', value: '30 с.' },
    { label: 'Погашено', value: '50 с.' },
    { label: 'Текущий долг', value: '218,25 с.', big: true },
  ])
  // Внизу — название магазина, жирным
  assert.equal(tk.tail.at(-1), 'Пайкар')
  assert.equal(tk.tail[tk.signAt], 'Пайкар')
})

test('выписка без долга на начало и без возвратов — лишних строк итогов нет; на таджикском — свои слова', () => {
  const h = istoriyaDolga({ customer: { ...C, debt: 98.25 }, sales: [sales[0]], payments, returns: [], now: NOW })
  setLang('tg')
  try {
    const tk = debtTicket(C, h, { t, money, when, pharmacy: 'Пайкар', now: NOW })
    assert.deepEqual(tk.totals.map((x) => x.label), [t('Куплено в долг'), t('Погашено'), t('Текущий долг')])
    assert.equal(tk.head[1], 'Қарзи мизоҷ')
  } finally {
    setLang('ru')
  }
})

test('строки с сервера без единицы — в истории в своей единице (кг из карточки товара)', () => {
  const serverSale = { id: 's9', date: day(1), payment: 'debt', customerId: 'c1', total: 15, items: [{ productId: 'p2', name: 'Мука', qty: 1, pieces: 500, unitsPerPack: 1000, price: 10, discount: 0 }] }
  const h = istoriyaDolga({ customer: { ...C, debt: 15 }, sales: [serverSale], products: [{ id: 'p2', unit: 'кг' }], now: NOW })
  assert.equal(tovaryText(h.events[0].items, t), 'Мука ×1,5\u00a0кг')
  // Без карточек: 1000 в упаковке — тоже килограммы
  const h2 = istoriyaDolga({ customer: { ...C, debt: 15 }, sales: [serverSale], now: NOW })
  assert.equal(tovaryText(h2.events[0].items, t), 'Мука ×1,5\u00a0кг')
})
