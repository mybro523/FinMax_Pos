// ── Запросы интерфейса внутри программы для Windows ──
//
// На сайте интерфейс ходит на сервер сам. В программе — через мост к её основной
// части: ключ входа лежит там, а окну сеть закрыта. Дорога другая, но всё, что видит
// человек, обязано остаться прежним: тот же текст отказа, тот же выход при
// недействительной сессии, тот же тихий повтор чтения при обрыве связи.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'

// Хранилище браузера — в памяти
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}
// Ключ входа живёт в хранилище вкладки — в проверках оно устроено так же
globalThis.sessionStorage = globalThis.localStorage

// Подставной мост. Обычного fetch здесь быть не должно вовсе: окно программы
// в сеть не ходит
const calls = []
let answer = () => ({ status: 200, date: null, data: [] })
globalThis.window = {
  apteka: {
    desktop: true,
    request: async (req) => {
      calls.push(req)
      return answer(req)
    },
    session: { clear: async () => true },
    realtime: { start: async () => true, stop: async () => true, on: () => () => {} },
  },
}
globalThis.fetch = async () => {
  throw new Error('интерфейс программы пошёл в сеть сам, мимо моста')
}

const { api, setAuthErrorHandler, LONG_TIMEOUT_MS } = await import('../src/db/api.js')
const { bridge, isDesktop, DESKTOP_TOKEN } = await import('../src/lib/desktop.js')
const { serverSkew } = await import('../src/lib/time.js')

test('интерфейс понимает, что он в программе', () => {
  assert.equal(isDesktop, true)
  assert.equal(bridge, globalThis.window.apteka)
  assert.equal(DESKTOP_TOKEN, 'desktop')
})

test('запрос уходит через мост: путь, а не адрес целиком', async () => {
  calls.length = 0
  answer = () => ({ status: 200, date: null, data: [{ id: 'p1', name: 'Аспирин' }] })
  const list = await api.get('/products')
  assert.deepEqual(list, [{ id: 'p1', name: 'Аспирин' }])
  assert.deepEqual(calls, [{ method: 'GET', path: '/products', body: undefined, timeoutMs: 15000 }])
})

test('тело записи и долгое ожидание доходят до моста как есть', async () => {
  calls.length = 0
  answer = () => ({ status: 201, date: null, data: { id: 's1' } })
  await api.post('/sales', { items: [{ productId: 'p1', qty: 1 }], payment: 'cash' })
  assert.deepEqual(calls[0].body, { items: [{ productId: 'p1', qty: 1 }], payment: 'cash' })
  assert.equal(calls[0].method, 'POST')

  await api.post('/backup/restore', { dump: {} }, { timeout: LONG_TIMEOUT_MS })
  assert.equal(calls[1].timeoutMs, LONG_TIMEOUT_MS)
})

test('отказ сервера звучит тем же текстом, что и на сайте', async () => {
  answer = () => ({ status: 400, date: null, data: { message: 'Недостаточно «Аспирин» на складе (есть 2 шт)' } })
  await assert.rejects(
    () => api.post('/sales', {}),
    (e) => e.message === 'Недостаточно «Аспирин» на складе (есть 2 шт)' && e.status === 400,
  )
  // Несколько замечаний сразу (проверка полей) склеиваются в одну строку
  answer = () => ({ status: 400, date: null, data: { message: ['Укажите название', 'Укажите цену'] } })
  await assert.rejects(() => api.post('/products', {}), (e) => e.message === 'Укажите название, Укажите цену')
  // Отказ без объяснения — хотя бы код
  answer = () => ({ status: 502, date: null, data: null })
  await assert.rejects(() => api.post('/sales', {}), (e) => e.message === 'Ошибка 502' && e.status === 502)
})

test('нет связи — status 0, как на сайте: по нему решают, повторять ли', async () => {
  answer = () => ({ status: 0, date: null, data: null, timedOut: false })
  await assert.rejects(() => api.post('/sales', {}), (e) => e.status === 0 && /Нет связи с сервером/.test(e.message))
  answer = () => ({ status: 0, date: null, data: null, timedOut: true })
  await assert.rejects(() => api.post('/sales', {}), (e) => e.status === 0 && /Сервер не отвечает/.test(e.message))
})

test('мост сам не ответил — для экрана это та же «нет связи»', async () => {
  const prev = globalThis.window.apteka.request
  globalThis.window.apteka.request = async () => {
    throw new Error('основная часть программы недоступна')
  }
  try {
    await assert.rejects(() => api.post('/sales', {}), (e) => e.status === 0 && /Нет связи/.test(e.message))
  } finally {
    globalThis.window.apteka.request = prev
  }
})

test('чтение при обрыве связи тихо повторяется один раз, запись — нет', async () => {
  calls.length = 0
  let n = 0
  answer = () => (++n === 1 ? { status: 0, date: null, data: null } : { status: 200, date: null, data: ['ok'] })
  assert.deepEqual(await api.get('/products'), ['ok'])
  assert.equal(calls.length, 2, 'чтение не повторилось после обрыва')

  calls.length = 0
  answer = () => ({ status: 0, date: null, data: null })
  await assert.rejects(() => api.post('/sales', {}))
  // Повтор записи мог бы провести продажу дважды — его делает слой операций, с ключом повтора
  assert.equal(calls.length, 1)
})

test('недействительная сессия выводит на вход — но не при самом входе', async () => {
  let kicked = 0
  setAuthErrorHandler(() => kicked++)
  sessionStorage.setItem('apteka_token', DESKTOP_TOKEN)

  answer = () => ({ status: 401, date: null, data: { message: 'Сессия недействительна' } })
  await assert.rejects(() => api.post('/sales', {}), (e) => e.status === 401)
  assert.equal(kicked, 1)

  // Неверный пароль — тоже 401, но это не «сессия кончилась»
  await assert.rejects(() => api.post('/auth/login', { name: 'a', password: 'b' }), (e) => e.status === 401)
  assert.equal(kicked, 1)

  // Входа и не было — выводить некуда
  sessionStorage.removeItem('apteka_token')
  await assert.rejects(() => api.post('/sales', {}), (e) => e.status === 401)
  assert.equal(kicked, 1)
  setAuthErrorHandler(() => {})
})

test('пустой ответ (204) — это просто «готово»', async () => {
  answer = () => ({ status: 204, date: null, data: null })
  assert.equal(await api.del('/products/p1'), null)
})

test('часы сверяются с сервером и через мост', async () => {
  const serverTime = new Date(Date.now() + 5 * 60 * 1000)
  answer = () => ({ status: 200, date: serverTime.toUTCString(), data: [] })
  await api.get('/products')
  // Заголовок Date — с точностью до секунды
  assert.ok(Math.abs(serverSkew() - 5 * 60 * 1000) < 2000, `расхождение часов не учтено: ${serverSkew()}`)
})

// ── Объяснения самой программы ──
// Часть отказов пишет не сервер, а программа: она знает, что интернета нет и что
// именно из-за этого не вышло. Такое объяснение человек должен увидеть вместо общего
// «проверьте интернет» — и на своём языке.

const { setLang } = await import('../src/lib/i18n.js')
const ONLINE_ONLY = 'Этот раздел работает только с интернетом. Касса, склад, инвентаризация, товары, поставщики, расходы, доходы и сотрудники доступны и без него.'
const NOT_SENT = 'Эта запись ещё не отправлена на сервер. Изменить или удалить её можно будет после отправки.'

test('«нет связи» с объяснением программы: показываем объяснение, а не общую фразу', async () => {
  answer = () => ({ status: 0, date: null, data: { message: ONLINE_ONLY }, timedOut: false })
  // status остаётся 0: для слоя операций это по-прежнему «связи нет»
  await assert.rejects(() => api.post('/products', {}), (e) => e.status === 0 && e.message === ONLINE_ONLY)
})

test('объяснения программы переводятся на таджикский, незнакомые тексты остаются как есть', async () => {
  setLang('tg')
  try {
    answer = () => ({ status: 0, date: null, data: { message: ONLINE_ONLY } })
    await assert.rejects(() => api.post('/products', {}), (e) => e.status === 0 && /^Ин бахш танҳо бо интернет кор мекунад/.test(e.message))

    answer = () => ({ status: 409, date: null, data: { message: NOT_SENT } })
    await assert.rejects(() => api.del('/arrivals/a1'), (e) => e.status === 409 && /^Ин сабт ҳанӯз ба сервер фиристода нашудааст/.test(e.message))

    // Текст, которого нет в словаре (отказ сервера с названием товара), не портится
    answer = () => ({ status: 400, date: null, data: { message: 'Недостаточно «Аспирин» на складе (есть 2 шт)' } })
    await assert.rejects(() => api.post('/sales', {}), (e) => e.message === 'Недостаточно «Аспирин» на складе (есть 2 шт)')
  } finally {
    setLang('ru')
  }
})
