// ── Кэш одного магазина не должен попадать на экран другого ──
// Слой данных держит копию списков в хранилище браузера, чтобы интерфейс появлялся
// мгновенно, ещё до ответа сервера. Пока магазин был один, ключ был общий.
//
// Теперь на одном компьютере может работать не одна: владелец сервиса заглянул
// в магазин клиента, вернулся к себе — и до первого ответа сервера видит чужие
// товары. В базе ничего не смешивается, но на экране показывается не то, и заметить
// это невозможно: интерфейс выглядит совершенно обычным.
//
// Запуск: npm test (в папке client).
import test from 'node:test'
import assert from 'node:assert/strict'

// Заглушка хранилища браузера — с length и key(), как у настоящего: слой данных
// перебирает ключи именно так, и заглушка без этих методов ничего бы не проверила
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _keys: () => [...map.keys()],
  }
}

// Слой данных читает хранилище при загрузке, поэтому подставляем его до импорта
const user = (code) => JSON.stringify({ id: '1', name: 'x', role: 'founder', pharmacy: { code, name: code } })

globalThis.localStorage = makeStorage({
  apteka_user: user('shifo'),
  // Кэш соседнего магазина, оставшийся от прошлой работы на этом компьютере
  'apteka_cache_v3_salom_products': JSON.stringify([{ id: 'chuzhoy', name: 'Товар соседей' }]),
  // И остаток от прежней версии ключа, когда он был общим
  'apteka_cache_v2_products': JSON.stringify([{ id: 'stary', name: 'Товар из общего кэша' }]),
})
globalThis.fetch = async () => {
  throw new Error('сеть в этой проверке не нужна')
}
globalThis.document = { visibilityState: 'visible', addEventListener() {}, querySelector: () => null }
globalThis.window = { addEventListener() {}, location: { reload() {} } }

const { db, setCollection, resetStore } = await import('../src/db/store.js')

test('чужой кэш не подхватывается при загрузке', () => {
  // В хранилище лежат товары магазина «salom» и остаток общего кэша, а вошли
  // мы в «shifo» — на экране не должно оказаться ни того, ни другого
  const products = db.get('products')
  assert.deepEqual(products, [], `подхватился чужой кэш: ${JSON.stringify(products)}`)
})

test('свой кэш сохраняется под ключом с кодом магазина', () => {
  setCollection('products', [{ id: 'moy', name: 'Свой товар' }])
  const keys = localStorage._keys()
  assert.ok(keys.includes('apteka_cache_v3_shifo_products'), `нет ключа своего магазина: ${keys.join(', ')}`)
  // Чужой ключ при этом не тронут — мы в него не пишем
  assert.equal(
    localStorage.getItem('apteka_cache_v3_salom_products'),
    JSON.stringify([{ id: 'chuzhoy', name: 'Товар соседей' }]),
    'запись в свой кэш задела чужой',
  )
})

test('сброс убирает кэш всех магазинов, а не только своего', () => {
  // Сброс делается при выходе и при смене того, кто работает. Оставлять после
  // себя чужие данные незачем — как и остатки от прежних версий ключа.
  resetStore()
  const left = localStorage._keys().filter((k) => k.startsWith('apteka_cache_'))
  assert.deepEqual(left, [], `после сброса остался кэш: ${left.join(', ')}`)
  // А вот запись о том, кто вошёл, сбросу кэша не подлежит: ею занимается выход
  assert.ok(localStorage.getItem('apteka_user'), 'сброс кэша снёс лишнее')
})
