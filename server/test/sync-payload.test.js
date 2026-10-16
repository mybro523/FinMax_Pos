// ── Разбор операций, присланных кассой ──
//
// Программа для Windows присылает на сервер сделанное без интернета. Стоит она на
// чужом компьютере, и запрос от её имени может прислать кто угодно, у кого есть
// ключ входа. Поэтому всё, что приходит, разбирается заново — и в базу попадает
// только то, что прошло проверку. Здесь стережётся сама граница: что отвергается,
// а что приводится к безопасному виду.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  Reject,
  FOUNDER_ONLY,
  OP_TYPES,
  parseSale,
  parseReturn,
  parseWriteOff,
  parseArrival,
  parseShiftOpen,
  parseShiftClose,
  parseDebtPay,
  parseCustomer,
  parseDeferredAdd,
  parseDeferredRemove,
  parseExpense,
  parseCashMove,
  when,
} = require('../dist/sync/payload')

const NOW = Date.parse('2026-10-04T10:00:00.000Z')
const AT = '2026-10-04T09:00:00.000Z'
const ID = '11111111-2222-4333-8444-555555555555'

const sale = (over = {}, item = {}) => ({
  sale: {
    id: ID,
    clientId: 'tmp_abc',
    date: AT,
    total: 150,
    cost: 100,
    profit: 50,
    payment: 'cash',
    customerId: null,
    shiftId: null,
    items: [{ id: ID + '-i', productId: 'cmproduct1', name: 'Нурофен', qty: 1, pieces: 0, unitsPerPack: 1, price: 150, cost: 100, discount: 0, ...item }],
    ...over,
  },
})

const rejected = (fn, re) => assert.throws(fn, (e) => e instanceof Reject && (!re || re.test(e.message)), 'ожидался отказ по существу')

test('обычный чек кассы разбирается без потерь', () => {
  const s = parseSale(sale(), NOW)
  assert.equal(s.id, ID)
  assert.equal(s.clientId, 'tmp_abc')
  assert.equal(s.date.toISOString(), AT)
  assert.equal(s.payment, 'cash')
  assert.equal(s.total, 150)
  assert.deepEqual(s.items[0], {
    id: ID + '-i',
    productId: 'cmproduct1',
    name: 'Нурофен',
    qty: 1,
    pieces: 0,
    unitsPerPack: 1,
    price: 150,
    cost: 100,
    discount: 0,
  })
  // Прибыль бывает отрицательной (продали ниже закупки) — это не повод для отказа
  assert.equal(parseSale(sale({ profit: -20 }), NOW).profit, -20)
})

test('мусор вместо чека отвергается, а не роняет сервер', () => {
  for (const bad of [null, undefined, 'строка', 5, [], {}, { sale: null }, { sale: [] }, { sale: { id: ID } }]) {
    rejected(() => parseSale(bad, NOW))
  }
  rejected(() => parseSale(sale({ items: [] }), NOW), /позиц/i)
  rejected(() => parseSale(sale({ items: 'нет' }), NOW))
  rejected(() => parseSale(sale({ payment: 'биткоин' }), NOW))
  rejected(() => parseSale(sale({ date: 'вчера' }), NOW), /дата/i)
  // В чеке не может быть тысячи позиций — это уже не чек
  rejected(() => parseSale(sale({ items: Array.from({ length: 501 }, () => sale().sale.items[0]) }), NOW))
})

test('номера записей — только буквы, цифры и дефисы', () => {
  // Номер попадает в базу ключом записи. Кавычка, пробел или перевод строки
  // в нём — либо ошибка, либо попытка подсунуть в запрос своё
  for (const bad of ["x'; DROP TABLE \"Sale\"; --", 'a b', '', 'a'.repeat(65), 'ид/ключ', 'line\nbreak', 12345, null]) {
    rejected(() => parseSale(sale({ id: bad }), NOW), /номер/i)
  }
  rejected(() => parseSale(sale({}, { productId: '../../x' }), NOW))
  // Номера сервера (cuid) и кассы (UUID) проходят оба
  assert.equal(parseSale(sale({ id: 'cmuty94dn0004132q97r8nn2j' }), NOW).id, 'cmuty94dn0004132q97r8nn2j')
  // Клиента и смены может не быть вовсе
  assert.equal(parseSale(sale({ customerId: undefined, shiftId: '' }), NOW).shiftId, null)
})

test('деньги и количества: ни отрицательных, ни бесконечных, ни дробных упаковок', () => {
  for (const total of [-1, NaN, Infinity, '150', null, 1e13]) rejected(() => parseSale(sale({ total }), NOW), /сумм/i)
  for (const qty of [-1, 1.5, '1', NaN, 1e9]) rejected(() => parseSale(sale({}, { qty }), NOW), /количеств/i)
  rejected(() => parseSale(sale({}, { qty: 0, pieces: 0 }), NOW), /без количества/)
  rejected(() => parseSale(sale({}, { unitsPerPack: 0 }), NOW))
  rejected(() => parseSale(sale({}, { discount: -5 }), NOW))
  rejected(() => parseSale(sale({}, { price: -1 }), NOW))
  // Поштучная продажа без целых упаковок — нормальна
  assert.equal(parseSale(sale({}, { qty: 0, pieces: 3, unitsPerPack: 10 }), NOW).items[0].pieces, 3)
})

test('время операции: прошлое — как есть, будущее — не дальше «сейчас»', () => {
  assert.equal(when(AT, 'чек', NOW).toISOString(), AT)
  // Неделя без связи — обычное дело
  assert.equal(when('2026-09-27T09:00:00.000Z', 'чек', NOW).toISOString(), '2026-09-27T09:00:00.000Z')
  // Часы кассы спешат на минуту — терпимо
  assert.equal(when('2026-10-04T10:01:00.000Z', 'чек', NOW).toISOString(), '2026-10-04T10:01:00.000Z')
  // «Завтрашний» чек исказил бы отчёты: записываем нынешним моментом
  assert.equal(when('2026-10-05T10:00:00.000Z', 'чек', NOW).getTime(), NOW)
  rejected(() => when(undefined, 'чек', NOW))
  rejected(() => when(1759572000000, 'чек', NOW), /дата/i)
})

test('длинный текст обрезается, а не отвергается', () => {
  const s = parseSale(sale({}, { name: 'Я'.repeat(1000) }), NOW)
  assert.equal(s.items[0].name.length, 300)
  rejected(() => parseSale(sale({}, { name: 123 }), NOW))
})

test('возврат: позиции, способ возврата денег, списание непринятого товара', () => {
  const ret = {
    ret: {
      id: ID,
      clientId: 'ret_1',
      date: AT,
      saleId: 'cmsale1',
      shiftId: null,
      refund: 'debt',
      total: 48,
      note: 'вскрыта',
      items: [{ id: ID + '-r', productId: 'p1', name: 'Парацетамол', units: 5, unitsPerPack: 20, price: 200, cost: 120, amount: 48 }],
    },
    writeOff: {
      id: ID + '-w',
      note: 'списано при возврате',
      items: [{ id: ID + '-wi', productId: 'p1', name: 'Парацетамол', units: 5, cost: 120, expiryDate: '2027-01-31T00:00:00.000Z' }],
    },
  }
  const r = parseReturn(ret, NOW)
  assert.equal(r.refund, 'debt')
  assert.equal(r.items[0].restock, true, 'не сказано иначе — товар возвращается в продажу')
  // Срок с упаковки касса присылает, только если кассир его вписал
  assert.equal(r.items[0].expiryDate, null)
  const dated = parseReturn({ ret: { ...ret.ret, items: [{ ...ret.ret.items[0], expiryDate: '2027-05-31T00:00:00.000Z' }] } }, NOW)
  assert.equal(dated.items[0].expiryDate.toISOString(), '2027-05-31T00:00:00.000Z')
  rejected(() => parseReturn({ ret: { ...ret.ret, items: [{ ...ret.ret.items[0], expiryDate: '+020266-01-01T00:00:00.000Z' }] } }, NOW), /срок годности/)
  rejected(() => parseReturn({ ret: { ...ret.ret, items: [{ ...ret.ret.items[0], expiryDate: 'завтра' }] } }, NOW), /срок годности/)
  assert.equal(r.writeOff.items[0].expiryDate.toISOString(), '2027-01-31T00:00:00.000Z')
  assert.equal(parseReturn({ ...ret, writeOff: null }, NOW).writeOff, null)
  assert.equal(parseReturn({ ret: { ...ret.ret, saleId: null } }, NOW).saleId, null, 'возврат без чека допустим')

  rejected(() => parseReturn({ ret: { ...ret.ret, refund: 'золотом' } }, NOW))
  rejected(() => parseReturn({ ret: { ...ret.ret, items: [{ ...ret.ret.items[0], units: 0 }] } }, NOW), /количеств/i)
  rejected(() => parseReturn({ ret: { ...ret.ret, items: [{ ...ret.ret.items[0], amount: -1 }] } }, NOW))
  rejected(() => parseReturn({ ...ret, writeOff: { id: ID, items: [] } }, NOW))
})

test('списание и приход', () => {
  const w = parseWriteOff({ writeOff: { id: ID, date: AT, reason: 'damaged', note: 'бой' }, ask: [{ productId: 'p1', units: 3 }] }, NOW)
  assert.deepEqual(w.ask, [{ productId: 'p1', units: 3 }])
  assert.equal(parseWriteOff({ writeOff: { id: ID, date: AT }, ask: [{ productId: 'p1', units: 1 }] }, NOW).reason, 'expired')
  rejected(() => parseWriteOff({ writeOff: { id: ID, date: AT, reason: 'надоело' }, ask: [{ productId: 'p1', units: 1 }] }, NOW))
  rejected(() => parseWriteOff({ writeOff: { id: ID, date: AT }, ask: [] }, NOW))
  rejected(() => parseWriteOff({ writeOff: { id: ID, date: AT }, ask: [{ productId: 'p1', units: 0 }] }, NOW))

  const a = parseArrival(
    {
      arrival: { id: ID, date: AT, supplier: '', total: 390, items: [{ id: ID + '-a', productId: 'p1', name: 'Товар', qty: 3, cost: 130 }] },
      expiry: ['2028-01-31T00:00:00.000Z'],
    },
    NOW,
  )
  assert.equal(a.supplier, '—', 'поставщик не указан — прочерк, как на сайте')
  assert.equal(a.items[0].expiryDate.toISOString(), '2028-01-31T00:00:00.000Z')
  // Срока может не быть (бинты, приборы) — и списка сроков тоже
  const noDate = parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID + '-a', productId: 'p1', name: 'Бинт', qty: 1, cost: 5 }] } }, NOW)
  assert.equal(noDate.items[0].expiryDate, null)
  // Новая цена продажи из прихода: есть — доходит, нет — null (цена прежняя), мусор — отказ
  assert.equal(a.items[0].price, null)
  const priced = parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID + '-a', productId: 'p1', name: 'x', qty: 1, cost: 5, price: 6.25 }] } }, NOW)
  assert.equal(priced.items[0].price, 6.25)
  rejected(() => parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID, productId: 'p1', name: 'x', qty: 1, cost: 5, price: 'дорого' }] } }, NOW))
  rejected(() => parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID, productId: 'p1', name: 'x', qty: 0, cost: 5 }] } }, NOW))
  rejected(() => parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID, productId: 'p1', name: 'x', qty: 1, cost: 5 }] }, expiry: ['не дата'] }, NOW))
  // Лишняя цифра в годе. Для программы это настоящая дата, но база её не хранит:
  // дойди она до базы, операцию нельзя было бы записать никогда
  const withExpiry = (expiry) => parseArrival({ arrival: { id: ID, date: AT, total: 5, items: [{ id: ID, productId: 'p1', name: 'x', qty: 1, cost: 5 }] }, expiry: [expiry] }, NOW)
  for (const far of ['20266-01-01', '+020266-01-01T00:00:00.000Z', '275760-09-12', '-000001-01-01T00:00:00.000Z']) {
    rejected(() => withExpiry(far), /Недопустимая дата: срок годности/)
  }
  assert.equal(withExpiry('9999-12-31T00:00:00.000Z').items[0].expiryDate.toISOString(), '9999-12-31T00:00:00.000Z')
  assert.equal(withExpiry('0202-06-01').items[0].expiryDate.toISOString(), '0202-06-01T00:00:00.000Z', 'странный, но хранимый год — не повод терять приход')
})

test('смена, долг, клиент, отложенный штрихкод', () => {
  assert.deepEqual(parseShiftOpen({ shift: { id: ID, openedAt: AT, openingCash: 100 } }, NOW), { id: ID, openedAt: new Date(AT), openingCash: 100 })
  rejected(() => parseShiftOpen({ shift: { id: ID, openedAt: AT, openingCash: -1 } }, NOW))
  assert.equal(parseShiftClose({ shift: { id: ID, closedAt: AT, countedCash: 120.5 } }, NOW).countedCash, 120.5)
  rejected(() => parseShiftClose({ shift: { id: ID } }, NOW))

  assert.equal(parseDebtPay({ payment: { id: ID, customerId: 'c1', amount: 30, shiftId: null, createdAt: AT } }, NOW).amount, 30)
  rejected(() => parseDebtPay({ payment: { id: ID, customerId: 'c1', amount: 0, createdAt: AT } }, NOW), /больше нуля/)
  rejected(() => parseDebtPay({ payment: { id: ID, amount: 5, createdAt: AT } }, NOW))

  assert.equal(parseCustomer({ customer: { id: ID, name: 'Иван', createdAt: AT } }, NOW).debt, 0)
  rejected(() => parseCustomer({ customer: { id: ID, name: '   ', createdAt: AT } }, NOW), /имени/)

  assert.equal(parseDeferredAdd({ deferred: { id: ID, barcode: '  4600000000017 ', createdAt: AT } }, NOW).barcode, '4600000000017')
  rejected(() => parseDeferredAdd({ deferred: { id: ID, barcode: '12', createdAt: AT } }, NOW))
  assert.deepEqual(parseDeferredRemove({ id: ID, barcode: '4600000000017' }), { id: ID, barcode: '4600000000017' })
})

test('расход с кассы: сумма больше нуля, статья обязательна, «из кассы» — только явное «да»', () => {
  const expense = { id: ID, date: AT, category: ' Транспорт ', amount: 50, note: 'такси до склада', fromCash: true, shiftId: 'cmshift1' }
  assert.deepEqual(parseExpense({ expense }, NOW), {
    id: ID, date: new Date(AT), category: 'Транспорт', amount: 50, note: 'такси до склада', fromCash: true, shiftId: 'cmshift1', employeeId: null, salaryMonth: '',
  })
  // Зарплата с кассы: сотрудник доходит до сервера вместе с расходом
  assert.equal(parseExpense({ expense: { ...expense, category: 'Зарплата', employeeId: 'cmuser7' } }, NOW).employeeId, 'cmuser7')
  // ...и месяц, за который она выдана
  assert.equal(parseExpense({ expense: { ...expense, category: 'Зарплата', employeeId: 'cmuser7', salaryMonth: '2026-10' } }, NOW).salaryMonth, '2026-10')
  // Непонятный месяц операцию не роняет: деньги выданы, месяц просто не записан
  for (const bad of ['2026-13', '10.2026', 'октябрь', 202610, '2026-1'])
    assert.equal(parseExpense({ expense: { ...expense, category: 'Зарплата', employeeId: 'cmuser7', salaryMonth: bad } }, NOW).salaryMonth, '')
  // Обычный расход — без смены и без отметки
  const plain = parseExpense({ expense: { id: ID, date: AT, category: 'Аренда', amount: 3000 } }, NOW)
  assert.deepEqual([plain.fromCash, plain.shiftId, plain.note], [false, null, ''])
  // Отметка «из кассы» — только настоящее «да»: единица или строка ею не считаются
  assert.equal(parseExpense({ expense: { ...expense, fromCash: 1 } }, NOW).fromCash, false)
  assert.equal(parseExpense({ expense: { ...expense, fromCash: 'да' } }, NOW).fromCash, false)

  rejected(() => parseExpense({ expense: { ...expense, amount: 0 } }, NOW), /больше нуля/)
  rejected(() => parseExpense({ expense: { ...expense, amount: -5 } }, NOW), /сумма расхода/)
  rejected(() => parseExpense({ expense: { ...expense, amount: 99_999_999_999 } }, NOW), /сумма расхода/)
  rejected(() => parseExpense({ expense: { ...expense, amount: '50' } }, NOW), /сумма расхода/)
  rejected(() => parseExpense({ expense: { ...expense, category: '   ' } }, NOW), /не указана статья/)
  rejected(() => parseExpense({ expense: { ...expense, date: 'вчера' } }, NOW), /Недопустимая дата/)
  rejected(() => parseExpense({ expense: { ...expense, id: 'плохой номер' } }, NOW))
  rejected(() => parseExpense({}, NOW))
  // Длинное примечание обрезается, а не роняет операцию: расход уже случился
  assert.equal(parseExpense({ expense: { ...expense, note: 'я'.repeat(900) } }, NOW).note.length, 500)
})

test('оплата переводом: сервис обязателен, у других оплат его нет', () => {
  const t = parseSale(sale({ payment: 'transfer', payVia: ' Alif ' }), NOW)
  assert.deepEqual([t.payment, t.payVia], ['transfer', 'Alif'])
  assert.equal(parseSale(sale({ payment: 'cash', payVia: 'Alif' }), NOW).payVia, null)
  rejected(() => parseSale(sale({ payment: 'transfer' }), NOW), /сервис/)
  rejected(() => parseSale(sale({ payment: 'transfer', payVia: '   ' }), NOW), /сервис/)
  // Длинное название сервиса обрезается, а не роняет чек
  assert.equal(parseSale(sale({ payment: 'transfer', payVia: 'x'.repeat(80) }), NOW).payVia.length, 40)
})

test('приход в долг: поставщик и неоплаченная часть, не больше самого прихода', () => {
  const arrival = (over = {}) => ({
    arrival: { id: ID, date: AT, supplier: 'Опт', total: 100, items: [{ id: ID, productId: 'cmprod1', name: 'Нурофен', qty: 5, cost: 20 }], ...over },
    expiry: ['2028-01-31'],
  })
  const a = parseArrival(arrival({ supplierId: 'cmsup1', debt: 60 }), NOW)
  assert.deepEqual([a.supplierId, a.debt, a.total], ['cmsup1', 60, 100])
  // Прежняя касса долга не присылает — приход оплачен
  const old = parseArrival(arrival(), NOW)
  assert.deepEqual([old.supplierId, old.debt], [null, 0])
  rejected(() => parseArrival(arrival({ supplierId: 'cmsup1', debt: 100.5 }), NOW), /больше суммы прихода/)
  rejected(() => parseArrival(arrival({ supplierId: 'плохой номер', debt: 1 }), NOW))
  rejected(() => parseArrival(arrival({ debt: -1 }), NOW), /долг поставщику/)
})

test('внесение и изъятие наличных: смена, вид и сумма больше нуля', () => {
  const move = { id: ID, shiftId: 'cmshift1', kind: 'in', amount: 200, note: 'размен', date: AT }
  assert.deepEqual(parseCashMove({ move }, NOW), { id: ID, shiftId: 'cmshift1', kind: 'in', amount: 200, note: 'размен', date: new Date(AT) })
  assert.equal(parseCashMove({ move: { ...move, kind: 'out', note: undefined } }, NOW).note, '')
  rejected(() => parseCashMove({ move: { ...move, kind: 'sideways' } }, NOW), /вид операции/)
  rejected(() => parseCashMove({ move: { ...move, amount: 0 } }, NOW), /больше нуля/)
  rejected(() => parseCashMove({ move: { ...move, amount: -3 } }, NOW), /сумма/)
  rejected(() => parseCashMove({ move: { ...move, shiftId: null } }, NOW), /смена/)
  rejected(() => parseCashMove({ move: { ...move, date: 'вчера' } }, NOW), /дата/i)
  rejected(() => parseCashMove({}, NOW))
})

test('список операций закрыт, а списание и расход — только владельцу', () => {
  assert.deepEqual([...OP_TYPES].sort(), [
    'arrival', 'cash.move', 'customer.create', 'debt.pay', 'deferred.add', 'deferred.remove', 'expense', 'income', 'return', 'sale', 'shift.close', 'shift.open', 'writeoff',
  ])
  // Внести размен и отдать выручку может и кассир — как на сайте
  assert.equal(FOUNDER_ONLY.has('cash.move'), false)
  // На сайте списание закрыто для кассира. Касса без интернета не должна стать обходом
  assert.equal(FOUNDER_ONLY.has('writeoff'), true)
  // Расходы — деньги магазина: и на сайте, и на кассе их вносит только владелец
  assert.equal(FOUNDER_ONLY.has('expense'), true)
  assert.equal(FOUNDER_ONLY.has('sale'), false)
})
