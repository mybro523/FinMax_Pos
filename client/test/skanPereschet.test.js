// ── Пересчёт сканером (1.7.2) ──
//
// Каждый скан — плюс одна упаковка (штук в ней), мешок весового товара — как штучный,
// весовой без мешка сканом не считают. Список отбора: свежий скан — наверху, повтор —
// та же строка. Насчитанное отбором переходит в поля «по факту» созданного листа.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const {
  MAX_PICKED, izOtbora, naverh, otborNachat, plusSkan, polyaIzOtbora, poryadokStrok, readOtbor, skanVPole, vOtbor, vOtboreStavim, writeOtbor, zaSkan,
  zhivyeVOtbore,
} = await import('../src/lib/skanPereschet.js')
const { productByCode } = await import('../src/lib/pick.js')

const box = { id: 'box', unit: 'уп', unitsPerPack: 1 }
const pills = { id: 'pills', unit: 'уп', unitsPerPack: 10 }
const kg = { id: 'kg', unit: 'кг', unitsPerPack: 1000 }
const sack = { id: 'sack', unit: 'кг', unitsPerPack: 50000 }

test('сколько прибавляет скан', () => {
  assert.equal(zaSkan(box), 1)
  assert.equal(zaSkan(pills), 10)
  assert.equal(zaSkan(sack), 50000)
  assert.equal(zaSkan(kg), null)
  assert.equal(zaSkan(null), null)
})

test('насчитанное после скана', () => {
  assert.equal(plusSkan(null, box), 1)
  assert.equal(plusSkan('', pills), 10)
  assert.equal(plusSkan(3, pills), 13)
  assert.equal(plusSkan('7', box), 8)
  // Весовой без мешка: скан ничего не прибавляет
  assert.equal(plusSkan(null, kg), null)
  assert.equal(plusSkan(2500, kg), 2500)
  // Больше девяти цифр поле не примет — дальше не растёт
  assert.equal(plusSkan(999999999, box), 999999999)
})

test('список отбора: свежий скан наверху, повтор — та же строка плюс упаковка', () => {
  let l = []
  l = vOtbor(l, box)
  l = vOtbor(l, pills)
  l = vOtbor(l, box)
  l = vOtbor(l, kg)
  assert.deepEqual(l, [
    { productId: 'kg', units: null },
    { productId: 'box', units: 2 },
    { productId: 'pills', units: 10 },
  ])
  l = vOtboreStavim(l, 'kg', 1250)
  l = vOtboreStavim(l, 'pills', '')
  assert.deepEqual(l.map((r) => r.units), [1250, 2, null])
  l = izOtbora(l, 'box')
  assert.deepEqual(l.map((r) => r.productId), ['kg', 'pills'])
  // Товар удалили на другом устройстве — строки нет ни на экране, ни в листе
  assert.deepEqual(zhivyeVOtbore(l, [kg]).map((r) => r.productId), ['kg'])
})

test('полный список новых товаров не берёт, а уже отобранные считает', () => {
  const full = Array.from({ length: MAX_PICKED }, (_, i) => ({ productId: 'p' + i, units: 1 }))
  assert.equal(vOtbor(full, box), full)
  const again = vOtbor(full, { id: 'p5', unitsPerPack: 1 })
  assert.equal(again[0].productId, 'p5')
  assert.equal(again[0].units, 2)
})

test('насчитанное отбором — в поля «по факту» созданного листа', () => {
  const sheet = {
    items: [
      { id: 'i1', productId: 'box' },
      { id: 'i2', productId: 'pills' },
      { id: 'i3', productId: 'kg' },
      { id: 'i4', productId: null },
    ],
  }
  const fields = polyaIzOtbora(sheet, [
    { productId: 'box', units: 3 },
    { productId: 'pills', units: 20 },
    { productId: 'kg', units: null },
  ])
  assert.deepEqual(fields, { i1: '3', i2: '20' })
})

test('порядок строк листа: отсканированные наверху, свежий первым', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  let top = []
  top = naverh(top, 'c')
  top = naverh(top, 'a')
  top = naverh(top, 'c')
  assert.deepEqual(top, ['c', 'a'])
  assert.deepEqual(poryadokStrok(items, top).map((i) => i.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(poryadokStrok(items, []).map((i) => i.id), ['a', 'b', 'c', 'd'])
})

test('список отбора переживает уход со страницы, у каждого магазина свой; помнит первый скан', () => {
  writeOtbor('shop1', [{ productId: 'box', units: 1 }], 1000)
  writeOtbor('shop1', [{ productId: 'box', units: 2 }], 5000)
  writeOtbor('shop2', [{ productId: 'kg', units: null }], 7000)
  assert.deepEqual(readOtbor('shop1'), [{ productId: 'box', units: 2 }])
  // Момент — первого скана списка, а не последнего
  assert.equal(otborNachat('shop1'), 1000)
  assert.deepEqual(JSON.parse(store.get('finmax_inv_pick_shop2')), { at: 7000, list: [{ productId: 'kg', units: null }] })
  writeOtbor('shop1', [])
  assert.equal(store.has('finmax_inv_pick_shop1'), false)
  assert.equal(otborNachat('shop1'), 0)
  // Новый список — новый момент
  writeOtbor('shop1', [{ productId: 'box', units: 1 }], 9000)
  assert.equal(otborNachat('shop1'), 9000)
})

test('испорченная запись в хранилище — пустой список, а не ошибка', async () => {
  store.set('finmax_inv_pick_bad', '{не json')
  store.set('finmax_inv_pick_odd', JSON.stringify({ at: 'вчера', list: [{ productId: 'a', units: -5 }, { productId: 'a', units: 1 }, { units: 3 }, 'x', { productId: 'b', units: 2.5 }, { productId: 'c', units: 4 }] }))
  store.set('finmax_inv_pick_arr', JSON.stringify([{ productId: 'a', units: 1 }]))
  // Свежий модуль: в памяти прежнего эти магазины ещё не читались, но так нагляднее
  const fresh = await import('../src/lib/skanPereschet.js?fresh')
  assert.deepEqual(fresh.readOtbor('bad'), [])
  assert.deepEqual(fresh.readOtbor('odd'), [{ productId: 'a', units: 1 }, { productId: 'c', units: 4 }])
  assert.equal(fresh.otborNachat('odd'), 0)
  assert.deepEqual(fresh.readOtbor('arr'), [])
})

test('скан не в то поле: код известного товара из восьми и больше цифр — это скан', () => {
  const products = [{ id: 'a', barcode: '4870204010022' }, { id: 'b', barcode: '12345678' }]
  assert.deepEqual(skanVPole('4870204010022', products, productByCode), { product: products[0], len: 13 })
  assert.equal(skanVPole('12345678', products, productByCode)?.product.id, 'b')
  // Набрали «7» руками и, не нажав Enter, отсканировали: код — в конце набора
  assert.deepEqual(skanVPole('74870204010022', products, productByCode), { product: products[0], len: 13 })
  assert.deepEqual(skanVPole('1.54870204010022', products, productByCode), { product: products[0], len: 13 })
  // Количество руками: короткое число, дробь, незнакомый код — не скан
  assert.equal(skanVPole('15', products, productByCode), null)
  assert.equal(skanVPole('1.25', products, productByCode), null)
  assert.equal(skanVPole('99999999', products, productByCode), null)
  assert.equal(skanVPole('', products, productByCode), null)
})
