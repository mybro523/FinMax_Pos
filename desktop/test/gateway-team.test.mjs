// ── Сотрудники без интернета глазами кассы: вход, пароли, блокировка, удаление ──
//
// Настоящий шлюз и настоящие базы касс, а вместо сервера — заглушка, которая умеет работать
// с сотрудниками (test-support/team-server.mjs). Владелец без связи заводит, блокирует и
// удаляет сотрудников, меняет им пароли и логины — на этой кассе или на соседней; связь
// пропадает и возвращается, правки уходят на сервер, а он их принимает, отвергает или
// оставляет своё. Главное обещание: без интернета касса пускает только того и только с тем
// паролем, кого пустил бы сервер. Чего касса знать не может (пароль сменили на соседней
// кассе — отпечаток по сети не ходит), того она не угадывает: вход без интернета закрыт до
// входа с интернетом.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { DAY } from '../test-support/pharmacy.mjs'
import { API, fakeSeal, manualTimers, memorySession } from '../test-support/server.mjs'
import { lan, makeServer, makeTill } from '../test-support/team-server.mjs'

const MIN = 60000

// Проверка с пояснением: что должно быть, а при неудаче — и что вышло на деле
function check(cond, what, extra) {
  assert.ok(cond, what + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''))
}

// Вход прямо на сервер, мимо кассы: какой пароль действует у самого сервера
async function serverLogin(S, name, password) {
  const res = await S.srv.fetchImpl(API + '/auth/login', { method: 'POST', headers: {}, body: JSON.stringify({ name, password }) })
  return res.status
}

// Кассы закрываются и тогда, когда проверка не прошла
function closeAfter(t, ...tills) {
  t.after(() => {
    for (const k of tills) k.gw.close()
  })
}

test('удалённый без связи сотрудник сразу не входит без интернета, а после принятого удаления его запись входа убрана; заведённый здесь, но не принятый сервером — не входит вовсе', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  // День первый: владелец работает с интернетом, список сотрудников ложится на кассу
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()

  // Позже на этой кассе с интернетом входит кассир (список на сервере не менялся — заново он не приходит)
  S.time.now += 30 * MIN
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (список сотрудников на сервере не менялся)')
  await A.gw.syncNow()

  // Владелец снова за кассой, интернет пропадает, владелец удаляет ali
  S.time.now += 30 * MIN
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()
  S.srv.state.online = false
  const del = await A.req('DELETE', '/users/acc-ali')
  check(del.status === 200, 'без связи: касса приняла удаление ali', del.status)
  check(!(await A.req('GET', '/users')).data.some((u) => u.id === 'acc-ali'), 'ali нет в списке сотрудников кассы')
  // Пока удаление ждёт ответа сервера, запись входа не стирается, а закрывается: сервер может
  // удаление не провести, и тогда сотрудник вернётся
  check(A.coreRow('ali')?.blocked === 1, 'запись входа ali закрыта, но не стёрта', A.coreRow('ali'))
  A.gw.logout()
  const gone = await A.login('ali', 'Ali-pass-1')
  check(gone.status === 401, 'после удаления ali без интернета не входит', { status: gone.status, user: gone.data?.user?.name })

  // Связь вернулась: удаление уходит ключом владельца, сервер его проводит — после этого обмена
  // записи входа ali на кассе больше нет
  S.srv.state.online = true
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом, очередь уходит')
  await A.gw.syncNow()
  check(!S.srv.state.users.has('ali'), 'сервер удалил ali')
  check(!A.coreRow('ali'), 'после принятого удаления запись входа ali убрана', A.coreRow('ali'))

  // Второй случай: сотрудник, заведённый на кассе без связи, которого сервер не принял
  S.srv.state.online = false
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит без интернета')
  const made = await A.req('POST', '/users', { name: 'temp1', password: 'Temp-pass-77' })
  check(made.status === 201, 'без связи: заведён сотрудник temp1', made.status)
  S.srv.state.online = true
  S.srv.rejectTeam = (op) => (op.type === 'user.create' ? 'Недостаточно прав' : null)
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом, очередь уходит')
  await A.gw.syncNow()
  await A.gw.syncNow()
  const rej = A.gw.rejected().map((o) => o.type)
  check(rej.includes('user.create'), 'сервер отверг заведение сотрудника', rej)
  check(!(await A.req('GET', '/users')).data.some((u) => u.name === 'temp1'), 'temp1 нет в списке кассы')
  S.srv.state.online = false
  A.gw.logout()
  const ghost = await A.login('temp1', 'Temp-pass-77')
  check(ghost.status !== 201, 'temp1, которого сервер так и не завёл, без интернета не входит', { status: ghost.status, user: ghost.data?.user?.name, role: ghost.data?.user?.role })
})

test('сотрудник, заблокированный здесь без связи, не входит и с интернетом, пока блокировка не дошла до сервера (ключ владельца за это время истёк)', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  S.srv.state.online = false
  S.time.now += 6 * DAY
  const blk = await A.req('PATCH', '/users/acc-ali', { active: false })
  check(blk.status === 200 && blk.data?.active === false, 'без связи: владелец заблокировал ali на этой кассе', blk.status)
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status !== 201, 'без связи: ali не входит')

  // Через два дня интернет вернулся; недельный ключ владельца за это время истёк — блокировку
  // отправить нечем, сервер о ней не знает
  S.time.now += 2 * DAY
  for (const [token, name] of S.srv.state.tokens) if (name === 'boss') S.srv.state.tokens.delete(token)
  S.srv.state.online = true
  const on = await A.login('ali', 'Ali-pass-1')
  check(on.status !== 201, 'с интернетом: ali, которую владелец заблокировал на этой кассе, не входит', { status: on.status, user: on.data?.user?.name })
  await A.gw.syncNow()
  await A.gw.syncNow()
  const work = await A.req('GET', '/products')
  check(!(work.status === 200 && A.session.activeId() === 'acc-ali'), 'работать на этой кассе ali не может', { status: work.status, active: A.session.activeId() })
})

test('пароль сменили без связи, а сотрудник успел войти через сервер прежним: после принятия смены без интернета подходит новый пароль, прежний — нет', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const NEW = 'Ali-new-pass-2'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  // Интернет пропал; владелец задаёт ali новый пароль
  S.time.now += 10 * MIN
  S.srv.state.online = false
  const pw = await A.req('PATCH', '/users/acc-ali', { password: NEW })
  check(pw.status === 200, 'без связи: владелец задал ali новый пароль', pw.status)

  // Интернет вернулся; первой за кассу садится ali и входит прежним паролем (смена ещё не ушла,
  // сервер знает прежний)
  S.time.now += 10 * MIN
  S.srv.state.online = true
  A.gw.logout()
  const old = await A.login('ali', 'Ali-pass-1')
  check(old.status === 201, 'ali входит С ИНТЕРНЕТОМ прежним паролем (сервер ещё знает его)', old.status)
  await A.gw.syncNow() // очередь уходит ключом владельца: смена принята, ключ ali отозван
  await A.gw.syncNow()

  // Позже обмен делает владелец (после удачного обмена список сотрудников ложится во вход без интернета)
  S.time.now += 10 * MIN
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', 'Ali-pass-1')) === 401 && (await serverLogin(S, 'ali', NEW)) === 201, 'сам сервер (вход мимо кассы): прежний пароль не принимает, новый принимает')

  // Интернет снова пропал
  S.srv.state.online = false
  A.gw.logout()
  const offOld = await A.login('ali', 'Ali-pass-1')
  check(offOld.status !== 201, 'без интернета ПРЕЖНИЙ пароль не подходит', offOld.status)
  A.gw.logout()
  const offNew = await A.login('ali', NEW)
  check(offNew.status === 201, 'без интернета НОВЫЙ пароль подходит', { status: offNew.status, msg: offNew.data?.message })
})

test('сотрудник попробовал новый пароль с интернетом раньше, чем касса отправила смену: после принятия он входит с ним и без интернета', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const NEW = 'Ali-new-pass-3'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()
  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: NEW })).status === 200, 'без связи: владелец задал ali новый пароль')
  A.gw.logout()

  // Интернет вернулся, и ali сразу пробует новый пароль: смена ещё не ушла, сервер знает прежний
  // и отказывает (401)
  S.srv.state.online = true
  await A.login('ali', NEW)

  // Приходит владелец, очередь уходит, смена принята
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом, очередь уходит')
  await A.gw.syncNow()
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', NEW)) === 201, 'сам сервер: действует новый пароль')

  S.srv.state.online = false
  A.gw.logout()
  const off = await A.login('ali', NEW)
  check(off.status === 201, 'без интернета ali входит с новым (принятым) паролем', { status: off.status, msg: off.data?.message })
})

test('новый сотрудник попробовал войти с интернетом раньше, чем касса отправила его заведение: после принятия он входит и без интернета', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  S.srv.state.online = false
  check((await A.req('POST', '/users', { name: 'novyi', password: 'Novyi-pass-1' })).status === 201, 'без связи: заведён сотрудник novyi')
  A.gw.logout()
  check((await A.login('novyi', 'Novyi-pass-1')).status === 201, 'без связи: novyi входит')
  A.gw.logout()

  // Интернет вернулся, novyi входит первым: заведение ещё не ушло, сервер его не знает (401)
  S.srv.state.online = true
  await A.login('novyi', 'Novyi-pass-1')
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом, очередь уходит')
  await A.gw.syncNow()
  await A.gw.syncNow()

  S.srv.state.online = false
  A.gw.logout()
  const off = await A.login('novyi', 'Novyi-pass-1')
  check(off.status === 201, 'без интернета novyi входит со своим (принятым) паролем', { status: off.status, msg: off.data?.message })
})

test('программу перезапустили, пока смена пароля ждёт отправки: вход через сервер прежним паролем не подменяет новый — без интернета подходит новый, прежний нет', async (t) => {
  const S = makeServer()
  const NEW = 'Ali-new-pass-2'
  // Один компьютер на два запуска программы: та же общая база, те же ключи и та же папка данных
  const core = openDb(':memory:', CORE_SCHEMA)
  const session = memorySession()
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-team-restart-'))
  const runs = []
  t.after(() => {
    for (const g of runs) g.close()
  })
  function start() {
    const g = createGateway({
      apiUrl: API,
      fetchImpl: (u, i) => S.srv.fetchImpl(u, i),
      session,
      core,
      cipher: fakeSeal,
      clock: { now: () => S.time.now, serverTime: () => {}, lic: () => S.time.now, floor: () => S.time.now },
      dataDir,
      timers: manualTimers(),
      emit: () => {},
      log: { info() {}, warn() {}, error() {} },
    })
    g.resume()
    runs.push(g)
    return g
  }

  let gw = start()
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = (n, p) => req('POST', '/auth/login', { name: n, password: p })

  check((await login('boss', 'Boss-pass-1')).status === 201, 'первый запуск: владелец входит с интернетом')
  await gw.syncNow()
  gw.logout()
  check((await login('ali', 'Ali-pass-1')).status === 201, 'первый запуск: ali входит с интернетом')
  await gw.syncNow()
  gw.logout()
  check((await login('boss', 'Boss-pass-1')).status === 201, 'первый запуск: снова владелец')
  await gw.syncNow()

  S.time.now += 10 * MIN
  S.srv.state.online = false
  check((await req('PATCH', '/users/acc-ali', { password: NEW })).status === 200, 'первый запуск, без связи: владелец задал ali новый пароль')
  gw.logout()
  gw.close()

  // Утро: программу запустили заново (никто не вошёл, база магазина ещё не открыта), интернет есть.
  // Первой за кассу садится ali и входит прежним паролем: смена ещё в очереди, сервер знает
  // прежний. Отпечаток нового пароля этот вход подменять не должен
  S.time.now += 12 * 60 * MIN
  S.srv.state.online = true
  gw = start()
  const on = await login('ali', 'Ali-pass-1')
  check(on.status === 201, 'второй запуск: ali входит С ИНТЕРНЕТОМ прежним паролем (смена ещё ждёт отправки)', on.status)
  await gw.syncNow()
  await gw.syncNow()
  check((await serverLogin(S, 'ali', NEW)) === 201 && (await serverLogin(S, 'ali', 'Ali-pass-1')) === 401, 'сам сервер: действует новый пароль, прежний — нет')

  // Интернет снова пропал
  S.srv.state.online = false
  gw.logout()
  const offOld = await login('ali', 'Ali-pass-1')
  check(offOld.status !== 201, 'без интернета прежний (отозванный) пароль не подходит', offOld.status)
  gw.logout()
  const offNew = await login('ali', NEW)
  check(offNew.status === 201, 'без интернета новый пароль подходит', { status: offNew.status, msg: offNew.data?.message })
})

test('после принятой смены пароля сотруднику задали на сайте пароль ещё новее, и он вошёл с ним: без интернета подходит пароль с сайта, а не заданный на кассе', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const P1 = 'Reset-on-till-1'
  const P2 = 'Reset-on-site-2'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: P1 })).status === 200, 'без связи: владелец задал ali пароль P1')
  A.gw.logout()

  // Пока P1 ждёт отправки, ali входит с интернетом прежним паролем. Смену сервер принимает и
  // отзывает ключ ali — её обмен получает отказ, и вход на кассе заканчивается
  S.time.now += 10 * MIN
  S.srv.state.online = true
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'с интернетом: ali входит прежним паролем, пока P1 ждёт отправки')
  await A.gw.syncNow()
  await A.gw.syncNow()

  // Сайт: P1 ali не знает — владелец задаёт пароль ещё раз (P2) и сообщает его
  S.time.now += 10 * MIN
  const u = S.srv.state.users.get('ali')
  u.hash = undefined
  u.password = P2
  for (const [token, name] of S.srv.state.tokens) if (name === 'ali') S.srv.state.revoked.add(token)
  A.gw.logout()
  check((await A.login('ali', P2)).status === 201, 'с интернетом: ali входит с P2 (его подтвердил сервер)')
  await A.gw.syncNow()
  await A.gw.syncNow()

  S.srv.state.online = false
  A.gw.logout()
  const p2 = await A.login('ali', P2)
  check(p2.status === 201, 'без интернета подходит P2 — пароль, который сервер принял последним', { status: p2.status, msg: p2.data?.message })
  A.gw.logout()
  const p1 = await A.login('ali', P1)
  check(p1.status !== 201, 'без интернета P1 (на сервере уже недействительный) не подходит', p1.status)
})

test('сервер оставил более поздний пароль с сайта: пароль, заданный на кассе, без интернета её не открывает', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const TILL = 'Till-reset-pass-1'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()
  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: TILL })).status === 200, 'без связи: владелец задал ali новый пароль на кассе')
  // Позже на сайте ali задали другой пароль: сервер оставит его, а на смену с кассы ответит
  // «принято», ничего не сделав
  S.srv.state.users.get('ali').password = 'Site-reset-pass-2'
  S.srv.noopTeam = (op) => op.type === 'user.update'
  S.srv.state.online = true
  await A.gw.syncNow()
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', TILL)) === 401, 'сам сервер: пароль с кассы не применён')

  S.srv.state.online = false
  A.gw.logout()
  const off = await A.login('ali', TILL)
  check(off.status !== 201, 'без интернета пароль с кассы (сервер его не применил) кассу не открывает', off.status)
})

test('две смены пароля без связи, вторую сервер отверг: без интернета подходит первая, принятая, а исходный пароль — нет', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const P1 = 'First-new-pass-1'
  const P2 = 'Second-new-pass-2'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: P1 })).status === 200, 'без связи: первая смена пароля')
  check((await A.req('PATCH', '/users/acc-ali', { password: P2, active: false })).status === 200, 'без связи: вторая смена пароля — вместе с блокировкой')

  // Сервер принимает первую и отвергает вторую (целиком — например, из-за блокировки)
  let n = 0
  S.srv.rejectTeam = (op) => (op.type === 'user.update' && ++n === 2 ? 'Нельзя заблокировать единственного владельца' : null)
  S.srv.state.online = true
  await A.gw.syncNow()
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', P1)) === 201 && (await serverLogin(S, 'ali', 'Ali-pass-1')) === 401, 'сам сервер: теперь действует P1, исходный пароль — нет')

  S.srv.state.online = false
  A.gw.logout()
  const p0 = await A.login('ali', 'Ali-pass-1')
  check(p0.status !== 201, 'без интернета исходный пароль не подходит', p0.status)
  A.gw.logout()
  const p1 = await A.login('ali', P1)
  check(p1.status === 201, 'без интернета принятый пароль P1 подходит', { status: p1.status, msg: p1.data?.message })
})

test('свою смену пароля без связи сервер отверг: без интернета снова подходит прежний пароль — и тогда, когда до этого пароль сменили на соседней кассе, а сотрудник вошёл здесь с новым через сервер', async (t) => {
  const V2 = 'Reset-on-A-222'
  const refusePw = (op) => (op.type === 'user.update' && op.payload?.set?.passwordHash ? 'Недостаточно прав' : null)

  // Сначала для сравнения — одна касса: смену пароля сервер отверг, и подходит прежний пароль
  {
    const S = makeServer()
    const A = makeTill(S, 'A')
    closeAfter(t, A)
    check((await A.login('boss', 'Boss-pass-1')).status === 201, 'одна касса: владелец входит с интернетом')
    await A.gw.syncNow()
    A.gw.logout()
    check((await A.login('ali', 'Ali-pass-1')).status === 201, 'одна касса: ali входит с интернетом (вход без интернета здесь теперь известен)')
    await A.gw.syncNow()
    A.gw.logout()
    check((await A.login('boss', 'Boss-pass-1')).status === 201, 'одна касса: владелец снова входит с интернетом')
    await A.gw.syncNow()
    S.srv.state.online = false
    check((await A.req('PATCH', '/users/acc-ali', { password: V2 })).status === 200, 'одна касса без связи: владелец задал ali новый пароль')
    S.srv.state.online = true
    S.srv.rejectTeam = refusePw
    await A.gw.syncNow()
    await A.gw.syncNow()
    S.srv.state.online = false
    A.gw.logout()
    const prev = await A.login('ali', 'Ali-pass-1')
    check(prev.status === 201, 'одна касса без интернета: смену сервер отверг — подходит прежний пароль', { status: prev.status, msg: prev.data?.message })
  }

  // Теперь до этого пароль ali сменили на соседней кассе B (V1), сервер смену принял, и ali вошла
  // с V1 здесь, на кассе A, с интернетом. Когда сервер отвергнет свою смену, та давняя, уже
  // подтверждённая смена соседа не должна снова сделать пароль «неизвестным»: прежний пароль здесь — V1
  {
    const S = makeServer()
    const A = makeTill(S, 'A')
    const B = makeTill(S, 'B')
    closeAfter(t, A, B)
    const V1 = 'Reset-on-B-111'
    for (const k of [A, B]) {
      check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
      await k.gw.syncNow()
    }
    A.gw.logout()
    check((await A.login('ali', 'Ali-pass-1')).status === 201, 'касса A: ali входит с интернетом (вход без интернета здесь теперь известен)')
    await A.gw.syncNow()
    A.gw.logout()
    check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: снова владелец')
    await A.gw.syncNow()
    lan(A, B)
    lan(B, A)

    // Касса B без связи задаёт ali пароль V1; по сети A узнаёт только, что пароль сменили
    S.srv.state.online = false
    check((await B.req('PATCH', '/users/acc-ali', { password: V1 })).status === 200, 'касса B без связи: ali задан пароль V1')
    lan(B, A)
    check(!A.coreRow('ali').hasVerifier, 'касса A: вход без интернета для ali закрыт — пароль сменили на соседней кассе, нового здесь не знают')

    // Связь вернулась: B отправляет смену, известие «сервер принял» по сети доходит до A, и A её подтверждает
    S.srv.state.online = true
    await B.gw.syncNow()
    lan(B, A)
    await A.gw.syncNow()
    await A.gw.syncNow()

    // ali входит на A с интернетом паролем V1 — теперь его знает и вход без интернета
    A.gw.logout()
    check((await A.login('ali', V1)).status === 201, 'касса A с интернетом: ali входит с V1 (его принял сервер)')
    await A.gw.syncNow()
    check(!!A.coreRow('ali').hasVerifier, 'касса A: вход без интернета для ali снова есть — по V1')
    A.gw.logout()
    check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: владелец снова входит с интернетом')
    await A.gw.syncNow()

    // Владелец на A без связи задаёт ali пароль V2 — эту смену сервер отвергнет
    S.srv.state.online = false
    check((await A.req('PATCH', '/users/acc-ali', { password: V2 })).status === 200, 'касса A без связи: ali задан пароль V2')
    S.srv.state.online = true
    S.srv.rejectTeam = refusePw
    await A.gw.syncNow()
    await A.gw.syncNow()
    const rej = A.gw.rejected().map((o) => o.type)
    check(rej.includes('user.update'), 'сервер отверг смену пароля V2', rej)

    S.srv.state.online = false
    A.gw.logout()
    const v1 = await A.login('ali', V1)
    check(v1.status === 201, 'касса A без интернета: подходит V1 — нынешний пароль на сервере (V2 отвергнут)', { status: v1.status, msg: v1.data?.message })
    A.gw.logout()
    const v2 = await A.login('ali', V2)
    check(v2.status !== 201, 'касса A без интернета: отвергнутый V2 не подходит', v2.status)
  }
})

test('второй владелец сменил сотруднику пароль без связи, а тот тем временем сам сменил свой пароль через сервер; смену владельца сервер отверг — без интернета подходит пароль, заданный самим сотрудником, а прежний (на сервере отозванный) нет', async (t) => {
  const S = makeServer()
  S.srv.addUser('boss2', 'Boss2-pass-1', 'founder', 'acc-boss2', { roleId: 'owner', roleName: 'Владелец' })
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const P1 = 'Reset-by-boss2-1'
  const W = 'Ali-own-new-W'
  // Что со сменой P1 в очереди отправки кассы
  const p1State = () => A.db().prepare("SELECT state FROM outbox WHERE type = 'user.update'").get()?.state

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss2', 'Boss2-pass-1')).status === 201, 'второй владелец boss2 входит с интернетом')
  await A.gw.syncNow()

  // Интернета нет; boss2 задаёт ali пароль P1
  S.srv.state.online = false
  const rs = await A.req('PATCH', '/users/acc-ali', { password: P1 })
  check(rs.status === 200, 'без связи: boss2 задал ali пароль P1', { status: rs.status, msg: rs.data?.message })
  A.gw.logout()
  // Неделя без интернета: ключи обоих владельцев на сервере истекли — P1 отправить пока нечем
  for (const [token, name] of S.srv.state.tokens) if (name === 'boss2' || name === 'boss') S.srv.state.tokens.delete(token)

  // Интернет вернулся; ali входит прежним паролем и сама меняет его на W — через сервер
  S.srv.state.online = true
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'с интернетом: ali входит прежним паролем')
  await A.gw.syncNow()
  check(p1State() === 'pending', 'смена P1 ждёт отправки', p1State())
  const cp = await A.req('POST', '/auth/change-password', { oldPassword: 'Ali-pass-1', newPassword: W })
  check(cp.status === 201, 'с интернетом: ali сменила свой пароль на W', cp.status)
  A.gw.logout()

  // Сайт: boss снял с boss2 права владельца. boss входит на кассе, P1 уходит его ключом, но автор
  // смены — boss2, и сервер её отвергает
  S.srv.state.users.get('boss2').role = 'cashier'
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'с интернетом: входит владелец boss, очередь уходит')
  await A.gw.syncNow()
  await A.gw.syncNow()
  check(p1State() === 'rejected', 'сервер отверг смену P1', p1State())
  check((await serverLogin(S, 'ali', W)) === 201 && (await serverLogin(S, 'ali', 'Ali-pass-1')) === 401, 'сам сервер: действует W, прежний пароль — нет')

  S.srv.state.online = false
  A.gw.logout()
  const old = await A.login('ali', 'Ali-pass-1')
  check(old.status !== 201, 'без интернета прежний пароль (на сервере отозванный) не подходит', old.status)
  A.gw.logout()
  const cur = await A.login('ali', W)
  check(cur.status === 201, 'без интернета подходит W — нынешний пароль на сервере', { status: cur.status, msg: cur.data?.message })
})

test('две смены пароля без связи: первую сервер принял, вторую в тот раз записать не смог; потом пароль задали на сайте, сотрудник вошёл с ним, а вторую смену сервер отверг — без интернета подходит пароль с сайта, а принятая раньше смена — нет', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const P0 = 'Reset-on-A-000'
  const P1 = 'Reset-on-A-111'
  const W = 'Reset-on-site-W'
  // Смены пароля в очереди отправки кассы — по порядку
  const queue = () => A.db().prepare("SELECT id, state FROM outbox WHERE type = 'user.update' ORDER BY seq").all()
  const states = () => queue().map((x) => x.state)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: P0 })).status === 200, 'без связи: владелец задал ali пароль P0')
  check((await A.req('PATCH', '/users/acc-ali', { password: P1 })).status === 200, 'без связи: и ещё раз — P1')
  const p1Id = queue()[1]?.id

  // Интернет вернулся: P0 сервер принимает, а P1 в этот раз записать не может — она остаётся в очереди
  S.srv.state.online = true
  S.srv.holdTeam = (op) => op.id === p1Id
  await A.gw.syncNow()
  S.srv.holdTeam = null
  check(states().join() === 'done,pending', 'P0 принята сервером, P1 ждёт повторной отправки', states())

  // Сайт: владелец задаёт ali пароль W, прежние ключи ali сервер отзывает
  const u = S.srv.state.users.get('ali')
  u.hash = undefined
  u.password = W
  for (const [token, name] of S.srv.state.tokens) if (name === 'ali') S.srv.state.revoked.add(token)
  A.gw.logout()
  // ali входит с W, пока P1 ещё в очереди; обмен, начатый входом, уносит P1, и сервер её отвергает
  S.srv.rejectTeam = (op) => (op.id === p1Id ? 'Недопустимый пароль' : null)
  check((await A.login('ali', W)).status === 201, 'с интернетом: ali входит с W, пока P1 ждёт отправки')
  await A.gw.syncNow()
  await A.gw.syncNow()
  check(states().join() === 'done,rejected', 'сервер отверг P1', states())
  check((await serverLogin(S, 'ali', W)) === 201 && (await serverLogin(S, 'ali', P0)) === 401, 'сам сервер: действует W, P0 — нет')

  S.srv.state.online = false
  A.gw.logout()
  const p0 = await A.login('ali', P0)
  check(p0.status !== 201, 'без интернета P0 (на сервере его заменил W) не подходит', p0.status)
  A.gw.logout()
  const w = await A.login('ali', W)
  check(w.status === 201, 'без интернета подходит W — нынешний пароль на сервере, с ним ali входила здесь', { status: w.status, msg: w.data?.message })
})

test('владелец сменил свой пароль без связи: новый подходит сразу, после отправки на сервер и потом без интернета', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-boss', { password: 'Boss-new-pass-2' })).status === 200, 'без связи: владелец сменил свой пароль')
  A.gw.logout()
  check((await A.login('boss', 'Boss-new-pass-2')).status === 201, 'без связи: новый пароль подходит')
  S.srv.state.online = true
  await A.gw.syncNow()
  await A.gw.syncNow()
  A.gw.logout()
  const back = await A.login('boss', 'Boss-new-pass-2')
  check(back.status === 201, 'с интернетом: после отправки владелец входит новым паролем', back.status)
  await A.gw.syncNow()
  S.srv.state.online = false
  A.gw.logout()
  check((await A.login('boss', 'Boss-new-pass-2')).status === 201, 'потом без интернета новый пароль по-прежнему подходит')
})

test('владелец сменил свой пароль без связи, смена ушла под кассиром: отозванный ключ владельца не стирает новый пароль — без интернета он входит', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const NEW = 'Boss-new-pass-9'

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-boss', { password: NEW })).status === 200, 'без связи: владелец сменил свой пароль')
  A.gw.logout()

  // Интернет вернулся; за кассой кассир — очередь уходит под её входом. Сервер принимает смену
  // и отзывает ключи владельца
  S.srv.state.online = true
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом')
  await A.gw.syncNow()
  await A.gw.syncNow()

  // Интернет пропал; владелец работает без связи с новым паролем
  S.srv.state.online = false
  A.gw.logout()
  check((await A.login('boss', NEW)).status === 201, 'без связи: владелец входит с новым паролем')
  const cust = await A.req('POST', '/customers', { name: 'Новый покупатель', phone: '' })
  check(cust.status === 201, 'без связи: владелец заводит клиента', cust.status)

  // Интернет вернулся — обмен. Отозванный ключ владельца касса убрала, как только сервер принял
  // смену: отказ по нему не сотрёт верный отпечаток
  S.srv.state.online = true
  await A.gw.syncNow()

  S.srv.state.online = false
  A.gw.logout()
  const again = await A.login('boss', NEW)
  check(again.status === 201, 'без интернета владелец по-прежнему входит с новым (верным, принятым) паролем', { status: again.status, msg: again.data?.message })
})

test('пароль сменили без связи на соседней кассе: здесь без интернета не подходит ни прежний, ни новый (отпечаток по сети не ходит), и через две недели прежний не возвращается; новый заработает после одного входа с интернетом', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)
  const OLD = 'Ali-pass-1'
  const NEW = 'Reset-on-A-2026'

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  B.gw.logout()
  check((await B.login('ali', OLD)).status === 201, 'касса B: ali входит с интернетом (вход без интернета здесь теперь известен)')
  await B.gw.syncNow()
  B.gw.logout()
  check((await B.login('boss', 'Boss-pass-1')).status === 201, 'касса B: снова владелец')
  await B.gw.syncNow()

  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: NEW })).status === 200, 'касса A без связи: ali задан новый пароль')
  lan(A, B)
  // По сети B узнаёт только, что пароль сменили: самого отпечатка там нет. Прежний пароль больше
  // не годится, а новый кассе B неизвестен — до входа с интернетом входа без него нет
  B.gw.logout()
  const oldAfterLan = await B.login('ali', OLD)
  check(oldAfterLan.status !== 201, 'касса B без связи: прежний пароль не подходит', oldAfterLan.status)
  B.gw.logout()
  const newAfterLan = await B.login('ali', NEW)
  check(newAfterLan.status !== 201, 'касса B без связи: новый пароль тоже не подходит — его отпечатка здесь нет', newAfterLan.status)
  B.gw.logout()
  check((await B.login('boss', 'Boss-pass-1')).status === 201, 'касса B: владелец снова за кассой')

  // Касса A выходит в интернет и отправляет смену; с кассой B по сети она больше не встречается
  S.srv.state.online = true
  await A.gw.syncNow()
  check(S.srv.state.teamLog.some((x) => x.type === 'user.update'), 'сервер принял смену пароля от кассы A')
  A.gw.close()

  // Касса B две недели работает с интернетом. В её обменах о пароле ни слова, известие «сервер
  // принял» от A так и не пришло — запись соседа за это время истекает и снимается
  for (let d = 1; d <= 15; d++) {
    S.time.now += DAY
    await B.gw.syncNow()
  }
  check((await serverLogin(S, 'ali', NEW)) === 201 && (await serverLogin(S, 'ali', OLD)) === 401, 'сам сервер: действует новый пароль')
  S.srv.state.online = false
  B.gw.logout()
  const oldOnB = await B.login('ali', OLD)
  check(oldOnB.status !== 201, 'касса B без связи: прежний пароль не вернулся', oldOnB.status)
  B.gw.logout()
  const newOnB = await B.login('ali', NEW)
  check(newOnB.status !== 201, 'касса B без связи: новый пароль — только после входа с интернетом', newOnB.status)

  // Один вход с интернетом на кассе B — и новый пароль действует здесь и без связи
  B.gw.logout()
  S.srv.state.online = true
  const online = await B.login('ali', NEW)
  check(online.status === 201, 'касса B: ali входит с интернетом новым паролем', online.status)
  S.srv.state.online = false
  B.gw.logout()
  const newOff = await B.login('ali', NEW)
  check(newOff.status === 201, 'касса B без связи: новый пароль подходит', { status: newOff.status, msg: newOff.data?.message })
  B.gw.logout()
  const oldOff = await B.login('ali', OLD)
  check(oldOff.status !== 201, 'касса B без связи: прежний пароль не подходит', oldOff.status)
})

test('пароль сменили без связи на двух кассах, сервер оставил более позднюю смену: пароль первой кассы без интернета её не открывает', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)
  const PA = 'Set-on-A-1000'
  const PB = 'Set-on-B-1005'

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'касса A: ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: снова владелец')
  await A.gw.syncNow()

  S.srv.state.online = false
  S.time.now += 10 * MIN
  check((await A.req('PATCH', '/users/acc-ali', { password: PA })).status === 200, 'касса A без связи: ali задан пароль PA')
  S.time.now += 5 * MIN
  check((await B.req('PATCH', '/users/acc-ali', { password: PB })).status === 200, 'касса B без связи, пятью минутами позже: ali задан пароль PB')
  lan(A, B)
  lan(B, A)

  // Интернет первой получает касса A: её смена принята
  S.srv.state.online = true
  S.time.now += MIN
  await A.gw.syncNow()
  // Затем касса B: сервер оставляет её, более позднюю смену. Известие «сервер принял» от B
  // доходит до A по сети, следующий обмен A подтверждает правку B
  await B.gw.syncNow()
  lan(A, B)
  lan(B, A)
  await A.gw.syncNow()
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', PB)) === 201 && (await serverLogin(S, 'ali', PA)) === 401, 'сам сервер: действует PB (более поздняя смена), PA — нет')

  S.srv.state.online = false
  A.gw.logout()
  const pa = await A.login('ali', PA)
  check(pa.status !== 201, 'касса A без связи: PA (сервер его уже не принимает) кассу не открывает', pa.status)
})

test('пароль сменили без связи на двух кассах, а сотрудник вошёл через сервер прежним, пока смена этой кассы ждала отправки: смена соседа (более поздняя) не теряется — пароль этой кассы без интернета её не открывает', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)
  const C1 = 'Reset-on-A-c1c1'
  const M = 'Reset-on-B-mmmm'

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'касса A: ali входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: снова владелец')
  await A.gw.syncNow()
  lan(A, B)
  lan(B, A)

  // Без связи: владелец на A задаёт ali пароль C1 и выходит; минутой позже владелец на B
  // задаёт ей пароль M — пометка «пароль сменили» доходит до A по сети
  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-ali', { password: C1 })).status === 200, 'касса A без связи: ali задан пароль C1')
  A.gw.logout()
  S.time.now += MIN
  check((await B.req('PATCH', '/users/acc-ali', { password: M })).status === 200, 'касса B без связи, минутой позже: ali задан пароль M')
  lan(B, A)

  // Интернет вернулся. Ali входит на A прежним паролем (C1 ещё не ушёл). Обмен A отправляет C1
  // ключом владельца — сервер отзывает свежий ключ ali, и получение сразу после отправки
  // отказано: перенос сотрудников в этот раз не идёт
  S.srv.state.online = true
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'касса A с интернетом: ali входит прежним паролем (C1 ещё не отправлен)')
  await A.gw.syncNow()
  // B отправляет M (он позже — остаётся он) и сообщает об этом A
  S.time.now += MIN
  await B.gw.syncNow()
  lan(B, A)
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: позже входит владелец')
  await A.gw.syncNow()
  check((await serverLogin(S, 'ali', M)) === 201 && (await serverLogin(S, 'ali', C1)) === 401, 'сам сервер: действует M, C1 — нет')

  S.srv.state.online = false
  A.gw.logout()
  const c1 = await A.login('ali', C1)
  check(c1.status !== 201, 'касса A без связи: C1 (на сервере его сменила более поздняя смена соседа) кассу не открывает', c1.status)
})

test('сотрудник работает за кассой, а соседняя касса его удалила: выйдя, без интернета он больше не войдёт', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  // ali знакома кассе B по прошлому входу (её вход с интернетом старше списка сотрудников на B)
  B.gw.logout()
  check((await B.login('ali', 'Ali-pass-1')).status === 201, 'касса B: ali входит с интернетом (вход без интернета здесь теперь известен)')
  await B.gw.syncNow()
  B.gw.logout()
  S.srv.state.roles.push({ id: 'r-y', name: 'Новая', description: '', system: null, permissions: [], people: 0 })
  S.time.now += MIN
  check((await B.login('boss', 'Boss-pass-1')).status === 201, 'касса B: владелец получает более новый список сотрудников')
  await B.gw.syncNow()
  B.gw.logout()

  // Интернета нет; ali работает на B, а владелец удаляет её на A
  S.srv.state.online = false
  check((await B.login('ali', 'Ali-pass-1')).status === 201, 'касса B без связи: ali за кассой')
  check((await A.req('DELETE', '/users/acc-ali')).status === 200, 'касса A без связи: владелец удалил ali')
  lan(A, B)
  B.gw.logout()
  const again = await B.login('ali', 'Ali-pass-1')
  check(again.status !== 201, 'касса B без связи: после удаления ali, выйдя, снова не входит', { status: again.status, user: again.data?.user?.name })
})

test('правка соседа, не подтверждённая сервером, прав не расширяет (владелец, новые права роли), а блокировка от соседа действует сразу; снять её владелец может здесь', async (t) => {
  const S = makeServer()
  S.srv.addUser('bob', 'Bob-pass-1', 'cashier', 'acc-bob', { roleId: 'r-cashier', roleName: 'Кассир' })
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  for (const [n, p] of [['ali', 'Ali-pass-1'], ['bob', 'Bob-pass-1']]) {
    A.gw.logout()
    check((await A.login(n, p)).status === 201, `касса A: ${n} входит с интернетом (вход без интернета здесь теперь известен)`)
    await A.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: снова владелец')
  await A.gw.syncNow()
  const perms = (login) => JSON.parse(A.coreRow(login).permissions || '[]')

  S.srv.state.online = false
  // Соседняя касса B: ali — владельцем, роли кассира — право на кассы, bob — заблокирован
  check((await B.req('PATCH', '/users/acc-ali', { roleId: 'owner' })).status === 200, 'касса B: ali назначена владельцем')
  check((await B.req('PATCH', '/roles/r-cashier', { permissions: ['pos.sell', 'shift.open', 'shift.view', 'settings.devices'] })).status === 200, 'касса B: роли кассира добавлено право на кассы')
  check((await B.req('PATCH', '/users/acc-bob', { active: false })).status === 200, 'касса B: bob заблокирован')
  lan(B, A)
  check(A.coreRow('ali').role === 'cashier', 'касса A: по неподтверждённой правке соседа ali владельцем не стала', A.coreRow('ali').role)
  check(!perms('bob').includes('settings.devices'), 'касса A: по неподтверждённой правке роли у соседа bob права на кассы не получил', perms('bob'))
  check(A.coreRow('bob').blocked === 1, 'касса A: bob заблокирован правкой соседа (урезание действует сразу)')

  // Владелец на кассе A сам снимает блокировку с bob
  const un = await A.req('PATCH', '/users/acc-bob', { active: true })
  check(un.status === 200 && un.data?.active === true, 'касса A: владелец снял блокировку с bob (своя правка)', un.status)
  A.gw.logout()
  const b = await A.login('bob', 'Bob-pass-1')
  check(b.status === 201, 'касса A без связи: bob, разблокированный владельцем на этой же кассе, входит', { status: b.status, msg: b.data?.message })
})

test('разблокировка с соседней кассы, не подтверждённая сервером, не открывает вход тому, кого эта касса сама заблокировала или удалила: пока своя правка ждёт отправки, сотрудник не входит и с интернетом', async (t) => {
  // Магазин с двумя кассами; на кассе A ali уже входила с интернетом
  async function shop() {
    const S = makeServer()
    const A = makeTill(S, 'A')
    const B = makeTill(S, 'B')
    closeAfter(t, A, B)
    for (const k of [A, B]) {
      check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
      await k.gw.syncNow()
    }
    A.gw.logout()
    check((await A.login('ali', 'Ali-pass-1')).status === 201, 'касса A: ali входит с интернетом (вход без интернета здесь теперь известен)')
    await A.gw.syncNow()
    A.gw.logout()
    check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: снова владелец')
    await A.gw.syncNow()
    lan(A, B)
    lan(B, A)
    return { S, A, B }
  }

  // Первый случай: касса A заблокировала ali, а касса B, увидев это, блокировку сняла
  {
    const { S, A, B } = await shop()
    S.srv.state.online = false
    check((await A.req('PATCH', '/users/acc-ali', { active: false })).status === 200, 'касса A без связи: владелец заблокировал ali')
    lan(A, B)
    const un = await B.req('PATCH', '/users/acc-ali', { active: true })
    check(un.status === 200 && un.data?.active === true, 'касса B без связи: владелец, увидев блокировку, снял её', un.status)
    lan(B, A)
    check(A.coreRow('ali').blocked === 1, 'касса A: вход без интернета для ali закрыт — разблокировку соседа сервер не подтвердил', A.coreRow('ali').blocked)
    A.gw.logout()
    check((await A.login('ali', 'Ali-pass-1')).status !== 201, 'касса A без связи: ali не входит')

    // Интернет вернулся, но ни блокировка A, ни разблокировка B на сервер ещё не ушли
    S.srv.state.online = true
    const on = await A.login('ali', 'Ali-pass-1')
    check(on.status !== 201, 'касса A с интернетом: ali не входит — своя блокировка ждёт отправки, а разблокировку соседа сервер не подтвердил', { status: on.status, active: A.session.activeId() })
    A.gw.logout()
    S.srv.state.online = false
    const off = await A.login('ali', 'Ali-pass-1')
    check(off.status !== 201, 'касса A без связи: ali по-прежнему не входит', off.status)
  }

  // Второй случай: B заблокировала ali, A её удалила, а B потом блокировку сняла. Удаление
  // окончательно — последующая правка соседа его не отменяет
  {
    const { S, A, B } = await shop()
    S.srv.state.online = false
    check((await B.req('PATCH', '/users/acc-ali', { active: false })).status === 200, 'касса B без связи: владелец заблокировал ali')
    lan(B, A)
    const del = await A.req('DELETE', '/users/acc-ali')
    check(del.status === 200, 'касса A без связи: владелец удалил ali', del.status)
    check((await B.req('PATCH', '/users/acc-ali', { active: true })).status === 200, 'касса B без связи: владелец снял с ali блокировку')
    lan(B, A)
    check(A.coreRow('ali')?.blocked === 1, 'касса A: запись входа ali закрыта удалением, которое ждёт отправки', A.coreRow('ali'))
    A.gw.logout()

    S.srv.state.online = true
    const on = await A.login('ali', 'Ali-pass-1')
    check(on.status !== 201, 'касса A с интернетом: удалённая здесь ali не входит, пока удаление ждёт отправки', { status: on.status, active: A.session.activeId() })
  }
})

test('сотрудник, которого соседняя касса без связи завела владельцем, не входит здесь без интернета с правами владельца оттого, что владелец этой кассы задал ему пароль: сервер его ещё не видел', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  lan(A, B)
  lan(B, A)

  S.srv.state.online = false
  const mk = await B.req('POST', '/users', { name: 'carl', password: 'Carl-on-B-1', roleId: 'owner' })
  check(mk.status === 201 && mk.data?.role === 'founder', 'касса B без связи: заведён сотрудник carl — владельцем', { status: mk.status, role: mk.data?.role })
  lan(B, A)
  check(!A.coreRow('carl'), 'касса A: заведённого соседом carl во входе без интернета пока нет')

  // Владелец на кассе A задаёт carl пароль — роль он не трогает
  const pw = await A.req('PATCH', '/users/' + mk.data?.id, { password: 'Carl-on-A-2' })
  check(pw.status === 200, 'касса A без связи: владелец задал carl пароль (роль не менял)', pw.status)
  A.gw.logout()
  const c = await A.login('carl', 'Carl-on-A-2')
  check(!(c.status === 201 && c.data?.user?.role === 'founder'), 'касса A без связи: carl не входит владельцем — его заведение на соседней кассе сервер ещё не подтвердил', { status: c.status, role: c.data?.user?.role, core: A.coreRow('carl') })
})

test('испорченная запись роли из обмена по сети (права — не список) не срывает перенос сотрудников во вход без интернета: заблокированный здесь сотрудник не входит', async (t) => {
  const S = makeServer()
  S.srv.addUser('bob', 'Bob-pass-1', 'cashier', 'acc-bob', { roleId: 'r-cashier', roleName: 'Кассир' })
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('bob', 'Bob-pass-1')).status === 201, 'bob входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()

  // Без связи по сети приходит подделанная запись «от соседней кассы»: права роли кассира — число,
  // а не список (имена полей касса сверяет, значения — нет)
  S.srv.state.online = false
  const body = { effects: { docs: [], moves: [], debts: [], edits: { rows: [{ tbl: 'team_roles', rowId: 'r-cashier', action: 'put', data: { set: { permissions: 5 }, was: {} } }], adj: [] } } }
  A.gw.lanHub.receive('evil-device', [{ seq: 1, id: 'evil-op-1', kind: 'op', origin: 'evil-device', type: 'role.update', accountId: null, createdAt: new Date(S.time.now).toISOString(), body: JSON.stringify(body), wide: 0, redacted: 0 }])

  // Владелец на этой кассе блокирует bob — вход без интернета для него закрывается сразу
  const blk = await A.req('PATCH', '/users/acc-bob', { active: false })
  check(blk.status === 200, 'без связи: владелец заблокировал bob', blk.status)
  check(A.coreRow('bob')?.blocked === 1, 'вход без интернета для bob закрыт', { bob: A.coreRow('bob'), warns: A.warns })
  A.gw.logout()
  const b = await A.login('bob', 'Bob-pass-1')
  check(b.status !== 201, 'без связи: заблокированный здесь bob не входит', { status: b.status, user: b.data?.user?.name })
})

test('соседняя касса блокирует, удаляет и назначает роль тем, кого эта касса завела без связи: сервер получает всё, и в верном порядке', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  S.srv.state.online = false
  const nov = await A.req('POST', '/users', { name: 'novyi', password: 'Novyi-pass-1' })
  const tmp = await A.req('POST', '/users', { name: 'temp2', password: 'Temp2-pass-1' })
  const role = await A.req('POST', '/roles', { name: 'Склад', permissions: ['pos.sell', 'arrivals.view'] })
  check(nov.status === 201 && tmp.status === 201 && role.status === 201, 'касса A без связи: заведены сотрудники novyi, temp2 и роль «Склад»', [nov.status, tmp.status, role.status])
  lan(A, B)
  const blk = await B.req('PATCH', '/users/' + nov.data.id, { active: false })
  const del = await B.req('DELETE', '/users/' + tmp.data.id)
  const asg = await B.req('PATCH', '/users/acc-ali', { roleId: role.data.id })
  check(blk.status === 200 && del.status === 200 && asg.status === 200, 'касса B без связи: novyi заблокирован, temp2 удалён, ali — в роли «Склад»', [blk.status, del.status, asg.status])

  // Интернет первой получает касса B, чуть позже — A. Правки B ждут, пока A отправит то, что завела
  S.srv.state.online = true
  await B.gw.syncNow()
  await A.gw.syncNow()
  lan(A, B)
  lan(B, A)
  await B.gw.syncNow()
  await A.gw.syncNow()

  const srvNov = S.srv.state.users.get('novyi')
  const srvTmp = S.srv.state.users.get('temp2')
  const srvAli = S.srv.state.users.get('ali')
  check(srvNov && srvNov.active === false, 'сервер: novyi заблокирован (владелец заблокировал его на B)', srvNov && { active: srvNov.active })
  check(!srvTmp, 'сервер: temp2 удалён (владелец удалил его на B)', srvTmp && { name: srvTmp.name, active: srvTmp.active })
  check(srvAli.roleId === role.data.id, 'сервер: у ali роль «Склад»', { roleId: srvAli.roleId, roleName: srvAli.roleName })
})

test('сервер принял правку сотрудника, но оставил своё (удаление, переименование): касса берёт его список заново, и вход без интернета — по нему', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('ali', 'Ali-pass-1')).status === 201, 'ali входит с интернетом (вход без интернета здесь теперь известен)')
  await A.gw.syncNow()
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит с интернетом')
  await A.gw.syncNow()
  // Список на сервере меняется ещё раз: вход ali с интернетом теперь старше списка на кассе
  S.srv.state.roles.push({ id: 'r-x', name: 'Склад', description: '', system: null, permissions: ['arrivals.create'], people: 0 })
  S.time.now += MIN
  await A.gw.syncNow()

  // Удаление сервер оставил без последствий (сотрудника на сайте правили позже)
  S.srv.state.online = false
  check((await A.req('DELETE', '/users/acc-ali')).status === 200, 'без связи: владелец удалил ali')
  S.srv.noopTeam = (op) => op.type === 'user.delete'
  S.srv.state.online = true
  await A.gw.syncNow()
  await A.gw.syncNow()
  check(S.srv.teamOf().accounts.some((a) => a.id === 'acc-ali'), 'на сервере ali остаётся (удаление не проведено)')
  let list = (await A.req('GET', '/users')).data
  check(list.some((u) => u.id === 'acc-ali'), 'в списке кассы ali снова есть — после полной загрузки', list.map((u) => u.name))
  await A.gw.resync()
  await A.gw.syncNow()
  list = (await A.req('GET', '/users')).data
  check(list.some((u) => u.id === 'acc-ali'), 'ali есть в списке и после «загрузить всё заново»', list.map((u) => u.name))
  check(!!A.coreRow('ali'), 'вход без интернета для ali на кассе остаётся (на сервере ali есть)', A.coreRow('ali'))
  S.srv.noopTeam = null

  // Переименование сервер не провёл (логин занят)
  S.srv.state.online = false
  check((await A.req('PATCH', '/users/acc-boss', { name: 'boss-renamed' })).status === 200, 'без связи: владелец сменил свой логин на boss-renamed')
  S.srv.noopTeam = (op) => op.type === 'user.update'
  S.srv.state.online = true
  await A.gw.syncNow()
  await A.gw.syncNow()
  check(S.srv.teamOf().accounts.some((a) => a.name === 'boss'), 'на сервере логин остался boss (переименование не проведено)')
  list = (await A.req('GET', '/users')).data
  check(list.some((u) => u.name === 'boss'), 'в списке кассы — логин сервера boss', list.map((u) => u.name))
  check(!!A.coreRow('boss'), 'вход без интернета под boss (настоящим логином) по-прежнему возможен', { boss: A.coreRow('boss')?.login, renamed: A.coreRow('boss-renamed')?.login })
})

test('два сотрудника поменялись логинами на сайте: оба входят без интернета — каждый под своим новым логином', async (t) => {
  const S = makeServer()
  S.srv.addUser('vali', 'Vali-pass-1', 'cashier', 'acc-vali', { roleId: 'r-cashier', roleName: 'Кассир' })
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  for (const [n, p] of [['ali', 'Ali-pass-1'], ['vali', 'Vali-pass-1']]) {
    A.gw.logout()
    check((await A.login(n, p)).status === 201, `${n} входит с интернетом (вход без интернета здесь теперь известен)`)
    await A.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец за кассой')
  await A.gw.syncNow()

  // Сайт: два логина меняются местами (пароли прежние)
  const users = S.srv.state.users
  const ali = users.get('ali')
  const vali = users.get('vali')
  users.delete('ali')
  users.delete('vali')
  ali.name = 'vali'
  vali.name = 'ali'
  users.set('vali', ali)
  users.set('ali', vali)
  S.time.now += MIN
  await A.gw.syncNow()
  const ids = A.core.prepare('SELECT id FROM accounts').all().map((x) => x.id)
  check(ids.includes('acc-ali') && ids.includes('acc-vali'), 'оба сотрудника по-прежнему известны входу без интернета', ids)

  S.srv.state.online = false
  A.gw.logout()
  const a = await A.login('vali', 'Ali-pass-1') // acc-ali, теперь под логином vali
  A.gw.logout()
  const b = await A.login('ali', 'Vali-pass-1') // acc-vali, теперь под логином ali
  check(a.status === 201 && b.status === 201, 'без связи оба входят под новыми логинами', { 'acc-ali как vali': a.status, 'acc-vali как ali': b.status, msg: b.data?.message || a.data?.message })
})

test('два сотрудника с одним логином (переименовали на разных кассах) — блокировка всё равно действует без связи', async (t) => {
  const S = makeServer()
  S.srv.addUser('bob', 'Bob-pass-1', 'cashier', 'acc-bob', { roleId: 'r-cashier', roleName: 'Кассир' })
  S.srv.addUser('carol', 'Carol-pass-1', 'cashier', 'acc-carol', { roleId: 'r-cashier', roleName: 'Кассир' })
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  for (const [n, p] of [['ali', 'Ali-pass-1'], ['bob', 'Bob-pass-1'], ['carol', 'Carol-pass-1']]) {
    A.gw.logout()
    check((await A.login(n, p)).status === 201, `касса A: ${n} входит с интернетом (вход без интернета здесь теперь известен)`)
    await A.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'касса A: владелец за кассой')
  await A.gw.syncNow()

  // Без связи каждая касса сверяет логин только со своим списком: A переименовывает ali в x,
  // B — bob в x. После обмена по сети у A два сотрудника с логином x
  S.srv.state.online = false
  const ra = await A.req('PATCH', '/users/acc-ali', { name: 'x' })
  const rb = await B.req('PATCH', '/users/acc-bob', { name: 'x' })
  check(ra.status === 200 && rb.status === 200, 'без связи: A переименовала ali в x, B — bob в x (каждой по её списку можно)', [ra.status, rb.status])
  lan(B, A)

  // Владелец тут же блокирует carol на A
  const blk = await A.req('PATCH', '/users/acc-carol', { active: false })
  check(blk.status === 200 && blk.data?.active === false, 'касса A без связи: владелец заблокировал carol', blk.status)
  check(A.coreRow('carol')?.blocked === 1, 'вход без интернета для carol на A закрыт', A.coreRow('carol'))
  A.gw.logout()
  const c = await A.login('carol', 'Carol-pass-1')
  check(c.status !== 201, 'касса A без связи: заблокированная carol не входит', { status: c.status, user: c.data?.user?.name })
})

test('новый логин сотрудника на сайте тем временем отдали другому — блокировка на этой кассе всё равно действует без связи', async (t) => {
  const S = makeServer()
  S.srv.addUser('bob', 'Bob-pass-1', 'cashier', 'acc-bob', { roleId: 'r-cashier', roleName: 'Кассир' })
  S.srv.addUser('carol', 'Carol-pass-1', 'cashier', 'acc-carol', { roleId: 'r-cashier', roleName: 'Кассир' })
  const A = makeTill(S, 'A')
  closeAfter(t, A)

  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит с интернетом')
  await A.gw.syncNow()
  for (const [n, p] of [['ali', 'Ali-pass-1'], ['bob', 'Bob-pass-1'], ['carol', 'Carol-pass-1']]) {
    A.gw.logout()
    check((await A.login(n, p)).status === 201, `${n} входит с интернетом (вход без интернета здесь теперь известен)`)
    await A.gw.syncNow()
  }
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова за кассой')
  await A.gw.syncNow()

  S.srv.state.online = false
  S.time.now += 6 * DAY
  check((await A.req('PATCH', '/users/acc-ali', { name: 'x' })).status === 200, 'без связи: владелец переименовал ali в x')
  A.gw.logout()

  // Сайт тем временем: bob переименован в x. Недельный ключ владельца на этой кассе истёк —
  // переименование ali отправить нечем; обмен кассира приносит список сайта (bob = x), а своя
  // правка поверх него делает x и ali
  const bob = S.srv.state.users.get('bob')
  S.srv.state.users.delete('bob')
  bob.name = 'x'
  S.srv.state.users.set('x', bob)
  for (const [token, name] of S.srv.state.tokens) if (name === 'boss') S.srv.state.tokens.delete(token)
  S.time.now += 2 * DAY
  S.srv.state.online = true
  check((await A.login('carol', 'Carol-pass-1')).status === 201, 'интернет вернулся: carol входит с интернетом')
  await A.gw.syncNow()
  await A.gw.syncNow()

  // Интернет пропал; владелец за кассой блокирует carol
  S.srv.state.online = false
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'без связи: владелец входит')
  const blk = await A.req('PATCH', '/users/acc-carol', { active: false })
  check(blk.status === 200, 'без связи: владелец заблокировал carol', blk.status)
  A.gw.logout()
  const c = await A.login('carol', 'Carol-pass-1')
  check(c.status !== 201, 'без связи: заблокированная carol не входит', { status: c.status, user: c.data?.user?.name })
})

test('отпечаток пароля открыто не лежит нигде — ни в базах обеих касс, ни в обмене по сети; на сервер он уходит как есть', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  const B = makeTill(S, 'B')
  closeAfter(t, A, B)

  for (const k of [A, B]) {
    check((await k.login('boss', 'Boss-pass-1')).status === 201, `касса ${k.name}: владелец входит с интернетом`)
    await k.gw.syncNow()
  }
  S.srv.state.online = false
  const made = await A.req('POST', '/users', { name: 'novyi', password: 'Novyi-pass-1' })
  const reset = await A.req('PATCH', '/users/acc-ali', { password: 'Ali-reset-22' })
  check(made.status === 201 && reset.status === 200, 'касса A без связи: заведён сотрудник и сменён пароль')
  // Обмен по сети — как lan(), но с тем, что идёт по проводу
  const wire = []
  for (;;) {
    const out = A.gw.lanHub.entriesFor(A.seen, true)
    A.seen = out.upTo
    wire.push(...out.entries)
    if (out.entries.length) B.gw.lanHub.receive(A.gw.deviceId, out.entries)
    if (!out.more) break
  }
  // Отпечаток пароля (scrypt) начинается с s3$
  check(!JSON.stringify(wire).includes('s3$'), 'в обмене по сети отпечатка нет')
  const scan = (db, label) => {
    const hits = []
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
        if (JSON.stringify(row).includes('s3$')) hits.push(name)
      }
    }
    check(!hits.length, `${label}: открытого отпечатка нет ни в одной таблице`, [...new Set(hits)])
  }
  scan(A.db(), 'база магазина на A')
  scan(B.db(), 'база магазина на B')
  scan(A.core, 'общая база на A')
  scan(B.core, 'общая база на B')

  // Серверу отпечаток нужен как есть: в отправке — он, а не зашифрованное поле
  const calls = []
  const orig = S.srv.fetchImpl
  S.srv.fetchImpl = async (u, i) => {
    if (u.endsWith('/sync/push')) calls.push(i.body)
    return orig(u, i)
  }
  S.srv.state.online = true
  await A.gw.syncNow()
  check(calls.some((b) => b.includes('s3$')) && !calls.some((b) => b.includes('passwordSealed')), 'в отправке на сервер — открытый отпечаток, зашифрованного поля нет')
})

test('встроенная роль «Кассир» (1.5.5): приходит с сервера, помнится для входа без интернета и меняется вместе с ролью', async (t) => {
  const S = makeServer()
  const A = makeTill(S, 'A')
  closeAfter(t, A)
  const roleOf = (login) => A.core.prepare('SELECT roleSystem FROM accounts WHERE login = ?').get(login)?.roleSystem

  const boss = await A.login('boss', 'Boss-pass-1')
  check(boss.status === 201 && boss.data.user.roleSystem === 'owner', 'владелец — встроенная роль owner', boss.data?.user)
  await A.gw.syncNow()
  A.gw.logout()
  const ali = await A.login('ali', 'Ali-pass-1')
  check(ali.status === 201 && ali.data.user.roleSystem === 'cashier', 'ali с интернетом — роль «Кассир»', ali.data?.user)
  check(roleOf('ali') === 'cashier', 'касса запомнила роль ali для входа без интернета', roleOf('ali'))
  await A.gw.syncNow()

  // Без связи касса отвечает по сохранённому — и на вход, и на «кто я»
  S.srv.state.online = false
  A.gw.logout()
  const off = await A.login('ali', 'Ali-pass-1')
  check(off.status === 201 && off.data.user.roleSystem === 'cashier', 'ali без интернета — по-прежнему «Кассир»: касса откроется сразу', off.data?.user)
  const me = await A.req('GET', '/auth/me')
  check(me.status === 200 && me.data.roleSystem === 'cashier', '«кто я» без интернета — тоже «Кассир»', me.data)

  // Владелец без связи переводит ali в свою роль «Старший» — касса знает это сразу
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец входит без интернета')
  const asg = await A.req('PATCH', '/users/acc-ali', { roleId: 'r-senior' })
  check(asg.status === 200, 'без связи: ali — в роли «Старший»', asg.status)
  check(roleOf('ali') === '', 'запись входа ali: уже не «Кассир»', roleOf('ali'))
  A.gw.logout()
  const sen = await A.login('ali', 'Ali-pass-1')
  check(sen.status === 201 && !sen.data.user.roleSystem, 'ali без интернета после смены роли — обычное меню', sen.data?.user)

  // И обратно в «Кассира»
  A.gw.logout()
  check((await A.login('boss', 'Boss-pass-1')).status === 201, 'владелец снова входит без интернета')
  const back = await A.req('PATCH', '/users/acc-ali', { roleId: 'r-cashier' })
  check(back.status === 200 && roleOf('ali') === 'cashier', 'ali снова «Кассир»', { status: back.status, role: roleOf('ali') })

  // Связь вернулась: правка ушла на сервер, вход с интернетом называет ту же роль
  S.srv.state.online = true
  await A.gw.syncNow()
  A.gw.logout()
  const on = await A.login('ali', 'Ali-pass-1')
  check(on.status === 201 && on.data.user.roleSystem === 'cashier' && roleOf('ali') === 'cashier', 'с интернетом — «Кассир», и касса помнит то же', { user: on.data?.user, role: roleOf('ali') })
})
