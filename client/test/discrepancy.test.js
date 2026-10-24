// Расхождения с касс: сервер присылает вид и числа, слова подбирает интерфейс.
// Здесь проверяется, что у каждого вида есть свой понятный текст — и на обоих языках.
import test from 'node:test'
import assert from 'node:assert/strict'
import { discrepancyAdvice, discrepancyDetail, discrepancyTitle } from '../src/lib/discrepancy.js'
import { setLang, translate } from '../src/lib/i18n.js'

const money = (n) => Number(n).toFixed(2) + ' с.'
const KINDS = ['sale', 'writeoff', 'price', 'return', 'counted', 'debt']

test('у каждого вида расхождения свой заголовок и свой совет', () => {
  setLang('ru')
  const titles = KINDS.map((k) => discrepancyTitle(k, translate))
  assert.equal(new Set(titles).size, KINDS.length, 'заголовки совпали: ' + titles.join(' | '))
  assert.equal(discrepancyTitle('sale', translate), 'Продано больше, чем было на складе')
  assert.equal(discrepancyTitle('price', translate), 'Цена в чеке не та, что была в базе')
  for (const k of KINDS) assert.ok(discrepancyAdvice(k, translate).length > 10, k)
})

test('подробность называет числа: штуки или обе цены', () => {
  setLang('ru')
  assert.equal(discrepancyDetail({ kind: 'sale', units: 3 }, translate, money), 'сверх остатка 3 шт')
  assert.equal(discrepancyDetail({ kind: 'writeoff', units: 1 }, translate, money), 'сверх остатка 1 шт')
  assert.equal(discrepancyDetail({ kind: 'return', units: 2 }, translate, money), 'лишних 2 шт')
  assert.equal(discrepancyDetail({ kind: 'counted', units: 3 }, translate, money), '3 шт — остаток не менялся')
  assert.equal(discrepancyDetail({ kind: 'debt', units: 0, checkPrice: 100, basePrice: 40 }, translate, money), 'принято 100.00 с., долг был 40.00 с.')
  assert.equal(
    discrepancyDetail({ kind: 'price', units: 1, checkPrice: 150, basePrice: 175 }, translate, money),
    'в чеке 150.00 с., в базе 175.00 с.',
  )
})

test('незнакомый вид не роняет экран: показывается общим словом', () => {
  setLang('ru')
  assert.equal(discrepancyTitle('чего-то-нового', translate), 'Расхождение')
  assert.equal(discrepancyDetail({ kind: 'чего-то-нового', units: 4 }, translate, money), 'сверх остатка 4 шт')
})

test('на таджикском все тексты переведены', () => {
  setLang('tg')
  try {
    const cyrRu = /[ыэъщ]|ться|ение/i
    for (const k of KINDS) {
      const title = discrepancyTitle(k, translate)
      const advice = discrepancyAdvice(k, translate)
      assert.ok(!cyrRu.test(title), `заголовок «${k}» остался русским: ${title}`)
      assert.ok(!cyrRu.test(advice), `совет «${k}» остался русским: ${advice}`)
    }
    assert.equal(discrepancyDetail({ kind: 'sale', units: 3 }, translate, money), 'зиёда аз бақия 3 дона')
    assert.equal(discrepancyDetail({ kind: 'counted', units: 3 }, translate, money), '3 дона — бақия тағйир наёфт')
    assert.equal(discrepancyDetail({ kind: 'debt', units: 0, checkPrice: 100, basePrice: 40 }, translate, money), 'қабул шуд 100.00 с., қарз буд 40.00 с.')
    assert.equal(
      discrepancyDetail({ kind: 'price', units: 1, checkPrice: 150, basePrice: 175 }, translate, money),
      'дар чек 150.00 с., дар пойгоҳ 175.00 с.',
    )
  } finally {
    setLang('ru')
  }
})

// ── Правки без связи (версия 1.4.14): правка в двух местах, дубль штрихкода, переплата ──
test('правка карточки в двух местах: по каждому полю — что на кассе, что на сайте и чья осталась', () => {
  setLang('ru')
  const note = JSON.stringify({ tbl: 'Product', fields: [{ field: 'price', kassa: 170, server: 160, won: 'kassa' }, { field: 'name', kassa: 'Нурофен форте', server: 'Нурофен 200', won: 'server' }] })
  assert.equal(discrepancyTitle('edit', translate), 'Правку сделали и на кассе без связи, и на сайте')
  assert.equal(
    discrepancyDetail({ kind: 'edit', note }, translate, money),
    'Цена продажи: на кассе 170.00 с., на сайте 160.00 с. — осталась правка кассы; Название: на кассе Нурофен форте, на сайте Нурофен 200 — осталась правка сайта',
  )
  assert.equal(discrepancyDetail({ kind: 'edit', note: JSON.stringify({ gone: true }) }, translate, money), 'запись удалили, пока касса была без связи, — правка с кассы не применена')
  assert.equal(discrepancyDetail({ kind: 'edit', note: JSON.stringify({ deleteKept: true }) }, translate, money), 'удаление с кассы не применено: запись поправили позже')
  // Подробности испорчены — экран не падает
  assert.equal(discrepancyDetail({ kind: 'edit', note: '{битые' }, translate, money), 'правку сделали в двух местах')
})

test('дубль штрихкода и переплата поставщику — своими словами, на обоих языках', () => {
  setLang('ru')
  const note = JSON.stringify({ barcode: '4600000000031', internal: '2001234567890', other: { id: 'p1', name: 'Анальгин' } })
  assert.equal(discrepancyDetail({ kind: 'barcode', note }, translate, money), 'код 4600000000031 уже у товара «Анальгин» — принят с кодом 2001234567890')
  assert.equal(discrepancyDetail({ kind: 'supdebt', checkPrice: 300, basePrice: 200 }, translate, money), 'оплачено 300.00 с., долг был 200.00 с.')
  for (const k of ['edit', 'barcode', 'supdebt']) assert.ok(discrepancyAdvice(k, translate).length > 10, k)
  setLang('tg')
  try {
    // «ъ» в таджикском своя (таъминкунанда, таърих) — по ней русский текст не узнать
    const cyrRu = /[ыэщ]|ться|ение/i
    for (const k of ['edit', 'barcode', 'supdebt']) {
      assert.ok(!cyrRu.test(discrepancyTitle(k, translate)), k)
      assert.ok(!cyrRu.test(discrepancyAdvice(k, translate)), k)
    }
  } finally {
    setLang('ru')
  }
})

test('остаток кассы на объединённой карточке и долг на начало у поставщика-двойника — словами', () => {
  setLang('ru')
  assert.equal(
    discrepancyDetail({ kind: 'edit', note: JSON.stringify({ tbl: 'Product', merged: true, stock: 7 }) }, translate, money),
    'остаток с кассы не применён: эту карточку уже объединили с другой (на кассе насчитали 7 шт)',
  )
  assert.equal(
    discrepancyDetail({ kind: 'edit', note: JSON.stringify({ tbl: 'Supplier', sameName: true, openingDebt: 500 }) }, translate, money),
    'поставщик с таким названием уже был — долг на начало с кассы к нему не прибавлен: 500.00 с.',
  )
  setLang('tg')
  try {
    const cyrRu = /[ыэщ]|ться|ение/i
    for (const note of [{ merged: true, stock: 7 }, { sameName: true, openingDebt: 500 }]) {
      assert.ok(!cyrRu.test(discrepancyDetail({ kind: 'edit', note: JSON.stringify(note) }, translate, money)), JSON.stringify(note))
    }
  } finally {
    setLang('ru')
  }
})
