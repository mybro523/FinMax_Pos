// ── Товар двумя полями: «Штрихкод» и «Наименование» (lib/pick.js) ──
// В приходе и возврате поставщику код сканируют или вписывают в первое поле — во
// втором само появляется название. Ошибка здесь — в приход встаёт не тот товар
// или нужный не находится, хотя лежит на складе.
import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_MS, AUTO_PREFIX_MS, autoPickDelay, codeIsPrefix, looksLikeCode, nameSuggest, productByCode } from '../src/lib/pick.js'

const P = [
  { id: 'nur', name: 'Нурофен 200 мг №10', barcode: '4870204010046' },
  { id: 'lin', name: 'Линекс капсулы №16', barcode: '4870204010053' },
  { id: 'muka', name: 'Мука 19060', barcode: '79060' },
  { id: 'muka2', name: 'Мука высший сорт', barcode: '790601' },
  { id: 'bez', name: 'Пакет фасовочный', barcode: '' },
]

test('товар по коду: тот же штрихкод или тот же товар из DataMatrix и QR', () => {
  assert.equal(productByCode(P, '4870204010053').id, 'lin')
  assert.equal(productByCode(P, '  4870204010053  ').id, 'lin', 'пробелы по краям не мешают')
  // DataMatrix маркировки: GTIN-14 с нулём впереди — это тот же EAN-13
  assert.equal(productByCode(P, '010487020401005321ABCDEF').id, 'lin')
  assert.equal(productByCode(P, '04870204010053').id, 'lin')
  assert.equal(productByCode(P, '79060').id, 'muka')
  assert.equal(productByCode(P, '4870204'), null, 'кусок кода — не товар')
  assert.equal(productByCode(P, '9999999999999'), null)
  assert.equal(productByCode(P, ''), null)
  // У товара без штрихкода код не находится ничем — даже пустым
  assert.equal(productByCode(P, ' '), null)
})

test('вписали код руками: товар подставляется сам, но после короткой паузы', () => {
  assert.equal(autoPickDelay(P, '4870204010053'), AUTO_MS)
  // Пока код не совпал — подставлять нечего
  assert.equal(autoPickDelay(P, '487020401005'), null)
  assert.equal(autoPickDelay(P, ''), null)
  // Пауза короче, чем человек думает между цифрами, но длиннее, чем сканер вводит код
  assert.ok(AUTO_MS >= 250 && AUTO_MS <= 500)
})

test('короткий код — начало длинного («79060» и «790601»): ждём дольше, чтобы успели допечатать', () => {
  assert.equal(codeIsPrefix(P, '79060'), true)
  assert.equal(codeIsPrefix(P, '790601'), false)
  assert.equal(codeIsPrefix(P, '4870204010053'), false)
  assert.equal(autoPickDelay(P, '79060'), AUTO_PREFIX_MS)
  assert.equal(autoPickDelay(P, '790601'), AUTO_MS)
  assert.ok(AUTO_PREFIX_MS > AUTO_MS * 2)
})

test('подсказки к названию: без учёта регистра, и по цифрам штрихкода тоже, не больше восьми', () => {
  assert.deepEqual(nameSuggest(P, 'мука').map((p) => p.id), ['muka', 'muka2'])
  assert.deepEqual(nameSuggest(P, 'ЛИНЕКС').map((p) => p.id), ['lin'])
  assert.deepEqual(nameSuggest(P, '010046').map((p) => p.id), ['nur'])
  // Товар без штрихкода находится по названию — ради этого второе поле и ищет
  assert.deepEqual(nameSuggest(P, 'пакет').map((p) => p.id), ['bez'])
  assert.deepEqual(nameSuggest(P, '   '), [])
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, name: 'Товар ' + i, barcode: '' }))
  assert.equal(nameSuggest(many, 'товар').length, 8)
})

test('в поле названия выстрелили сканером: это код, а не название', () => {
  assert.equal(looksLikeCode('4870204010053'), true)
  assert.equal(looksLikeCode('487 020 401 0053'), true)
  assert.equal(looksLikeCode('010487020401005321ABCDEF'), true, 'DataMatrix')
  assert.equal(looksLikeCode('79060'), false, 'пять цифр — это может быть и название («19060»)')
  assert.equal(looksLikeCode('Нурофен'), false)
  assert.equal(looksLikeCode('Мука 19060'), false)
})
