// ── Табло покупателя на COM-порту (1.7.6) ──
// Цифровое (8 цифр): ESC @, ESC s n (лампочка), ESC Q A <цифры> CR. Двухстрочное 2×20:
// ESC @, FF, 40 знаков латиницей. Что показать — из состояния экрана покупателя
import test from 'node:test'
import assert from 'node:assert/strict'
import { latinica, summaIz, tabloBytes, tabloKadr, tabloSkorost, tabloVid, TABLO_PROBA } from '../src/lib/tablo.js'

const txt = (bytes) => String.fromCharCode(...bytes)

test('сумма из строки денег', () => {
  assert.equal(summaIz('1 234,5 сомони'), '1234.50')
  assert.equal(summaIz('18\u00a0сомони'), '18.00')
  assert.equal(summaIz('−12 сомони'), '12.00')
  assert.equal(summaIz(''), '')
  assert.equal(summaIz(undefined), '')
})

test('что показать: корзина — итог, оплата — сдача, ожидание — пусто', () => {
  assert.deepEqual(tabloKadr({ mode: 'cart', total: '233 сомони' }), { lamp: 2, amount: '233.00', line1: 'ITOGO:', line2: '233.00 TJS' })
  assert.deepEqual(tabloKadr({ mode: 'thanks', total: '233 сомони', change: '17 сомони' }), { lamp: 4, amount: '17.00', line1: 'SDACHA:', line2: '17.00 TJS' })
  assert.equal(tabloKadr({ mode: 'thanks', total: '233 сомони', change: '' }).amount, '233.00')
  assert.deepEqual(tabloKadr({ mode: 'idle', shop: 'Шифо' }), { lamp: 0, amount: '', line1: 'Шифо', line2: '' })
})

test('цифровое табло: лампочка и число; ожидание — очистить', () => {
  const b = tabloBytes('led8', tabloKadr({ mode: 'cart', total: '1 234,56 сомони' }))
  assert.deepEqual(b.slice(0, 5), [0x1b, 0x40, 0x1b, 0x73, 0x32])
  assert.equal(txt(b.slice(5)), '\x1bQA1234.56\r')
  const idle = tabloBytes('led8', tabloKadr({ mode: 'idle' }))
  assert.deepEqual(idle, [0x1b, 0x40, 0x1b, 0x73, 0x30, 0x0c])
  // Больше 8 цифр — без копеек
  assert.equal(txt(tabloBytes('led8', { lamp: 2, amount: '1234567.89' }).slice(5)), '\x1bQA1234567\r')
})

test('двухстрочное табло: 40 знаков латиницей, сумма справа', () => {
  const b = tabloBytes('vfd', tabloKadr({ mode: 'cart', total: '18 сомони' }))
  assert.deepEqual(b.slice(0, 3), [0x1b, 0x40, 0x0c])
  const body = txt(b.slice(3))
  assert.equal(body.length, 40)
  assert.equal(body.slice(0, 20), 'ITOGO:'.padEnd(20))
  assert.equal(body.slice(20), '18.00 TJS'.padStart(20))
  const idle = txt(tabloBytes('vfd', tabloKadr({ mode: 'idle', shop: 'Магазин «Шифо»' })).slice(3))
  assert.equal(idle.slice(0, 20).trim(), 'Magazin "Shifo"')
  assert.ok(b.every((x) => x >= 0 && x < 128))
})

test('латиница, вид и скорость по умолчанию, проба', () => {
  assert.equal(latinica('Ҳисоб ҷамъ'), 'Hisob jam')
  assert.equal(tabloVid('x'), 'off')
  assert.equal(tabloSkorost(undefined, 'led8'), 2400)
  assert.equal(tabloSkorost(undefined, 'vfd'), 9600)
  assert.equal(tabloSkorost(19200, 'led8'), 19200)
  assert.equal(tabloKadr(TABLO_PROBA).amount, '1234.56')
  assert.deepEqual(tabloBytes('off', tabloKadr(TABLO_PROBA)), [])
})
