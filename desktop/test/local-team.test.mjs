// ── Сотрудники и роли без интернета (версия 1.4.16) ──
//
// Владелец на кассе без связи заводит сотрудника, меняет ему роль, пароль, оклад, блокирует
// и удаляет; заводит роли и меняет их права — с теми же проверками и словами, что на сайте.
// Сделанное лежит поправками поверх списка сервера (раздел team и staff) и уходит на сервер
// операцией. Пароль — только отпечатком (его считает шлюз).
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchLocal } from '../src/local/api.mjs'
import { lanCatchUp, lanEntriesSince, lanGen, lanReceive } from '../src/local/lan.mjs'
import { createRole, createUser, deleteRole, deleteUser, rolesList, staffList, TEAM_TEXT, updateRole, updateUser, usersList } from '../src/local/ops/team.mjs'
import { ackOp, describeOp, pendingOps, rejectOp } from '../src/local/outbox.mjs'
import { applyPull } from '../src/local/snapshot.mjs'
import { ctx, NOW, pharmacy, refused, row } from '../test-support/pharmacy.mjs'

// Отпечаток пароля в том виде, в каком его считает шлюз (s3$N$r$p$соль$отпечаток)
const HASH = 's3$16384$8$4$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)
const HASH2 = 's3$16384$8$4$' + 'c'.repeat(32) + '$' + 'd'.repeat(128)

const OWNER = { id: 'owner', name: 'Владелец', description: 'Все права', system: 'owner', permissions: ['pos.sell'], people: 1 }
const CASHIER = { id: 'r-cashier', name: 'Кассир', description: '', system: 'cashier', permissions: ['pos.sell', 'shift.open'], people: 1 }
const SENIOR = { id: 'r-senior', name: 'Старший кассир', description: '', system: null, permissions: ['pos.sell', 'returns.create'], people: 0 }
const TEAM = {
  v: 'v1',
  accounts: [
    { id: 'acc-1', name: 'kassir', role: 'founder', roleId: 'owner', roleName: 'Владелец', active: true, createdAt: '2026-09-01T08:00:00.000Z', userId: 'u-owner' },
    { id: 'acc-2', name: 'ali', role: 'cashier', roleId: 'r-cashier', roleName: 'Кассир', active: true, createdAt: '2026-09-02T08:00:00.000Z', userId: 'u-ali' },
  ],
  roles: [OWNER, CASHIER, SENIOR],
}
const STAFF = [
  { id: 'u-owner', name: 'kassir', fullName: 'Фарход', role: 'founder', active: true, salary: 0, bonusPercent: 0, salaryDay: 1, createdAt: '2026-09-01T08:00:00.000Z' },
  { id: 'u-ali', name: 'ali', fullName: 'Алиев Али', role: 'cashier', active: true, salary: 3000, bonusPercent: 2.5, salaryDay: 10, createdAt: '2026-09-02T08:00:00.000Z' },
]
const up = (...list) => ({ upsert: list, remove: [] })
function shop() {
  const db = pharmacy()
  applyPull(db, { full: false, cursor: '1', data: { team: TEAM, staff: up(...STAFF) } }, { now: NOW })
  return db
}
const ops = (db) => pendingOps(db, 100)
const opOf = (db, type) => ops(db).find((o) => o.type === type)
const userOf = (db, id) => usersList(db).find((u) => u.id === id)
const roleOf = (db, id) => rolesList(db).find((r) => r.id === id)

test('список сотрудников и ролей — как у сервера; без списка с сервера — к серверу', () => {
  const db = shop()
  assert.deepEqual(usersList(db).map((u) => [u.name, u.roleId, u.roleName, u.fullName, u.salary, u.bonusPercent, u.salaryDay]), [
    ['kassir', 'owner', 'Владелец', 'Фарход', 0, 0, 1],
    ['ali', 'r-cashier', 'Кассир', 'Алиев Али', 3000, 2.5, 10],
  ])
  assert.deepEqual(rolesList(db).map((r) => [r.id, r.people]), [['owner', 1], ['r-cashier', 1], ['r-senior', 0]])
  assert.deepEqual(staffList(db).map((s) => [s.name, s.salary, s.bonusPercent, s.salaryDay]), [['ali', 3000, 2.5, 10], ['kassir', 0, 0, 1]])
  const empty = pharmacy()
  assert.deepEqual(usersList(empty), { __remote: true })
  assert.deepEqual(staffList(empty), { __remote: true })
})

test('новый сотрудник без связи: в списке сразу, на сервер — отпечаток пароля, не пароль', () => {
  const db = shop()
  const u = createUser(ctx(db), { name: 'vali', passwordHash: HASH, roleId: 'r-senior', fullName: 'Валиев Вали', salary: 2500, bonusPercent: 1.5, salaryDay: 5 })
  assert.deepEqual([u.name, u.roleId, u.roleName, u.active, u.fullName, u.salary, u.bonusPercent, u.salaryDay], ['vali', 'r-senior', 'Старший кассир', true, 'Валиев Вали', 2500, 1.5, 5])
  const op = opOf(db, 'user.create')
  assert.deepEqual(
    [op.payload.user.id, op.payload.user.userId, op.payload.user.name, op.payload.user.passwordHash, op.payload.user.roleId, op.payload.user.salary, op.payload.user.bonusPercent],
    [u.id, u.userId, 'vali', HASH, 'r-senior', 2500, 1.5],
  )
  assert.equal(JSON.stringify(op.payload).includes('password"'), false)
  assert.equal(staffList(db).some((s) => s.id === u.userId && s.salary === 2500), true)
  assert.equal(roleOf(db, 'r-senior').people, 1)
  refused(() => createUser(ctx(db), { name: 'ali', passwordHash: HASH }), 400, TEAM_TEXT.loginTaken('ali'))
  refused(() => createUser(ctx(db), { name: ' ', passwordHash: HASH }), 400, TEAM_TEXT.noName)
  refused(() => createUser(ctx(db), { name: 'x1', passwordHash: HASH, roleId: 'net-takoy' }), 400, TEAM_TEXT.roleNotFound)
  // Владельцем — тоже
  assert.equal(createUser(ctx(db), { name: 'boss2', passwordHash: HASH, roleId: 'owner' }).role, 'founder')
})

test('правка сотрудника: имя, роль, блокировка, пароль и оклад — поправкой; на сервер — что поменяли и что было', () => {
  const db = shop()
  const u = updateUser(ctx(db), 'acc-2', { name: 'ali2', roleId: 'r-senior', active: false, passwordHash: HASH2, salary: 3500 })
  assert.deepEqual([u.name, u.roleId, u.active, u.salary], ['ali2', 'r-senior', false, 3500])
  const op = opOf(db, 'user.update')
  assert.deepEqual(op.payload.set, { name: 'ali2', active: false, roleId: 'r-senior', salary: 3500, passwordHash: HASH2 })
  assert.deepEqual(op.payload.base, { name: 'ali', active: true, roleId: 'r-cashier', salary: 3000 })
  // Пароль в списке «не принято сервером» не показывается
  assert.equal(JSON.stringify(describeOp(op, () => ({ login: 'ali2' })).detail).includes(HASH2), false)
  assert.equal(staffList(db).find((s) => s.id === 'u-ali').name, 'ali2')
  // Ничего не поменяли — операции нет
  updateUser(ctx(db), 'acc-2', { name: 'ali2' })
  assert.equal(ops(db).filter((o) => o.type === 'user.update').length, 1)
})

test('владелец не может остаться без прав — те же отказы, что на сайте', () => {
  const db = shop()
  refused(() => updateUser(ctx(db), 'acc-1', { active: false }), 400, TEAM_TEXT.blockSelf)
  refused(() => updateUser(ctx(db), 'acc-1', { roleId: 'r-cashier' }), 400, TEAM_TEXT.ownRole)
  refused(() => deleteUser(ctx(db), 'acc-1'), 400, TEAM_TEXT.deleteOwner)
  // Второй владелец: заблокировать его можно, единственного — нет
  createUser(ctx(db), { name: 'boss2', passwordHash: HASH, roleId: 'owner' })
  const boss2 = usersList(db).find((u) => u.name === 'boss2')
  const other = ctx(db, { user: { accountId: boss2.id, id: 'u-b2', name: 'boss2', role: 'founder' } })
  updateUser(ctx(db), boss2.id, { active: false })
  refused(() => updateUser(other, 'acc-1', { active: false }), 400, TEAM_TEXT.blockLastOwner)
  refused(() => deleteUser(ctx(db, { user: { accountId: 'acc-2', id: 'u-ali', name: 'ali', role: 'founder' } }), 'acc-2'), 400, TEAM_TEXT.deleteSelf)
  refused(() => updateUser(ctx(db), 'net', { active: false }), 404, TEAM_TEXT.notFound)
})

test('удаление сотрудника — без связи; сервер отверг — сотрудник вернулся', () => {
  const db = shop()
  deleteUser(ctx(db), 'acc-2')
  assert.equal(userOf(db, 'acc-2'), undefined)
  assert.equal(staffList(db).some((s) => s.id === 'u-ali'), false)
  rejectOp(db, opOf(db, 'user.delete'), 'Сотрудник не найден')
  assert.equal(userOf(db, 'acc-2').name, 'ali')
  assert.equal(staffList(db).find((s) => s.id === 'u-ali').salary, 3000)
})

test('роли: завести, переименовать, поменять права, удалить — с проверками сайта', () => {
  const db = shop()
  const r = createRole(ctx(db), { name: '  Кладовщик   склада ', description: 'Приход и склад', permissions: ['arrivals.create', 'arrivals.create'] })
  assert.deepEqual([r.name, r.permissions, r.people, r.system], ['Кладовщик склада', ['arrivals.create'], 0, null])
  assert.deepEqual(opOf(db, 'role.create').payload.role.permissions, ['arrivals.create'])
  refused(() => createRole(ctx(db), { name: 'Кладовщик склада' }), 400, TEAM_TEXT.roleExists('Кладовщик склада'))
  refused(() => createRole(ctx(db), { name: 'владелец' }), 400, TEAM_TEXT.ownerName)
  refused(() => createRole(ctx(db), { name: '' }), 400, TEAM_TEXT.roleNoName)
  const u2 = updateRole(ctx(db), r.id, { permissions: ['arrivals.create', 'products.edit'] })
  assert.deepEqual(u2.permissions, ['arrivals.create', 'products.edit'])
  assert.deepEqual(opOf(db, 'role.update').payload.base, { permissions: ['arrivals.create'] })
  refused(() => updateRole(ctx(db), 'owner', { permissions: [] }), 400, TEAM_TEXT.ownerRoleEdit)
  refused(() => updateRole(ctx(db), 'r-cashier', { name: 'Продавец' }), 400, TEAM_TEXT.systemRename)
  refused(() => deleteRole(ctx(db), 'owner'), 400, TEAM_TEXT.ownerRoleDelete)
  refused(() => deleteRole(ctx(db), 'r-cashier'), 400, TEAM_TEXT.systemDelete)
  updateUser(ctx(db), 'acc-2', { roleId: 'r-senior' })
  refused(() => deleteRole(ctx(db), 'r-senior'), 400, TEAM_TEXT.roleInUse(1))
  deleteRole(ctx(db), r.id)
  assert.equal(roleOf(db, r.id), undefined)
  // Переименование роли — и у её сотрудников в списке
  updateRole(ctx(db), 'r-senior', { name: 'Старший' })
  assert.equal(userOf(db, 'acc-2').roleName, 'Старший')
})

test('свежий список сервера ложится основой, неотправленное — поверх; принятое — уже в списке сервера', () => {
  const db = shop()
  const u = createUser(ctx(db), { name: 'vali', passwordHash: HASH })
  updateUser(ctx(db), 'acc-2', { active: false })
  // Сервер ещё не получил ни того, ни другого
  applyPull(db, { full: false, cursor: '2', data: { team: { ...TEAM, v: 'v2' } } }, { now: NOW })
  assert.equal(userOf(db, u.id).name, 'vali')
  assert.equal(userOf(db, 'acc-2').active, false)
  // Сервер принял заведение: в его списке сотрудник уже есть
  ackOp(db, opOf(db, 'user.create'), { status: 'ok', docId: u.id })
  const withVali = { ...TEAM, v: 'v3', accounts: [...TEAM.accounts, { id: u.id, name: 'vali', role: 'cashier', roleId: 'r-cashier', roleName: 'Кассир', active: true, createdAt: u.createdAt, userId: u.userId }] }
  applyPull(db, { full: false, cursor: '3', data: { team: withVali } }, { now: NOW })
  assert.equal(userOf(db, u.id).name, 'vali')
  assert.equal(row(db, "SELECT value FROM meta WHERE key = 'teamv'").value, 'v3')
})

test('сервер отверг заведение — сотрудника нет и здесь', () => {
  const db = shop()
  const u = createUser(ctx(db), { name: 'vali', passwordHash: HASH })
  rejectOp(db, opOf(db, 'user.create'), 'Недостаточно прав')
  assert.equal(userOf(db, u.id), undefined)
  assert.equal(staffList(db).some((s) => s.id === u.userId), false)
})

test('права — как на сайте: сотрудники и роли только у владельца, список для зарплаты — по праву на расходы', () => {
  const db = shop()
  const call = (method, path, user, body) => {
    const m = matchLocal(method, path)
    return m.handler({ ...ctx(db, { user }), params: m.params, query: m.query, body })
  }
  const cashier = { accountId: 'acc-2', id: 'u-ali', name: 'ali', role: 'cashier', permissions: ['pos.sell', 'expenses.create'] }
  refused(() => call('GET', '/users', cashier), 403, 'Недостаточно прав')
  refused(() => call('POST', '/roles', cashier, { name: 'x' }), 403, 'Недостаточно прав')
  assert.equal(call('GET', '/expenses/staff', cashier).length, 2)
  refused(() => call('GET', '/expenses/staff', { ...cashier, permissions: ['pos.sell'] }), 403, 'Недостаточно прав')
})

test('по сети: учётные записи и роли — каждой соседней кассе, оклады — только соседу с правами', () => {
  const a = shop()
  const wide = shop()
  const narrow = shop()
  const u = createUser(ctx(a, { deviceId: 'A' }), { name: 'vali', passwordHash: HASH, salary: 2500 })
  lanCatchUp(a, { deviceId: 'A', now: NOW })
  for (const [to, isWide] of [[wide, true], [narrow, false]]) lanReceive(to, lanEntriesSince(a, 0, { wide: isWide }).entries, { now: NOW, gen: lanGen(to) })
  assert.equal(userOf(wide, u.id).name, 'vali')
  assert.equal(userOf(narrow, u.id).name, 'vali', 'сотрудник известен и кассиру — для входа без интернета')
  assert.equal(staffList(wide).find((s) => s.id === u.userId).salary, 2500)
  assert.equal(staffList(narrow).some((s) => s.id === u.userId), false, 'оклад кассиру не уходит')
  // Отпечаток пароля — в поправке соседа: по нему сосед пустит сотрудника без интернета
  assert.equal(JSON.parse(row(narrow, "SELECT data FROM row_edits WHERE tbl = 'team_accounts' AND rowId = ?", u.id).data).pw, HASH)
})
