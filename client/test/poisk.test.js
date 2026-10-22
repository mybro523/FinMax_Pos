// ── Поиск по товару: по названию и по штрихкоду (lib/poisk.js) ──
// Во всех поисках по товарам годится и штрихкод: кусок цифр, код со сканера или
// маркировка DataMatrix. Ошибка здесь — товар есть, а поиск его «не видит».
import test from 'node:test'
import assert from 'node:assert/strict'
import { poiskZapros, kodPodhodit, kodyPodhodyat, tovarPodhodit, shtrihkodyPoId } from '../src/lib/poisk.js'

test('пустой запрос — подходит всё', () => {
  assert.equal(poiskZapros(''), null)
  assert.equal(poiskZapros('   '), null)
  assert.equal(tovarPodhodit(null, 'Нурофен', '4870204010046'), true)
})

test('по названию — без учёта регистра', () => {
  const z = poiskZapros('НУРО')
  assert.equal(z.code, '')
  assert.equal(tovarPodhodit(z, 'Нурофен 200 мг', '4870204010046'), true)
  assert.equal(tovarPodhodit(z, 'Линекс', '4870204010053'), false)
})

test('по штрихкоду: целиком, кусок цифр, с пробелами', () => {
  assert.equal(tovarPodhodit(poiskZapros('4870204010046'), 'Нурофен', '4870204010046'), true)
  assert.equal(tovarPodhodit(poiskZapros('010046'), 'Нурофен', '4870204010046'), true)
  assert.equal(tovarPodhodit(poiskZapros('487 0204 010046'), 'Нурофен', '4870204010046'), true)
  assert.equal(tovarPodhodit(poiskZapros('010053'), 'Нурофен', '4870204010046'), false)
  // Две цифры — слишком мало для штрихкода: ищем только в названиях
  assert.equal(poiskZapros('46').code, '')
  // Цифры в названии тоже находятся («Аспирин 500»)
  assert.equal(tovarPodhodit(poiskZapros('500'), 'Аспирин 500мг', ''), true)
})

test('код со сканера: GTIN-14 и маркировка DataMatrix находят товар с EAN-13', () => {
  assert.equal(tovarPodhodit(poiskZapros('04870204010046'), 'Нурофен', '4870204010046'), true)
  assert.equal(tovarPodhodit(poiskZapros('010487020401004621ABCDEF'), 'Нурофен', '4870204010046'), true)
  assert.equal(tovarPodhodit(poiskZapros('010487020401004621ABCDEF'), 'Линекс', '4870204010053'), false)
  // И наоборот: у товара записан GTIN-14, ищут по EAN-13
  assert.equal(kodPodhodit(poiskZapros('4870204010046'), '04870204010046'), true)
})

test('строки без штрихкода: по коду не находятся, по названию — да', () => {
  assert.equal(tovarPodhodit(poiskZapros('487020'), 'Пакет', ''), false)
  assert.equal(tovarPodhodit(poiskZapros('пакет'), 'Пакет', ''), true)
})

test('чек или приход подходит, если подходит хоть одна его строка', () => {
  const z = poiskZapros('010053')
  assert.equal(kodyPodhodyat(z, ['4870204010046', '4870204010053']), true)
  assert.equal(kodyPodhodyat(z, ['4870204010046']), false)
  assert.equal(kodyPodhodyat(poiskZapros('нурофен'), ['4870204010046']), false, 'текст по кодам не ищется')
  assert.equal(kodyPodhodyat(z, []), false)
  const byId = shtrihkodyPoId([{ id: 'a', barcode: '111' }, { id: 'b' }])
  assert.equal(byId.get('a'), '111')
  assert.equal(byId.get('b'), '')
})
