// ── Фискальный принтер: сборка тела запроса и разбор ответа ──
// Деньги целые (дирамы). Главный инвариант чека: Σ products.sum == receiptSum ==
// receiptCash + receiptNonCash, и price*quantity == sum у каждой позиции.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closeShiftReq,
  fitCashier,
  fitExternalId,
  fitName,
  openShiftReq,
  parseReply,
  reconcile,
  saleReceipt,
  statusReq,
  vatInclusive,
} from '../src/local/fiskal/map.mjs'

const CFG = { taxType: 'GENERAL', vatCode: 'STANDARD', commodity: 'GOODS' }
const bytes = (s) => new TextEncoder().encode(s).length

test('НДС «внутри суммы»: sum * R / (100 + R), до дирама', () => {
  assert.equal(vatInclusive(11400, 'STANDARD'), 1400) // 14%: 11400 → ровно 1400
  assert.equal(vatInclusive(10000, 'STANDARD'), 1228) // 140000/114 = 1228.07 → 1228
  assert.equal(vatInclusive(10700, 'REDUCED1'), 700) // 7%: ровно 700
  assert.equal(vatInclusive(600, 'STANDARD'), 74) // 8400/114 = 73.68 → 74
  assert.equal(vatInclusive(1000, 'ZERO_TAX'), 0)
  assert.equal(vatInclusive(1000, 'ZERO_TAX_EXPORT'), 0)
})

test('имя товара — не длиннее 128 байт, режется по символу; пусто → «—»', () => {
  assert.equal(fitName('Хлеб'), 'Хлеб')
  assert.equal(fitName('  Хлеб   белый '), 'Хлеб белый')
  const long = 'А'.repeat(200) // 400 байт кириллицей
  const cut = fitName(long)
  assert.ok(bytes(cut) <= 128)
  assert.ok(cut.length >= 1 && long.startsWith(cut))
  assert.equal(fitName(''), '—')
  assert.equal(fitName(null), '—')
  assert.equal(fitCashier(''), 'Кассир')
  assert.ok(bytes(fitCashier('Я'.repeat(100))) <= 64)
})

test('externalId — до 36 знаков ASCII, пробелы и непечатное убраны', () => {
  assert.equal(fitExternalId('01929a40-da0c-76d5-8555-9aca1b87fbe5'), '01929a40-da0c-76d5-8555-9aca1b87fbe5')
  assert.equal(fitExternalId('a b\tc'), 'abc')
  assert.ok(fitExternalId('x'.repeat(50)).length === 36)
  assert.equal(fitExternalId(null), '')
})

test('подгонка сумм строк под итог: Σ строк == итог, строки не ниже 1 дирама', () => {
  assert.deepEqual(reconcile([100, 200, 300], 600), [100, 200, 300])
  assert.deepEqual(reconcile([100, 200, 299], 600), [100, 200, 300]) // +1 крупной
  assert.deepEqual(reconcile([100, 200, 301], 600), [100, 200, 300]) // −1 крупной
  assert.equal(
    reconcile([1, 5], 3).reduce((s, c) => s + c, 0),
    3,
  )
  assert.ok(reconcile([1, 5], 3).every((c) => c >= 1))
  // Любой набор сходится к итогу
  for (const [arr, total] of [
    [[33, 33, 34], 101],
    [[1000, 1, 1], 1003],
    [[62, 63], 125],
  ]) {
    assert.equal(
      reconcile(arr, total).reduce((s, c) => s + c, 0),
      total,
    )
  }
})

test('чек прихода: целые упаковки — «quantity по price», скидка/штуки — одной позицией', () => {
  const r = saleReceipt(
    {
      totalC: 600,
      payment: 'cash',
      lines: [
        { name: 'Хлеб', qty: 2, pieces: 0, sumC: 200 },
        { name: 'Молоко', qty: 1, pieces: 0, sumC: 400 },
      ],
    },
    CFG,
    { externalId: 'id-1' },
  )
  assert.equal(r.formCode, 'RECEIPT')
  assert.equal(r.operationType, 'INCOME')
  assert.equal(r.taxType, 'GENERAL')
  assert.equal(r.receiptSum, 600)
  assert.equal(r.receiptCash, 600)
  assert.equal(r.receiptNonCash, 0)
  // Хлеб: 2 упаковки по 100
  assert.deepEqual(r.products[0], { code: null, name: 'Хлеб', price: 100, quantity: 2, commodity: 'GOODS', vatCode: 'STANDARD', sum: 200 })
  // Молоко: 1 упаковка 400
  assert.equal(r.products[1].quantity, 1)
  assert.equal(r.products[1].price, 400)
  // Инвариант
  const sum = r.products.reduce((s, p) => s + p.sum, 0)
  assert.equal(sum, r.receiptSum)
  assert.equal(r.receiptCash + r.receiptNonCash, r.receiptSum)
  for (const p of r.products) assert.equal(p.price * p.quantity, p.sum)
  assert.equal(r.taxes.vats[0].vatCode, 'STANDARD')
  assert.equal(r.taxes.vats[0].vatSum, vatInclusive(600, 'STANDARD'))
})

test('оплата: наличные → cash, карта и перевод → nonCash', () => {
  const line = { lines: [{ name: 'Т', qty: 1, pieces: 0, sumC: 500 }], totalC: 500 }
  assert.equal(saleReceipt({ ...line, payment: 'cash' }, CFG, {}).receiptCash, 500)
  assert.equal(saleReceipt({ ...line, payment: 'card' }, CFG, {}).receiptNonCash, 500)
  assert.equal(saleReceipt({ ...line, payment: 'transfer' }, CFG, {}).receiptNonCash, 500)
  assert.equal(saleReceipt({ ...line, payment: 'card' }, CFG, {}).receiptCash, 0)
})

test('чек с дробным товаром: суммы строк подгоняются под итог', () => {
  // Две строки по 62.5 дирама округлятся каждая, а итог продажи — один раз
  const r = saleReceipt(
    {
      totalC: 125,
      payment: 'cash',
      lines: [
        { name: 'Крупа', qty: 0, pieces: 3, sumC: 63 },
        { name: 'Крупа2', qty: 0, pieces: 3, sumC: 63 },
      ],
    },
    CFG,
    {},
  )
  assert.equal(
    r.products.reduce((s, p) => s + p.sum, 0),
    125,
  )
  assert.equal(r.receiptSum, 125)
  for (const p of r.products) assert.equal(p.price * p.quantity, p.sum)
})

test('нечего бить: итог 0 (всё по скидке) или нет строк → null', () => {
  assert.equal(saleReceipt({ totalC: 0, payment: 'cash', lines: [{ name: 'Т', qty: 1, pieces: 0, sumC: 0 }] }, CFG, {}), null)
  assert.equal(saleReceipt({ totalC: 500, payment: 'cash', lines: [] }, CFG, {}), null)
  // Нулевые строки отсеиваются, остаётся положительная
  const r = saleReceipt(
    { totalC: 500, payment: 'cash', lines: [{ name: 'A', qty: 1, pieces: 0, sumC: 0 }, { name: 'B', qty: 1, pieces: 0, sumC: 500 }] },
    CFG,
    {},
  )
  assert.equal(r.products.length, 1)
  assert.equal(r.products[0].name, 'B')
})

test('смена и статус: тело запросов', () => {
  const open = openShiftReq({ cashier: 'Фарход', externalId: 'sid-1' })
  assert.equal(open.formCode, 'OPEN_SHIFT')
  assert.equal(open.cashier, 'Фарход')
  assert.equal(open.shouldPrintSlip, true)
  assert.equal(closeShiftReq({ cashier: '' }).formCode, 'CLOSE_SHIFT')
  assert.equal(closeShiftReq({ cashier: '' }).cashier, 'Кассир')
  assert.deepEqual(statusReq(), { formCode: 'DEVICE_STATUS', shouldPrintSlip: false })
})

test('разбор ответа: SUCCESS → реквизиты ФД; иначе — код ошибки', () => {
  const ok = parseReply({ rc: 'SUCCESS', data: { fdNumber: 7, fpd: 'C394F8AC', shiftNumber: 3, receiptNumber: 2, onlineStatus: true } })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.fd, { fdNumber: 7, fpd: 'C394F8AC', shiftNumber: 3, receiptNumber: 2, onlineStatus: true })
  const bad = parseReply({ rc: 'OUT_OF_PAPER', message: 'no paper' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'OUT_OF_PAPER')
  assert.equal(bad.message, 'no paper')
  assert.equal(parseReply({}).code, 'UNKNOWN_ERROR')
  assert.equal(parseReply(null).ok, false)
})
