// ── Основной или запасной адрес сервера (db/apiBase.js, 04.11.2026) ──
//
// 04.11 у регистратора домена отказали DNS: api.finmaxpos.tj перестал находиться, сайт писал
// «Нет связи с сервером», хотя сервер работал под своим именем у OVH. Теперь сайт спрашивает
// оба адреса и работает с тем, что ответил; основному — фора. 05.11: выбор начинается в фоне,
// ожидание можно ограничить, основной проверяется снова, пока работа идёт через запасной.
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
  assert.equal(c.reachable(), true)
  c.stop()
})

test('основной молчит (DNS не отвечает) — запасной после форы', async () => {
  const pr = probes({ [P]: never, [F]: true })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, preferMs: 60 })
  const t0 = Date.now()
  assert.equal(await c.ready(), F)
  assert.ok(Date.now() - t0 >= 50, 'основному дали фору')
})

test('оба молчат — остаёмся на основном: ошибку покажет сам запрос, а сервер «недоступен»', async () => {
  const pr = probes({ [P]: false, [F]: false })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  assert.equal(c.reachable(), null, 'до выбора — неизвестно')
  assert.equal(await c.ready(), P)
  assert.equal(c.reachable(), false)
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
  c.stop()
})

test('фора основному по умолчанию короткая — 0,3 с, а не полторы', async () => {
  const pr = probes({ [P]: never, [F]: true })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  const t0 = Date.now()
  assert.equal(await c.ready(), F)
  const took = Date.now() - t0
  assert.ok(took >= 250 && took < 1000, 'ждали ' + took + ' мс')
  c.stop()
})

test('ограниченное ожидание: не успели выбрать — null, выбор идёт дальше и отвечает следующим', async () => {
  const pr = probes({ [P]: () => later(120, false), [F]: () => later(120, false) })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  assert.equal(await c.ready(30), null, 'за 30 мс не решилось')
  assert.equal(c.chosen(), false)
  assert.equal(await c.ready(), P, 'выбор тот же самый, не новый')
  assert.equal(pr.calls.length, 2)
  assert.equal(c.reachable(), false)
  assert.equal(await c.ready(0), P, 'решено — ответ сразу')
})

// Таймеры по команде: возврат на основной ждёт 5 минут — в проверке их «проматываем»
function manualTimers() {
  const list = new Map()
  let id = 0
  return {
    timers: {
      set: (fn, ms) => {
        list.set(++id, { fn, ms })
        return id
      },
      clear: (t) => list.delete(t),
    },
    // Запустить все таймеры не короче ms (возврат на основной), вернуть, сколько запустили
    async fire(ms) {
      const due = [...list.entries()].filter(([, t]) => t.ms >= ms)
      for (const [k] of due) list.delete(k)
      for (const [, t] of due) await t.fn()
      return due.length
    },
    count: () => list.size,
  }
}

test('работа через запасной — основной проверяется снова и, ответив, становится адресом опять', async () => {
  let primaryUp = false
  const pr = probes({ [P]: () => primaryUp, [F]: true })
  const mt = manualTimers()
  const changes = []
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, timers: mt.timers, preferMs: 0, returnMs: 300000 })
  c.onChange((b) => changes.push(b))
  assert.equal(await c.ready(), F)
  // Основной всё ещё молчит — остаёмся, проверка назначена снова
  assert.equal(await mt.fire(300000), 1)
  assert.equal(c.current(), F)
  assert.equal(mt.count(), 1, 'следующая проверка назначена')
  // Основной ожил — возвращаемся, подписчики знают
  primaryUp = true
  assert.equal(await mt.fire(300000), 1)
  assert.equal(c.current(), P)
  assert.deepEqual(changes, [F, P])
  assert.equal(mt.count(), 0, 'на основном проверять нечего')
})

test('stop() снимает проверку основного', async () => {
  const pr = probes({ [P]: false, [F]: true })
  const mt = manualTimers()
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, timers: mt.timers })
  assert.equal(await c.ready(), F)
  assert.equal(mt.count(), 1)
  c.stop()
  assert.equal(mt.count(), 0)
})

test('часы ушли назад после выбора — пауза между выборами не растягивается: выбор делается', async () => {
  let clock = 100000
  const pr = probes({ [P]: false, [F]: false })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, now: () => clock })
  await c.ready()
  assert.equal(c.reachable(), false)
  pr.calls.length = 0
  clock -= 86400000 // кассир перевёл часы на сутки назад
  await c.failed()
  assert.equal(pr.calls.length, 2, 'адреса спрошены снова, а не через сутки')
})

test('обычный ответ сервера сильнее проверки: на медленной связи проверка не успела, а запрос прошёл', async () => {
  const pr = probes({ [P]: false, [F]: false })
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe })
  await c.ready()
  assert.equal(c.reachable(), false)
  c.answered(F) // не тот адрес, через который идёт работа, — не в счёт
  assert.equal(c.reachable(), false)
  c.answered(P)
  assert.equal(c.reachable(), true)
})

test('ошибка подписчика не ломает выбор адреса', async () => {
  const pr = probes({ [P]: false, [F]: true })
  const mt = manualTimers()
  const c = createBaseChooser({ primary: P, fallback: F, probe: pr.probe, timers: mt.timers, preferMs: 0 })
  c.onChange(() => {
    throw new Error('беда подписчика')
  })
  const seen = []
  c.onChange((b) => seen.push(b))
  assert.equal(await c.ready(), F)
  assert.deepEqual(seen, [F], 'второй подписчик узнал о смене')
  assert.equal(mt.count(), 1, 'проверка основного назначена, несмотря на ошибку первого')
  c.stop()
})

