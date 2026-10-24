import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/admin-client'
import { AdminDbService } from '../admin/admin-db.service'
import { AccountCache } from '../admin/account-cache.service'
import { EventsGateway } from '../events/events.gateway'
import {
  ALL_PERMISSIONS,
  CASHIER_DEFAULT,
  OWNER_ROLE,
  ROLE_PRESETS,
  SYSTEM_CASHIER,
  isPermission,
} from '../auth/permissions'
import { CreateRoleDto, UpdateRoleDto } from './dto'
import { PrismaService } from '../prisma/prisma.service'
import { forgetStamps, stamp } from '../common/stamps'
import { teamMemoForget } from '../sync/team'

// ── Роли магазина ──
// Владелец — не запись в таблице, а особое положение: он может всё, и отнять у него
// права нельзя. В списке он показывается как роль «Владелец» с замком. Остальные
// роли лежат в панели рядом с учётными записями: роль — это доступ, а не данные магазина.
//
// Системная роль кассира и две заготовки заводятся при первом обращении. Так же
// получают роль кассиры, заведённые до появления ролей: без неё они работали бы
// по правам «по умолчанию», и владелец не смог бы их поправить.

const isTaken = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

const MAX_NAME = 40
const MAX_DESC = 200

export type RoleView = {
  id: string
  name: string
  description: string
  system: string | null
  permissions: string[]
  people: number
}

@Injectable()
export class RolesService {
  private readonly log = new Logger('Roles')

  constructor(
    private admin: AdminDbService,
    private accounts: AccountCache,
    private events: EventsGateway,
    private prisma: PrismaService,
  ) {}

  // Системная роль кассира, заготовки и роль у кассиров прежней версии
  async ensure(pharmacyId: string) {
    const existing = await this.admin.role.findMany({ where: { pharmacyId }, select: { id: true, name: true, system: true } })
    let cashier = existing.find((r) => r.system === 'cashier') || null
    if (!cashier) {
      // Имя «Кассир» могла занять своя роль — тогда системная получает пометку
      const busy = existing.some((r) => r.name === SYSTEM_CASHIER.name)
      cashier = await this.admin.role.create({
        data: {
          pharmacyId,
          name: busy ? `${SYSTEM_CASHIER.name} (системная)` : SYSTEM_CASHIER.name,
          description: SYSTEM_CASHIER.description,
          system: 'cashier',
          permissions: CASHIER_DEFAULT,
        },
        select: { id: true, name: true, system: true },
      })
      this.log.log(`Системная роль кассира заведена для магазина ${pharmacyId}`)
    }
    if (existing.length === 0) {
      for (const p of ROLE_PRESETS) {
        await this.admin.role
          .create({ data: { pharmacyId, name: p.name, description: p.description, permissions: p.permissions } })
          .catch(() => {})
      }
    }
    const assigned = await this.admin.account.updateMany({
      where: { pharmacyId, role: 'cashier', roleId: null },
      data: { roleId: cashier.id },
    })
    if (assigned.count > 0) this.accounts.dropPharmacy(pharmacyId)
    return cashier
  }

  async list(pharmacyId: string): Promise<RoleView[]> {
    await this.ensure(pharmacyId)
    const [rows, owners] = await Promise.all([
      this.admin.role.findMany({
        where: { pharmacyId },
        orderBy: [{ system: 'desc' }, { createdAt: 'asc' }],
        include: { _count: { select: { accounts: true } } },
      }),
      this.admin.account.count({ where: { pharmacyId, role: 'founder' } }),
    ])
    return [
      { id: OWNER_ROLE.id, name: OWNER_ROLE.name, description: OWNER_ROLE.description, system: 'owner', permissions: ALL_PERMISSIONS, people: owners },
      ...rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        system: r.system,
        permissions: r.permissions.filter(isPermission),
        people: r._count.accounts,
      })),
    ]
  }

  // Роль магазина по id — для проверки при назначении сотруднику
  async find(pharmacyId: string, id: string) {
    return this.admin.role.findFirst({ where: { id, pharmacyId } })
  }

  async create(pharmacyId: string, dto: CreateRoleDto): Promise<RoleView> {
    const name = cleanName(dto.name)
    const permissions = cleanPermissions(dto.permissions)
    try {
      const r = await this.admin.role.create({
        data: { pharmacyId, name, description: cleanDesc(dto.description), permissions },
      })
      this.touched(pharmacyId)
      return { id: r.id, name: r.name, description: r.description, system: null, permissions: r.permissions, people: 0 }
    } catch (e) {
      if (isTaken(e)) throw new BadRequestException(`Роль «${name}» уже есть`)
      throw e
    }
  }

  async update(pharmacyId: string, id: string, dto: UpdateRoleDto): Promise<RoleView> {
    if (id === OWNER_ROLE.id) throw new BadRequestException('Права владельца изменить нельзя')
    const r = await this.find(pharmacyId, id)
    if (!r) throw new NotFoundException('Роль не найдена')
    const data: Prisma.RoleUpdateInput = {}
    if (dto.name !== undefined) {
      if (r.system) throw new BadRequestException('Системную роль нельзя переименовать')
      data.name = cleanName(dto.name)
    }
    if (dto.description !== undefined) data.description = cleanDesc(dto.description)
    if (dto.permissions !== undefined) data.permissions = cleanPermissions(dto.permissions)
    try {
      const u = await this.admin.role.update({ where: { id }, data, include: { _count: { select: { accounts: true } } } })
      // Когда правили поля роли: касса без связи могла править её же (sync/team.ts)
      await stamp(this.prisma as any, 'Role', id, Object.keys(data)).catch(() => {})
      this.touched(pharmacyId)
      return { id: u.id, name: u.name, description: u.description, system: u.system, permissions: u.permissions, people: u._count.accounts }
    } catch (e) {
      if (isTaken(e)) throw new BadRequestException(`Роль «${dto.name}» уже есть`)
      throw e
    }
  }

  async remove(pharmacyId: string, id: string) {
    if (id === OWNER_ROLE.id) throw new BadRequestException('Роль владельца удалить нельзя')
    const r = await this.admin.role.findFirst({ where: { id, pharmacyId }, include: { _count: { select: { accounts: true } } } })
    if (!r) throw new NotFoundException('Роль не найдена')
    if (r.system) throw new BadRequestException('Системную роль удалить нельзя')
    if (r._count.accounts > 0) {
      throw new BadRequestException(`На этой роли ${r._count.accounts} сотрудник(ов). Сначала переведите их на другую роль`)
    }
    await this.admin.role.delete({ where: { id } })
    await forgetStamps(this.prisma as any, 'Role', id).catch(() => {})
    this.touched(pharmacyId)
    return { ok: true }
  }

  // Права поменялись: кэш учётных записей сбрасывается, чтобы следующий же запрос
  // проверялся по новым правам, а открытые окна узнают об этом и перечитают «кто я»
  private touched(pharmacyId: string) {
    teamMemoForget(pharmacyId)
    this.accounts.dropPharmacy(pharmacyId)
    this.events.changed('roles', 'users')
  }
}

function cleanName(raw: unknown) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!name) throw new BadRequestException('Укажите название роли')
  if (name.length > MAX_NAME) throw new BadRequestException(`Название роли — не длиннее ${MAX_NAME} знаков`)
  if (name.toLowerCase() === OWNER_ROLE.name.toLowerCase()) throw new BadRequestException('Это имя занято ролью владельца')
  return name
}

function cleanDesc(raw: unknown) {
  return String(raw ?? '').trim().slice(0, MAX_DESC)
}

function cleanPermissions(raw: unknown) {
  if (!Array.isArray(raw)) throw new BadRequestException('Права должны быть списком')
  const unknown = raw.filter((k) => !isPermission(k))
  if (unknown.length) throw new BadRequestException(`Неизвестные права: ${unknown.slice(0, 3).join(', ')}`)
  return [...new Set(raw as string[])]
}
