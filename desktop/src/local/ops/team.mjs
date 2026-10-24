// ── Сотрудники и роли — и без связи (версия 1.4.16) ──
//
// Перенос серверных правил (server/src/users, server/src/roles): владелец заводит сотрудника,
// меняет ему роль, пароль, оклад, блокирует и удаляет; заводит роли и меняет их права — с теми
// же проверками и текстами, что на сайте. Сделанное ложится поправкой поверх данных сервера
// (edits.mjs: team_accounts, team_roles, staff) и уходит на сервер, когда появится связь.
//
// Пароль сюда приходит уже отпечатком, зашифрованным средствами Windows (passwordSealed):
// его считает и прячет шлюз (gateway.mjs) — тем же способом, что сервер. В базе кассы и в
// очереди на отправку отпечаток лежит только зашифрованным; на сервер шлюз отдаёт его
// расшифрованным, соседним кассам он не уходит вовсе (lan.mjs). По нему вход без интернета
// заработает на этой кассе (gateway.mjs, teamToCore); на соседней — после входа с интернетом.
//
// Список сотрудников и ролей — тот, что сервер отдал владельцу (раздел team). Его ещё не
// было на этой кассе — запрос уходит на сервер, как раньше ({ __remote }).
import { bodyOf, checker } from '../check.mjs'
import { bad, getMeta, inTx, newId, notFound, q } from '../db.mjs'
import { enqueue } from '../docs.mjs'
import { recordEdit } from '../edits.mjs'

// Тексты — слово в слово как у сервера
export const TEAM_TEXT = {
  noName: 'Укажите имя сотрудника',
  loginTaken: (name) => `Логин «${name}» уже занят. Он должен быть свободен среди всех магазинов — добавьте к нему что-нибудь своё.`,
  loginTakenUpdate: (name) => `Логин «${name}» уже занят другим сотрудником сервиса`,
  notFound: 'Сотрудник не найден',
  roleNotFound: 'Роль не найдена',
  blockSelf: 'Нельзя заблокировать самого себя',
  blockLastOwner: 'Нельзя заблокировать единственного владельца',
  ownRole: 'Свою роль владелец изменить не может',
  lastOwnerRole: 'Нельзя снять права с единственного владельца',
  deleteOwner: 'Нельзя удалить владельца',
  deleteSelf: 'Нельзя удалить себя',
  ownerRoleEdit: 'Права владельца изменить нельзя',
  ownerRoleDelete: 'Роль владельца удалить нельзя',
  systemRename: 'Системную роль нельзя переименовать',
  systemDelete: 'Системную роль удалить нельзя',
  roleNoName: 'Укажите название роли',
  roleNameLong: 'Название роли — не длиннее 40 знаков',
  ownerName: 'Это имя занято ролью владельца',
  roleExists: (name) => `Роль «${name}» уже есть`,
  roleInUse: (n) => `На этой роли ${n} сотрудник(ов). Сначала переведите их на другую роль`,
  permsList: 'Права должны быть списком',
  noPassword: 'Пароль слишком короткий (минимум 6 символов)',
}
const OWNER = { id: 'owner', name: 'Владелец' }
const MAX_ROLE_NAME = 40
const MAX_ROLE_DESC = 200

const iso = (now) => new Date(now).toISOString()
const parse = (s, fallback) => {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
const loaded = (db) => getMeta(db, 'teamLoaded') === '1'
const staffLoaded = (db) => getMeta(db, 'staffLoaded') === '1'

// ── Как отдаёт сервер ──
const money2 = (c) => Math.round(Number(c || 0)) / 100
function userView(db, a) {
  const p = a.userId ? q(db, 'SELECT * FROM staff WHERE id = ?').get(a.userId) : null
  return {
    id: a.id,
    name: a.login,
    role: a.role,
    roleId: a.role === 'founder' ? 'owner' : a.roleId ?? null,
    roleName: a.role === 'founder' ? OWNER.name : a.roleName || 'Кассир',
    active: !!a.active,
    createdAt: a.createdAt,
    userId: a.userId ?? null,
    fullName: p?.fullName || '',
    salary: money2(p?.salaryC),
    bonusPercent: money2(p?.bonusBp),
    salaryDay: p?.salaryDay || 1,
  }
}
function roleView(db, r) {
  const people = r.id === OWNER.id
    ? q(db, "SELECT COUNT(*) AS n FROM team_accounts WHERE role = 'founder'").get().n
    : q(db, "SELECT COUNT(*) AS n FROM team_accounts WHERE role <> 'founder' AND roleId = ?").get(r.id).n
  return { id: r.id, name: r.name, description: r.description, system: r.system ?? null, permissions: parse(r.permissions, []), people }
}

// ── Списки ──
export function usersList(db) {
  // Нужны оба списка: без сотрудников магазина окно показало бы оклад и ФИО пустыми, а
  // сохранение карточки затёрло бы их на сервере
  if (!loaded(db) || !staffLoaded(db)) return { __remote: true }
  // Как у сервера: владельцы первыми, дальше — в порядке заведения
  return q(db, "SELECT * FROM team_accounts ORDER BY CASE WHEN role = 'founder' THEN 0 ELSE 1 END, ord, createdAt").all().map((a) => userView(db, a))
}

export function rolesList(db) {
  if (!loaded(db)) return { __remote: true }
  // Владелец — первой строкой, затем системные, затем по порядку заведения
  return q(db, "SELECT * FROM team_roles ORDER BY CASE WHEN id = 'owner' THEN 0 WHEN system IS NOT NULL THEN 1 ELSE 2 END, ord, createdAt").all().map((r) => roleView(db, r))
}

// Кому выдают зарплату — как GET /expenses/staff
export function staffList(db) {
  if (!staffLoaded(db)) return { __remote: true }
  return q(db, 'SELECT * FROM staff ORDER BY active DESC, name').all().map((u) => ({
    id: u.id,
    name: u.name,
    fullName: u.fullName,
    role: u.role,
    active: !!u.active,
    salary: money2(u.salaryC),
    bonusPercent: money2(u.bonusBp),
    salaryDay: u.salaryDay || 1,
  }))
}

// ── Поля из запроса — те же правила, что у сервера (users/dto, users.service profileData) ──
function profileFrom(dto, c) {
  const out = {}
  if (dto.fullName !== undefined) {
    const v = c.str(dto.fullName, 'fullName', { optional: true })
    if (typeof v === 'string') out.fullName = v.trim().slice(0, 120)
  }
  if (dto.salary !== undefined) {
    const v = c.num(dto.salary, 'salary', { optional: true })
    if (typeof v === 'number') out.salaryC = Math.round(Math.max(0, v) * 100)
  }
  if (dto.bonusPercent !== undefined) {
    const v = c.num(dto.bonusPercent, 'bonusPercent', { optional: true, max: 100 })
    if (typeof v === 'number') out.bonusBp = Math.round(Math.min(100, Math.max(0, v)) * 100)
  }
  if (dto.salaryDay !== undefined) {
    const v = c.int(dto.salaryDay, 'salaryDay', { optional: true, min: 1, max: 28 })
    if (typeof v === 'number') out.salaryDay = v
  }
  return out
}
// В операцию — так, как ждёт сервер (рубли и проценты, а не дирамы)
const profileOut = (pr) => ({
  ...(pr.fullName !== undefined ? { fullName: pr.fullName } : {}),
  ...(pr.salaryC !== undefined ? { salary: pr.salaryC / 100 } : {}),
  ...(pr.bonusBp !== undefined ? { bonusPercent: pr.bonusBp / 100 } : {}),
  ...(pr.salaryDay !== undefined ? { salaryDay: pr.salaryDay } : {}),
})

const loginTakenHere = (db, login, exceptId = null) => !!q(db, 'SELECT 1 FROM team_accounts WHERE login = ? AND id <> ?').get(login, exceptId ?? '')
const activeOwners = (db) => q(db, "SELECT COUNT(*) AS n FROM team_accounts WHERE role = 'founder' AND active = 1").get().n

// Роль для сотрудника: 'owner' — владелец; номер роли магазина; пусто — системная роль кассира
function roleFor(db, roleId) {
  if (roleId === OWNER.id) return { role: 'founder', roleId: null, roleName: OWNER.name }
  const cashier = q(db, "SELECT * FROM team_roles WHERE system = 'cashier'").get()
  if (!roleId || roleId === cashier?.id) return { role: 'cashier', roleId: cashier?.id ?? null, roleName: cashier?.name || 'Кассир' }
  const r = q(db, 'SELECT * FROM team_roles WHERE id = ?').get(roleId)
  if (!r || r.id === OWNER.id) throw bad(TEAM_TEXT.roleNotFound)
  return { role: 'cashier', roleId: r.id, roleName: r.name }
}

// ── Новый сотрудник ──
export function createUser(ctx, raw) {
  const { db, now } = ctx
  if (!loaded(db) || !staffLoaded(db)) return { __remote: true }
  const dto = bodyOf(raw)
  const c = checker()
  const name = (c.str(dto.name, 'name', { optional: true }) || '').trim()
  const roleId = c.str(dto.roleId, 'roleId', { optional: true })
  const profile = profileFrom(dto, c)
  c.done()
  if (!name) throw bad(TEAM_TEXT.noName)
  if (typeof dto.passwordSealed !== 'string' || !dto.passwordSealed) throw bad(TEAM_TEXT.noPassword)
  return inTx(db, () => {
    if (loginTakenHere(db, name)) throw bad(TEAM_TEXT.loginTaken(name))
    const r = roleFor(db, dto.role === 'founder' ? OWNER.id : roleId || null)
    const id = newId()
    const userId = newId()
    const opId = newId()
    const createdAt = iso(now)
    const ord = q(db, 'SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM team_accounts').get().n
    recordEdit(db, {
      opId, tbl: 'team_accounts', rowId: id, action: 'put',
      data: { row: { login: name, role: r.role, roleId: r.roleId, roleName: r.roleName, active: 1, userId, createdAt, ord }, pw: dto.passwordSealed },
      now,
    })
    recordEdit(db, {
      opId, tbl: 'staff', rowId: userId, action: 'put',
      data: { row: { name, role: r.role, active: 1, fullName: profile.fullName ?? '', salaryC: profile.salaryC ?? 0, bonusBp: profile.bonusBp ?? 0, salaryDay: profile.salaryDay ?? 1, createdAt } },
      now,
    })
    enqueue(db, {
      id: opId,
      type: 'user.create',
      accountId: ctx.user.accountId,
      payload: {
        user: {
          id, userId, name, passwordSealed: dto.passwordSealed, roleId: r.role === 'founder' ? OWNER.id : r.roleId,
          fullName: profile.fullName ?? '', salary: (profile.salaryC ?? 0) / 100, bonusPercent: (profile.bonusBp ?? 0) / 100, salaryDay: profile.salaryDay ?? 1, createdAt,
        },
      },
      now,
    })
    return userView(db, q(db, 'SELECT * FROM team_accounts WHERE id = ?').get(id))
  })
}

// ── Правка сотрудника ──
export function updateUser(ctx, id, raw) {
  const { db, now } = ctx
  if (!loaded(db) || !staffLoaded(db)) return { __remote: true }
  const dto = bodyOf(raw)
  const c = checker()
  const nameRaw = c.str(dto.name, 'name', { optional: true })
  const active = c.bool(dto.active, 'active', { optional: true })
  const roleId = c.str(dto.roleId, 'roleId', { optional: true })
  const profile = profileFrom(dto, c)
  c.done()
  return inTx(db, () => {
    const acc = q(db, 'SELECT * FROM team_accounts WHERE id = ?').get(id)
    if (!acc) throw notFound(TEAM_TEXT.notFound)
    const me = ctx.user.accountId
    // Защита от того, чтобы магазин остался без владельца, — как на сайте
    if (active === false && acc.active) {
      if (id === me) throw bad(TEAM_TEXT.blockSelf)
      if (acc.role === 'founder' && activeOwners(db) <= 1) throw bad(TEAM_TEXT.blockLastOwner)
    }
    const set = {}
    const base = {}
    const accSet = {}
    const accWas = {}
    // Сотрудник магазина: имя, блокировка и роль повторяют учётную запись (как у сервера)
    const prof = acc.userId ? q(db, 'SELECT * FROM staff WHERE id = ?').get(acc.userId) : null
    const staffSet = {}
    const staffWas = {}
    const staff = (k, v) => {
      staffSet[k] = v
      if (prof) staffWas[k] = prof[k]
    }
    const name = nameRaw === undefined ? undefined : nameRaw.trim()
    if (name && name !== acc.login) {
      if (loginTakenHere(db, name, id)) throw bad(TEAM_TEXT.loginTakenUpdate(name))
      set.name = name
      base.name = acc.login
      accSet.login = name
      accWas.login = acc.login
      staff('name', name)
    }
    if (active !== undefined && active !== !!acc.active) {
      set.active = active
      base.active = !!acc.active
      accSet.active = active ? 1 : 0
      accWas.active = acc.active
      staff('active', active ? 1 : 0)
    }
    if (roleId !== undefined) {
      const wantsOwner = roleId === OWNER.id
      const cur = acc.role === 'founder' ? OWNER.id : acc.roleId
      if (acc.role === 'founder' && !wantsOwner) {
        if (id === me) throw bad(TEAM_TEXT.ownRole)
        if (activeOwners(db) <= 1) throw bad(TEAM_TEXT.lastOwnerRole)
      }
      const next = roleFor(db, roleId)
      const nextRef = next.role === 'founder' ? OWNER.id : next.roleId
      if (nextRef !== cur) {
        set.roleId = nextRef
        base.roleId = cur
        Object.assign(accSet, { role: next.role, roleId: next.roleId, roleName: next.roleName })
        Object.assign(accWas, { role: acc.role, roleId: acc.roleId, roleName: acc.roleName })
        staff('role', next.role)
      }
    }
    // ФИО, оклад, бонус, день зарплаты — только изменившиеся
    const changedProfile = {}
    const wasProfile = {}
    for (const [k, v] of Object.entries(profile)) {
      // Сотрудника магазина здесь нет — сравнить не с чем: такие поля не отправляем, иначе
      // сервер записал бы их поверх своих без «как было»
      if (!prof) break
      if (prof[k] === v) continue
      changedProfile[k] = v
      if (prof) wasProfile[k] = prof[k]
      staff(k, v)
    }
    Object.assign(set, profileOut(changedProfile))
    if (prof) Object.assign(base, profileOut(wasProfile))
    const password = typeof dto.passwordSealed === 'string' && dto.passwordSealed ? dto.passwordSealed : null
    if (!Object.keys(set).length && !password) return userView(db, acc)
    const opId = newId()
    if (Object.keys(accSet).length || password) {
      recordEdit(db, { opId, tbl: 'team_accounts', rowId: id, action: 'put', data: { set: accSet, was: accWas, ...(password ? { pw: password } : {}) }, now })
    }
    if (prof && Object.keys(staffSet).length) recordEdit(db, { opId, tbl: 'staff', rowId: prof.id, action: 'put', data: { set: staffSet, was: staffWas }, now })
    enqueue(db, {
      id: opId,
      type: 'user.update',
      accountId: ctx.user.accountId,
      payload: { id, at: iso(now), set: { ...set, ...(password ? { passwordSealed: password } : {}) }, base },
      now,
    })
    return userView(db, q(db, 'SELECT * FROM team_accounts WHERE id = ?').get(id))
  })
}

// ── Удаление сотрудника ──
export function deleteUser(ctx, id) {
  const { db, now } = ctx
  if (!loaded(db) || !staffLoaded(db)) return { __remote: true }
  return inTx(db, () => {
    const acc = q(db, 'SELECT * FROM team_accounts WHERE id = ?').get(id)
    if (!acc) throw notFound(TEAM_TEXT.notFound)
    if (acc.role === 'founder') throw bad(TEAM_TEXT.deleteOwner)
    if (id === ctx.user.accountId) throw bad(TEAM_TEXT.deleteSelf)
    const opId = newId()
    const { id: _a, ...wasRow } = acc
    recordEdit(db, { opId, tbl: 'team_accounts', rowId: id, action: 'del', data: { wasRow }, now })
    const prof = acc.userId ? q(db, 'SELECT * FROM staff WHERE id = ?').get(acc.userId) : null
    if (prof) {
      const { id: _s, ...wasStaff } = prof
      recordEdit(db, { opId, tbl: 'staff', rowId: prof.id, action: 'del', data: { wasRow: wasStaff }, now })
    }
    // Запись магазина — тоже: сервер уберёт её и тогда, когда учётную запись удалили раньше
    enqueue(db, { id: opId, type: 'user.delete', accountId: ctx.user.accountId, payload: { id, at: iso(now), userId: acc.userId ?? null }, now })
    return { ok: true }
  })
}

// ── Роли ──
function roleName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw bad(TEAM_TEXT.roleNoName)
  if (name.length > MAX_ROLE_NAME) throw bad(TEAM_TEXT.roleNameLong)
  if (name.toLowerCase() === OWNER.name.toLowerCase()) throw bad(TEAM_TEXT.ownerName)
  return name
}
function permsOf(raw) {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw bad(TEAM_TEXT.permsList)
  return [...new Set(raw)]
}
const roleNameTaken = (db, name, exceptId = '') => !!q(db, 'SELECT 1 FROM team_roles WHERE name = ? AND id <> ?').get(name, exceptId)

export function createRole(ctx, raw) {
  const { db, now } = ctx
  if (!loaded(db)) return { __remote: true }
  const dto = bodyOf(raw)
  const name = roleName(dto.name)
  const description = String(dto.description ?? '').trim().slice(0, MAX_ROLE_DESC)
  const permissions = permsOf(dto.permissions ?? [])
  return inTx(db, () => {
    if (roleNameTaken(db, name)) throw bad(TEAM_TEXT.roleExists(name))
    const id = newId()
    const opId = newId()
    const createdAt = iso(now)
    const ord = q(db, 'SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM team_roles').get().n
    recordEdit(db, { opId, tbl: 'team_roles', rowId: id, action: 'put', data: { row: { name, description, system: null, permissions: JSON.stringify(permissions), createdAt, ord } }, now })
    enqueue(db, { id: opId, type: 'role.create', accountId: ctx.user.accountId, payload: { role: { id, name, description, permissions, createdAt } }, now })
    return roleView(db, q(db, 'SELECT * FROM team_roles WHERE id = ?').get(id))
  })
}

export function updateRole(ctx, id, raw) {
  const { db, now } = ctx
  if (!loaded(db)) return { __remote: true }
  if (id === OWNER.id) throw bad(TEAM_TEXT.ownerRoleEdit)
  const dto = bodyOf(raw)
  return inTx(db, () => {
    const r = q(db, 'SELECT * FROM team_roles WHERE id = ?').get(id)
    if (!r) throw notFound(TEAM_TEXT.roleNotFound)
    const set = {}
    const base = {}
    const rowSet = {}
    const rowWas = {}
    if (dto.name !== undefined) {
      if (r.system) throw bad(TEAM_TEXT.systemRename)
      const name = roleName(dto.name)
      if (name !== r.name) {
        if (roleNameTaken(db, name, id)) throw bad(TEAM_TEXT.roleExists(name))
        set.name = name
        base.name = r.name
        rowSet.name = name
        rowWas.name = r.name
      }
    }
    if (dto.description !== undefined) {
      const d = String(dto.description ?? '').trim().slice(0, MAX_ROLE_DESC)
      if (d !== r.description) {
        set.description = d
        base.description = r.description
        rowSet.description = d
        rowWas.description = r.description
      }
    }
    if (dto.permissions !== undefined) {
      const perms = permsOf(dto.permissions)
      const was = parse(r.permissions, [])
      if (perms.length !== was.length || perms.some((x) => !was.includes(x))) {
        set.permissions = perms
        base.permissions = was
        rowSet.permissions = JSON.stringify(perms)
        rowWas.permissions = r.permissions
      }
    }
    if (!Object.keys(set).length) return roleView(db, r)
    const opId = newId()
    recordEdit(db, { opId, tbl: 'team_roles', rowId: id, action: 'put', data: { set: rowSet, was: rowWas }, now })
    // Название роли у её сотрудников — тоже (в списке сотрудников оно стоит рядом)
    if (set.name) recordEdit(db, { opId, tbl: 'team_accounts', rowId: '*', action: 'map', data: { col: 'roleName', from: r.name, to: set.name }, now })
    enqueue(db, { id: opId, type: 'role.update', accountId: ctx.user.accountId, payload: { id, at: iso(now), set, base }, now })
    return roleView(db, q(db, 'SELECT * FROM team_roles WHERE id = ?').get(id))
  })
}

export function deleteRole(ctx, id) {
  const { db, now } = ctx
  if (!loaded(db)) return { __remote: true }
  if (id === OWNER.id) throw bad(TEAM_TEXT.ownerRoleDelete)
  return inTx(db, () => {
    const r = q(db, 'SELECT * FROM team_roles WHERE id = ?').get(id)
    if (!r) throw notFound(TEAM_TEXT.roleNotFound)
    if (r.system) throw bad(TEAM_TEXT.systemDelete)
    const people = q(db, "SELECT COUNT(*) AS n FROM team_accounts WHERE role <> 'founder' AND roleId = ?").get(id).n
    if (people > 0) throw bad(TEAM_TEXT.roleInUse(people))
    const opId = newId()
    const { id: _r, ...wasRow } = r
    recordEdit(db, { opId, tbl: 'team_roles', rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type: 'role.delete', accountId: ctx.user.accountId, payload: { id, at: iso(now) }, now })
    return { ok: true }
  })
}
