// ── Основной или запасной адрес сервера (db/apiBase.js, 04.11.2026) ──
//
// 04.11 у регистратора домена отказали DNS: api.finmaxpos.tj перестал находиться, сайт писал
// «Нет связи с сервером», хотя сервер работал под своим именем у OVH. Теперь сайт спрашивает
// оба адреса и работает с тем, что ответил; основному — фора.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createBaseChooser } from '../src/db/apiBase.js'

const P = 'https://api.finmaxpos.tj/api'
const F = 'https://vps-04688c58.vps.ovh.net/api'
const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
const never = () => new Promise(() => {})

// probe по адресам: что ответить и когда; считает вызовы
function probes(map) {
  const calls = []
  return {
    calls,
    probe: (base) => {
      calls.push(base)
      const v = map[base]
      return typeof v === 'function' ? v() : v
    },
  }
}

test('запасного нет — выбирать нечего: основной сразу, без проверок', async () => {
  const pr = probes({})
  const c = createBaseChooser({ primary: '/api', fallback: '', probe: pr.probe })
  assert.equal(c.chosen(), true)
  assert.equal(await c.ready(), '/api')
  assert.equal(await c.failed(), '/api')
  assert.deepEqual(pr.calls, [])
})

test('основной отвечает — работаем с ним, даже если запасной ответил раньше', async () => {
  const pr = probes({ [P]: () => later(20, true), [F]: true })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, preferMs: 200 })
  assert.equal(c.chosen(), false)
  assert.equal(c.current(), P, 'до выбора — основной')
  assert.equal(await c.ready(), P)
  assert.equal(c.chosen(), true)
})

test('основной не находится (как 04.11) — сразу запасной, и об этом узнают подписчики', async () => {
  const pr = probes({ [P]: () => Promise.reject(new TypeError('Failed to fetch')), [F]: () => later(10, true) })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, preferMs: 5000 })
  const changes = []
  c.onChange((b) => changes.push(b))
  const t0 = Date.now()
  assert.equal(await c.ready(), F)
  assert.ok(Date.now() - t0 < 1000, 'фору не ждали: основной уже отказал')
  assert.equal(c.current(), F)
  assert.deepEqual(changes, [F])
})

test('основной молчит (DNS не отвечает) — запасной после форы', async () => {
  const pr = probes({ [P]: never, [F]: true })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, preferMs: 60 })
  const t0 = Date.now()
  assert.equal(await c.ready(), F)
  assert.ok(Date.now() - t0 >= 50, 'основному дали фору')
})

test('оба молчат — остаёмся на основном: ошибку покажет сам запрос', async () => {
  const pr = probes({ [P]: false, [F]: false })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  assert.equal(await c.ready(), P)
})

test('выбор один на все запросы, сколько бы их ни ждало', async () => {
  const pr = probes({ [P]: () => later(20, true), [F]: () => later(20, true) })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  const all = await Promise.all([c.ready(), c.ready(), c.ready()])
  assert.deepEqual(all, [P, P, P])
  assert.equal(pr.calls.length, 2, 'каждый адрес спросили один раз')
})

test('основной отказал посреди работы — выбор заново (не чаще раза в recheckMs), переход на запасной', async () => {
  let primaryUp = true
  let clock = 0
  const pr = probes({ [P]: () => primaryUp, [F]: true })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, now: () => clock, recheckMs: 20000, preferMs: 50 })
  assert.equal(await c.ready(), P)
  primaryUp = false
  // Сразу после выбора — не перепроверяем (запросы сыплются пачкой)
  clock = 5000
  assert.equal(await c.failed(), P)
  // Прошло достаточно — выбираем заново и уходим на запасной
  clock = 30000
  assert.equal(await c.failed(), F)
  assert.equal(c.current(), F)
})
