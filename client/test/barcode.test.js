// ── Штрихкоды: EAN-13, EAN-8, Code 128 ──
// Ошибка здесь не видна глазом: полоски как полоски, а сканер код не читает — или читает
// не тот, и касса не находит товар. Поэтому проверяется всё, что можно посчитать:
// контрольные цифры, таблица Code 128, переходы между наборами, ширина модуля.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  barcodeKind,
  barcodeModel,
  barcodeSvg,
  code128Bits,
  code128Values,
  CODE128_PATTERNS,
  ean13Bits,
  ean13CheckDigit,
  ean8Bits,
  ean8CheckDigit,
  modulesOf,
  moduleFor,
} from '../src/lib/barcode.js'

test('вид кода: EAN-13 и EAN-8 — только цифры нужной длины с верной контрольной, остальное — Code 128', () => {
  assert.equal(barcodeKind('4870204010060'), 'ean13')
  assert.equal(barcodeKind(' 4870204010060 '), 'ean13', 'пробелы по краям не мешают')
  assert.equal(barcodeKind('96385074'), 'ean8')
  // Неверная контрольная цифра — печатается как есть, Code 128: сканер выдаст те же цифры
  assert.equal(barcodeKind('4870204010061'), 'code128')
  assert.equal(barcodeKind('96385075'), 'code128')
  // С чёрточками — не EAN: сканер выдал бы цифры без них
  assert.equal(barcodeKind('4870-2040-1006-0'), 'code128')
  assert.equal(barcodeKind('123'), 'code128')
  assert.equal(barcodeKind('ABC-12'), 'code128')
  assert.equal(barcodeKind('012345678905'), 'code128', '12 цифр — Code 128, чтобы сканер выдал ровно 12')
  // Русские буквы в Code 128 не закодировать; пусто — нечего печатать
  assert.equal(barcodeKind('Шифо1'), '')
  assert.equal(barcodeKind(''), '')
  assert.equal(barcodeKind(null), '')
})

test('контрольные цифры EAN-13 и EAN-8', () => {
  assert.equal(ean13CheckDigit('487020401006'), '0')
  assert.equal(ean13CheckDigit('460000000000'), '8')
  assert.equal(ean8CheckDigit('9638507'), '4')
  assert.equal(ean8CheckDigit('5512345'), '7')
})

test('EAN-13 — 95 модулей, EAN-8 — 67; разделители на месте', () => {
  const b13 = ean13Bits('4870204010060')
  assert.equal(b13.length, 95)
  assert.equal(b13.slice(0, 3), '101')
  assert.equal(b13.slice(45, 50), '01010')
  assert.equal(b13.slice(92), '101')
  const b8 = ean8Bits('96385074')
  assert.equal(b8.length, 67)
  assert.equal(b8.slice(0, 3), '101')
  assert.equal(b8.slice(31, 36), '01010')
  assert.equal(b8.slice(64), '101')
  // Первая цифра EAN-8 «9» набором L: 0001011
  assert.equal(b8.slice(3, 10), '0001011')
  assert.equal(ean8Bits('123'), '')
})

test('таблица Code 128: 107 знаков, каждый на 11 модулей, «стоп» — на 13', () => {
  assert.equal(CODE128_PATTERNS.length, 107)
  CODE128_PATTERNS.forEach((p, v) => {
    const sum = [...p].reduce((s, d) => s + Number(d), 0)
    assert.equal(sum, v === 106 ? 13 : 11, `знак ${v}`)
    assert.equal(p.length, v === 106 ? 7 : 6, `знак ${v}`)
  })
  // Все знаки разные — иначе сканер путал бы их
  assert.equal(new Set(CODE128_PATTERNS).size, 107)
})

test('Code 128: буквы — набором B, контрольный знак по весам', () => {
  // «PJJ123C»: старт B (104) + P48·1 + J42·2 + J42·3 + 1(17)·4 + 2(18)·5 + 3(19)·6 + C35·7 = 879; 879 mod 103 = 55
  assert.deepEqual(code128Values('PJJ123C'), [104, 48, 42, 42, 17, 18, 19, 35, 55, 106])
  // Короткий код из трёх цифр — набором B, переход на C не окупился бы
  assert.deepEqual(code128Values('123').slice(0, 4), [104, 17, 18, 19])
})

test('Code 128: длинные цифры — парами (набор C), нечётная — отдельно', () => {
  // Чётные цифры — старт C, пары
  assert.deepEqual(code128Values('12345678').slice(0, 5), [105, 12, 34, 56, 78])
  // Нечётные: пары, потом переход на B и последняя цифра
  assert.deepEqual(code128Values('12345').slice(0, 5), [105, 12, 34, 100, 21])
  // Буквы, потом цифры в конце: B, переход на C, пары
  assert.deepEqual(code128Values('AB1234').slice(0, 6), [104, 33, 34, 99, 12, 34])
  // Цифры в середине — меньше шести, остаются в B
  assert.deepEqual(code128Values('A1234B').slice(0, 7), [104, 33, 17, 18, 19, 20, 34])
  // Шесть в середине — переход на C и обратно
  assert.deepEqual(code128Values('A123456B').slice(0, 8), [104, 33, 99, 12, 34, 56, 100, 34])
  // Две цифры — одна пара набора C
  assert.deepEqual(code128Values('07').slice(0, 2), [105, 7])
  // Контрольный знак всегда сходится
  for (const s of ['12345', 'AB1234', 'A123456B', 'x', '2000000000008', '4600-1']) {
    const v = code128Values(s)
    let sum = v[0]
    for (let k = 1; k < v.length - 2; k++) sum += v[k] * k
    assert.equal(v[v.length - 2], sum % 103, s)
    assert.equal(v[v.length - 1], 106, s)
  }
  assert.equal(code128Values('Шифо'), null)
  assert.equal(code128Values(''), null)
})

test('Code 128 полосками: начинается и кончается чёрной, длина по числу знаков', () => {
  const bits = code128Bits('PJJ123C')
  assert.equal(bits.length, 11 * 9 + 13)
  assert.equal(bits[0], '1')
  assert.equal(bits[bits.length - 1], '1')
  // «Стоп» — 2331112
  assert.equal(bits.slice(-13), '1100011101011')
})

test('ширина модуля — целое число точек принтера: 2 или 3 у 203 dpi, 3 или 4 у 300 dpi', () => {
  const dot203 = 25.4 / 203
  const ean = modulesOf(barcodeModel('4870204010060'))
  assert.equal(ean, 95 + 18)
  // Наклейка 58 мм: помещается 3 точки
  assert.ok(Math.abs(moduleFor(ean, 56.4, 203) - 3 * dot203) < 1e-12)
  // 40 и 30 мм — 2 точки
  assert.ok(Math.abs(moduleFor(ean, 38.4, 203) - 2 * dot203) < 1e-12)
  assert.ok(Math.abs(moduleFor(ean, 28.4, 203) - 2 * dot203) < 1e-12)
  // Не помещается даже 2 точки — 0
  assert.equal(moduleFor(ean, 25, 203), 0)
  const dot300 = 25.4 / 300
  assert.ok(Math.abs(moduleFor(ean, 56.4, 300) - 4 * dot300) < 1e-12)
  assert.ok(Math.abs(moduleFor(ean, 28.9, 300) - 3 * dot300) < 1e-12)
})

test('SVG: размер в миллиметрах, полосы слиты, подпись цифрами', () => {
  const model = barcodeModel('4870204010060')
  const module = 3 * (25.4 / 203)
  const svg = barcodeSvg(model, { module, barMm: 14, fontMm: 3 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="42\.417mm"/)
  assert.match(svg, /shape-rendering="crispEdges"/)
  // Чёрных полос у EAN-13 ровно 30: по две на цифру и шесть в разделителях
  assert.equal((svg.match(/<rect /g) || []).length, 30)
  assert.match(svg, />4</)
  assert.match(svg, />870204</)
  assert.match(svg, />010060</)
  // Code 128: знаки в подписи экранируются
  const c = barcodeSvg(barcodeModel('A<B&1'), { module: 0.25, barMm: 8, fontMm: 2 })
  assert.match(c, />A&lt;B&amp;1</)
  // Без подписи — только полосы
  assert.doesNotMatch(barcodeSvg(model, { module, barMm: 10 }), /<text/)
  assert.equal(barcodeSvg(null, { module, barMm: 10 }), '')
})
