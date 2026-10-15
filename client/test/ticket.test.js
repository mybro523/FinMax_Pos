// Чек и Z-отчёт для чекового принтера: какие строки уйдут на ленту.
// Принтер печатает не картинку, а строки, — и собрать их надо теми же словами и
// числами, что кассир видит на экране. Разойдутся — покупатель получит чек,
// в котором сумма не та, что ему назвали.
import test from 'node:test'
import assert from 'node:assert/strict'
import { qtyPriceText, returnTicket, saleTicket, shiftTicket } from '../src/lib/ticket.js'
import { autoPrint, forgetPrintConfig, printTicket } from '../src/lib/print.js'
import { setLang, translate as t } from '../src/lib/i18n.js'

const money = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',') + ' с.'
const when = (iso) => 'дата:' + String(iso).slice(0, 10)
const opts = { t, money, when, pharmacy: 'Магазин №1', cashier: 'Нилуфар' }

const sale = {
  id: 's1',
  date: '2026-10-04T10:30:00.000Z',
  total: 345,
  payment: 'cash',
  received: 500,
  change: 155,
  customer: null,
  items: [
    { name: 'Нурофен', qty: 2, pieces: 0, unitsPerPack: 1, price: 150, discount: 0 },
    { name: 'Парацетамол', qty: 0, pieces: 5, unitsPerPack: 20, price: 200, discount: 5 },
  ],
}

test('количество и цена: упаковки — по цене упаковки, штуки — по цене штуки', () => {
  setLang('ru')
  assert.equal(qtyPriceText({ qty: 2, pieces: 0, unitsPerPack: 1, price: 150 }, t, money), '2 уп × 150 с.')
  assert.equal(qtyPriceText({ qty: 0, pieces: 5, unitsPerPack: 20, price: 200 }, t, money), '5 шт × 10 с.')
  // Упаковка и три штуки — всё в штуках: иначе перемножить нечего
  assert.equal(qtyPriceText({ qty: 1, pieces: 3, unitsPerPack: 10, price: 50 }, t, money), '13 шт × 5 с.')
})

test('чек продажи: шапка, позиции, скидка, итог, сдача, кассир', () => {
  setLang('ru')
  const ticket = saleTicket(sale, opts)
  assert.deepEqual(ticket.head, ['Магазин №1', 'дата:2026-10-04'])
  assert.deepEqual(ticket.rows, [
    { name: 'Нурофен', sub: '2 уп × 150 с.', value: '300 с.' },
    { name: 'Парацетамол', sub: '5 шт × 10 с. · скидка −5 с.', value: '45 с.' },
  ])
  assert.deepEqual(ticket.totals, [
    { label: 'Скидка', value: '−5 с.' },
    { label: 'Итого', value: '345 с.', big: true },
    { label: 'Оплата', value: 'Наличные' },
    { label: 'Получено', value: '500 с.' },
    { label: 'Сдача', value: '155 с.' },
  ])
  assert.deepEqual(ticket.tail, ['Кассир: Нилуфар', 'Спасибо за покупку!', 'FinMax POS'])
})

test('чек без скидки, картой и в долг: лишних строк нет, клиент назван', () => {
  setLang('ru')
  const card = saleTicket({ ...sale, payment: 'card', received: null, items: [sale.items[0]], total: 300 }, opts)
  assert.deepEqual(card.totals, [{ label: 'Итого', value: '300 с.', big: true }, { label: 'Оплата', value: 'Карта' }])
  const debt = saleTicket({ ...sale, payment: 'debt', received: undefined, customer: { name: 'Иван' }, items: [sale.items[0]], total: 300 }, opts)
  assert.deepEqual(debt.totals.slice(-2), [{ label: 'Оплата', value: 'В долг' }, { label: 'Клиент', value: 'Иван' }])
  // Магазин без названия и чек без кассира не роняют печать
  const bare = saleTicket({ date: sale.date, total: 0, payment: 'cash', items: [] }, { t, money, when })
  assert.deepEqual(bare.head, ['Магазин', 'дата:2026-10-04'])
  assert.deepEqual(bare.tail, ['Спасибо за покупку!', 'FinMax POS'])
})

const shift = {
  openedAt: '2026-10-04T03:00:00.000Z',
  closedAt: '2026-10-04T15:00:00.000Z',
  count: 12,
  salesCash: 900,
  salesCard: 300,
  salesDebt: 100,
  debtPaid: 0,
  discount: 15,
  openingCash: 100,
  refundCash: 0,
  expectedCash: 1000,
  countedCash: 995,
  difference: -5,
  user: { name: 'Нилуфар' },
  deviceName: 'Касса 2',
}

test('Z-отчёт: те же строки, что на экране; выручка и расхождение — крупно', () => {
  setLang('ru')
  const ticket = shiftTicket(shift, { gross: 1300, refunds: 0, netSales: 1300, netProfit: 400 }, opts)
  assert.deepEqual(ticket.head, ['Магазин №1', 'Z-отчёт смены', 'дата:2026-10-04 — дата:2026-10-04', 'Касса 2'])
  assert.deepEqual(ticket.rows, [])
  assert.deepEqual(ticket.totals.map((r) => r.label), [
    'Чеков', 'Наличными', 'Картой', 'В долг', 'Скидки', 'Выручка', 'Прибыль', 'Касса на старте', 'Ожидалось в кассе', 'Пересчитано (факт)', 'Расхождение',
  ])
  assert.deepEqual(ticket.totals.filter((r) => r.big).map((r) => [r.label, r.value]), [['Выручка', '1300 с.'], ['Расхождение', '-5 с.']])
  assert.deepEqual(ticket.tail, ['Кассир: Нилуфар', 'FinMax POS'])

  // Возвраты и погашения долга появляются, только когда они были
  const busy = shiftTicket({ ...shift, debtPaid: 50, refundCash: 30, difference: 10 }, { gross: 1300, refunds: 150, netSales: 1150, netProfit: 350 }, opts)
  const labels = busy.totals.map((r) => r.label)
  for (const need of ['Погашено долгов (нал.)', 'Продано за смену', 'Возвраты покупателям', 'Выдано за возвраты (нал.)']) assert.ok(labels.includes(need), need)
  assert.equal(busy.totals.at(-1).value, '+10 с.', 'излишек — с плюсом')
  assert.ok(!labels.includes('Расходы из кассы'), 'расходов из кассы не было — строки нет')

  // Расходы из кассы — отдельной строкой перед «Ожидалось»: иначе бумага не сходится
  const spent = shiftTicket({ ...shift, expenseCash: 45 }, { gross: 1300, refunds: 0, netSales: 1300, netProfit: 400 }, opts)
  const at = spent.totals.findIndex((r) => r.label === 'Расходы из кассы')
  assert.equal(spent.totals[at].value, '−45 с.')
  assert.equal(spent.totals[at + 1].label, 'Ожидалось в кассе')
})

test('на таджикском чек печатается таджикскими словами', () => {
  setLang('tg')
  try {
    const ticket = saleTicket(sale, opts)
    assert.equal(ticket.totals.find((r) => r.big).label, 'Ҳамагӣ')
    assert.equal(ticket.tail.at(-2), 'Ташаккур барои харид!')
    assert.equal(ticket.tail.at(-1), 'FinMax POS', 'имя программы не переводится')
    assert.equal(ticket.rows[0].sub, '2 қуттӣ × 150 с.')
  } finally {
    setLang('ru')
  }
})

test('реквизиты и номер чека: адрес, телефон и подпись попадают на чек, когда они заданы', () => {
  setLang('ru')
  const full = saleTicket(sale, {
    ...opts,
    rekvizity: { address: 'ул. Рудаки, 10', phone: '+992 900', footer: 'Будьте здоровы!' },
    nomer: '1004-103000',
  })
  assert.deepEqual(full.head, ['Магазин №1', 'ул. Рудаки, 10', 'Тел. +992 900', 'Чек № 1004-103000', 'дата:2026-10-04'])
  assert.equal(full.tail.at(-2), 'Спасибо за покупку!')
  assert.ok(full.tail.includes('Будьте здоровы!'), 'подпись владельца — в подвале')
  // Пустые реквизиты не оставляют пустых строк
  const empty = saleTicket(sale, { ...opts, rekvizity: { address: '', phone: '', footer: '' } })
  assert.deepEqual(empty.head, ['Магазин №1', 'дата:2026-10-04'])
})

test('продажа в долг: чек называет клиента и его новый долг', () => {
  setLang('ru')
  const debt = saleTicket(
    { ...sale, payment: 'debt', received: null, customer: { id: 'c1', name: 'Иван' } },
    { ...opts, customerDebt: 345 },
  )
  assert.deepEqual(debt.totals.slice(-2), [
    { label: 'Клиент', value: 'Иван' },
    { label: 'Долг клиента', value: '345 с.' },
  ])
  // При оплате наличными долг не печатается, даже если его передали
  const cash = saleTicket(sale, { ...opts, customerDebt: 345 })
  assert.ok(!cash.totals.some((r) => r.label === 'Долг клиента'))
})

const ret = {
  id: 'ret1',
  date: '2026-10-04T12:00:00.000Z',
  saleId: 's1',
  refund: 'cash',
  refundVia: '',
  total: 150,
  items: [
    { id: 'l1', name: 'Нурофен', units: 1, restock: true, amount: 150 },
    { id: 'l2', name: 'Парацетамол', units: 2, restock: false, amount: 0 },
  ],
}

test('чек возврата: позиции с пометкой «списано», сумма, способ и номер чека продажи', () => {
  setLang('ru')
  const ticket = returnTicket(ret, { ...opts, nomer: '1004-120000', saleNomer: '1004-103000' })
  assert.deepEqual(ticket.head, ['Магазин №1', 'Чек возврата № 1004-120000', 'дата:2026-10-04'])
  assert.deepEqual(ticket.rows, [
    { name: 'Нурофен', sub: '1 шт', value: '150 с.' },
    { name: 'Парацетамол', sub: '2 шт · списано', value: '0 с.' },
  ])
  assert.deepEqual(ticket.totals, [
    { label: 'Возвращено покупателю', value: '150 с.', big: true },
    { label: 'Способ возврата', value: 'Наличными из кассы' },
    { label: 'По чеку', value: '№ 1004-103000' },
  ])
  assert.deepEqual(ticket.tail, ['Кассир: Нилуфар', 'FinMax POS'])
  // Возврат переводом называет сервис; уменьшение долга — прямым текстом
  const via = returnTicket({ ...ret, refund: 'transfer', refundVia: 'Алиф' }, opts)
  assert.equal(via.totals[1].value, 'Возврат переводом · Алиф')
  const debt = returnTicket({ ...ret, refund: 'debt' }, opts)
  assert.equal(debt.totals[1].value, 'Уменьшен долг клиента')
})

// ── Куда уходит печать ──
// В проверках моста программы нет (это не окно программы), поэтому здесь —
// только то, что на сайте всё остаётся как было
test('на сайте чековых принтеров нет: печать идёт через окно печати, как раньше', async () => {
  forgetPrintConfig()
  let printed = 0
  assert.equal(await printTicket({ head: [] }, () => printed++), 'system')
  assert.equal(printed, 1)
  assert.equal(await autoPrint(), false, 'сам собой чек на сайте не печатается')
})
