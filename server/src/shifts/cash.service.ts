import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { setCashMoves } from './totals'
import { cashSources, lockShift, NO_OPEN_SHIFT_CASH, openShiftFor, SHIFT_CLOSED_CASH } from './till'
import { CashMoveDto } from './dto'
import { hasPerm } from '../auth/permissions'

// ── Внесение и изъятие наличных ──
// Кассир положил в ящик размен, владелец забрал выручку днём. Это не продажа и не
// расход — деньги просто вошли в ящик или вышли из него. Без записи смена при
// закрытии не сходилась ровно на эту сумму, а оформлять «расходом» было неверно:
// расход уменьшает чистую прибыль, а забранная выручка — нет.
//
// Операция живёт в открытой смене: внести или изъять можно только при открытой
// смене, а отменить — пока она открыта. Закрыли — операция в её отчёте.

const withUser = { user: { select: { id: true, name: true } } }

@Injectable()
export class CashService {
  constructor(private prisma: PrismaService) {}

  list(q: PeriodQuery = {}) {
    return this.prisma.cashMove.findMany({ where: periodFilter(q, 180), include: withUser, orderBy: { date: 'desc' }, take: MAX_ROWS })
  }

  // Из каких ящиков можно брать деньги: владельцу — все открытые смены, кассиру —
  // смена сайта
  sources(founder: boolean) {
    return cashSources(this.prisma, founder)
  }

  async create(dto: CashMoveDto, user: { tenantUserId?: string | null; role?: string } | undefined) {
    const { clientId } = dto
    if (clientId) {
      const already = await this.prisma.cashMove.findUnique({ where: { clientId }, include: withUser })
      if (already) return already
    }
    const founder = hasPerm(user, 'shift.others')
    const amount = D(dto.amount).toDecimalPlaces(2)
    if (amount.lte(0)) throw new BadRequestException('Укажите сумму')
    return this.prisma
      .$transaction(async (tx) => {
        // Кассир работает только со сменой сайта: ящик кассы с программой не его
        const shiftId = await openShiftFor(tx, founder ? dto.shiftId : undefined, NO_OPEN_SHIFT_CASH)
        const move = await tx.cashMove.create({
          data: { clientId: clientId ?? null, shiftId, kind: dto.kind, amount, note: (dto.note || '').trim(), userId: user?.tenantUserId ?? null },
          include: withUser,
        })
        await setCashMoves(tx, shiftId)
        return move
      }, TX)
      .catch(async (e: any) => {
        if (clientId && e?.code === 'P2002') {
          const existing = await this.prisma.cashMove.findUnique({ where: { clientId }, include: withUser })
          if (existing) return existing
        }
        throw e
      })
  }

  async remove(id: string) {
    await this.prisma.$transaction(async (tx) => {
      if (!(await removeCashMoveIn(tx, id))) throw new NotFoundException('Операция не найдена')
    }, TX)
    return { ok: true }
  }
}

// ── Отменить внесение или изъятие ──
// Общая часть для сайта и для отмены на кассе без связи (sync). Записи уже нет — false
export async function removeCashMoveIn(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const move = await tx.cashMove.findUnique({ where: { id } })
  if (!move) return false
  const shift = await lockShift(tx, move.shiftId)
  if (shift?.closedAt) throw new BadRequestException(SHIFT_CLOSED_CASH)
  await tx.cashMove.delete({ where: { id } })
  await setCashMoves(tx, move.shiftId)
  return true
}
