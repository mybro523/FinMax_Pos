// ── Логотип магазина: что показывать и когда забирать заново (lib/logoSync.js, 1.6.4) ──
//
// Два круга ревью нашли здесь ошибки при зелёных тестах: сигнал «магазин изменился» и «кто я»
// расходятся по времени, ответы сервера обгоняют друг друга, связь пропадает. Здесь —
// все эти случаи на заглушке сервера.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLogoSync } from '../src/lib/logoSync.js'

const L1 = 'data:image/png;base64,AAAA'
const L2 = 'data:image/jpeg;base64,/9j/BBBB'
const T1 = '2026-11-01T15:00:00.000Z'
const T2 = '2026-11-02T09:00:00.000Z'

// Сервер-заглушка /shop/logo: отвечает, как настоящий (та же отметка — коротко), пишет вызовы
function server(now = { logo: L1, at: T1 }) {
  const s = { now, calls: [], fail: false }
  const get = async (path) => {
    s.calls.push(path)
    if (s.fail) throw new Error('нет связи')
    const known = new URLSearchParams(path.split('?')[1] || '').get('at')
    if (s.now.at && s.now.logo && known === s.now.at) return { at: s.now.at, same: true }
    return s.now.at ? { logo: s.now.logo, at: s.now.at } : { logo: '', at: null }
  }
  return { s, get }
}
const user = (code, logoAt) => ({ pharmacy: { code, name: 'Шифо', ...(logoAt !== undefined ? { logoAt } : {}) } })
const AT1 = '/shop/logo?at=' + encodeURIComponent(T1)

test('вход: картинка забирается один раз; сотни чеков за смену её не трогают', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await l.settled()
  assert.equal(l.logoFor('a'), L1)
  for (let i = 0; i < 5; i++) l.sync(user('a', T1))
  await l.settled()
  assert.deepEqual(s.calls, ['/shop/logo'])
})

test('логотипа нет («кто я»: null) — без запроса', async () => {
  const { s, get } = server({ logo: '', at: null })
  const l = createLogoSync(get)
  l.sync(user('a', null))
  await l.settled()
  assert.equal(l.logoFor('a'), '')
  assert.deepEqual(s.calls, [])
})

test('сигнал «магазин изменился»: та же картинка — коротко; новая — заменяется; прежний «кто я» её не стирает и не качает заново', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await l.settled()
  l.changed()
  await l.settled()
  assert.equal(s.calls.at(-1), AT1, 'сверка со своей отметкой')
  assert.equal(l.logoFor('a'), L1)
  s.now = { logo: L2, at: T2 }
  l.changed()
  await l.settled()
  assert.equal(l.logoFor('a'), L2)
  const n = s.calls.length
  // «Кто я» в памяти окна ещё прежний (T1) — новые чеки монтируются с ним
  for (let i = 0; i < 3; i++) l.sync(user('a', T1))
  // Потом «кто я» обновился (T2) — картинка та же, что показана
  l.sync(user('a', T2))
  await l.settled()
  assert.equal(l.logoFor('a'), L2)
  assert.equal(s.calls.length, n, 'ни одного лишнего запроса')
})

test('логотип поставили при открытой кассе: «кто я» ещё говорит «нет», а чеки его не стирают', async () => {
  const { s, get } = server({ logo: '', at: null })
  const l = createLogoSync(get)
  l.sync(user('a', null))
  s.now = { logo: L1, at: T1 }
  l.changed()
  await l.settled()
  assert.equal(l.logoFor('a'), L1)
  const n = s.calls.length
  for (let i = 0; i < 3; i++) l.sync(user('a', null))
  await l.settled()
  assert.equal(l.logoFor('a'), L1, 'новые чеки логотип не стёрли')
  assert.equal(s.calls.length, n)
})

test('«кто я» отстал и говорит «нет», а логотип есть: сверка с сервером, а не стирание', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await l.settled()
  l.sync(user('a', null))
  await l.settled()
  assert.equal(s.calls.at(-1), AT1)
  assert.equal(l.logoFor('a'), L1, 'сервер подтвердил — логотип на месте')
  // А теперь его действительно убрали
  s.now = { logo: '', at: null }
  l.changed()
  await l.settled()
  assert.equal(l.logoFor('a'), '')
})

test('ответы не по порядку: запоздавший прежний не затирает новый', async () => {
  let release
  const slow = new Promise((r) => (release = r))
  const calls = []
  const get = async (path) => {
    calls.push(path)
    if (calls.length === 1) {
      await slow
      return { logo: L1, at: T1 }
    }
    return { logo: L2, at: T2 }
  }
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await new Promise((r) => setTimeout(r, 0))
  l.changed() // пришёл сигнал, пока первый запрос ещё едет
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(l.logoFor('a'), L2)
  release()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(l.logoFor('a'), L2, 'старый ответ пришёл позже — не принят')
})

test('ошибка связи: следующий чек пробует снова, а не остаётся без логотипа до перезагрузки', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  s.fail = true
  l.sync(user('a', T1))
  await l.settled()
  assert.equal(l.logoFor('a'), '')
  s.fail = false
  l.sync(user('a', T1))
  await l.settled()
  assert.equal(l.logoFor('a'), L1)
  assert.equal(s.calls.length, 2)
})

test('выход и вход в другой магазин: чужой логотип не показывается ни мгновения', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await l.settled()
  l.sync(null)
  assert.equal(l.logoFor('a'), '')
  s.now = { logo: L2, at: T2 }
  l.sync(user('b', T2))
  assert.equal(l.logoFor('b'), '', 'пока картинка магазина b не пришла — пусто, а не логотип a')
  assert.equal(l.logoFor('a'), '')
  await l.settled()
  assert.equal(l.logoFor('b'), L2)
})

test('связь вернулась: сверка по отметке; если запрос уже идёт — второго нет', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  l.reconnected() // вход и подключение совпали — запрос уже идёт
  await l.settled()
  assert.deepEqual(s.calls, ['/shop/logo'])
  l.reconnected()
  await l.settled()
  assert.deepEqual(s.calls, ['/shop/logo', AT1])
  assert.equal(l.logoFor('a'), L1)
})

test('программа без связи («кто я» без отметки): забранное у кассы — нынешнее, не перезапрашивается', async () => {
  const { s, get } = server()
  const l = createLogoSync(get)
  l.sync(user('a', undefined))
  await l.settled()
  assert.equal(l.logoFor('a'), L1)
  l.sync(user('a', undefined))
  await l.settled()
  assert.equal(s.calls.length, 1)
})

test('в окно попадает только картинка PNG или JPEG', async () => {
  const { s, get } = server({ logo: 'javascript:alert(1)', at: T1 })
  const l = createLogoSync(get)
  l.sync(user('a', T1))
  await l.settled()
  assert.equal(l.logoFor('a'), '')
  s.now = { logo: 'data:image/webp;base64,UklGRg==', at: T2 }
  l.changed()
  await l.settled()
  assert.equal(l.logoFor('a'), '')
})
