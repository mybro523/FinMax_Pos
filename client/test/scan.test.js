// Разбор отсканированного кода. От него зависит и касса, и приёмка товара:
// сканер может отдать обычный штрихкод, маркировку DataMatrix или QR со ссылкой,
// а найти товар нужно во всех случаях.
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeScan, canonBarcode, looksLikeDataMatrix } from '../src/lib/scan.js'

const EAN = '4870204010015'
const GTIN = '0' + EAN // тот же товар в виде GTIN-14

test('обычный штрихкод остаётся как есть', () => {
  assert.equal(normalizeScan(EAN), EAN)
})

test('GTIN-14 приводится к штрихкоду на упаковке', () => {
  assert.equal(normalizeScan(GTIN), EAN)
  assert.equal(canonBarcode(GTIN), EAN)
})

test('маркировка DataMatrix: берём код товара, а не серийный номер', () => {
  // 01 + GTIN(14) + 21 + серийный номер — у каждой пачки он свой
  assert.equal(normalizeScan(`01${GTIN}21ABC12345`), EAN)
  assert.equal(normalizeScan(`01${GTIN}21XYZ99999`), EAN, 'другая пачка того же товара — тот же товар')
})

test('сканер с префиксом символогии не ломает поиск', () => {
  assert.equal(normalizeScan(`]d201${GTIN}21ABC12345`), EAN)
  assert.equal(normalizeScan(`]C1${EAN}`), EAN)
})

test('разделитель GS перед кодом товара', () => {
  assert.equal(normalizeScan(`\x1d01${GTIN}\x1d21ABC`), EAN)
})

test('QR со ссылкой на упаковке', () => {
  assert.equal(normalizeScan(`https://aptekа.tj/01/${GTIN}/21/abc`), EAN)
  assert.equal(normalizeScan(`https://example.com/p?01=${GTIN}`), EAN)
})

test('пробелы и пустое значение', () => {
  assert.equal(normalizeScan(`  ${EAN}  `), EAN)
  assert.equal(normalizeScan(''), '')
  assert.equal(normalizeScan(null), '')
})

test('непонятный код возвращается очищенным, а не теряется', () => {
  assert.equal(normalizeScan('ABC-123'), 'ABC-123')
  assert.equal(normalizeScan(']E0ABC-123'), 'ABC-123')
})

test('распознаём, что это маркировка', () => {
  assert.equal(looksLikeDataMatrix(`01${GTIN}21ABC12345`), true)
  assert.equal(looksLikeDataMatrix(EAN), false)
})
