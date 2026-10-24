// ── Сервер с сотрудниками и несколько касс — для проверок входа без интернета ──
//
// Сервер-заглушка из server.mjs и то, чего ему не хватает для сотрудников без интернета
// (версия 1.4.16): раздел team в обмене (с отпечатком teamv — неизменившийся список не
// приходит) и операции user.* и role.* — новый сотрудник с отпечатком пароля, правка,
// блокировка, удаление, роли. Как и настоящий сервер, он отзывает ключи сотрудника, которому
// сменили пароль или которого удалили. Один сервер — на несколько касс (makeTill); lan()
// передаёт журнал обмена одной кассы другой — так, как это делает местная сеть.
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createGateway } from '../src/gateway.mjs'
import { checkVerifier } from '../src/local/accounts.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { CATEGORIES, EXPENSE_CATEGORIES, NOW, PAY_SERVICES, product, SUPPLIERS } from './pharmacy.mjs'
import { API, fakeSeal, fakeServer, manualTimers, memorySession } from './server.mjs'

// Роли магазина — как их отдаёт сервер
export const ROLES = [
  { id: 'owner', name: 'Владелец', description: 'Все права', system: 'owner', permissions: ['pos.sell'], people: 1 },
  { id: 'r-cashier', name: 'Кассир', description: '', system: 'cashier', permissions: ['pos.sell', 'shift.open', 'shift.view'], people: 1 },
  { id: 'r-senior', name: 'Старший', description: '', system: null, permissions: ['pos.sell', 'returns.create'], people: 0 },
]

// Один сервер на несколько касс. В магазине двое: владелец boss и кассир ali.
// Чем проверка управляет сверх server.mjs:
//   srv.rejectTeam = (op) → текст отказа или ничего — отвергнуть операцию с сотрудником или ролью;
//   srv.noopTeam = (op) → true — принять, но ничего не сделать (сервер оставил своё: удаление
//     правили позже, логин занят, пароль с сайта новее) — ответ «принято» без документа;
//   srv.holdTeam = (op) → true — сервер не смог записать операцию сейчас («отправьте ещё раз»):
//     она остаётся в очереди кассы, а остаток пачки сервер, как и настоящий, не разбирает;
//   srv.teamOf() — список сотрудников и ролей, каким его сейчас отдал бы сервер;
//   srv.state.teamLog — все пришедшие операции с сотрудниками и ролями (тип, от кого, что);
//   srv.state.revoked — отозванные ключи (с ними сервер отвечает 401).
export function makeServer() {
  const time = { now: NOW }
  const srv = fakeServer({ now: () => time.now })
  srv.addUser('boss', 'Boss-pass-1', 'founder', 'acc-boss', { roleId: 'owner', roleName: 'Владелец' })
  srv.addUser('ali', 'Ali-pass-1', 'cashier', 'acc-ali', { roleId: 'r-cashier', roleName: 'Кассир', permissions: ROLES[1].permissions })
  srv.state.data.categories = CATEGORIES
  srv.state.data.expenseCategories = EXPENSE_CATEGORIES
  srv.state.data.suppliers = SUPPLIERS.map((s) => ({ ...s }))
  srv.state.data.payServices = PAY_SERVICES
  srv.state.data.products = [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 5 })]
  srv.state.lan = { key: 'K'.repeat(32), devices: 2 }
  srv.state.roles = ROLES.map((r) => ({ ...r }))
  srv.state.revoked = new Set()
  srv.state.teamLog = []
  // Раздел team — как у настоящего сервера: сотрудники без паролей, роли и отпечаток всего списка
  const teamOf = () => {
    const accounts = [...srv.state.users.values()]
      .filter((u) => u.role !== 'superadmin')
      .map((u) => ({ id: u.id, name: u.name, role: u.role, roleId: u.role === 'founder' ? 'owner' : u.roleId ?? 'r-cashier', roleName: u.role === 'founder' ? 'Владелец' : u.roleName || 'Кассир', active: u.active !== false, createdAt: '2026-09-01T08:00:00.000Z', userId: u.tenantUserId }))
    const t = { accounts, roles: srv.state.roles }
    return { v: createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 20), ...t }
  }
  srv.teamOf = teamOf
  const base = srv.fetchImpl
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === 'date' ? new Date(time.now).toUTCString() : null) }, text: async () => JSON.stringify(body) })
  const byId = (id) => [...srv.state.users.values()].find((u) => u.id === id)
  // Пароль, заданный на кассе, сервер знает только отпечатком (hash). password '\u0000' — пароль,
  // которого никто не введёт: вход сверяется с отпечатком (см. /auth/login ниже)
  function applyTeamOp(op, by) {
    const p = op.payload || {}
    srv.state.teamLog.push({ type: op.type, by: by.name, payload: p })
    if (by.role !== 'founder') return { id: op.id, status: 'rejected', error: 'Недостаточно прав' }
    if (srv.rejectTeam) {
      const why = srv.rejectTeam(op)
      if (why) return { id: op.id, status: 'rejected', error: why }
    }
    if (srv.noopTeam && srv.noopTeam(op)) return { id: op.id, status: 'ok', docId: null }
    // Сбой у самого сервера, а не в операции: касса пришлёт её ещё раз
    if (srv.holdTeam && srv.holdTeam(op)) return { id: op.id, status: 'retry', error: 'Сервер не смог записать операцию. Она будет отправлена повторно.' }
    switch (op.type) {
      case 'user.create': {
        const u = p.user
        const acc = { id: u.id, name: u.name, password: '\u0000', hash: u.passwordHash, role: u.roleId === 'owner' ? 'founder' : 'cashier', roleId: u.roleId === 'owner' ? null : u.roleId || 'r-cashier', active: true, tenantUserId: u.userId }
        srv.state.users.set(u.name, acc)
        return { id: op.id, status: 'ok', docId: u.id }
      }
      case 'user.update': {
        const acc = byId(p.id)
        if (!acc) return { id: op.id, status: 'ok', docId: null }
        const set = p.set || {}
        if (set.name) {
          srv.state.users.delete(acc.name)
          acc.name = set.name
          srv.state.users.set(acc.name, acc)
        }
        if (set.active !== undefined) acc.active = set.active
        if (set.roleId) {
          acc.role = set.roleId === 'owner' ? 'founder' : 'cashier'
          acc.roleId = set.roleId === 'owner' ? null : set.roleId
          acc.roleName = (srv.state.roles.find((r) => r.id === set.roleId) || {}).name
        }
        if (set.passwordHash) {
          acc.hash = set.passwordHash
          acc.password = '\u0000'
          // Как у настоящего сервера: ключи, выданные до смены пароля, больше не действуют
          for (const [t, name] of srv.state.tokens) if (name === acc.name) srv.state.revoked.add(t)
        }
        return { id: op.id, status: 'ok', docId: acc.id }
      }
      case 'user.delete': {
        const acc = byId(p.id)
        if (acc) {
          srv.state.users.delete(acc.name)
          for (const [t, name] of srv.state.tokens) if (name === acc.name) srv.state.revoked.add(t)
        }
        return { id: op.id, status: 'ok', docId: p.id }
      }
      case 'role.create':
        srv.state.roles.push({ ...p.role, system: null, people: 0 })
        return { id: op.id, status: 'ok', docId: p.role.id }
      case 'role.update': {
        const r = srv.state.roles.find((x) => x.id === p.id)
        if (!r) return { id: op.id, status: 'ok', docId: null }
        Object.assign(r, p.set)
        return { id: op.id, status: 'ok', docId: r.id }
      }
      case 'role.delete':
        srv.state.roles = srv.state.roles.filter((x) => x.id !== p.id)
        return { id: op.id, status: 'ok', docId: p.id }
    }
    return null
  }
  srv.fetchImpl = async (url, init = {}) => {
    const path = url.slice(API.length)
    const route = path.split('?')[0]
    const method = init.method || 'GET'
    if (!srv.state.online) return base(url, init)
    const token = (init.headers?.Authorization || '').replace(/^Bearer /, '')
    if (token && srv.state.revoked.has(token)) {
      srv.state.calls.push({ method, path, route, revoked: true })
      return json(401, { statusCode: 401, message: 'Пароль был изменён — войдите заново' })
    }
    if (route === '/auth/login' && method === 'POST') {
      const body = JSON.parse(init.body)
      const u = srv.state.users.get(String(body?.name || '').trim())
      if (u && u.hash) u.password = (await checkVerifier(String(body.password), u.hash)) ? body.password : '\u0000'
      return base(url, init)
    }
    if (route === '/sync/push' && method === 'POST') {
      const body = JSON.parse(init.body)
      const u = srv.state.users.get(srv.state.tokens.get(token))
      if (!u) return base(url, init)
      const results = []
      for (const op of body.ops || []) {
        if (srv.state.ops.has(op.id)) {
          const was = srv.state.ops.get(op.id)
          results.push(was.status === 'ok' ? { id: op.id, status: 'duplicate', docId: was.docId } : was)
          continue
        }
        if (/^(user|role)\./.test(op.type)) {
          // Права — автора операции, а не того, чьим ключом пришла пачка (операции владельца
          // уходят и под кассиром). Автора сервер не знает — прав нет
          const performer = op.accountId && op.accountId !== u.id ? byId(op.accountId) || { role: 'cashier' } : u
          const r = applyTeamOp(op, performer)
          // Незаписанную операцию сервер не запоминает и дальше не идёт — порядок важен:
          // остаток пачки касса пришлёт ещё раз
          if (r && r.status === 'retry') {
            results.push(r)
            break
          }
          srv.state.ops.set(op.id, r)
          results.push(r)
          continue
        }
        const res = await base(url, { ...init, body: JSON.stringify({ ...body, ops: [op] }) })
        const data = JSON.parse(await res.text())
        results.push(...(data.results || []))
      }
      return json(201, { results })
    }
    const res = await base(url, init)
    if (route === '/sync/pull' && method === 'GET' && res.status === 200) {
      const data = JSON.parse(await res.text())
      const q = Object.fromEntries(new URLSearchParams(path.split('?')[1] || ''))
      const t = teamOf()
      if (q.teamv !== t.v && data.data) data.data.team = t
      return json(200, data)
    }
    return res
  }
  return { srv, time }
}

// Касса (шлюз программы со своей общей базой и папкой данных), подключённая к общему серверу.
// Закрывается через gw.close()
export function makeTill(server, name = 'A') {
  const core = openDb(':memory:', CORE_SCHEMA)
  const session = memorySession()
  const errors = []
  const warns = []
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: (u, i) => server.srv.fetchImpl(u, i),
    session,
    core,
    cipher: fakeSeal,
    clock: { now: () => server.time.now, serverTime: () => {}, lic: () => server.time.now, floor: () => server.time.now },
    dataDir: fs.mkdtempSync(join(os.tmpdir(), 'apteka-team-' + name + '-')),
    timers: manualTimers(),
    emit: () => {},
    log: { info() {}, warn: (...a) => warns.push(a.map(String).join(' ')), error: (...a) => errors.push(a.map(String).join(' ')) },
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  const login = (n, p) => req('POST', '/auth/login', { name: n, password: p })
  // Запись входа без интернета (общая база программы) — без самих отпечатков
  const coreRow = (login) => core.prepare('SELECT id, login, role, blocked, localPw, permissions, verifier IS NOT NULL AS hasVerifier, seenAt FROM accounts WHERE login = ?').get(login)
  const db = () => gw.pharmacyDb()
  return { name, gw, core, session, req, login, coreRow, db, errors, warns, seen: 0 }
}

// Местная сеть: передать кассе to всё, что есть у кассы from (с того места, где остановились)
export function lan(from, to, wide = true) {
  for (;;) {
    const out = from.gw.lanHub.entriesFor(from.seen, wide)
    from.seen = out.upTo
    if (out.entries.length) to.gw.lanHub.receive(from.gw.deviceId, out.entries)
    if (!out.more) break
  }
}
