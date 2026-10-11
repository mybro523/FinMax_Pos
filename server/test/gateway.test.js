// ── Кому и что уходит по связи ──
// Ошибка здесь молчалива вдвойне: событие не приходит, а на экране остаётся
// вчерашнее — и выглядит это не как поломка, а как «программа тормозит».
//
// Самое дорогое из проверяемого — порядок при приостановке. Сначала объяснение,
// потом обрыв. Поменяй местами — и кассир увидит просто пропавшую связь, решит,
// что виноват интернет, и упрётся в отказ посреди продажи.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'
process.env.AUTH_SECRET = 'proverochnyy-sekret-dlinoy-bolshe-tridtsati-znakov'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventsGateway } = require('../dist/events/events.gateway')
const { ChangeStamp } = require('../dist/events/change-stamp.service')

// Поддельный socket.io: запоминает, что и куда ушло
function fakeServer() {
  const sent = []
  const dropped = []
  return {
    sent,
    dropped,
    to(room) {
      return { emit: (event, payload) => sent.push({ room, event, payload }) }
    },
    in(room) {
      return { disconnectSockets: () => dropped.push(room) }
    },
  }
}

// Поддельный запас подключений: запоминает, кого просили держать наготове
function fakePool() {
  return { warmed: [], cooled: [], keepWarm(s) { this.warmed.push(s) }, letCool(s) { this.cooled.push(s) } }
}

function gateway(pool = fakePool()) {
  // Настоящие зависимости не нужны: проверяем рассылку, а не проверку доступа
  const g = new EventsGateway({ verify: () => null }, {}, pool, new ChangeStamp())
  g.onModuleDestroy() // не оставляем за собой таймер перепроверки
  g.server = fakeServer()
  g.pool_ = pool
  return g
}

test('аптека слышит только своё', () => {
  const g = gateway()
  g.changedIn('tenant_shifo', 'products', 'sales')
  assert.deepEqual(g.server.sent, [
    { room: 'tenant_shifo', event: 'changed', payload: ['products', 'sales'] },
  ])
})

test('без аптеки не уходит ничего — лучше молчание, чем рассылка всем', () => {
  const g = gateway()
  g.changedIn(undefined, 'products')
  g.changedIn('', 'products')
  assert.deepEqual(g.server.sent, [])
})

test('повторы и пустые названия отсеиваются', () => {
  const g = gateway()
  g.changedIn('tenant_a', 'products', 'products', '', null, 'sales')
  assert.deepEqual(g.server.sent[0].payload, ['products', 'sales'])
})

test('приостановка: сначала объяснение, потом обрыв', async () => {
  const g = gateway()
  g.suspendPharmacy('tenant_shifo', 'Работа приостановлена')

  // В тот же миг — только сообщение. Рвать связь сразу нельзя: объяснение
  // не успеет уйти, и кассир решит, что пропал интернет.
  assert.deepEqual(g.server.sent, [
    { room: 'tenant_shifo', event: 'suspended', payload: { message: 'Работа приостановлена' } },
  ])
  assert.deepEqual(g.server.dropped, [], 'связь оборвана раньше объяснения')

  await new Promise((r) => setTimeout(r, 700))
  assert.deepEqual(g.server.dropped, ['tenant_shifo'], 'связь так и не оборвалась')
})

test('продление доходит до аптеки', () => {
  const g = gateway()
  g.subscriptionChanged('tenant_shifo', 'Подписка продлена')
  assert.deepEqual(g.server.sent, [
    { room: 'tenant_shifo', event: 'subscription', payload: { note: 'Подписка продлена' } },
  ])
})

test('новости панели уходят в комнату владельца сервиса, а не аптекам', () => {
  const g = gateway()
  g.toService('pharmacies', { code: 'shifo' })
  assert.deepEqual(g.server.sent, [
    { room: 'service', event: 'service', payload: { what: 'pharmacies', code: 'shifo' } },
  ])
})

// ── Кто сейчас на связи ──
test('аптека считается работающей, пока жив хоть один её экран', () => {
  const g = gateway()
  g.markOnline('shifo', 'tenant_shifo', +1) // касса
  g.markOnline('shifo', 'tenant_shifo', +1) // телефон владельца
  assert.deepEqual(g.onlinePharmacies(), ['shifo'])

  g.markOnline('shifo', 'tenant_shifo', -1) // телефон закрыли
  assert.deepEqual(g.onlinePharmacies(), ['shifo'], 'аптека пропала из-за одного закрытого экрана')

  g.markOnline('shifo', 'tenant_shifo', -1) // ушли и с кассы
  assert.deepEqual(g.onlinePharmacies(), [])
})

test('панель дёргается только при появлении и уходе аптеки', () => {
  const g = gateway()
  const presence = () => g.server.sent.filter((s) => s.event === 'presence').length

  g.markOnline('shifo', 'tenant_shifo', +1)
  assert.equal(presence(), 1, 'появление не показано')

  // Переподключение телефона — обычное дело при плохой связи, и панель
  // не должна перерисовываться от каждого такого
  g.markOnline('shifo', 'tenant_shifo', +1)
  g.markOnline('shifo', 'tenant_shifo', -1)
  assert.equal(presence(), 1, 'панель дёргается на каждое переподключение')

  g.markOnline('shifo', 'tenant_shifo', -1)
  assert.equal(presence(), 2, 'уход не показан')
})

// ── Кого пускают на связь ──
// Поддельное соединение: запоминает комнаты, свои сообщения и обрыв
function fakeSocket(token) {
  return {
    handshake: { auth: { token } },
    data: {},
    rooms: [],
    mine: [],
    closed: false,
    join(r) {
      this.rooms.push(r)
    },
    emit(e, p) {
      this.mine.push({ event: e, payload: p })
    },
    disconnect() {
      this.closed = true
    },
  }
}

// Шлюз с подставными проверками доступа: платит ли клиент и жив ли сотрудник
function gatewayWith(payload, account, pool = fakePool()) {
  const g = new EventsGateway({ verify: () => payload }, {
    account: { findUnique: async () => account },
  }, pool, new ChangeStamp())
  g.pool_ = pool
  g.onModuleDestroy()
  g.server = fakeServer()
  return g
}

const LIVE_ACCOUNT = { active: true, passwordChangedAt: null, pharmacy: { blocked: false } }

test('пущенной аптеке сразу говорят, что можно работать', async () => {
  // Это слово снимает объявление о приостановке у того, кто заплатил, пока
  // объявление висело на экране. Без него он смотрел бы на него до перезагрузки.
  const g = gatewayWith({ sub: 'a1', sch: 'tenant_shifo', ph: 'shifo', iat: 1 }, LIVE_ACCOUNT)
  const s = fakeSocket('token')
  await g.handleConnection(s)

  assert.equal(s.closed, false)
  assert.deepEqual(s.rooms, ['tenant_shifo'])
  assert.deepEqual(s.mine, [{ event: 'resumed', payload: undefined }])
})

test('приостановленную аптеку не пускают и работать не разрешают', async () => {
  const g = gatewayWith(
    { sub: 'a1', sch: 'tenant_shifo', ph: 'shifo', iat: 1 },
    { active: true, passwordChangedAt: null, pharmacy: { blocked: true } },
  )
  const s = fakeSocket('token')
  await g.handleConnection(s)

  assert.equal(s.closed, true, 'приостановленную аптеку пустили на связь')
  assert.deepEqual(s.mine, [], 'приостановленной аптеке разрешили работать')
  assert.deepEqual(g.onlinePharmacies(), [], 'она ещё и числится работающей')
})

test('владелец сервиса слушает своё и сразу узнаёт, кто за кассой', async () => {
  const g = gatewayWith({ sub: 'sa', iat: 1 }, { active: true, passwordChangedAt: null, pharmacy: null })
  const s = fakeSocket('token')
  await g.handleConnection(s)

  assert.deepEqual(s.rooms, ['service'], 'владелец сервиса попал не в свою комнату')
  assert.equal(s.mine[0].event, 'presence')
  // И аптекой он не числится: своей у него нет
  assert.deepEqual(g.onlinePharmacies(), [])
})

test('поддержка, зашедшая под владельцем, отметку «работают» не зажигает', async () => {
  // Иначе владелец сервиса сам создавал бы признак жизни у молчащего клиента
  const g = gatewayWith({ sub: 'sa', sch: 'tenant_shifo', ph: 'shifo', imp: 'sa', iat: 1 }, LIVE_ACCOUNT)
  const s = fakeSocket('token')
  await g.handleConnection(s)

  assert.deepEqual(s.rooms, ['tenant_shifo'], 'поддержка не слышит аптеку, в которую зашла')
  assert.deepEqual(g.onlinePharmacies(), [], 'поддержка зажгла отметку «сейчас работают»')
})

test('без действующего входа на связь не пускают', async () => {
  const g = gatewayWith(null, LIVE_ACCOUNT)
  const s = fakeSocket('musor')
  await g.handleConnection(s)
  assert.equal(s.closed, true)
})

test('пока за кассой кто-то есть, подключение к её данным держат наготове', () => {
  // Prisma подключается лениво, и раньше за это платил первый покупатель дня:
  // 1,7 с на первое обращение против 0,5 с на все следующие
  const g = gateway()
  g.markOnline('shifo', 'tenant_shifo', +1)
  assert.deepEqual(g.pool_.warmed, ['tenant_shifo'], 'подключение не подготовили')

  // Второй экран той же аптеки ничего не меняет
  g.markOnline('shifo', 'tenant_shifo', +1)
  assert.deepEqual(g.pool_.warmed, ['tenant_shifo'], 'дёргаем запас на каждое подключение')
  assert.deepEqual(g.pool_.cooled, [])

  g.markOnline('shifo', 'tenant_shifo', -1)
  assert.deepEqual(g.pool_.cooled, [], 'отпустили при живом втором экране')
  g.markOnline('shifo', 'tenant_shifo', -1)
  assert.deepEqual(g.pool_.cooled, ['tenant_shifo'], 'после ухода всех подключение не отпущено')
})

test('счётчик не уходит в минус от лишнего отключения', () => {
  const g = gateway()
  g.markOnline('shifo', 'tenant_shifo', -1)
  g.markOnline('shifo', 'tenant_shifo', -1)
  g.markOnline('shifo', 'tenant_shifo', +1)
  assert.deepEqual(g.onlinePharmacies(), ['shifo'], 'аптека не показалась: счётчик ушёл в минус')
})

test('изменение отмечается даже до появления первого соединения', () => {
  // Сервер только поднялся, устройств ещё нет — рассылать некому. Но браузер,
  // который подключится следом, спросит обычным запросом «что изменилось»,
  // и отметка обязана быть уже сбита.
  const stamp = new ChangeStamp()
  const g = new EventsGateway({ verify: () => null }, {}, fakePool(), stamp)
  g.onModuleDestroy()
  g.server = null

  const before = stamp.tag('tenant_shifo', 'products', '/products')
  g.changedIn('tenant_shifo', 'products')
  assert.notEqual(stamp.tag('tenant_shifo', 'products', '/products'), before, 'изменение прошло незамеченным')
})
