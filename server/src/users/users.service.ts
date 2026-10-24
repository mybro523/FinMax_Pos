import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/admin-client'
import { PrismaService } from '../prisma/prisma.service'
import { AdminDbService } from '../admin/admin-db.service'
import { AuthService } from '../auth/auth.service'
import { passwordProblem } from '../auth/password'
import { EventsGateway } from '../events/events.gateway'
import { AccountCache } from '../admin/account-cache.service'
import { CreateUserDto, UpdateUserDto } from './dto'
import { RolesService } from '../roles/roles.service'
import { forgetStamps, same, stamp } from '../common/stamps'
import { teamMemoForget } from '../sync/team'

// ── Сотрудники магазина ──
// Запись идёт в две базы сразу, и общей транзакции между ними нет. В панели живёт
// доступ: логин, пароль, роль, блокировка. В схеме магазина — имя, на которое
// ссылаются чеки, смены, возвраты и списания.
//
// Порядок обязателен: сначала бронируем логин в панели. Он уникален на весь сервис,
// и занят он или нет — знает только она. Пойди мы с другого конца, сотрудник
// появился бы в магазине, а войти под ним было бы нельзя.
//
// Если второй шаг не удался, бронь снимается. Остаться может разве что запись в
// магазине без доступа — под ней просто нельзя войти, и владелец увидит это в списке.

type AccountRow = {
  id: string
  login: string
  role: string
  active: boolean
  createdAt: Date
  roleId?: string | null
  roleRef?: { name: string } | null
  tenantUserId?: string | null
}
// Данные для зарплаты живут в схеме магазина, рядом с именем сотрудника
type Profile = { fullName: string; salary: unknown; bonusPercent: unknown; salaryDay?: number }
const SELECT = {
  id: true, login: true, role: true, active: true, createdAt: true, roleId: true, tenantUserId: true, roleRef: { select: { name: true } },
} as const
const PROFILE = { id: true, fullName: true, salary: true, bonusPercent: true, salaryDay: true } as const
const view = (a: AccountRow, p?: Profile | null) => ({
  id: a.id,
  name: a.login,
  role: a.role,
  roleId: a.role === 'founder' ? 'owner' : a.roleId ?? null,
  roleName: a.role === 'founder' ? 'Владелец' : a.roleRef?.name || 'Кассир',
  active: a.active,
  createdAt: a.createdAt,
  // Сотрудник в схеме магазина: на него ссылаются чеки — по нему считается бонус
  userId: a.tenantUserId ?? null,
  fullName: p?.fullName || '',
  salary: Number(p?.salary ?? 0) || 0,
  bonusPercent: Number(p?.bonusPercent ?? 0) || 0,
  // С какого числа начинается его месяц зарплаты
  salaryDay: Number(p?.salaryDay ?? 1) || 1,
})

// ФИО, оклад и бонус из запроса — только то, что прислали
function profileData(dto: { fullName?: string; salary?: number; bonusPercent?: number; salaryDay?: number }) {
  const data: { fullName?: string; salary?: number; bonusPercent?: number; salaryDay?: number } = {}
  if (dto.fullName !== undefined) data.fullName = String(dto.fullName || '').trim().slice(0, 120)
  if (dto.salary !== undefined) data.salary = Math.round(Math.max(0, Number(dto.salary) || 0) * 100) / 100
  if (dto.bonusPercent !== undefined) data.bonusPercent = Math.round(Math.min(100, Math.max(0, Number(dto.bonusPercent) || 0)) * 100) / 100
  if (dto.salaryDay !== undefined) data.salaryDay = Math.min(28, Math.max(1, Math.trunc(Number(dto.salaryDay) || 1)))
  return data
}

const isTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

@Injectable()
export class UsersService {
  private readonly log = new Logger('Users')

  constructor(
    private prisma: PrismaService,
    private admin: AdminDbService,
    private events: EventsGateway,
    private accounts: AccountCache,
    private roles: RolesService,
  ) {}

  async findAll(pharmacyId: string) {
    // Кассиры прежней версии получают системную роль здесь — до того, как владелец
    // увидит список и захочет что-то поправить
    await this.roles.ensure(pharmacyId)
    const rows = await this.admin.account.findMany({
      where: { pharmacyId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: SELECT,
    })
    // ФИО, оклад и бонус — из схемы магазина, одним запросом на весь список
    const ids = rows.map((r) => r.tenantUserId).filter(Boolean) as string[]
    const profiles = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: PROFILE }) : []
    const byId = new Map(profiles.map((p) => [p.id, p]))
    return rows.map((r) => view(r, r.tenantUserId ? byId.get(r.tenantUserId) : null))
  }

  // Роль для новой записи: владелец — без роли (он может всё), остальные — выбранная
  // или системная роль кассира. Чужую роль (другого магазина) назначить нельзя
  private async resolveRole(pharmacyId: string, wantsOwner: boolean, roleId?: string) {
    if (wantsOwner) return { role: 'founder', roleId: null as string | null }
    const cashier = await this.roles.ensure(pharmacyId)
    if (!roleId || roleId === cashier.id) return { role: 'cashier', roleId: cashier.id }
    const r = await this.roles.find(pharmacyId, roleId)
    if (!r) throw new BadRequestException('Роль не найдена')
    return { role: 'cashier', roleId: r.id }
  }

  async create(dto: CreateUserDto, pharmacyId: string) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите имя сотрудника')
    const bad = passwordProblem(dto.password)
    if (bad) throw new BadRequestException(bad)
    const { role, roleId } = await this.resolveRole(pharmacyId, dto.role === 'founder' || dto.roleId === 'owner', dto.roleId)
    // Шаг первый: бронь логина
    let acc
    try {
      acc = await this.admin.account.create({
        data: { login: name, passwordHash: await AuthService.hashPassword(dto.password), role, roleId, pharmacyId },
        select: SELECT,
      })
    } catch (e) {
      if (isTaken(e)) {
        throw new BadRequestException(
          `Логин «${name}» уже занят. Он должен быть свободен среди всех магазинов — добавьте к нему что-нибудь своё.`,
        )
      }
      throw e
    }

    // Шаг второй: сам сотрудник в схеме магазина — с ФИО, окладом и бонусом
    let profile: Profile | null = null
    try {
      const user = await this.prisma.user.create({ data: { name, role, ...profileData(dto) } })
      profile = user
      await this.admin.account.update({ where: { id: acc.id }, data: { tenantUserId: user.id } })
      acc = { ...acc, tenantUserId: user.id }
    } catch (e) {
      await this.admin.account.delete({ where: { id: acc.id } }).catch(() => {})
      this.log.error(`Сотрудник «${name}» не заведён, бронь логина снята: ${(e as any)?.message || e}`)
      throw e
    }

    // Все открытые списки сотрудников перечитываются — без этого экран жил бы
    // своими догадками и после обрыва связи показывал бы призрачные строки
    teamMemoForget(pharmacyId)
    this.events.changed('users')
    return view(acc, profile)
  }

  async update(id: string, dto: UpdateUserDto, currentAccountId: string, pharmacyId: string) {
    const acc = await this.admin.account.findFirst({ where: { id, pharmacyId } })
    if (!acc) throw new NotFoundException('Сотрудник не найден')

    // Защита от лок-аута: нельзя заблокировать себя или единственного активного владельца
    if (dto.active === false) {
      if (id === currentAccountId) throw new BadRequestException('Нельзя заблокировать самого себя')
      if (acc.role === 'founder') {
        const active = await this.admin.account.count({ where: { pharmacyId, role: 'founder', active: true } })
        if (active <= 1) throw new BadRequestException('Нельзя заблокировать единственного владельца')
      }
    }

    const name = dto.name === undefined ? undefined : dto.name.trim()
    const data: any = {}
    if (name) data.login = name
    if (dto.active !== undefined) data.active = dto.active
    // Смена роли. Последнего владельца разжаловать нельзя, себя — тоже: иначе
    // магазин остался бы без того, кто может всё
    let roleChanged = false
    if (dto.roleId !== undefined) {
      const wantsOwner = dto.roleId === 'owner'
      if (acc.role === 'founder' && !wantsOwner) {
        if (id === currentAccountId) throw new BadRequestException('Свою роль владелец изменить не может')
        const active = await this.admin.account.count({ where: { pharmacyId, role: 'founder', active: true } })
        if (active <= 1) throw new BadRequestException('Нельзя снять права с единственного владельца')
      }
      const next = await this.resolveRole(pharmacyId, wantsOwner, dto.roleId)
      if (next.role !== acc.role || next.roleId !== acc.roleId) {
        data.role = next.role
        data.roleId = next.roleId
        roleChanged = true
      }
    }
    if (dto.password) {
      const bad = passwordProblem(dto.password)
      if (bad) throw new BadRequestException(bad)
      data.passwordHash = await AuthService.hashPassword(dto.password)
      // Владелец сбрасывает пароль сотруднику обычно потому, что доступ надо
      // отобрать. Старые токены после этого действовать не должны.
      data.passwordChangedAt = new Date()
    }

    let updated
    try {
      updated = await this.admin.account.update({
        where: { id },
        data,
        select: SELECT,
      })
    } catch (e) {
      if (isTaken(e)) throw new BadRequestException(`Логин «${name}» уже занят другим сотрудником сервиса`)
      throw e
    }

    // Имя в магазине приводим к логину: под ним сотрудник значится в чеках и сменах
    if (name && name !== acc.login && acc.tenantUserId) {
      try {
        await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { name } })
      } catch (e) {
        // Возвращаем логин обратно: расхождение имён хуже, чем несостоявшееся
        // переименование — в чеках значился бы один человек, в списке другой
        await this.admin.account.update({ where: { id }, data: { login: acc.login } }).catch(() => {})
        throw new BadRequestException(`Сотрудник с именем «${name}» в этом магазине уже есть`)
      }
    }
    if (dto.active !== undefined && acc.tenantUserId) {
      await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { active: dto.active } }).catch(() => {})
    }
    // ФИО, оклад и бонус — в схеме магазина. Ошибку здесь не глотаем: владелец
    // должен узнать, что оклад не сохранился, а не увидеть «изменено»
    const profile = profileData(dto)
    // Каким был профиль до правки: отметку времени получают только поля, которые правда
    // поменялись (окно «Сотрудник» присылает их все сразу)
    const wasProfile = acc.tenantUserId && Object.keys(profile).length ? await this.prisma.user.findUnique({ where: { id: acc.tenantUserId }, select: PROFILE }) : null
    let saved: Profile | null = null
    if (acc.tenantUserId) {
      saved = Object.keys(profile).length
        ? await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: profile, select: PROFILE })
        : await this.prisma.user.findUnique({ where: { id: acc.tenantUserId }, select: PROFILE })
    } else if (Object.keys(profile).length) {
      throw new BadRequestException('У сотрудника нет записи в магазине — оклад сохранить некуда')
    }
    if (roleChanged) {
      if (acc.tenantUserId && data.role) {
        await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { role: data.role } }).catch(() => {})
      }
      // Открытые окна этого сотрудника перечитают «кто я» и спрячут или покажут разделы
      teamMemoForget(pharmacyId)
      this.events.changed('roles', 'users')
    } else {
      // Имя, блокировка, пароль — списки сотрудников тоже перечитываются
      teamMemoForget(pharmacyId)
    this.events.changed('users')
    }

    // Когда правили поля: касса без связи могла править того же сотрудника, и остаётся более
    // поздняя по времени правка (sync/team.ts). Отметка — в схеме магазина, и только полям,
    // которые правда поменялись: «Сохранить» без изменений не должно перекрыть правку кассы
    const touchedFields = [
      ...(name && name !== acc.login ? ['name'] : []),
      ...(dto.active !== undefined && dto.active !== acc.active ? ['active'] : []),
      ...(roleChanged ? ['roleId'] : []),
      ...(dto.password ? ['password'] : []),
      ...Object.keys(profile).filter((k) => !wasProfile || !same((wasProfile as any)[k], (profile as any)[k])),
    ]
    if (touchedFields.length) await stamp(this.prisma as any, 'Account', id, touchedFields).catch(() => {})

    // Доступ отобрали — обрываем и постоянное соединение. Обычные запросы
    // сотрудника уже отклоняются, а связь жила бы своей жизнью до перепроверки
    if (dto.active === false || dto.password) {
      this.events.dropUser(id, dto.active === false ? 'сотрудник заблокирован' : 'пароль сброшен')
    }
    // Сторож помнит сотрудника несколько секунд — но не тогда, когда мы сами
    // только что отобрали доступ или сменили пароль. Такое обязано действовать сразу.
    this.accounts.drop(id)
    return view(updated, saved)
  }

  async remove(id: string, currentAccountId: string, pharmacyId: string) {
    const acc = await this.admin.account.findFirst({ where: { id, pharmacyId } })
    if (!acc) throw new NotFoundException('Сотрудник не найден')
    if (acc.role === 'founder') throw new BadRequestException('Нельзя удалить владельца')
    if (id === currentAccountId) throw new BadRequestException('Нельзя удалить себя')

    // Сначала доступ: без него человек уже не войдёт, даже если второй шаг не удастся
    await this.admin.account.delete({ where: { id } })
    // Продажи и смены ссылаются на сотрудника через SetNull — история сохранится
    if (acc.tenantUserId) {
      await this.prisma.user.delete({ where: { id: acc.tenantUserId } }).catch(() => {})
    }
    await forgetStamps(this.prisma as any, 'Account', id).catch(() => {})
    this.events.dropUser(id, 'сотрудник удалён')
    this.accounts.drop(id)
    teamMemoForget(pharmacyId)
    this.events.changed('users')
    return { ok: true }
  }
}
