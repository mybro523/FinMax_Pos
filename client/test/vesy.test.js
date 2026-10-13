// Весовой товар: разбор этикетки весов и строка веса в чеке.
// Этикетка EAN-13: ПП ККККК ВВВВВ К — префикс, код товара, граммы, контрольная.
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVesEtiketku, productPoVesKodu, VESY_PUSTO } from '../src/lib/vesy.js'
import { isVesovoy, kgText, gramsOfKg, lineNet } from '../src/lib/units.js'
import { saleTicket, qtyPriceText } from '../src/lib/ticket.js'
import { setLang, translate as t } from '../src/lib/i18n.js'

const CFG = { on: true, prefix: '22', codeLen: 5 }

test('этикетка весов разбирается: код товара и граммы', () => {
  // 22 01234 00350 K — товар 01234, 350 граммов
  assert.deepEqual(parseVesEtiketku('2201234003507', CFG), { code: '01234', grams: 350 })
  // 12,35 кг
  assert.deepEqual(parseVesEtiketku('2200077123509', CFG), { code: '00077', grams: 12350 })
  // Код из четырёх цифр — настройка длины
  assert.deepEqual(parseVesEtiketku('2212340003507', { ...CFG, codeLen: 4 }), { code: '1234', grams: 350 })
})

test('не этикетка — null: чужой префикс, не 13 цифр, нулевой вес, весы выключены', () => {
  assert.equal(parseVesEtiketku('4870204010060', CFG), null, 'обычный штрихкод')
  assert.equal(parseVesEtiketku('220123400350', CFG), null, '12 цифр')
  assert.equal(parseVesEtiketku('2201234000007', CFG), null, 'вес 0')
  assert.equal(parseVesEtiketku('2201234003507', { ...CFG, on: false }), null, 'весы выключены')
  assert.equal(parseVesEtiketku('2201234003507', VESY_PUSTO), null, 'по умолчанию выключены')
})

test('весовой товар находится по коду — с ведущими нулями и без', () => {
  const sahar = { id: 's', name: 'Сахар', unit: 'кг', barcode: '1234' }
  const ne_ves = { id: 'x', name: 'Не весовой', unit: 'уп', barcode: '01234' }
  assert.equal(productPoVesKodu([ne_ves, sahar], '01234'), sahar, 'не весовой не подходит, нули не мешают')
  assert.equal(productPoVesKodu([{ ...sahar, barcode: '01234' }], '01234')?.barcode, '01234', 'и с нулями находится')
  assert.equal(productPoVesKodu([sahar], '09999'), null)
})

test('вес: помощники и деньги', () => {
  assert.equal(isVesovoy({ unit: 'кг' }), true)
  assert.equal(isVesovoy({ unit: 'уп' }), false)
  assert.equal(kgText(12350), '12,35')
  assert.equal(gramsOfKg('1,25'), 1250)
  // 350 г по 25 с/кг = 8,75
  assert.equal(lineNet({ qty: 0, pieces: 350, unitsPerPack: 1000, price: 25 }), 8.75)
})

test('чек: весовая строка — килограммы и цена за килограмм', () => {
  setLang('ru')
  const money = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',') + ' с.'
  const i = { name: 'Сахар', qty: 0, pieces: 350, unitsPerPack: 1000, unit: 'кг', price: 25, discount: 0 }
  assert.equal(qtyPriceText(i, t, money), '0,35 кг × 25 с.')
  const ticket = saleTicket(
    { date: '2026-10-13T10:00:00.000Z', total: 8.75, payment: 'cash', items: [i] },
    { t, money, when: () => 'дата' },
  )
  assert.deepEqual(ticket.rows, [{ name: 'Сахар', sub: '0,35 кг × 25 с.', value: '8,75 с.' }])
})
