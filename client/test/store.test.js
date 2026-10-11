// Гонка сохранения и фонового опроса.
// Именно из-за неё добавленный товар пропадал с экрана до перезагрузки страницы:
// опрос уходил на сервер ДО сохранения, а возвращался ПОСЛЕ — и затирал список
// данными, в которых нового товара ещё нет.
import test from 'node:test'
import assert from 'node:assert/strict'

// Заглушки браузерного окружения — до загрузки слоя данных
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}

const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
// Заголовок Date есть у каждого настоящего ответа — по нему сверяются часы
const jsonRes = (data) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => (k.toLowerCase() === 'date' ? new Date().toUTCString() : null) },
  json: async () => data,
})
const settle = () => new Promise((r) => setTimeout(r, 0))

let serverProducts = []
let getGate = null
let postGate = null
let getCalls = 0

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  if (method === 'GET') {
    getCalls++
    if (getGate) await getGate.promise
    return jsonRes(serverProducts)
  }
  if (method === 'POST') {
    const body = JSON.parse(opts.body)
    const created = { id: 'srv_1', ...body }
    if (postGate) await postGate.promise
    serverProducts = [created]
    return jsonRes(created)
  }
  return jsonRes(null)
}

const { db, fetchKey } = await import('../src/db/store.js')

test('ответ опроса, устаревший из-за сохранения, не стирает новый товар', async () => {
  serverProducts = []
  getGate = deferred()
  postGate = deferred()

  // 1. Опрос ушёл на сервер и завис в пути
  const polling = fetchKey('products')
  await settle()

  // 2. Пользователь сохраняет товар — он обязан появиться сразу
  const saving = db.push('products', { name: 'Алмагель', barcode: '111' })
  await settle()
  assert.equal(db.get('products').length, 1, 'товар показан мгновенно, не дожидаясь сервера')
  assert.equal(db.get('products')[0].name, 'Алмагель')

  // 3. Возвращается ответ опроса — в нём товара ещё нет
  getGate.resolve()
  await polling
  await settle()
  assert.equal(db.get('products').length, 1, 'устаревший ответ не должен стирать сохранённое')
  assert.equal(db.get('products')[0].name, 'Алмагель')

  // 4. Сервер подтверждает сохранение — временная запись становится настоящей
  postGate.resolve()
  const created = await saving
  await settle()
  assert.equal(created.id, 'srv_1')
  const list = db.get('products')
  assert.equal(list.length, 1, 'товар не задвоился')
  assert.equal(list[0].id, 'srv_1', 'на экране запись с сервера, а не временная')
})

test('после сохранения программа сверяется с сервером', async () => {
  serverProducts = []
  getGate = null
  postGate = null
  const before = getCalls
  await db.push('products', { name: 'Но-шпа', barcode: '222' })
  await settle()
  assert.ok(getCalls > before, 'должен уйти сверочный запрос')
  assert.equal(db.get('products').some((p) => p.name === 'Но-шпа'), true)
})

test('неудачное сохранение убирает временную запись', async () => {
  serverProducts = []
  getGate = null
  postGate = null
  const fetchOk = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') return { ok: false, status: 409, json: async () => ({ message: 'Такой штрихкод уже есть' }) }
    return jsonRes(serverProducts)
  }
  await assert.rejects(() => db.push('products', { name: 'Дубль', barcode: '333' }))
  await settle()
  assert.equal(db.get('products').some((p) => p.name === 'Дубль'), false, 'запись, которую сервер не принял, на экране не остаётся')
  globalThis.fetch = fetchOk
})

// ── Товар, заведённый секунду назад, обязан продаваться ──
//
// Новый товар показывается сразу, ещё до ответа сервера, — иначе кассир не смог бы
// завести его и тут же пробить. Живёт он под временным номером, а с ответом сервера
// номер меняется на настоящий.
//
// Кто успел запомнить временный — корзина кассы, отложенный чек, строка прихода —
// для того товар просто исчезал: «Товар не найден» на товар, который прямо на экране.
//
// Так и было на живом сервере. Пряталось за медлительностью: переход между разделами
// занимал вчетверо больше времени, чем ответ сервера, и подмена всегда успевала
// пройти раньше, чем кассир доходил до кассы. Стоило программе стать быстрой —
// и ошибка вылезла в самом дорогом месте.
test('корзина находит товар, даже если он успел сменить номер', async () => {
  const { realId } = await import('../src/db/store.js')

  serverProducts = []
  getGate = null
  postGate = deferred()

  // Кассир завёл товар — на экране он есть, ответа сервера ещё нет
  const saving = db.push('products', { name: 'Цитрамон', barcode: '222' })
  await settle()
  const shown = db.get('products').find((p) => p.name === 'Цитрамон')
  assert.ok(shown.id.startsWith('tmp_'), 'товар должен показаться сразу, под временным номером')

  // Кассир кладёт его в корзину — она запоминает временный номер
  const vKorzine = shown.id

  // Приходит ответ сервера, номер меняется на настоящий
  postGate.resolve()
  await saving
  await settle()
  assert.equal(db.get('products').find((p) => p.name === 'Цитрамон').id, 'srv_1')

  // И корзина обязана всё ещё находить этот товар
  assert.equal(realId(vKorzine), 'srv_1', 'корзина потеряла товар, который лежит на экране')
})

test('обычный номер перевод не портит', async () => {
  const { realId } = await import('../src/db/store.js')
  assert.equal(realId('srv_1'), 'srv_1')
  assert.equal(realId('cmt5bvrun008'), 'cmt5bvrun008')
  assert.equal(realId(undefined), undefined)
})
