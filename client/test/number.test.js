// Фильтр числового ввода. Из-за его отсутствия в карточку товара попадали
// «−12 упаковок» и «−1 вскрытая»: обычное поле type="number" минус пропускает.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeNumber } from '../src/lib/number.js'
import { sellsBelowCost } from '../src/lib/pricing.js'

test('минус не проходит — ни спереди, ни в середине', () => {
  assert.equal(sanitizeNumber('-12', true), '12')
  assert.equal(sanitizeNumber('-1', true), '1')
  assert.equal(sanitizeNumber('1-2', true), '12')
  assert.equal(sanitizeNumber('-', true), '')
  assert.equal(sanitizeNumber('−5', true), '5', 'типографский минус тоже')
})

test('буквы и знак экспоненты не проходят', () => {
  assert.equal(sanitizeNumber('12e5', true), '125')
  assert.equal(sanitizeNumber('abc', true), '')
  assert.equal(sanitizeNumber('20 сомони', false), '20')
  assert.equal(sanitizeNumber('1e-9', false), '19')
})

test('целые поля не принимают дробное', () => {
  assert.equal(sanitizeNumber('3.5', true), '35', 'количество упаковок — только целое')
  assert.equal(sanitizeNumber('3.5', false), '3.5', 'цена может быть дробной')
})

test('запятая работает как точка', () => {
  assert.equal(sanitizeNumber('12,50', false), '12.50')
})

test('точка только одна', () => {
  assert.equal(sanitizeNumber('12.3.4', false), '12.34')
  assert.equal(sanitizeNumber('..5', false), '.5')
})

test('обычные значения не портятся', () => {
  assert.equal(sanitizeNumber('0', true), '0')
  assert.equal(sanitizeNumber('149', true), '149')
  assert.equal(sanitizeNumber('290.50', false), '290.50')
  assert.equal(sanitizeNumber('', true), '')
})

test('вставка из буфера чистится так же, как набор', () => {
  assert.equal(sanitizeNumber('  -1 200,75  ', false), '1200.75')
})

// ── Цена ниже закупочной ──

test('продажа дешевле закупки замечается', () => {
  assert.equal(sellsBelowCost(200, 20), true)
  assert.equal(sellsBelowCost(20, 200), false)
  assert.equal(sellsBelowCost(100, 100), false, 'равные цены — не убыток')
})

test('пустые и нулевые цены не считаются убытком', () => {
  assert.equal(sellsBelowCost(0, 100), false, 'закупочная не заполнена')
  assert.equal(sellsBelowCost(100, 0), false, 'цена ещё не введена')
  assert.equal(sellsBelowCost('', ''), false)
})

test('строки из полей формы разбираются', () => {
  assert.equal(sellsBelowCost('200', '20'), true)
  assert.equal(sellsBelowCost('20.5', '30.1'), false)
})
