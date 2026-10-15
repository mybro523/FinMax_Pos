// ── Обмен с сервером: порядок разговора ──
//
// Касса отправляет сделанное и забирает изменившееся. Здесь проверяется сам порядок:
// что уходит и в какой последовательности, что бывает при обрыве связи посреди
// отправки, когда можно спрашивать свежие данные, а когда нельзя, и как касса
// повторяет попытки. Сети и базы тут нет — только правила.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSync } from '../src/sync.mjs'
import { manualTimers } from '../test-support/server.mjs'

const op = (id, accountId = 'kassir', type = 'sale') => ({ id, type, accountId, createdAt: '2026-10-04T10:00:00.000Z', payload: { n: id }, state: 'pending', attempts: 0 })

// Касса и сервер — в памяти. Сервер по умолчанию принимает всё
function setup(ops = [], over = {}) {
  const timers = manualTimers()
  const t = {
    timers,
    // Секундомер обмена: идёт только тогда, когда его двигает проверка (см. step)
    clock: 0,
    ops: ops.map((o) => ({ ...o })),
    cursor: '',
    log: [],
    pushed: [],
    states: [],
    denied: [],
    changed: [],
    tokens: { kassir: 'ключ-кассира', vladelec: 'ключ-владельца' },
    // Ответ сервера на отправку: (пачка, ключ) → ответ
    onPush: (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok' })) } }),
    // Ответ сервера на получение: (отметка, о каких операциях спросили) → ответ.
    // По умолчанию сервер ни одной из спрошенных не принимал
    onPull: (cursor) => ({ status: 200, data: { full: !cursor, cursor: String(Number(cursor || 0) + 1), ops: {}, data: {}, changed: [] } }),
  }
  const find = (id) => t.ops.find((o) => o.id === id)
  t.sync = createSync({
    timers,
    now: () => t.clock,
    tokenFor: (o) => t.tokens[o.accountId] || '',
    push: async (batch, token) => {
      t.log.push('push:' + batch.map((o) => o.id).join(','))
      t.pushed.push({ ids: batch.map((o) => o.id), token })
      return t.onPush(batch, token)
    },
    pull: async (cursor, asked = []) => {
      // В журнале проверки: с какой отметки спросили и о каких операциях
      t.log.push('pull:' + cursor + (asked.length ? '?' + asked.join(',') : ''))
      return t.onPull(cursor, asked)
    },
    store: {
      pendingOps: (n) => t.ops.filter((o) => o.state === 'pending').slice(0, n),
      // «Уходила на сервер» помнится отдельно от счётчика попыток и не снимается
      markAttempt: (batch) => batch.forEach((o) => Object.assign(find(o.id), { attempts: find(o.id).attempts + 1, sent: true })),
      clearAttempts: (batch) => batch.forEach((o) => (find(o.id).attempts = 0)),
      ack: (o, fate) => Object.assign(find(o.id), { state: 'done', fate }),
      reject: (o, error) => {
        Object.assign(find(o.id), { state: 'rejected', error })
        if (t.fullOnReject) t.wantFull = true
      },
      sentOps: (n) => t.ops.filter((o) => o.state === 'pending' && o.sent).slice(0, n),
      // Нужна ли весь магазин целиком. Называть или не называть отметку, решает сам обмен
      wantsFull: () => !!t.wantFull,
      cursor: () => t.cursor,
      // Как в программе: сначала судьба операций, о которых спрашивали, потом данные
      applyPull: (res, sent = []) => {
        if (t.failApply) throw new Error('диск полон')
        for (const o of sent) {
          const fate = res.ops?.[o.id]
          if (fate?.status === 'ok') find(o.id).state = 'done'
          else if (fate?.status === 'rejected') {
            Object.assign(find(o.id), { state: 'rejected', error: fate.error })
            if (t.fullOnReject) t.wantFull = true
          }
        }
        t.cursor = res.cursor
        if (res.full) t.wantFull = false
        return res.changed || []
      },
    },
    onChanged: (keys) => t.changed.push(keys),
    onDenied: (res, token) => t.denied.push({ status: res.status, token }),
    onState: (st) => t.states.push({ ...st }),
    ...over,
  })
  t.states_ = () => t.ops.map((o) => o.state).join(',')
  return t
}

// Дождаться запланированного захода: время доходит до его срока, и он выполняется.
// Возвращает, сколько пришлось ждать
async function step(t) {
  const [timer] = [...t.timers.pending]
  assert.ok(timer, 'следующий заход не запланирован')
  t.clock += timer.ms
  await t.sync.run()
  return timer.ms
}

// Сервер отдаёт то, что просили: без отметки — весь магазин, с отметкой — изменения
const okPull = (cursor, changed = []) => ({ status: 200, data: { full: !cursor, cursor: String(Number(cursor || 100) + 1), ops: {}, data: {}, changed } })

// Случайные числа с зерном: сценарий можно повторить
function dice(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = Math.imul(a ^ (a >>> 15), 1 | a)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

test('сначала отправка, потом получение — и никогда наоборот', async () => {
  const t = setup([op('a'), op('b')])
  const r = await t.sync.start()
  assert.equal(r.ok, true)
  assert.deepEqual(t.log, ['push:a,b', 'pull:'])
  assert.equal(t.states_(), 'done,done')
  assert.equal(t.cursor, '1', 'отметка «докуда получили» запомнена')
  t.sync.stop()
})

test('нечего отправлять — только получение, со своей отметки', async () => {
  const t = setup()
  t.cursor = '41'
  await t.sync.start()
  assert.deepEqual(t.log, ['pull:41'])
  t.sync.stop()
})

test('операции уходят пачками и по порядку', async () => {
  const many = Array.from({ length: 120 }, (_, i) => op('op' + String(i).padStart(3, '0')))
  const t = setup(many)
  await t.sync.start()
  assert.deepEqual(t.pushed.map((p) => p.ids.length), [50, 50, 20])
  assert.deepEqual(t.pushed.flatMap((p) => p.ids), many.map((o) => o.id), 'порядок нарушен')
  assert.equal(t.log.at(-1), 'pull:')
  t.sync.stop()
})

test('обрыв связи посреди отправки: пока сервер недоступен, за свежими данными не ходим; повтор пачки ничего не задваивает', async () => {
  const t = setup([op('a'), op('b')])
  // Запрос ушёл, ответа нет. Принял сервер операции или нет — неизвестно
  t.onPush = () => ({ status: 0 })
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.deepEqual(t.log, ['push:a,b'], 'связи нет — получать не у кого')
  assert.equal(t.states_(), 'pending,pending')

  // Сервер лежит — то же самое
  t.onPush = () => ({ status: 502, data: null })
  await t.sync.run()
  assert.equal(t.log.filter((x) => x.startsWith('pull')).length, 0)

  // Связь вернулась: та же пачка уходит ещё раз, сервер узнаёт её по номерам
  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'duplicate' })) } })
  const again = await t.sync.run()
  assert.equal(again.ok, true)
  assert.equal(t.states_(), 'done,done', 'повтор, принятый раньше, — тоже «принято»')
  assert.equal(t.log.at(-1), 'pull:', 'теперь можно и получать')
  t.sync.stop()
})

test('сервер отверг операцию по существу — она помечается, остальные идут дальше', async () => {
  const t = setup([op('a'), op('b'), op('c')])
  t.onPush = (batch) => ({
    status: 201,
    data: { results: batch.map((o) => (o.id === 'b' ? { id: 'b', status: 'rejected', error: 'Клиент не найден' } : { id: o.id, status: 'ok' })) },
  })
  const r = await t.sync.start()
  assert.equal(r.ok, true, 'отказ по существу — не сбой обмена')
  assert.equal(t.states_(), 'done,rejected,done')
  assert.equal(t.ops[1].error, 'Клиент не найден')
  assert.deepEqual(t.log, ['push:a,b,c', 'pull:'])
  t.sync.stop()
})

test('сервер не смог записать операцию — на ней и останавливаемся: порядок важнее скорости', async () => {
  const t = setup([op('a'), op('b'), op('c')])
  // Сервер останавливается на первой неудаче и про остальные молчит
  t.onPush = () => ({ status: 201, data: { results: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'retry' }] } })
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.equal(t.states_(), 'done,pending,pending')
  assert.deepEqual(t.ops.map((o) => o.attempts), [1, 0, 0], 'сервер ответил «не записал» — неизвестности нет')
  // Свежие данные берём — и заодно спрашиваем про «b» и «c»: они уходили на сервер
  assert.deepEqual(t.log, ['push:a,b,c', 'pull:?b,c'])
  assert.equal([...t.timers.pending][0].ms, 5000, 'повтор — скоро')

  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok' })) } })
  await t.sync.run()
  assert.equal(t.states_(), 'done,done,done')
  assert.equal(t.pushed.at(-1).ids.join(), 'b,c', 'возврат не ушёл раньше своего чека')
  t.sync.stop()
})

test('у каждого сотрудника свой ключ: операции идут подряд, пачка — пока ключ тот же', async () => {
  const t = setup([op('a', 'kassir'), op('b', 'kassir'), op('c', 'vladelec'), op('d', 'kassir')])
  await t.sync.start()
  assert.deepEqual(
    t.pushed.map((p) => [p.ids.join(), p.token]),
    [
      ['a,b', 'ключ-кассира'],
      ['c', 'ключ-владельца'],
      ['d', 'ключ-кассира'],
    ],
  )
  t.sync.stop()
})

test('отправить нечем (нет ключа автора) — операции ждут, а получение продолжается', async () => {
  const t = setup([op('a', 'kassir'), op('b', 'uvolennyj'), op('c', 'kassir')])
  const r = await t.sync.start()
  // «a» ушла; «b» отправить нечем — и «c» ждёт за ней, порядок не нарушаем
  assert.equal(t.states_(), 'done,pending,pending')
  assert.deepEqual(t.log, ['push:a', 'pull:'], 'неотправленное (а не «отправленное без ответа») получению не мешает')
  assert.equal(r.ok, true)
  assert.equal(t.states.at(-1).blocked, true, 'кассир должен увидеть, что операции ждут чьего-то входа')

  // Владелец вошёл на этом компьютере — его ключом уходит и чужое
  t.tokens.uvolennyj = t.tokens.vladelec
  await t.sync.run()
  assert.equal(t.states_(), 'done,done,done')
  assert.equal(t.states.at(-1).blocked, false)
  t.sync.stop()
})

test('сервер отозвал ключ: ни одна операция не принята, получения нет, повторов не ставим', async () => {
  const t = setup([op('a')])
  t.onPush = () => ({ status: 401, data: { message: 'Пароль был изменён — войдите заново' } })
  const r = await t.sync.start()
  assert.equal(r.denied, true)
  assert.deepEqual(t.denied, [{ status: 401, token: 'ключ-кассира' }])
  assert.deepEqual(t.log, ['push:a'])
  assert.equal(t.ops[0].attempts, 0, 'сервер отказал до операций — их судьба известна: не приняты')
  assert.equal(t.timers.pending.size, 0, 'после отказа сервера повторять нечего — нужен новый вход')
  t.sync.stop()
})

test('отказ при получении (подписка закончилась) — данные не трогаем', async () => {
  const t = setup()
  t.cursor = '7'
  t.onPull = () => ({ status: 403, data: { message: 'Подписка закончилась' } })
  const r = await t.sync.start()
  assert.equal(r.denied, true)
  assert.deepEqual(t.denied, [{ status: 403, token: null }])
  assert.equal(t.cursor, '7')
  t.sync.stop()
})

test('связи нет — попытки повторяются с нарастающей паузой', async () => {
  const t = setup()
  t.onPull = () => ({ status: 0 })
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.equal(t.sync.isOnline(), false)

  const pauses = []
  for (let i = 0; i < 7; i++) {
    const [timer] = [...t.timers.pending]
    pauses.push(timer.ms)
    t.timers.pending.clear()
    timer.fn()
    await t.sync.current()
  }
  assert.deepEqual(pauses, [5000, 10000, 20000, 40000, 60000, 60000, 60000])

  // Связь вернулась: следующая попытка удачна, и пауза снова длинная
  t.onPull = (cursor) => ({ status: 200, data: { full: true, cursor: '5', data: {} } })
  const [timer] = [...t.timers.pending]
  t.timers.pending.clear()
  timer.fn()
  await t.sync.current()
  assert.equal(t.sync.isOnline(), true)
  assert.equal([...t.timers.pending][0].ms, 5 * 60 * 1000)
  // Значок связи менялся дважды: «нет» → «есть». Сколько бы попыток ни было
  // (до первого ответа связь неизвестна — это не «нет» и не «есть»)
  const seen = t.states.map((s) => s.online).filter((v) => v !== null).filter((v, i, all) => i === 0 || v !== all[i - 1])
  assert.deepEqual(seen, [false, true])
  t.sync.stop()
})

test('чужая страница вместо ответа сервера (гостевой Wi-Fi) — это «нет связи»', async () => {
  const t = setup([op('a')])
  t.onPush = () => ({ status: 200, data: null, foreign: true })
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.equal(t.states_(), 'pending')
  assert.equal(t.log.includes('pull:'), false)
  t.sync.stop()
})

test('пробили чек — обмен начинается почти сразу, но три чека подряд уходят одной пачкой', async () => {
  const t = setup()
  await t.sync.start()
  t.log.length = 0
  t.timers.pending.clear()

  t.ops.push(op('a'))
  t.sync.kick()
  t.ops.push(op('b'))
  t.sync.kick()
  t.ops.push(op('c'))
  t.sync.kick()
  assert.equal(t.timers.pending.size, 1, 'на три чека — один отложенный обмен')
  const [timer] = [...t.timers.pending]
  assert.equal(timer.ms, 1000)
  t.timers.pending.clear()
  timer.fn()
  await t.sync.current()
  assert.deepEqual(t.log, ['push:a,b,c', 'pull:1'])
  t.sync.stop()
})

test('одновременно идёт один обмен; просьба во время него — ещё один заход следом', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const t = setup([op('a')])
  let first = true
  t.onPush = async (batch) => {
    if (first) {
      first = false
      await gate
    }
    return { status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok' })) } }
  }
  const one = t.sync.start()
  // Пока первый обмен идёт, пробили ещё чек и трижды попросили обменяться
  t.ops.push(op('b'))
  const two = t.sync.run()
  t.sync.run()
  t.sync.kick()
  assert.deepEqual(t.log, ['push:a'])
  release()
  await Promise.all([one, two])
  // Чек «b» успел в первый же заход: отправка идёт, пока очередь не опустеет.
  // А три просьбы подряд дали ровно один повторный заход, а не три
  assert.deepEqual(t.log, ['push:a', 'push:b', 'pull:', 'pull:1'])
  assert.equal(t.states_(), 'done,done')
  t.sync.stop()
})

test('сервер прислал изменения — окно узнаёт, какие разделы перечитать', async () => {
  const t = setup()
  t.onPull = () => ({ status: 200, data: { full: false, cursor: '9', data: {}, changed: ['products', 'sales'] } })
  await t.sync.start()
  assert.deepEqual(t.changed, [['products', 'sales']])
  t.sync.stop()
})

test('запись в локальную базу не удалась — отметка не сдвигается, обмен повторится', async () => {
  const t = setup()
  t.cursor = '3'
  t.failApply = true
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.equal(t.cursor, '3', 'ответ, который не записался, не должен считаться полученным')
  assert.equal([...t.timers.pending][0].ms, 5000)
  t.sync.stop()
})

test('ответ сервера не того вида — не применяем, а не падаем', async () => {
  for (const answer of [{ status: 200, data: null }, { status: 200, data: [] }, { status: 200, data: { cursor: '5' } }, { status: 404, data: { message: 'нет' } }]) {
    const t = setup()
    t.onPull = () => answer
    const r = await t.sync.start()
    assert.equal(r.ok, false, JSON.stringify(answer))
    assert.equal(t.cursor, '')
    t.sync.stop()
  }
})

test('после остановки ничего не запускается само', async () => {
  const t = setup()
  await t.sync.start()
  t.sync.stop()
  assert.equal(t.timers.pending.size, 0)
  t.sync.kick()
  assert.equal(t.timers.pending.size, 0, 'после выхода обмен не должен запускаться от чужих событий')
  // Обмен по прямой просьбе проходит, но расписание не возобновляет
  await t.sync.run()
  assert.equal(t.timers.pending.size, 0)
})

test('сервер на связи, но пачку не принял целиком — очередь стоит, и причина видна человеку', async () => {
  const t = setup([op('a'), op('b')])
  // Так отвечает сервер, которому не подошёл сам вид запроса: программа новее сервера
  t.onPush = () => ({ status: 400, data: { message: ['лишнее поле ops.0.novoe'] } })
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.equal(t.states_(), 'pending,pending', 'непринятое остаётся в очереди — ничего не теряется и не отвергается')
  assert.equal(t.ops.every((o) => o.attempts === 0), true, 'ответ определённый: сервер ничего не записал')
  const last = t.sync.state()
  assert.deepEqual([last.online, last.refused], [true, 'лишнее поле ops.0.novoe'])
  // Свежие данные получать можно. Про операции касса на всякий случай спрашивает:
  // они уходили на сервер, и помнить об этом надёжнее, чем угадывать
  assert.equal(t.log.at(-1), 'pull:?a,b')

  // Сервер обновили — очередь уходит, отметка о беде снимается
  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok' })) } })
  await t.sync.run()
  assert.equal(t.states_(), 'done,done')
  assert.equal(t.sync.state().refused, '')
  t.sync.stop()
})

// ── Судьба отправленного ──
// Операция ушла на сервер, а ответ не пришёл. Принята она или нет — касса не знает.
// Раньше она в таком положении не брала свежие данные вовсе; но бывает, что отправить
// операцию повторно нечем (ключ её автора отозван), и тогда касса не получала ничего —
// или, хуже, получала данные, в которых операция уже была, и считала её второй раз.
// Теперь касса спрашивает о таких операциях при получении, и сервер отвечает из того
// же состояния базы, из которого отдаёт данные.

test('ответ на отправку потерялся, а ключ автора отозван: касса узнаёт судьбу операции при получении', async () => {
  const t = setup([op('a')])
  t.onPush = () => ({ status: 0 }) // сервер принял, ответ не дошёл
  await t.sync.start()
  assert.equal(t.states_(), 'pending')

  // Отправить «a» повторно нечем
  delete t.tokens.kassir
  let asked = null
  t.onPull = (cursor, ids) => {
    asked = ids
    return { status: 200, data: { full: false, cursor: '5', ops: { a: { status: 'ok', docId: 'a' } }, data: {} } }
  }
  const r = await t.sync.run()
  assert.deepEqual(asked, ['a'], 'касса должна спросить про операцию, на которую не дождалась ответа')
  assert.equal(r.ok, true)
  assert.equal(t.states_(), 'done', 'сервер её принял — поправка снята, второй раз она не посчитается')
  assert.equal(t.cursor, '5')
  assert.equal(t.states.at(-1).online, true, 'и связь есть: значок не должен говорить «нет интернета»')
  t.sync.stop()
})

test('сервер операцию не принимал — она остаётся в очереди, и о ней спросят снова', async () => {
  const t = setup([op('a'), op('b')])
  t.onPush = () => ({ status: 0 })
  await t.sync.start()
  delete t.tokens.kassir
  await t.sync.run()
  assert.equal(t.log.at(-1), 'pull:?a,b')
  assert.equal(t.states_(), 'pending,pending', 'не принята — значит, по-прежнему наша неотправленная')
  assert.equal(t.cursor, '1', 'данные при этом получены')
  await t.sync.run()
  assert.equal(t.log.at(-1), 'pull:1?a,b', 'спрашиваем, пока судьба не выяснится')

  // Одну сервер, оказывается, принял, вторую отверг
  t.onPull = () => ({ status: 200, data: { full: false, cursor: '9', ops: { a: { status: 'ok' }, b: { status: 'rejected', error: 'Клиент не найден' } }, data: {} } })
  await t.sync.run()
  assert.equal(t.states_(), 'done,rejected')
  assert.equal(t.ops[1].error, 'Клиент не найден')
  t.sync.stop()
})

test('отказ во входе при повторной отправке не стирает память о прежней отправке без ответа', async () => {
  // Ответ на первую отправку потерялся. Потом кассиру сменили пароль: повтор получает
  // отказ. Сервер отказал до операций — но это про ЭТУ попытку; первую он мог принять
  const t = setup([op('a')], { onDenied: () => 'retry' })
  t.onPush = () => ({ status: 0 })
  await t.sync.start()
  t.onPush = () => ({ status: 401, data: { message: 'Пароль был изменён — войдите заново' } })
  t.onPull = () => ({ status: 200, data: { full: false, cursor: '5', ops: { a: { status: 'ok' } }, data: {} } })
  await t.sync.run()
  assert.equal(t.log.at(-1), 'pull:?a', 'после отказа касса обязана спросить про операцию, а не забыть о ней')
  assert.equal(t.states_(), 'done')
  t.sync.stop()
})

test('сервер промолчал о судьбе операций — такие данные касса не применяет', async () => {
  const t = setup([op('a')])
  t.onPush = () => ({ status: 0 })
  await t.sync.start()
  delete t.tokens.kassir
  t.cursor = '3'
  // Ответ без раздела «ops»: есть ли в этих данных наша операция — неизвестно
  t.onPull = () => ({ status: 200, data: { full: false, cursor: '8', data: {} } })
  const r = await t.sync.run()
  assert.equal(r.ok, false)
  assert.equal(t.cursor, '3', 'отметка не сдвинулась')
  assert.equal(t.states_(), 'pending')
  t.sync.stop()
})

test('операций без ответа больше, чем можно назвать за раз, — сначала отправка, получение подождёт', async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ ...op('op' + i, 'uvolennyj'), sent: true }))
  const t = setup(many)
  const r = await t.sync.start()
  assert.equal(r.ok, false)
  assert.deepEqual(t.log, [], 'ни отправить (нет ключа), ни спросить обо всех разом')
  // Владелец вошёл — очередь ушла, получение возобновилось
  t.tokens.uvolennyj = t.tokens.vladelec
  await t.sync.run()
  assert.equal(t.log.at(-1), 'pull:')
  t.sync.stop()
})

test('сервер раз за разом не может записать одну и ту же операцию — причина видна человеку', async () => {
  const t = setup([op('a'), op('b')])
  t.onPush = () => ({ status: 201, data: { results: [{ id: 'a', status: 'retry', error: 'Сервер не смог записать операцию. Она будет отправлена повторно.' }] } })
  await t.sync.start()
  await t.sync.run()
  assert.equal(t.sync.state().refused, '', 'два сбоя подряд — ещё не повод тревожить: база могла быть занята')
  await t.sync.run()
  assert.match(t.sync.state().refused, /не смог записать/, 'на третий раз человек должен узнать, что очередь стоит')
  assert.equal(t.states_(), 'pending,pending', 'сама операция при этом не теряется и не отвергается')

  // Беду на сервере устранили — очередь уходит, отметка снимается
  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok' })) } })
  await t.sync.run()
  assert.equal(t.states_(), 'done,done')
  assert.equal(t.sync.state().refused, '')
  t.sync.stop()
})

test('сервер принял операцию без документа — касса узнаёт об этом из ответа', async () => {
  const t = setup([op('a', 'kassir', 'writeoff')])
  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => ({ id: o.id, status: 'ok', docId: null })) } })
  await t.sync.start()
  assert.equal(t.ops[0].state, 'done')
  assert.equal(t.ops[0].fate.docId, null, 'ответ сервера должен дойти до локальной базы: документа там нет')
  t.sync.stop()
})

// ── После отказа касса забирает магазин целиком ──
// Отказ значит, что касса и сервер разошлись в том, что считают правдой. Касса не
// гадает, что поправить у себя, а берёт у сервера всё, как он это видит.

test('сервер отверг операцию при отправке — тем же заходом касса забирает магазин целиком', async () => {
  const t = setup([op('a'), op('b')])
  t.cursor = '7'
  t.fullOnReject = true
  t.onPush = (batch) => ({ status: 201, data: { results: batch.map((o) => (o.id === 'a' ? { id: 'a', status: 'rejected', error: 'Смена не найдена' } : { id: o.id, status: 'ok' })) } })
  const r = await t.sync.start()
  assert.equal(r.ok, true)
  assert.deepEqual(t.log, ['push:a,b', 'pull:'], 'спросить надо без отметки — то есть всё; и одного захода на это хватает')
  assert.equal(t.wantFull, false)
  t.sync.stop()
})

test('об отказе касса узнала при получении — сразу ещё один заход, уже за всем магазином', async () => {
  const t = setup([op('a')])
  t.cursor = '7'
  t.fullOnReject = true
  t.onPush = () => ({ status: 0 }) // сервер получил операцию, ответ не дошёл
  await t.sync.start()
  delete t.tokens.kassir // повторить отправку нечем — судьбу операции скажет получение
  t.log.length = 0
  t.onPull = (cursor) => ({ status: 200, data: { full: !cursor, cursor: '9', ops: cursor ? { a: { status: 'rejected', error: 'Смена не найдена' } } : {}, data: {} } })
  const r = await t.sync.run()
  assert.equal(r.ok, true)
  assert.deepEqual(t.log, ['pull:7?a', 'pull:'], 'пять минут до следующей сверки касса с устаревшими данными не ждёт')
  assert.equal(t.states_(), 'rejected')
  assert.equal(t.wantFull, false)
  t.sync.stop()
})

test('сервер не отдаёт магазин целиком, хотя его просят, — касса не заводит круг запросов без паузы', async () => {
  const t = setup()
  t.cursor = '7'
  t.wantFull = true
  // Сервер упорно отвечает «вот изменения»
  t.onPull = () => ({ status: 200, data: { full: false, cursor: '9', ops: {}, data: {} } })
  await t.sync.start()
  assert.deepEqual(t.log, ['pull:'], 'один заход — и до следующей сверки по расписанию')
  assert.equal(t.timers.pending.size, 1)
  assert.equal([...t.timers.pending][0].ms, 5 * 60 * 1000)
  t.sync.stop()
})

test('полная загрузка сорвалась один раз — через считаные секунды касса забирает всё', async () => {
  const t = setup()
  t.cursor = '7'
  t.wantFull = true
  // Связь моргнула ровно на большом ответе
  let blink = true
  t.onPull = (cursor) => (!cursor && blink ? { status: 0 } : okPull(cursor))
  const first = await t.sync.start()
  assert.equal(first.ok, false)
  assert.deepEqual(t.log, ['pull:'], 'сначала — попытка забрать всё')
  blink = false

  // Через пять секунд — заход за изменениями: по нему видно, что связь есть
  assert.equal(await step(t), 5000)
  assert.deepEqual(t.log, ['pull:', 'pull:7'])
  assert.equal(t.wantFull, true, 'полная загрузка по-прежнему за кассой')
  // И ещё через пять — снова за всем. Раньше касса ждала этого пять минут
  assert.equal(await step(t), 5000)
  assert.deepEqual(t.log, ['pull:', 'pull:7', 'pull:'])
  assert.equal(t.wantFull, false)
  // Дальше обмен обычный: сверка раз в пять минут и только за изменениями
  assert.equal(await step(t), 5 * 60 * 1000)
  assert.match(t.log.at(-1), /^pull:\d+$/)
  t.sync.stop()
})

test('полная загрузка не проходит (слабая связь), а короткие ответы проходят — касса продолжает получать изменения', async () => {
  const t = setup()
  t.cursor = '7'
  t.wantFull = true
  // Весь магазин — большой ответ: он обрывается. «Что изменилось» — короткий: доходит
  t.onPull = (cursor) => (cursor ? okPull(cursor, ['products']) : { status: 0 })
  await t.sync.start()
  assert.deepEqual(t.log, ['pull:'], 'сначала — попытка забрать всё')

  // Что было дальше: через сколько секунд заход и за чем он ходил
  const line = []
  for (let n = 0; n < 14; n++) {
    const before = t.log.length
    const ms = await step(t)
    line.push([ms / 1000, t.log.slice(before).map((x) => (x === 'pull:' ? 'всё' : 'изменения')).join('+')])
  }
  assert.deepEqual(line, [
    // После каждой неудачной попытки — через пять секунд заход за изменениями…
    [5, 'изменения'],
    // …а следующая попытка забрать всё — с каждым разом позже
    [5, 'всё'], [5, 'изменения'],
    [15, 'всё'], [5, 'изменения'],
    [60, 'всё'], [5, 'изменения'],
    [120, 'всё'], [5, 'изменения'],
    [300, 'всё'], [5, 'изменения'],
    [300, 'всё'], [5, 'изменения'],
    [300, 'всё'],
  ])
  assert.equal(t.cursor, '14', 'изменения всё это время шли')
  assert.equal(t.changed.length, 7)
  assert.equal(t.wantFull, true)

  // Пока касса ждёт следующей попытки, пробили чек: обмен идёт сразу, но только за
  // изменениями, — а попытка забрать всё остаётся на своём месте
  await step(t)
  t.sync.kick()
  assert.equal(await step(t), 1000)
  assert.match(t.log.at(-1), /^pull:\d+$/)
  assert.equal([...t.timers.pending][0].ms, 299000, 'до попытки — столько, сколько оставалось: пять минут без этой секунды')

  // Связь наладилась — следующая же попытка проходит, и дальше обмен обычный
  t.onPull = (cursor) => okPull(cursor)
  await step(t)
  assert.equal(t.log.at(-1), 'pull:')
  assert.equal(t.wantFull, false)
  assert.equal(await step(t), 5 * 60 * 1000)
  assert.match(t.log.at(-1), /^pull:\d+$/, 'после удачной полной загрузки — снова только изменения')
  t.sync.stop()
})

test('связи не было вовсе, сколько бы это ни длилось, — когда она появилась, касса забирает всё за минуту с небольшим', async () => {
  for (const dead of [1, 2, 3, 4, 5, 8, 13, 21, 34]) {
    const t = setup()
    t.cursor = '7'
    t.wantFull = true
    t.onPull = () => ({ status: 0 })
    await t.sync.start()
    for (let n = 1; n < dead; n++) assert.ok((await step(t)) >= 5000)
    assert.equal(t.log.length, dead, 'без связи — один запрос за заход, а не круг запросов')

    // Раньше неудачи без связи копились как «большой ответ не проходит», и после её
    // возвращения касса ждала полной загрузки до получаса
    t.onPull = (cursor) => okPull(cursor)
    const from = t.clock
    let passes = 0
    while (t.wantFull) {
      await step(t)
      assert.ok(++passes <= 2, `связи не было ${dead} заходов: полная загрузка всё не проходит`)
    }
    assert.ok(t.clock - from <= 65000, `связи не было ${dead} заходов: после её возвращения касса ждала ${(t.clock - from) / 1000} с`)
    t.sync.stop()
  }
})

test('полная загрузка: какой бы ни была связь — ни круга запросов без паузы, ни вечного ожидания', async () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rnd = dice(seed)
    const t = setup()
    t.cursor = '7'
    t.wantFull = true
    // Связи нет; есть, но большой ответ не проходит; всё проходит
    let link = 'нет'
    t.onPull = (cursor) => (link === 'нет' || (link === 'слабая' && !cursor) ? { status: 0 } : okPull(cursor))
    await t.sync.start()
    for (let n = 0; n < 60 && t.wantFull; n++) {
      if (rnd() < 0.3) link = ['нет', 'слабая', 'хорошая'][Math.floor(rnd() * 3)]
      const before = t.log.length
      const ms = await step(t)
      assert.ok(ms >= 1000, `зерно ${seed}: заход через ${ms} мс`)
      assert.ok(t.log.length - before <= 2, `зерно ${seed}: ${t.log.length - before} запроса за один заход`)
    }
    // Связь стала хорошей и такой остаётся: самое долгое — дождаться отложенной попытки
    link = 'хорошая'
    const from = t.clock
    for (let n = 0; n < 6 && t.wantFull; n++) await step(t)
    assert.equal(t.wantFull, false, `зерно ${seed}: магазин так и не забран`)
    assert.ok(t.clock - from <= 365000, `зерно ${seed}: при хорошей связи касса ждала ${(t.clock - from) / 1000} с`)
    t.sync.stop()
  }
})
