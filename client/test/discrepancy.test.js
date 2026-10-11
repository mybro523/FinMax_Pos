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
