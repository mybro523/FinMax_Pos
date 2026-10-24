// Отвергнутая сервером операция: что видит владелец.
// Программа для Windows снимает такую операцию с учёта, и в журналах кассы её больше
// нет. Список «не принято сервером» — единственное место, где видно, что было сделано.
// Здесь проверяется, что операция показана целиком — по ней её можно оформить заново —
// и что слова есть на обоих языках.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasRejectedDetail, rejectedDetail } from '../src/lib/rejected.js'
import { setLang, translate } from '../src/lib/i18n.js'

const money = (n) => Number(n).toFixed(2) + ' с.'
const pairs = (d) => d.facts.map((f) => [f.label, f.value])
const rows = (d) => d.lines.map((l) => [l.name, l.text])

test('чек: оплата, клиент и все позиции — упаковки, штуки, цена, скидка', () => {
  setLang('ru')
  const d = rejectedDetail(
    {
      type: 'sale',
      detail: {
        payment: 'debt',
        customer: 'Иван',
        lines: [
          { name: 'Нурофен', qty: 2, pieces: 0, unitsPerPack: 1, price: 150, discount: 0 },
          { name: 'Парацетамол', qty: 1, pieces: 5, unitsPerPack: 20, price: 200, discount: 10 },
          { name: 'Аспирин', qty: 0, pieces: 3, unitsPerPack: 10, price: 50, discount: 0 },
          { name: 'Бинт', qty: 4, pieces: 0, unitsPerPack: 1, price: 12, discount: 0 },
          { name: 'Вата', qty: 1, pieces: 0, unitsPerPack: 1, price: 9, discount: 0 },
        ],
      },
    },
    translate,
    money,
  )
  assert.deepEqual(pairs(d), [['Оплата', 'В долг'], ['Клиент', 'Иван']])
  assert.deepEqual(rows(d), [
    ['Нурофен', '2 уп × 150.00 с.'],
    ['Парацетамол', '25 шт × 10.00 с. · скидка −10.00 с.'],
    ['Аспирин', '3 шт × 5.00 с.'],
    ['Бинт', '4 уп × 12.00 с.'],
    ['Вата', '1 уп × 9.00 с.'],
  ])
})

test('чек за наличные без клиента: строки «Клиент» нет', () => {
  setLang('ru')
  const d = rejectedDetail({ type: 'sale', detail: { payment: 'cash', customer: '', lines: [] } }, translate, money)
  assert.deepEqual(pairs(d), [['Оплата', 'Наличные']])
  assert.equal(rejectedDetail({ type: 'sale', detail: { payment: 'card', lines: [] } }, translate, money).facts[0].value, 'Карта')
})

test('возврат: чем вернули деньги, примечание и что ушло в списание', () => {
  setLang('ru')
  const d = rejectedDetail(
    {
      type: 'return',
      detail: {
        refund: 'card',
        note: 'передумал',
        lines: [
          { name: 'Нурофен', units: 1, amount: 150, restock: true },
          { name: 'Аспирин', units: 3, amount: 15, restock: false },
        ],
      },
    },
    translate,
    money,
  )
  assert.deepEqual(pairs(d), [['Чем возвращаем деньги', 'Возврат на карту'], ['Примечание', 'передумал']])
  // Возврат называет свой чек — по дате и сумме его можно найти и оформить возврат заново
  const withSale = rejectedDetail({ type: 'return', detail: { refund: 'cash', sale: { date: '2026-10-04T05:00:00.000Z', total: 300 }, lines: [] } }, translate, money, { when: (d) => 'когда:' + d.slice(0, 10) })
  assert.deepEqual(pairs(withSale)[0], ['Чек', 'когда:2026-10-04 · 300.00 с.'])
  assert.deepEqual(rows(d), [['Нурофен', '1 шт · 150.00 с.'], ['Аспирин', '3 шт · 15.00 с. · списано']])
  assert.equal(rejectedDetail({ type: 'return', detail: { refund: 'debt', lines: [] } }, translate, money).facts[0].value, 'Уменьшить долг клиента')
  assert.equal(rejectedDetail({ type: 'return', detail: { refund: 'cash', lines: [] } }, translate, money).facts[0].value, 'Наличными из кассы')
})

test('приход: поставщик (если назван) и что пришло, по какой цене', () => {
  setLang('ru')
  const lines = [{ name: 'Нурофен', qty: 3, cost: 90 }, { name: 'Парацетамол', qty: 1, cost: 110.5 }]
  const named = rejectedDetail({ type: 'arrival', detail: { supplier: 'Опт-Маркет', lines } }, translate, money)
  assert.deepEqual(pairs(named), [['Поставщик', 'Опт-Маркет']])
  assert.deepEqual(rows(named), [['Нурофен', '3 уп × 90.00 с.'], ['Парацетамол', '1 уп × 110.50 с.']])
  // Со сроком годности, если касса его записала: без него приход заново не оформить
  const dated = rejectedDetail(
    { type: 'arrival', detail: { supplier: '', lines: [{ name: 'Нурофен', qty: 3, cost: 90, expiry: '2028-01-31T00:00:00.000Z' }, { name: 'Бинт', qty: 1, cost: 5, expiry: null }] } },
    translate,
    money,
    { day: (d) => 'день:' + d.slice(0, 10) },
  )
  assert.deepEqual(rows(dated), [['Нурофен', '3 уп × 90.00 с. · Срок годности: день:2028-01-31'], ['Бинт', '1 уп × 5.00 с.']])
  // Прочерк вместо поставщика — это «не указан», показывать его незачем
  assert.deepEqual(pairs(rejectedDetail({ type: 'arrival', detail: { supplier: '—', lines } }, translate, money)), [])
})

test('списание: причина словами, примечание и сколько штук', () => {
  setLang('ru')
  const d = rejectedDetail({ type: 'writeoff', detail: { reason: 'damaged', note: 'разбили', lines: [{ name: 'Парацетамол', units: 3 }] } }, translate, money)
  assert.deepEqual(pairs(d), [['Причина', 'Брак или повреждение'], ['Примечание', 'разбили']])
  assert.deepEqual(rows(d), [['Парацетамол', '3 шт']])
  const reasons = ['expired', 'damaged', 'lost', 'other'].map((reason) => rejectedDetail({ type: 'writeoff', detail: { reason, lines: [] } }, translate, money).facts[0].value)
  assert.deepEqual(reasons, ['Просрочен', 'Брак или повреждение', 'Недостача (не нашли)', 'Другое'])
})

test('расход: статья, день, откуда деньги и примечание — по ним его вносят заново', () => {
  setLang('ru')
  const fmt = { day: (d) => 'день:' + String(d).slice(0, 10) }
  const cash = rejectedDetail(
    { type: 'expense', detail: { category: 'Транспорт', note: 'такси за товаром', date: '2026-10-04T10:00:00.000Z', fromCash: true } },
    translate, money, fmt,
  )
  assert.deepEqual(pairs(cash), [['Статья расхода', 'Транспорт'], ['Дата', 'день:2026-10-04'], ['Оплата', 'из кассы'], ['Примечание', 'такси за товаром']])
  assert.deepEqual(rows(cash), [])
  // Обычный расход: строки «из кассы» нет, пустое примечание не показывается
  const plain = rejectedDetail({ type: 'expense', detail: { category: 'Аренда', note: '', date: '2026-10-01T07:00:00.000Z', fromCash: false } }, translate, money, fmt)
  assert.deepEqual(pairs(plain), [['Статья расхода', 'Аренда'], ['Дата', 'день:2026-10-01']])
  // Готовая статья на таджикском показывается переводом, своя — как её назвал владелец
  setLang('tg')
  try {
    const tg = (category) => rejectedDetail({ type: 'expense', detail: { category } }, translate, money, fmt).facts[0]
    assert.deepEqual(tg('Аренда'), { label: 'Моддаи хароҷот', value: 'Иҷора' })
    assert.equal(tg('Охрана склада').value, 'Охрана склада')
  } finally {
    setLang('ru')
  }
})

test('погашение долга и новый клиент: чей долг, телефон и начальный долг', () => {
  setLang('ru')
  assert.deepEqual(pairs(rejectedDetail({ type: 'debt.pay', detail: { customer: 'Иван' } }, translate, money)), [['Клиент', 'Иван']])
  assert.deepEqual(pairs(rejectedDetail({ type: 'customer.create', detail: { phone: '900112233', debt: 50 } }, translate, money)), [['Телефон', '900112233'], ['Долг', '50.00 с.']])
  assert.deepEqual(pairs(rejectedDetail({ type: 'customer.create', detail: { phone: '', debt: 0 } }, translate, money)), [])
})

test('смена: с чем открыли; при закрытии — сколько должно быть в кассе и сколько насчитали', () => {
  setLang('ru')
  assert.deepEqual(pairs(rejectedDetail({ type: 'shift.open', detail: { openingCash: 100 } }, translate, money)), [['касса на старте', '100.00 с.']])
  const closed = rejectedDetail({ type: 'shift.close', detail: { openingCash: 100, countedCash: 240, expectedCash: 250, difference: -10, count: 3 } }, translate, money)
  assert.deepEqual(pairs(closed), [
    ['Чеков', '3'],
    ['касса на старте', '100.00 с.'],
    ['Ожидается в кассе', '250.00 с.'],
    ['Наличные (факт)', '240.00 с.'],
    ['Расхождение', '-10.00 с.'],
  ])
})

test('показывать нечего — блока нет: незнакомая операция, штрихкод, запись прежней версии программы', () => {
  setLang('ru')
  for (const r of [{ type: 'чего-то-нового', detail: { x: 1 } }, { type: 'deferred.add', detail: {} }, { type: 'sale' }, { type: 'sale', detail: null }, null, undefined]) {
    if (r?.type === 'sale') {
      // У чека без подробностей остаётся только способ оплаты по умолчанию — и он показывается
      assert.equal(rejectedDetail(r, translate, money).lines.length, 0)
      continue
    }
    assert.deepEqual(rejectedDetail(r, translate, money), { facts: [], lines: [] })
    assert.equal(hasRejectedDetail(r, translate, money), false)
  }
  assert.equal(hasRejectedDetail({ type: 'debt.pay', detail: { customer: 'Иван' } }, translate, money), true)
  // Мусор вместо списка позиций экран не роняет
  assert.deepEqual(rejectedDetail({ type: 'writeoff', detail: { reason: 'lost', lines: 'не список' } }, translate, money).lines, [])
})

test('на таджикском подписи переведены', () => {
  setLang('tg')
  try {
    // Буквы и окончания, которых в таджикском нет («э» и «ъ» в нём есть: «Эзоҳ», «баъд»)
    const cyrRu = /[ыщ]|ться|ение/i
    const samples = [
      { type: 'sale', detail: { payment: 'debt', customer: 'Иван', lines: [{ name: 'Нурофен', qty: 2, pieces: 0, unitsPerPack: 1, price: 150, discount: 5 }] } },
      { type: 'return', detail: { refund: 'cash', note: 'x', lines: [{ name: 'Нурофен', units: 1, amount: 150, restock: false }] } },
      { type: 'arrival', detail: { supplier: 'Опт', lines: [{ name: 'Нурофен', qty: 3, cost: 90 }] } },
      { type: 'writeoff', detail: { reason: 'expired', note: 'x', lines: [{ name: 'Нурофен', units: 3 }] } },
      { type: 'customer.create', detail: { phone: '9', debt: 5 } },
      { type: 'shift.close', detail: { openingCash: 1, countedCash: 2, expectedCash: 3, difference: 4, count: 5 } },
    ]
    for (const r of samples) {
      const d = rejectedDetail(r, translate, money)
      for (const f of d.facts) assert.equal(cyrRu.test(f.label), false, `${r.type}: подпись «${f.label}» осталась русской`)
    }
    const sale = rejectedDetail(samples[0], translate, money)
    assert.deepEqual(pairs(sale), [['Пардохт', 'Ба қарз'], ['Мизоҷ', 'Иван']])
    assert.deepEqual(rows(sale), [['Нурофен', '2 қуттӣ × 150.00 с. · тахфиф −5.00 с.']])
    assert.equal(rejectedDetail(samples[1], translate, money).lines[0].text, '1 дона · 150.00 с. · нест карда шуд')
    assert.equal(translate('Что было в операции'), 'Дар амалиёт чӣ буд')
  } finally {
    setLang('ru')
  }
})

test('справочники и правки (1.4.14): что завели, что поменяли — словами, на обоих языках', () => {
  setLang('ru')
  const day = (d) => 'день:' + d.slice(0, 10)
  // Новый товар: по штрихкоду, цене и остатку его заводят заново
  assert.deepEqual(pairs(rejectedDetail({ type: 'product.create', detail: { barcode: '4600001', price: 15, stock: 3 } }, translate, money)), [
    ['Штрихкод', '4600001'],
    ['Цена продажи', '15.00 с.'],
    ['Остаток', '3'],
  ])
  // Правка карточки: какие поля поменяли — так, как назвал бы человек, и новый остаток
  assert.deepEqual(pairs(rejectedDetail({ type: 'product.update', detail: { fields: ['price', 'name'], stock: 7 } }, translate, money)), [
    ['Что поменяли', 'Цена продажи, Название'],
    ['Остаток', '7'],
  ])
  // Остаток не меняли — строки «Остаток» нет; незнакомое поле — как есть
  assert.deepEqual(pairs(rejectedDetail({ type: 'supplier.update', detail: { fields: ['phone', 'чтото'], stock: null } }, translate, money)), [['Что поменяли', 'Телефон, чтото']])
  // Правка и удаление документа: за какой день
  assert.deepEqual(pairs(rejectedDetail({ type: 'expense.update', detail: { date: '2026-10-20T00:00:00.000Z', fields: ['amount'] } }, translate, money, { day })), [
    ['Дата', 'день:2026-10-20'],
    ['Что поменяли', 'Сумма'],
  ])
  assert.deepEqual(pairs(rejectedDetail({ type: 'arrival.delete', detail: {} }, translate, money)), [])
  // Поставщик: телефон и долг на начало; оплата — откуда деньги и примечание
  assert.deepEqual(pairs(rejectedDetail({ type: 'supplier.create', detail: { phone: '900', openingDebt: 250 } }, translate, money)), [
    ['Телефон', '900'],
    ['Долг на начало', '250.00 с.'],
  ])
  assert.deepEqual(pairs(rejectedDetail({ type: 'supplier.pay', detail: { fromCash: true, note: 'за май' } }, translate, money)), [
    ['Оплата', 'из кассы'],
    ['Примечание', 'за май'],
  ])
  setLang('tg')
  try {
    const cyrRu = /[ыщ]|ться|ение/i
    for (const r of [
      { type: 'product.create', detail: { barcode: '1', price: 1, stock: 1 } },
      { type: 'product.update', detail: { fields: ['price', 'name', 'category', 'minStock'], stock: 1 } },
      { type: 'supplier.create', detail: { phone: '9', openingDebt: 5 } },
      { type: 'supplier.pay', detail: { fromCash: true, note: 'x' } },
    ]) {
      for (const f of rejectedDetail(r, translate, money).facts) {
        assert.equal(cyrRu.test(f.label), false, `${r.type}: подпись «${f.label}» осталась русской`)
        assert.equal(cyrRu.test(f.value), false, `${r.type}: значение «${f.value}» осталось русским`)
      }
    }
  } finally {
    setLang('ru')
  }
})
