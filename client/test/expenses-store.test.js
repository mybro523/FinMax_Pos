// ── Расходы в слое данных: по какому адресу и что уходит на сервер ──
//
// У раздела статей расходов адрес на сервере пишется иначе, чем его имя в программе
// («expense-categories», а не «expenseCategories»). Ошибись слой данных адресом —
// список статей молча остался бы пустым, а новая статья не сохранялась бы.
//
// И расход обязан уйти с ключом повтора: связь в магазине моргает, запрос
// переигрывается, и без ключа аренда записалась бы дважды.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'

const ls = new Map()
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
}

const calls = []
let failNext = 0
// Расходы «на сервере»: слой данных после каждой записи сверяется с ним
let serverExpenses = []
const res = (data, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'date' ? new Date().toUTCString() : null) },
  json: async () => data,
  text: async () => JSON.stringify(data),
})
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  const path = String(url).replace(/^.*\/api/, '')
  const body = opts.body ? JSON.parse(opts.body) : undefined
  calls.push({ method, path, body })
  if (method !== 'GET' && failNext > 0) {
    failNext--
    throw new TypeError('fetch failed')
  }
  if (method === 'POST' && path === '/expenses') {
    const created = { id: 'e-' + calls.length, ...body, date: '2026-10-07T07:00:00.000Z' }
    serverExpenses = [created, ...serverExpenses]
    return res(created)
  }
  if (method === 'POST' && path === '/expense-categories') return res({ id: 'c-1', ...body })
  if (method === 'PATCH') {
    const id = path.split('/').pop()
    serverExpenses = serverExpenses.map((e) => (e.id === id ? { ...e, ...body } : e))
    return res(serverExpenses.find((e) => e.id === id))
  }
  if (method === 'DELETE' && path.startsWith('/expenses/')) serverExpenses = serverExpenses.filter((e) => e.id !== path.split('/').pop())
  if (method === 'GET') return res(path.startsWith('/expenses?') ? serverExpenses : [])
  return res({ ok: true })
}

const { db, fetchKey, pathOf, loadRange } = await import('../src/db/store.js')
const { addExpense, updateExpense, removeExpense } = await import('../src/db/ops.js')
const settle = () => new Promise((r) => setTimeout(r, 0))
const last = (method) => calls.filter((c) => c.method === method).at(-1)

test('адрес раздела: статьи расходов лежат по своему адресу, остальные — по имени', () => {
  assert.equal(pathOf('expenseCategories'), '/expense-categories')
  assert.equal(pathOf('expenses'), '/expenses')
  assert.equal(pathOf('products'), '/products')
})

test('расходы и статьи запрашиваются по своим адресам; расходы — за полгода', async () => {
  calls.length = 0
  await fetchKey('expenses')
  await fetchKey('expenseCategories')
  assert.deepEqual(calls.map((c) => c.path), ['/expenses?days=180', '/expense-categories'])
  calls.length = 0
  await loadRange('expenses', null, null)
  assert.equal(calls[0].path, '/expenses?days=0', 'за всё время — отдельным запросом')
})

test('своя статья сохраняется и убирается по адресу статей', async () => {
  calls.length = 0
  const created = await db.push('expenseCategories', { name: 'Охрана' })
  assert.equal(created.id, 'c-1')
  assert.deepEqual(last('POST'), { method: 'POST', path: '/expense-categories', body: { name: 'Охрана' } })
  await db.remove('expenseCategories', 'c-1')
  assert.equal(last('DELETE').path, '/expense-categories/c-1')
  await settle()
})

test('обычный расход уходит с датой и ключом повтора, без отметки «из кассы»', async () => {
  calls.length = 0
  const e = await addExpense({ date: '2026-10-01', category: 'Аренда', amount: '1500.456', note: '  за октябрь ', fromCash: false, shiftId: null })
  const sent = last('POST').body
  assert.equal(sent.category, 'Аренда')
  assert.equal(sent.amount, 1500.46, 'сумма — до копеек')
  assert.equal(sent.note, 'за октябрь')
  assert.equal(sent.date, '2026-10-01')
  assert.ok(/^exp_.{10,}/.test(sent.clientId), 'ключ повтора: ' + sent.clientId)
  assert.ok(!('fromCash' in sent) && !('shiftId' in sent), 'лишнего в запросе нет')
  assert.equal(db.get('expenses')[0].id, e.id, 'расход сразу в списке')
  await settle()
})

test('расход из кассы уходит со сменой и без даты: дату ставит сервер', async () => {
  calls.length = 0
  await addExpense({ date: '2026-10-01', category: 'Транспорт', amount: 40, note: '', fromCash: true, shiftId: 'shift-7' })
  const sent = last('POST').body
  assert.equal(sent.fromCash, true)
  assert.equal(sent.shiftId, 'shift-7')
  assert.ok(!('date' in sent), 'дата расхода из кассы — «сейчас», её не присылают')
  await settle()
  // Смена изменилась — её перечитывают вместе с расходами
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/shifts'), 'смены перечитаны')
})

test('обрыв связи: запрос переигрывается с тем же ключом повтора', async () => {
  calls.length = 0
  failNext = 1
  await addExpense({ date: '2026-10-02', category: 'Налоги', amount: 10, note: '' })
  const posts = calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 2, 'вторая попытка после обрыва')
  assert.equal(posts[0].body.clientId, posts[1].body.clientId, 'ключ тот же — второго расхода сервер не заведёт')
  await settle()
})

test('правка и удаление идут по номеру расхода и обновляют список', async () => {
  calls.length = 0
  const e = await addExpense({ date: '2026-10-02', category: 'Аренда', amount: 5, note: '' })
  const updated = await updateExpense(e, { amount: 7 })
  assert.deepEqual(last('PATCH'), { method: 'PATCH', path: '/expenses/' + e.id, body: { amount: 7 } })
  assert.equal(db.get('expenses').find((x) => x.id === e.id).amount, 7)
  assert.equal(updated.amount, 7)
  await removeExpense(e)
  assert.equal(last('DELETE').path, '/expenses/' + e.id)
  assert.equal(db.get('expenses').some((x) => x.id === e.id), false, 'удалённого расхода в списке нет')
  await settle()
})
