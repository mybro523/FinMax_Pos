// ── Товары из Excel: разбор файла (12.11.2026) ──
// Колонки ищутся по шапке или сами (длинные числа — штрихкод, текст — название); товар без
// штрихкода получает свой EAN-13 с «2»; повтор — первая строка, остальные — в пропущенные.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { cellText, colLetter, razobrat } from '../src/lib/importTovarov.js'
import { isValidEan13 } from '../src/lib/barcode.js'

const rows = (list) => list.map((cells, i) => ({ n: i + 1, cells }))

test('файл как у клиента: две колонки без шапки, штрихкоды числами', () => {
  const r = razobrat(
    rows([
      [30056640, 'Rexona Део-Стик для Жен Алоэ Вера 40гр'],
      [30079861, 'Тушь "Колосал Волюм Экспресс" 100% Экст чёр'],
      [4870204010060, 'Шоколад Батон "Киндер Макси" с Мол.Начинкой 21гр'],
      [30079861, 'Тушь повтором'],
      ['', 'Жев рез Эклипс'],
      [42124016, ''],
    ]),
  )
  assert.deepEqual(r.cols, { barcode: 0, name: 1 })
  assert.equal(r.items.length, 4)
  assert.equal(r.items[0].barcode, '30056640')
  assert.equal(r.items[2].barcode, '4870204010060')
  const own = r.items.find((x) => x.name === 'Жев рез Эклипс')
  assert.ok(own.own && isValidEan13(own.barcode) && own.barcode[0] === '2', own.barcode)
  assert.equal(r.ownCodes, 1)
  assert.deepEqual(r.skipped.map((s) => [s.n, s.why, s.ref]), [[4, 'dup', 2], [6, 'noname', undefined]])
})

test('таблица с шапкой: колонки в любом порядке, цена, остаток, категория, единица', () => {
  const r = razobrat(
    rows([
      ['Список товаров магазина'],
      ['Наименование', 'Цена', 'Штрихкод', 'Остаток', 'Категория', 'Ед.', 'Цена закупки'],
      ['Фанта 0.5л', '8,50', '40822938', 12, 'Напитки', 'шт', 6],
      ['Сахар', 14, 2000000000015, '2,5', 'Бакалея', 'кг', ''],
    ]),
  )
  assert.equal(r.cols.name, 0)
  assert.equal(r.cols.price, 1)
  assert.equal(r.cols.barcode, 2)
  assert.equal(r.cols.cost, 6)
  assert.deepEqual(r.items[0], { barcode: '40822938', name: 'Фанта 0.5л', price: 8.5, cost: 6, stock: 12, category: 'Напитки', unit: 'шт' })
  assert.deepEqual(r.items[1], { barcode: '2000000000015', name: 'Сахар', price: 14, stock: 2, category: 'Бакалея', unit: 'кг' })
})

test('свой код не совпадает со штрихкодом ниже по файлу и с занятыми', () => {
  const taken = new Set()
  const r = razobrat(rows([['', 'Без кода'], ['12345678', 'С кодом']]), { taken: ['2999999999990'] })
  for (const it of r.items) taken.add(it.barcode)
  assert.equal(taken.size, 2)
  assert.notEqual(r.items[0].barcode, '2999999999990')
})

test('без колонки названий — понятная ошибка', () => {
  const r = razobrat(rows([[123456789], [987654321]]))
  assert.equal(r.items.length, 0)
  assert.ok(r.error)
})

test('ячейки Excel: формула, ссылка, «богатый» текст, большие числа', () => {
  assert.equal(cellText({ formula: 'A1', result: 4870204010060 }), '4870204010060')
  assert.equal(cellText({ text: 'Ссылка', hyperlink: 'x' }), 'Ссылка')
  assert.equal(cellText({ richText: [{ text: 'Киндер ' }, { text: 'Сюрприз' }] }), 'Киндер Сюрприз')
  assert.equal(cellText(4870204010060), '4870204010060')
  assert.equal(cellText(null), '')
  assert.equal(colLetter(0), 'A')
  assert.equal(colLetter(27), 'AB')
})
