import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/admin-client'
import { PrismaService } from '../prisma/prisma.service'
import { AdminDbService } from '../admin/admin-db.service'
import { AuthService } from '../auth/auth.service'
import { passwordProblem } from '../auth/password'
import { EventsGateway } from '../events/events.gateway'
import { AccountCache } from '../admin/account-cache.service'
import { CreateUserDto, UpdateUserDto } from './dto'

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

const view = (a: { id: string; login: string; role: string; active: boolean; createdAt: Date }) => ({
  id: a.id,
  name: a.login,
  role: a.role,
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
  ) {}

  findAll(pharmacyId: string) {
    return this.admin.account
      .findMany({
        where: { pharmacyId },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, login: true, role: true, active: true, createdAt: true },
      })
      .then((rows) => rows.map(view))
  }

  async create(dto: CreateUserDto, pharmacyId: string) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите имя сотрудника')
    const bad = passwordProblem(dto.password)
    if (bad) throw new BadRequestException(bad)
    const role = dto.role === 'founder' ? 'founder' : 'cashier'

    // Шаг первый: бронь логина
    let acc
    try {
      acc = await this.admin.account.create({
        data: { login: name, passwordHash: await AuthService.hashPassword(dto.password), role, pharmacyId },
        select: { id: true, login: true, role: true, active: true, createdAt: true },
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
        select: { id: true, login: true, role: true, active: true, createdAt: true },
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
