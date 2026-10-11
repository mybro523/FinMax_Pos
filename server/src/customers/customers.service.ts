import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { CreateCustomerDto } from './dto'
import { WEB_SHIFT } from '../shifts/shifts.service'

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.customer.findMany({ orderBy: { createdAt: 'desc' } })
  }

  // Журнал погашений долга (для сверки смены и аудита), новые сверху
  listPayments(q: PeriodQuery = {}) {
    return this.prisma.debtPayment.findMany({
      where: periodFilter(q, 180, 'createdAt'),
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { customer: { select: { name: true } } },
    })
  }

  create(dto: CreateCustomerDto) {
    const debt = Prisma.Decimal.max(0, D(dto.debt || 0))
    return this.prisma.customer.create({
      data: { name: dto.name, phone: dto.phone || '', debt },
    })
  }

  async remove(id: string) {
    await this.ensure(id)
    await this.prisma.customer.delete({ where: { id } })
    return { ok: true }
  }

  // Погашение долга — атомарно, с журналом и защитой от ухода в минус
  async payDebt(id: string, amount: number) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.customer.findUnique({ where: { id } })
      if (!c) throw new NotFoundException('Клиент не найден')

      // Гасим не больше текущего долга (переплата не уходит в минус)
      const pay = Prisma.Decimal.min(D(amount), D(c.debt))
      if (pay.lte(0)) return c

      // Условный декремент: если долг успели уменьшить в другой операции — count=0
      const r = await tx.customer.updateMany({
        where: { id, debt: { gte: pay } },
        data: { debt: { decrement: pay } },
      })
      if (r.count !== 1) throw new BadRequestException('Долг изменился, обновите данные и повторите')

      const openShift = await tx.shift.findFirst({ where: WEB_SHIFT, select: { id: true } })
      await tx.debtPayment.create({ data: { customerId: id, amount: pay, shiftId: openShift?.id ?? null } })

      return tx.customer.findUnique({ where: { id } })
    }, TX)
  }

  private async ensure(id: string) {
    const c = await this.prisma.customer.findUnique({ where: { id } })
    if (!c) throw new NotFoundException('Клиент не найден')
    return c
  }
}
