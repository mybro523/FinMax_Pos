// ── Подписка кончается сама, и об этом надо сказать вслух ──
// Никто не нажимает кнопку «просрочить»: просто наступает следующий день. Касса
// при этом открыта во вкладке сутками и своё состояние спрашивает только при
// запуске — без этой сверки кассир узнавал бы о просрочке от покупателя, вместе
// с первым отказом продать.
//
// Проверяем две вещи, каждая из которых уже была бы бедой:
//   рассылка при смене состояния — иначе предупреждение опаздывает на сутки;
//   молчание, когда ничего не изменилось — иначе каждый час дёргаются все аптеки.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')
const { SubscriptionWatchService } = require('../dist/admin/subscription-watch.service')

const DAY = 86400000

// Поддельная панель управления: отдаёт то, что ей положили
function fakeAdmin(rows) {
  return { pharmacy: { findMany: async () => rows } }
}

function fakeEvents() {
  const subs = []
  const panel = []
  const suspended = []
  return {
    subs,
    panel,
    suspended,
    subscriptionChanged: (schema, note) => subs.push({ schema, note }),
    suspendPharmacy: (schema, message) => suspended.push({ schema, message }),
    toService: (what, payload) => panel.push({ what, ...payload }),
  }
}

function pharmacy(over = {}) {
  return {
    id: 'p1',
    code: 'shifo',
    schemaName: 'tenant_shifo',
    paidUntil: new Date(Date.now() + 30 * DAY),
    trial: false,
    blocked: false,
    ...over,
  }
}

// Память сторожа тоже сбрасывается при смене состояния — подсовываем заглушку
const fakeAccounts = () => ({ dropped: [], dropPharmacy(id) { this.dropped.push(id) } })

function watcher(rows, events, accounts = fakeAccounts()) {
  const w = new SubscriptionWatchService(fakeAdmin(rows), events, accounts)
  w.accounts_ = accounts
  return w // onModuleInit не зовём: таймер в проверке не нужен
}

test('первый проход после запуска молчит — он только запоминает', async () => {
  // Иначе каждый перезапуск сервера рассылал бы всем аптекам их же состояние
  const e = fakeEvents()
  const ph = pharmacy({ paidUntil: new Date(Date.now() - 40 * DAY) }) // давно просрочена
  const changed = await watcher([ph], e).tick()
  assert.equal(changed, 0)
  assert.deepEqual(e.subs, [], 'разослал состояние, которое никто не менял')
})

test('срок вышел — аптеку отключают, а не предупреждают', async () => {
  // Прежде здесь начиналась отсрочка и аптека получала предупреждение. Теперь
  // срок значит срок: связь рвётся, а перед обрывом уходит объяснение.
  const e = fakeEvents()
  const ph = pharmacy({ paidUntil: new Date(Date.now() + 1 * DAY) })
  const w = watcher([ph], e)

  await w.tick() // запомнили: оплачено
  assert.deepEqual(e.suspended, [])

  const changed = await w.tick(new Date(Date.now() + 2 * DAY))
  assert.equal(changed, 1)
  assert.equal(e.suspended.length, 1, 'аптеку не отключили по истечении срока')
  assert.equal(e.suspended[0].schema, 'tenant_shifo')
  assert.match(e.suspended[0].message, /Подписка закончилась/, 'человеку не объяснили причину')
  assert.match(e.suspended[0].message, /данные аптеки сохранены/i, 'человек решит, что потерял аптеку')

  // И панель узнаёт: список «кому звонить сегодня» пересобирается сам
  assert.deepEqual(e.panel, [{ what: 'pharmacies', code: 'shifo' }])
  // И память сторожа сброшена — иначе аптека ещё десять секунд работала бы
  assert.deepEqual(w.accounts_.dropped, [ph.id])
})

test('пока ничего не меняется, никого не дёргаем', async () => {
  const e = fakeEvents()
  const w = watcher([pharmacy()], e)
  await w.tick()
  await w.tick()
  await w.tick()
  assert.deepEqual(e.subs, [], 'аптеку дёргают каждый час без причины')
})

test('продление отменяет отключение', async () => {
  // Клиент заплатил за час до срока. Отключить его после этого — потерять клиента
  // и объясняться потом по телефону.
  const e = fakeEvents()
  const ph = pharmacy({ paidUntil: new Date(Date.now() + 1 * DAY) })
  const w = watcher([ph], e)
  await w.tick()

  ph.paidUntil = new Date(Date.now() + 40 * DAY) // продлили
  const changed = await w.tick(new Date(Date.now() + 2 * DAY))
  assert.equal(changed, 0, 'состояние не менялось — аптека как была оплачена, так и осталась')
  assert.deepEqual(e.suspended, [], 'продлённую аптеку отключать нельзя')
})

test('удалённая аптека не остаётся в памяти навсегда', async () => {
  const e = fakeEvents()
  const rows = [pharmacy()]
  const w = new SubscriptionWatchService({ pharmacy: { findMany: async () => rows } }, e)
  await w.tick()
  rows.length = 0 // аптеку удалили
  await w.tick()
  assert.equal(w.seen.size, 0, 'память растёт вместе с забытыми кодами')
})
