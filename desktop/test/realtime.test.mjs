// ── Постоянное соединение в основной части программы ──
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRealtime } from '../src/realtime.mjs'

// Подставное соединение: запоминает, с чем его открыли, и умеет «прислать» событие
function fakeIo() {
  const sockets = []
  const io = (origin, opts) => {
    const handlers = new Map()
    const socket = {
      origin,
      opts,
      closed: false,
      on: (type, fn) => handlers.set(type, fn),
      removeAllListeners: () => handlers.clear(),
      disconnect: () => (socket.closed = true),
      fire: (type, payload) => handlers.get(type)?.(payload),
      listens: (type) => handlers.has(type),
    }
    sockets.push(socket)
    return socket
  }
  return { io, sockets }
}

function setup(token = 'ключ-1') {
  const { io, sockets } = fakeIo()
  const sent = []
  const session = { token, get: () => session.token }
  const rt = createRealtime({ io, origin: 'https://server.example', session, send: (type, payload) => sent.push({ type, payload }) })
  return { rt, sockets, sent, session }
}

test('без входа соединение не открывается', () => {
  const { rt, sockets } = setup('')
  rt.start()
  assert.equal(sockets.length, 0)
  assert.equal(rt.isOpen(), false)
})

test('соединение открывается по ключу из основной части, к корню сервера', () => {
  const { rt, sockets } = setup('ключ-1')
  rt.start()
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].origin, 'https://server.example')
  assert.deepEqual(sockets[0].opts.auth, { token: 'ключ-1' })
  // Сначала постоянное соединение, с откатом на обычные запросы — как у сайта
  assert.deepEqual(sockets[0].opts.transports, ['websocket', 'polling'])
  assert.equal(sockets[0].opts.tryAllTransports, true)
})

test('повторная просьба второе соединение не открывает', () => {
  const { rt, sockets } = setup()
  rt.start()
  rt.start()
  rt.start()
  assert.equal(sockets.length, 1)
})

test('события сервера пересылаются в окно', () => {
  const { rt, sockets, sent } = setup()
  rt.start()
  const s = sockets[0]
  s.fire('connect')
  s.fire('changed', ['products', 'sales'])
  s.fire('subscription', { note: 'Подписка продлена' })
  s.fire('suspended', { message: 'Работа приостановлена' })
  s.fire('resumed')
  s.fire('disconnect')
  s.fire('connect_error')
  assert.deepEqual(sent, [
    { type: 'connect', payload: undefined },
    { type: 'changed', payload: ['products', 'sales'] },
    { type: 'subscription', payload: { note: 'Подписка продлена' } },
    { type: 'suspended', payload: { message: 'Работа приостановлена' } },
    { type: 'resumed', payload: undefined },
    { type: 'disconnect', payload: undefined },
    // Не удалось подключиться — для окна это то же «связи нет»
    { type: 'disconnect', payload: undefined },
  ])
})

test('события панели владельца сервиса программа не слушает', () => {
  // У программы нет панели: «кто на связи» и новости сервиса ей не нужны
  const { rt, sockets } = setup()
  rt.start()
  assert.equal(sockets[0].listens('service'), false)
  assert.equal(sockets[0].listens('presence'), false)
})

test('ключ сменился — соединение переоткрывается под новым', () => {
  // Сервер разбирает ключ один раз, при подключении. Прежнее соединение осталось бы
  // жить со старым ключом — а после смены пароля сервер его вовсе не пустит
  const { rt, sockets, session } = setup('ключ-1')
  rt.start()
  session.token = 'ключ-2'
  rt.sessionChanged()
  assert.equal(sockets.length, 2)
  assert.equal(sockets[0].closed, true)
  assert.deepEqual(sockets[1].opts.auth, { token: 'ключ-2' })
})

test('ключ сменился до того, как соединение попросили, — ничего не открываем', () => {
  const { rt, sockets, session } = setup('')
  session.token = 'ключ-1'
  rt.sessionChanged()
  assert.equal(sockets.length, 0)
})

test('остановка закрывает соединение и сообщает окну', () => {
  const { rt, sockets, sent } = setup()
  rt.start()
  rt.stop()
  assert.equal(sockets[0].closed, true)
  assert.equal(rt.isOpen(), false)
  assert.deepEqual(sent.at(-1), { type: 'disconnect', payload: undefined })
  // После остановки смена ключа соединение не возвращает
  rt.sessionChanged()
  assert.equal(sockets.length, 1)
})

test('вышли из программы — после нового входа соединение открывается заново', () => {
  const { rt, sockets, session } = setup('ключ-1')
  rt.start()
  rt.stop()
  session.token = 'ключ-2'
  rt.start()
  assert.equal(sockets.length, 2)
  assert.deepEqual(sockets[1].opts.auth, { token: 'ключ-2' })
})
