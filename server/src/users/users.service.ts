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

// ── Сотрудники аптеки ──
// Запись идёт в две базы сразу, и общей транзакции между ними нет. В панели живёт
// доступ: логин, пароль, роль, блокировка. В схеме аптеки — имя, на которое
// ссылаются чеки, смены, возвраты и списания.
//
// Порядок обязателен: сначала бронируем логин в панели. Он уникален на весь сервис,
// и занят он или нет — знает только она. Пойди мы с другого конца, сотрудник
// появился бы в аптеке, а войти под ним было бы нельзя.
//
// Если второй шаг не удался, бронь снимается. Остаться может разве что запись в
// аптеке без доступа — под ней просто нельзя войти, и владелец увидит это в списке.

type AccountRow = {
  id: string
  login: string
  role: string
  active: boolean
  createdAt: Date
  roleId?: string | null
  roleRef?: { name: string } | null
}
const SELECT = { id: true, login: true, role: true, active: true, createdAt: true, roleId: true, roleRef: { select: { name: true } } } as const
const view = (a: AccountRow) => ({
  id: a.id,
  name: a.login,
  role: a.role,
  roleId: a.role === 'founder' ? 'owner' : a.roleId ?? null,
  roleName: a.role === 'founder' ? 'Владелец' : a.roleRef?.name || 'Кассир',
  active: a.active,
  createdAt: a.createdAt,
})

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
    return rows.map(view)
  }

  // Роль для новой записи: владелец — без роли (он может всё), остальные — выбранная
  // или системная роль кассира. Чужую роль (другой аптеки) назначить нельзя
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
          `Логин «${name}» уже занят. Он должен быть свободен среди всех аптек — добавьте к нему что-нибудь своё.`,
        )
      }
      throw e
    }

    // Шаг второй: сам сотрудник в схеме аптеки
    try {
      const user = await this.prisma.user.create({ data: { name, role } })
      await this.admin.account.update({ where: { id: acc.id }, data: { tenantUserId: user.id } })
    } catch (e) {
      await this.admin.account.delete({ where: { id: acc.id } }).catch(() => {})
      this.log.error(`Сотрудник «${name}» не заведён, бронь логина снята: ${(e as any)?.message || e}`)
      throw e
    }

    return view(acc)
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
    // аптека осталась бы без того, кто может всё
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

    // Имя в аптеке приводим к логину: под ним сотрудник значится в чеках и сменах
    if (name && name !== acc.login && acc.tenantUserId) {
      try {
        await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { name } })
      } catch (e) {
        // Возвращаем логин обратно: расхождение имён хуже, чем несостоявшееся
        // переименование — в чеках значился бы один человек, в списке другой
        await this.admin.account.update({ where: { id }, data: { login: acc.login } }).catch(() => {})
        throw new BadRequestException(`Сотрудник с именем «${name}» в этой аптеке уже есть`)
      }
    }
    if (dto.active !== undefined && acc.tenantUserId) {
      await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { active: dto.active } }).catch(() => {})
    }
    if (roleChanged) {
      if (acc.tenantUserId && data.role) {
        await this.prisma.user.update({ where: { id: acc.tenantUserId }, data: { role: data.role } }).catch(() => {})
      }
      // Открытые окна этого сотрудника перечитают «кто я» и спрячут или покажут разделы
      this.events.changed('roles', 'users')
    }

    // Доступ отобрали — обрываем и постоянное соединение. Обычные запросы
    // сотрудника уже отклоняются, а связь жила бы своей жизнью до перепроверки
    if (dto.active === false || dto.password) {
      this.events.dropUser(id, dto.active === false ? 'сотрудник заблокирован' : 'пароль сброшен')
    }
    // Сторож помнит сотрудника несколько секунд — но не тогда, когда мы сами
    // только что отобрали доступ или сменили пароль. Такое обязано действовать сразу.
    this.accounts.drop(id)
    return view(updated)
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
    this.events.dropUser(id, 'сотрудник удалён')
    this.accounts.drop(id)
    return { ok: true }
  }
}
