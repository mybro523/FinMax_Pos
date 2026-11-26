// ── Отложенные товары кассы (1.8.15) ──
//
// Отложенный ТОВАР уходит из корзины в отдельный список на устройстве и не продаётся,
// пока его не вернут. Здесь — без браузера: разбор сохранённого (мусор отбрасывается,
// предел соблюдается), снимок строки, круговой путь чтения/записи, и сверка с базой при
// возврате (osvezhit из lib/cheki.js): исчез, кончился, подорожал, не влез по остатку.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { razobratOtlozh, otlozhitItem, chitatOtlozh, pisatOtlozh, klyuchOtlozh, MAX_OTLOZH, vernutVChek } from '../src/lib/otlozhennye.js'
import { osvezhit, klyuch } from '../src/lib/cheki.js'

const line = (over = {}) => ({ productId: 'p1', name: 'Спирт', price: 60, cost: 40, unitsPerPack: 1, unit: 'шт', stock: 100, looseUnits: 0, qty: 4, pieces: 0, discount: 0, ...over })
const prod = (over = {}) => ({ id: 'p1', name: 'Спирт', price: 60, cost: 40, unitsPerPack: 1, unit: 'шт', stock: 100, looseUnits: 0, ...over })

test('снимок строки: id, время и поля строки чека', () => {
  const it = otlozhitItem(line({ qty: 3, pieces: 2, discount: 5 }))
  assert.ok(it.id && typeof it.id === 'string')
  assert.ok(it.at > 0)
  assert.equal(it.productId, 'p1')
  assert.equal(it.qty, 3)
  assert.equal(it.pieces, 2)
  assert.equal(it.discount, 5)
  assert.equal(it.price, 60)
})

test('разбор: мусор отбрасывается, предел соблюдается, id проставляется', () => {
  assert.deepEqual(razobratOtlozh(null), [])
  assert.deepEqual(razobratOtlozh('не json'), [])
  // Без productId — не строка товара, выкидываем; отрицательное кол-во обнуляется
  const r = razobratOtlozh([{ name: 'нет кода' }, { productId: 'p1', name: 'A', qty: -3 }, { productId: 'p2', name: 'B', qty: 2 }])
  assert.equal(r.length, 2)
  assert.equal(r[0].qty, 0)
  assert.ok(r.every((x) => typeof x.id === 'string' && x.id))
  // Форма { list: [...] } тоже читается
  assert.equal(razobratOtlozh({ list: [{ productId: 'p9', name: 'Z' }] }).length, 1)
  // Больше предела не берём
  const many = Array.from({ length: MAX_OTLOZH + 20 }, (_, i) => ({ productId: 'p' + i, name: 'T' }))
  assert.equal(razobratOtlozh(many).length, MAX_OTLOZH)
})

test('чтение/запись: круговой путь через localStorage', () => {
  const store = {}
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }
  try {
    pisatOtlozh('shop1', [otlozhitItem(line()), otlozhitItem(line({ productId: 'p2', name: 'Вата' }))])
    assert.ok(store[klyuchOtlozh('shop1')], 'записалось под ключом магазина')
    const back = chitatOtlozh('shop1')
    assert.equal(back.length, 2)
    assert.equal(back[0].name, 'Спирт')
    // Чужой магазин — пусто
    assert.deepEqual(chitatOtlozh('shop2'), [])
  } finally {
    delete globalThis.localStorage
  }
})

test('возврат сверяется с базой: исчез, кончился, подорожал, не влез по остатку', () => {
  const it = otlozhitItem(line({ qty: 4 }))

  // Товар удалён из базы — строки не возвращается, помечено «gone»
  const gone = osvezhit([it], [])
  assert.equal(gone.cart.length, 0)
  assert.equal(gone.notes[0]?.kind, 'gone')

  // Товар кончился на складе (остаток 0) — не возвращается, помечено «out»
  const out = osvezhit([it], [prod({ stock: 0 })])
  assert.equal(out.cart.length, 0)
  assert.equal(out.notes[0]?.kind, 'out')

  // Подорожал, пока лежал — цена в строке обновится, помечено «price»
  const pricey = osvezhit([it], [prod({ price: 75 })])
  assert.equal(pricey.cart[0].price, 75)
  assert.ok(pricey.notes.some((n) => n.kind === 'price'))

  // На складе осталось меньше, чем отложено (4 упак., а осталось 2) — урезано, «stock»
  const low = osvezhit([it], [prod({ stock: 2 })])
  assert.equal(low.cart[0].qty, 2)
  assert.ok(low.notes.some((n) => n.kind === 'stock'))
})

test('вернуть в чек: кладёт товар в активный чек кассы, объединяет и не возвращает исчезнувший', () => {
  const store = {}
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }
  try {
    const item = otlozhitItem(line({ qty: 4 }))

    // Пустой чек на устройстве — товар ложится в активный чек
    const ok = vernutVChek('shop1', item, [prod()])
    assert.equal(ok.ok, true)
    let ch = JSON.parse(store[klyuch('shop1')])
    let active = ch.list.find((c) => c.id === ch.active)
    assert.equal(active.cart.length, 1)
    assert.equal(active.cart[0].productId, 'p1')
    assert.equal(active.cart[0].qty, 4)
    // id/время из списка отложенных в строку чека не несём
    assert.ok(!('id' in active.cart[0]) && !('at' in active.cart[0]))

    // Тот же товар уже в чеке — количество складывается (4 + 3 = 7)
    vernutVChek('shop1', otlozhitItem(line({ qty: 3 })), [prod()])
    ch = JSON.parse(store[klyuch('shop1')])
    active = ch.list.find((c) => c.id === ch.active)
    assert.equal(active.cart.length, 1, 'не вторая строка того же товара')
    assert.equal(active.cart[0].qty, 7)

    // Товар удалён из базы — не возвращается
    const gone = vernutVChek('shop1', otlozhitItem(line({ productId: 'nope', name: 'Нет' })), [prod()])
    assert.equal(gone.ok, false)
  } finally {
    delete globalThis.localStorage
  }
})
