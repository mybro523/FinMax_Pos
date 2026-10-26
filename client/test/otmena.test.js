// ── Отмена чека и отчёт «Чеки» ──
// Отмена в кассе — это возврат всего чека с пометкой «Отмена чека». Ошибка здесь видна
// сразу в деньгах: вернули не тем способом, не всё или не тому клиенту. Отчёт «Чеки»
// показывает отменённый чек с отметкой, но в итоги его не берёт — продажи не было.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { OTMENA_CHEKA, isOtmena, otmenaVozvrat, otmenennyeCheki } from '../src/lib/otmena.js'
import { spisokChekov, chekPodhodit } from '../src/lib/otchety.js'
import { poiskZapros } from '../src/lib/poisk.js'
import { shiftTicket, saleTicket } from '../src/lib/ticket.js'

const saleTicketOf = (s, opts) => saleTicket(s, { t, money: (n) => String(n), when: (d) => String(d), pharmacy: 'Пайкар', nomer: '1026-100000', ...opts })
import { setLang, translate as t } from '../src/lib/i18n.js'

const items = [
  { productId: 'p1', name: 'Нурофен', qty: 2, pieces: 0, unitsPerPack: 1, unit: 'уп', price: 150, cost: 100, discount: 0 },
  { productId: 'p2', name: 'Парацетамол', qty: 0, pieces: 5, unitsPerPack: 20, unit: 'уп', price: 200, cost: 120, discount: 5 },
  { productId: 'p3', name: 'Мука', qty: 1, pieces: 500, unitsPerPack: 1000, unit: 'кг', price: 10, cost: 7, discount: 0 },
]
const sale = { id: 's1', date: '2026-10-26T10:00:00Z', payment: 'cash', total: 360, items, user: { name: 'Нилуфар' } }

test('отмена: все позиции целиком и на полку, деньги — тем же способом, с пометкой', () => {
  const v = otmenaVozvrat(sale)
  assert.equal(v.saleId, 's1')
  assert.equal(v.refund, 'cash')
  assert.equal(v.note, OTMENA_CHEKA)
  assert.equal(v.total, 360)
  assert.deepEqual(v.lines.map((l) => [l.productId, l.units, l.restock]), [['p1', 2, true], ['p2', 5, true], ['p3', 1500, true]])
  // Сумма строки — то, что за неё заплатили (со скидкой)
  assert.equal(v.lines[1].amount, 45)
  assert.equal(v.refundVia, '')
  assert.equal(v.customerId, '')
})

test('отмена: карта — на карту, перевод — тем же сервисом, в долг — долг этого клиента', () => {
  assert.equal(otmenaVozvrat({ ...sale, payment: 'card' }).refund, 'card')
  const tr = otmenaVozvrat({ ...sale, payment: 'transfer', payVia: 'Алиф' })
  assert.deepEqual([tr.refund, tr.refundVia], ['transfer', 'Алиф'])
  assert.equal(otmenaVozvrat({ ...sale, payment: 'debt', customerId: 'c7' }).customerId, 'c7')
  assert.equal(otmenaVozvrat({ ...sale, payment: 'debt', customer: { id: 'c8', name: 'Иван' } }).customerId, 'c8')
  // Непонятный способ — наличными, как у сервера
  assert.equal(otmenaVozvrat({ ...sale, payment: 'бартер' }).refund, 'cash')
  // Строка без товара (удалённый товар) или без количества вернуть нельзя — её нет
  const v = otmenaVozvrat({ ...sale, items: [...items, { productId: null, name: 'x', qty: 1 }, { productId: 'p9', name: 'y', qty: 0, pieces: 0 }] })
  assert.equal(v.lines.length, 3)
})

test('пометка отмены и отменённые чеки', () => {
  assert.equal(isOtmena({ note: OTMENA_CHEKA }), true)
  assert.equal(isOtmena({ note: 'Возврат покупателя' }), false)
  assert.equal(isOtmena(null), false)
  const set = otmenennyeCheki([{ saleId: 's1', note: OTMENA_CHEKA }, { saleId: 's2', note: '' }, { saleId: null, note: OTMENA_CHEKA }])
  assert.deepEqual([...set], ['s1'])
})

const sales = [
  sale,
  { id: 's2', date: '2026-10-26T11:00:00Z', payment: 'debt', total: 300, customer: { name: 'Бунёд' }, items: [items[0]], user: { name: 'Фарход' } },
  { id: 's3', date: '2026-10-26T12:00:00Z', payment: 'card', total: 45, items: [items[1]], user: { name: 'Нилуфар' } },
  { id: 's0', date: '2026-10-20T12:00:00Z', payment: 'cash', total: 99, items: [items[0]] }, // вне периода
]
const returns = [
  { id: 'r1', saleId: 's2', note: OTMENA_CHEKA, total: 300, date: '2026-10-26T11:01:00Z', refund: 'debt', items: [] },
  // Возврат части чека через неделю — после конца периода, но к чеку относится
  { id: 'r2', saleId: 's3', note: '', total: 20, date: '2026-11-02T09:00:00Z', refund: 'card', items: [] },
]
const from = new Date('2026-10-26T00:00:00Z')
const to = new Date('2026-10-27T00:00:00Z')

test('отчёт «Чеки»: чек — строка, новые сверху; отменённый — с отметкой и без итогов; возврат — суммой', () => {
  const r = spisokChekov({ sales, returns, from, to })
  assert.deepEqual(r.rows.map((x) => x.id), ['s3', 's2', 's1'])
  const [c3, c2, c1] = r.rows
  assert.deepEqual([c1.cashier, c1.payment, c1.positions, c1.discount, c1.total], ['Нилуфар', 'cash', 3, 5, 360])
  assert.equal(c2.customer, 'Бунёд')
  assert.equal(c2.otmena?.id, 'r1')
  assert.equal(c3.vozvrat, 20)
  assert.equal(c3.otmena, null)
  // Итог — без отменённого чека
  assert.deepEqual(r.itogo, { cheki: 2, sum: 405, otmeneno: 1 })
})

test('поиск чека: по номеру (с чёрточкой и без), товару, штрихкоду, клиенту и кассиру', () => {
  const r = spisokChekov({ sales, returns, from, to }).rows.find((x) => x.id === 's2')
  const kody = new Map([['p1', '4870204010060']])
  const nomer = '1026-160000'
  const ok = (q) => chekPodhodit(poiskZapros(q), r, nomer, kody)
  assert.equal(ok(''), true)
  assert.equal(ok('1026-16'), true)
  assert.equal(ok('1026160000'), true)
  assert.equal(ok('нурофен'), true)
  assert.equal(ok('4870204010060'), true)
  assert.equal(ok('бунёд'), true)
  assert.equal(ok('фарход'), true)
  assert.equal(ok('аспирин'), false)
  assert.equal(ok('9999'), false)
})

test('Z-отчёт: отмены чеков — строкой под возвратами; нет отмен — строки нет', () => {
  setLang('ru')
  const money = (n) => String(n) + ' с.'
  const shift = { openedAt: '2026-10-26T03:00:00Z', closedAt: '2026-10-26T15:00:00Z', count: 3, discount: 0 }
  const totals = { gross: 705, refunds: 320, netSales: 385, netProfit: 100 }
  const z = shiftTicket(shift, totals, { t, money, when: (d) => d, otmeny: { count: 1, total: 300 } })
  const labels = z.totals.map((r) => r.label)
  const at = labels.indexOf('Возвраты покупателям')
  assert.ok(at >= 0)
  assert.deepEqual(z.totals[at + 1], { label: '  в т.ч. отмены чеков (1)', value: '−300 с.' })
  const none = shiftTicket(shift, totals, { t, money, when: (d) => d, otmeny: { count: 0, total: 0 } })
  assert.ok(!none.totals.some((r) => r.label.includes('отмены')))
})

test('отмена: ключ повтора один на продажу — второе нажатие после обрыва получит тот же возврат', () => {
  assert.equal(otmenaVozvrat(sale).clientId, 'otmena:s1')
  assert.equal(otmenaVozvrat(sale).clientId, otmenaVozvrat({ ...sale }).clientId)
  assert.equal(otmenaVozvrat({ ...sale, id: undefined }).clientId, '')
})

test('строки с сервера без единицы: единица из карточки товара, у удалённого — по «штук в упаковке»', async () => {
  const { sEdinicami, edinicaStroki } = await import('../src/lib/units.js')
  const server = [
    { productId: 'p3', name: 'Мука', qty: 1, pieces: 500, unitsPerPack: 1000, price: 10 }, // весовой, без единицы
    { productId: 'pR', name: 'Обои', qty: 2, pieces: 0, unitsPerPack: 1, price: 50 }, // своя единица в карточке
    { productId: 'gone', name: 'Старый', qty: 0, pieces: 300, unitsPerPack: 1000, price: 5 }, // товара уже нет
    { productId: 'p1', name: 'Нурофен', qty: 1, pieces: 0, unitsPerPack: 1, unit: 'уп', price: 150 }, // единица уже есть
  ]
  const products = [{ id: 'p3', unit: 'кг' }, { id: 'pR', unit: 'рулон' }, { id: 'p1', unit: 'шт' }]
  assert.deepEqual(sEdinicami(server, products).map((i) => i.unit), ['кг', 'рулон', 'кг', 'уп'])
  assert.equal(edinicaStroki({ unitsPerPack: 20 }, null), 'уп')
  // Живая карточка без единицы и по 1000 в упаковке — обычные упаковки, не килограммы
  assert.equal(edinicaStroki({ unitsPerPack: 1000 }, { id: 'old', unit: '' }), 'уп')
  // Чек по такой строке — в килограммах, а не «1500 шт × 0,01»
  const { qtyPriceText } = await import('../src/lib/ticket.js')
  const money = (n) => String(n).replace('.', ',')
  assert.equal(qtyPriceText(sEdinicami(server, products)[0], t, money), '1,5 кг × 10')
})

test('повтор отменённого чека — с пометкой под датой', () => {
  setLang('ru')
  const tk = (opts) => saleTicketOf(sale, opts)
  assert.deepEqual(tk({ pometka: 'Чек отменён 26.10' }).head.slice(-1), ['Чек отменён 26.10'])
  assert.ok(!tk({}).head.includes(''), 'без пометки лишней строки нет')
})
