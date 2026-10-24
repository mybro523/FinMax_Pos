// ── Сотрудники и роли, изменённые на кассе без связи (версия 1.4.16) ──
//
// Владелец заводит сотрудника, меняет ему роль, пароль, оклад, блокирует и удаляет, правит
// роли и их права — прямо на кассе без интернета. Операции приходят сюда позже.
//
// Учётная запись (логин, отпечаток пароля, роль, блокировка) и роли живут в базе ПАНЕЛИ,
// сотрудник магазина (ФИО, оклад, бонус) — в схеме магазина (см. users.service). Общей
// транзакции у двух баз нет, поэтому запись в панель — повторяемая: номер записи придумала
// касса, и повтор операции находит её на месте, а не заводит вторую.
//
// Правила — как у справочников этапа 1 (edits.ts):
//   • поле правили и на кассе, и на сайте — остаётся более поздняя по времени правка
//     (FieldStamp 'Account' / 'Role' в схеме магазина; сайт ставит «сейчас»);
//   • логин общий на весь сервис: занят — сотрудник всё равно заводится (его чеки без связи
//     не должны пропасть) под свободным логином «имя-2», «имя-3»…; владелец видит это в
//     «Расхождениях», касса узнаёт новый логин при обмене;
//   • роль с таким же названием уже есть — это та же роль (номер кассы ведёт к ней);
//   • отказы — те же, что на сайте, теми же словами.
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { AdminDbService } from '../admin/admin-db.service'
import { AccountCache } from '../admin/account-cache.service'
import { EventsGateway } from '../events/events.gateway'
import { RolesService } from '../roles/roles.service'
import { ALL_PERMISSIONS, isPermission, OWNER_ROLE } from '../auth/permissions'
import { conflictNote, EditOutcome, forgetStamps, lastEditOf, resolveEdit, stamp, stampsOf } from '../common/stamps'
import { aliasOf, EditCtx, EditKit, setAlias } from './edits'
import { parseRemove, parseRoleCreate, parseRoleUpdate, parseUserCreate, parseUserUpdate, Reject } from './payload'

type Tx = Prisma.TransactionClient

export interface TeamKit {
  admin: AdminDbService
  accounts: AccountCache
  events: EventsGateway
  roles: RolesService
}

export const TEAM_TYPES: ReadonlySet<string> = new Set(['user.create', 'user.update', 'user.delete', 'role.create', 'role.update', 'role.delete'])

// Тексты отказов — слово в слово как на сайте (users.service, roles.service)
export const TEAM_TEXT = {
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
  ownerName: 'Это имя занято ролью владельца',
}

const pick = (set: Record<string, any>, fields: string[]) => Object.fromEntries(fields.map((f) => [f, set[f]]))

export async function applyTeam(tx: Tx, type: string, payload: any, ctx: EditCtx, kit: EditKit, team: TeamKit): Promise<string | null> {
  const pharmacyId = ctx.pharmacyId
  if (!pharmacyId) throw new Reject('Сотрудников заводит только владелец магазина')
  switch (type) {
    case 'user.create':
      return userCreate(tx, parseUserCreate(payload), ctx, kit, team, pharmacyId)
    case 'user.update':
      return userUpdate(tx, parseUserUpdate(payload), ctx, kit, team, pharmacyId)
    case 'user.delete':
      return userDelete(tx, parseRemove(payload, 'сотрудник'), ctx, kit, team, pharmacyId)
    case 'role.create':
      return roleCreate(tx, parseRoleCreate(payload), ctx, kit, team, pharmacyId)
    case 'role.update':
      return roleUpdate(tx, parseRoleUpdate(payload), ctx, kit, team, pharmacyId)
    case 'role.delete':
      return roleDelete(tx, parseRemove(payload, 'роль'), ctx, kit, team, pharmacyId)
    default:
      throw new Reject('Неизвестная операция')
  }
}

// ── Роль для сотрудника ──
// 'owner' — владелец; номер роли магазина (или роли кассы, слитой с ролью сайта); пусто или
// роли уже нет (удалили на сайте) — системная роль кассира: сотрудник не должен пропасть
async function roleFor(team: TeamKit, ctx: EditCtx, pharmacyId: string, roleId: string | null) {
  if (roleId === 'owner') return { role: 'founder', roleId: null as string | null, roleName: OWNER_ROLE.name }
  const cashier = await team.roles.ensure(pharmacyId)
  const rid = roleId ? aliasOf(ctx.aliases, 'role', roleId) : null
  if (rid && rid !== cashier.id) {
    const r = await team.roles.find(pharmacyId, rid)
    if (r) return { role: 'cashier', roleId: r.id, roleName: r.name }
  }
  return { role: 'cashier', roleId: cashier.id, roleName: cashier.name }
}

// Логин свободен и в панели (на весь сервис), и среди сотрудников магазина
async function loginFree(tx: Tx, team: TeamKit, login: string, exceptAccount?: string, exceptUser?: string | null) {
  const acc = await team.admin.account.findUnique({ where: { login }, select: { id: true } })
  if (acc && acc.id !== exceptAccount) return false
  const u = await tx.user.findUnique({ where: { name: login }, select: { id: true } })
  return !u || u.id === exceptUser
}

const profileOf = (p: { fullName?: string; salary?: number; bonusPercent?: number; salaryDay?: number }) => {
  const out: Record<string, any> = {}
  if (p.fullName !== undefined) out.fullName = p.fullName
  if (p.salary !== undefined) out.salary = Math.round(p.salary * 100) / 100
  if (p.bonusPercent !== undefined) out.bonusPercent = Math.round(p.bonusPercent * 100) / 100
  if (p.salaryDay !== undefined) out.salaryDay = p.salaryDay
  return out
}

// ── Новый сотрудник ──
async function userCreate(tx: Tx, p: ReturnType<typeof parseUserCreate>, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string> {
  const existing = await team.admin.account.findUnique({ where: { id: p.id } })
  if (existing) {
    if (existing.pharmacyId !== pharmacyId) throw new Reject('Сотрудник не найден')
    // Повтор операции: учётная запись уже есть. Сотрудник магазина мог не завестись (сбой
    // между двумя базами) — заводим его, если его нет
    const uid = existing.tenantUserId || p.userId
    if (!(await tx.user.findUnique({ where: { id: uid }, select: { id: true } }))) {
      await tx.user.create({ data: { id: uid, name: existing.login, role: existing.role, ...profileOf(p) } })
    }
    if (!existing.tenantUserId) await team.admin.account.update({ where: { id: existing.id }, data: { tenantUserId: uid } })
    return p.id
  }
  const r = await roleFor(team, ctx, pharmacyId, p.roleId)
  let login = p.name
  for (let n = 2; !(await loginFree(tx, team, login)); n++) {
    if (n > 999) throw new Reject(`Логин «${p.name}» уже занят`)
    login = `${p.name}-${n}`
  }
  await team.admin.account.create({
    data: { id: p.id, login, passwordHash: p.passwordHash, role: r.role, roleId: r.roleId, pharmacyId, tenantUserId: p.userId, createdAt: p.createdAt },
  })
  await tx.user.create({ data: { id: p.userId, name: login, role: r.role, createdAt: p.createdAt, ...profileOf(p) } })
  if (login !== p.name) {
    await kit.flag(tx, ctx, { id: p.userId, date: p.createdAt }, { kind: 'edit', name: login, units: 0, note: JSON.stringify({ tbl: 'Account', loginTaken: p.name, login }) })
  }
  team.accounts.drop(p.id)
  return p.id
}

// ── Правка сотрудника ──
async function userUpdate(tx: Tx, p: ReturnType<typeof parseUserUpdate>, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string | null> {
  const acc = await team.admin.account.findFirst({ where: { id: p.id, pharmacyId } })
  if (!acc) return null
  const prof = acc.tenantUserId ? await tx.user.findUnique({ where: { id: acc.tenantUserId } }) : null
  const current: Record<string, any> = {
    name: acc.login,
    active: acc.active,
    roleId: acc.role === 'founder' ? 'owner' : acc.roleId,
    fullName: prof?.fullName ?? '',
    salary: prof ? Number(prof.salary) : 0,
    bonusPercent: prof ? Number(prof.bonusPercent) : 0,
    salaryDay: prof?.salaryDay ?? 1,
  }
  const stamps = await stampsOf(tx, 'Account', acc.id)
  const out: EditOutcome = resolveEdit(p.set, p.base, current, stamps, p.at)
  const extra: Record<string, any> = {}
  const actor = ctx.actor?.accountId
  const drop = (f: string) => {
    out.apply = out.apply.filter((x) => x !== f)
    out.overrode = out.overrode.filter((x) => x !== f)
  }

  // Защита от того, чтобы магазин остался без владельца, — как на сайте: это отказ
  if (out.apply.includes('active') && p.set.active === false) {
    if (acc.id === actor) throw new Reject(TEAM_TEXT.blockSelf)
    if (acc.role === 'founder' && (await team.admin.account.count({ where: { pharmacyId, role: 'founder', active: true } })) <= 1) throw new Reject(TEAM_TEXT.blockLastOwner)
  }
  let next: Awaited<ReturnType<typeof roleFor>> | null = null
  if (out.apply.includes('roleId')) {
    if (acc.role === 'founder' && p.set.roleId !== 'owner') {
      if (acc.id === actor) throw new Reject(TEAM_TEXT.ownRole)
      if ((await team.admin.account.count({ where: { pharmacyId, role: 'founder', active: true } })) <= 1) throw new Reject(TEAM_TEXT.lastOwnerRole)
    }
    next = await roleFor(team, ctx, pharmacyId, p.set.roleId)
  }
  // Логин занят другим — переименование не ложится, остальное — да
  if (out.apply.includes('name') && !(await loginFree(tx, team, p.set.name, acc.id, acc.tenantUserId))) {
    drop('name')
    extra.nameTaken = p.set.name
  }
  // Пароль: с прежним сравнивать нечего — ложится, если на сайте его не меняли позже
  let password = false
  if (p.passwordHash) {
    const last = stamps.get('password')
    if (!last || p.at.getTime() > last.getTime()) password = true
    else extra.passwordKept = true
  }

  const data: Record<string, any> = {}
  if (out.apply.includes('name')) data.login = p.set.name
  if (out.apply.includes('active')) data.active = p.set.active
  if (next) {
    data.role = next.role
    data.roleId = next.roleId
  }
  if (password) {
    data.passwordHash = p.passwordHash
    // Ключи, выданные до смены пароля, больше не действуют — как на сайте
    data.passwordChangedAt = new Date()
  }
  if (Object.keys(data).length) await team.admin.account.update({ where: { id: acc.id }, data })

  if (acc.tenantUserId && prof) {
    const udata: Record<string, any> = profileOf(pick(p.set, out.apply.filter((f) => ['fullName', 'salary', 'bonusPercent', 'salaryDay'].includes(f))))
    if (data.login) udata.name = data.login
    if (data.active !== undefined) udata.active = data.active
    if (data.role) udata.role = data.role
    if (Object.keys(udata).length) await tx.user.update({ where: { id: acc.tenantUserId }, data: udata })
  }
  const stamped = [...out.apply, ...(password ? ['password'] : [])]
  if (stamped.length) await stamp(tx, 'Account', acc.id, stamped, p.at)
  if (out.overrode.length || out.kept.length || Object.keys(extra).length) {
    await kit.flag(tx, ctx, { id: acc.tenantUserId || acc.id, date: p.at }, { kind: 'edit', name: acc.login, units: 0, note: conflictNote('Account', p.set, current, out, extra) })
  }
  // Сторож помнит учётную запись несколько секунд — после правки обязан спросить заново.
  // Заблокировали или сменили пароль — открытые окна сотрудника закрываются сразу
  team.accounts.drop(acc.id)
  if (data.active === false || password) team.events.dropUser(acc.id, data.active === false ? 'сотрудник заблокирован' : 'пароль сброшен')
  return out.kept.length || extra.nameTaken || extra.passwordKept ? null : acc.id
}

// ── Удаление сотрудника ──
async function userDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string | null> {
  const acc = await team.admin.account.findFirst({ where: { id: p.id, pharmacyId } })
  // Уже удалили (на сайте или повтор) — удалять нечего, итог тот же
  if (!acc) return p.id
  if (acc.role === 'founder') throw new Reject(TEAM_TEXT.deleteOwner)
  if (acc.id === ctx.actor?.accountId) throw new Reject(TEAM_TEXT.deleteSelf)
  // Позже удаления его правили на сайте — он остаётся (как запись справочника, этап 1)
  const last = await lastEditOf(tx, 'Account', acc.id)
  if (last && last.getTime() > p.at.getTime()) {
    await kit.flag(tx, ctx, { id: acc.tenantUserId || acc.id, date: p.at }, { kind: 'edit', name: acc.login, units: 0, note: JSON.stringify({ tbl: 'Account', deleteKept: true, editedAt: last.toISOString() }) })
    return null
  }
  await team.admin.account.delete({ where: { id: acc.id } })
  // Чеки и смены ссылаются на сотрудника магазина с SetNull — история остаётся
  if (acc.tenantUserId) await tx.user.deleteMany({ where: { id: acc.tenantUserId } })
  await forgetStamps(tx, 'Account', acc.id)
  team.accounts.drop(acc.id)
  team.events.dropUser(acc.id, 'сотрудник удалён')
  return p.id
}

// Права роли: только известные этой версии сервера
const knownPerms = (list: string[]) => list.filter(isPermission)

// ── Новая роль ──
async function roleCreate(tx: Tx, p: ReturnType<typeof parseRoleCreate>, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string> {
  if (p.name.toLowerCase() === OWNER_ROLE.name.toLowerCase()) throw new Reject(TEAM_TEXT.ownerName)
  const existing = await team.admin.role.findUnique({ where: { id: p.id } })
  if (existing) {
    if (existing.pharmacyId !== pharmacyId) throw new Reject('Роль не найдена')
    return p.id
  }
  await team.roles.ensure(pharmacyId)
  // Такую же завели на сайте — это она и есть: сотрудники, назначенные на роль кассы, лягут
  // на неё (псевдоним). Права — как на сайте; владелец видит, что роли совпали по названию
  const same = await team.admin.role.findFirst({ where: { pharmacyId, name: p.name } })
  if (same) {
    await setAlias(tx, ctx, 'role', p.id, same.id)
    const perms = knownPerms(p.permissions)
    if (perms.length !== same.permissions.length || perms.some((x) => !same.permissions.includes(x))) {
      await kit.flag(tx, ctx, { id: same.id, date: p.createdAt }, { kind: 'edit', name: same.name, units: 0, note: JSON.stringify({ tbl: 'Role', sameName: true }) })
    }
    return same.id
  }
  await team.admin.role.create({ data: { id: p.id, pharmacyId, name: p.name, description: p.description, permissions: knownPerms(p.permissions), createdAt: p.createdAt } })
  team.accounts.dropPharmacy(pharmacyId)
  return p.id
}

// ── Правка роли ──
async function roleUpdate(tx: Tx, p: ReturnType<typeof parseRoleUpdate>, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string | null> {
  if (p.id === OWNER_ROLE.id) throw new Reject(TEAM_TEXT.ownerRoleEdit)
  const rid = aliasOf(ctx.aliases, 'role', p.id)
  const r = await team.admin.role.findFirst({ where: { id: rid, pharmacyId } })
  if (!r) return null
  const set = { ...p.set }
  if (set.permissions) set.permissions = knownPerms(set.permissions)
  const current = { name: r.name, description: r.description, permissions: r.permissions }
  const out = resolveEdit(set, p.base, current, await stampsOf(tx, 'Role', r.id), p.at)
  const extra: Record<string, any> = {}
  if (out.apply.includes('name')) {
    if (r.system) throw new Reject(TEAM_TEXT.systemRename)
    if (set.name.toLowerCase() === OWNER_ROLE.name.toLowerCase()) throw new Reject(TEAM_TEXT.ownerName)
    if (await team.admin.role.findFirst({ where: { pharmacyId, name: set.name, NOT: { id: r.id } }, select: { id: true } })) {
      out.apply = out.apply.filter((f) => f !== 'name')
      out.overrode = out.overrode.filter((f) => f !== 'name')
      extra.nameTaken = set.name
    }
  }
  if (out.apply.length) {
    await team.admin.role.update({ where: { id: r.id }, data: pick(set, out.apply) })
    await stamp(tx, 'Role', r.id, out.apply, p.at)
    // Права поменялись — сторож проверит каждого сотрудника этой роли заново
    team.accounts.dropPharmacy(pharmacyId)
  }
  if (out.overrode.length || out.kept.length || Object.keys(extra).length) {
    await kit.flag(tx, ctx, { id: r.id, date: p.at }, { kind: 'edit', name: r.name, units: 0, note: conflictNote('Role', set, current, out, extra) })
  }
  return out.kept.length || extra.nameTaken ? null : r.id
}

// ── Удаление роли ──
async function roleDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit, team: TeamKit, pharmacyId: string): Promise<string | null> {
  if (p.id === OWNER_ROLE.id) throw new Reject(TEAM_TEXT.ownerRoleDelete)
  const rid = aliasOf(ctx.aliases, 'role', p.id)
  // Номер кассы ведёт к роли сайта (совпали по названию) — её удаление с кассы не касается
  if (rid !== p.id) return null
  const r = await team.admin.role.findFirst({ where: { id: rid, pharmacyId }, include: { _count: { select: { accounts: true } } } })
  if (!r) return p.id
  if (r.system) throw new Reject(TEAM_TEXT.systemDelete)
  if (r._count.accounts > 0) throw new Reject(`На этой роли ${r._count.accounts} сотрудник(ов). Сначала переведите их на другую роль`)
  const last = await lastEditOf(tx, 'Role', r.id)
  if (last && last.getTime() > p.at.getTime()) {
    await kit.flag(tx, ctx, { id: r.id, date: p.at }, { kind: 'edit', name: r.name, units: 0, note: JSON.stringify({ tbl: 'Role', deleteKept: true, editedAt: last.toISOString() }) })
    return null
  }
  await team.admin.role.delete({ where: { id: r.id } })
  await forgetStamps(tx, 'Role', r.id)
  team.accounts.dropPharmacy(pharmacyId)
  return p.id
}

// ── Сотрудники и роли для кассы (раздел обмена team) ──
// Как отдают GET /users и GET /roles. Целиком: список маленький; касса присылает отпечаток
// прошлого списка, и неизменившийся не отдаётся снова. Кассы спрашивают изменения часто,
// а список меняется редко — он помнится несколько секунд и забывается при любой правке
// сотрудника или роли (здесь, на сайте — users.service, roles.service)
const TEAM_MEMO_MS = 5000
const memo = new Map<string, { at: number; value: { v: string; accounts: any[]; roles: any[] } }>()
export function teamMemoForget(pharmacyId?: string | null) {
  if (pharmacyId) memo.delete(pharmacyId)
}
export async function teamFor(team: TeamKit, pharmacyId: string) {
  const hit = memo.get(pharmacyId)
  if (hit && Date.now() - hit.at < TEAM_MEMO_MS) return hit.value
  const t = await teamOf(team, pharmacyId)
  const v = createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 20)
  const value = { v, ...t }
  memo.set(pharmacyId, { at: Date.now(), value })
  return value
}

async function teamOf(team: TeamKit, pharmacyId: string) {
  // Без «заведения ролей по умолчанию» (roles.ensure пишет в базу): обмен только читает
  const [roleRows, owners] = await Promise.all([
    team.admin.role.findMany({ where: { pharmacyId }, orderBy: [{ system: 'desc' }, { createdAt: 'asc' }], include: { _count: { select: { accounts: true } } } }),
    team.admin.account.count({ where: { pharmacyId, role: 'founder' } }),
  ])
  const roles = [
    { id: OWNER_ROLE.id, name: OWNER_ROLE.name, description: OWNER_ROLE.description, system: 'owner', permissions: ALL_PERMISSIONS, people: owners },
    ...roleRows.map((r) => ({ id: r.id, name: r.name, description: r.description, system: r.system, permissions: r.permissions.filter(isPermission), people: r._count.accounts })),
  ]
  const rows = await team.admin.account.findMany({
    where: { pharmacyId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, login: true, role: true, active: true, createdAt: true, roleId: true, tenantUserId: true, roleRef: { select: { name: true } } },
  })
  const accounts = rows.map((a) => ({
    id: a.id,
    name: a.login,
    role: a.role,
    roleId: a.role === 'founder' ? 'owner' : a.roleId ?? null,
    roleName: a.role === 'founder' ? OWNER_ROLE.name : a.roleRef?.name || 'Кассир',
    active: a.active,
    createdAt: a.createdAt,
    userId: a.tenantUserId ?? null,
  }))
  return { accounts, roles }
}
