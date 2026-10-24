import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { setSupplierCash } from '../shifts/totals'
import { lockShift, openShiftFor } from '../shifts/till'
import { changedFields, forgetStamps, stamp } from '../common/stamps'
import { CreateSupplierDto, PaySupplierDto, UpdateSupplierDto } from './dto'

// ── Поставщики и долги перед ними ──
// Магазин берёт товар у дистрибьюторов в долг. Приход записывался, а кому и сколько
// магазин должен — нигде, и владелец считал это на бумажке. Теперь долг ведётся у
// поставщика готовой суммой: начальный + неоплаченная часть приходов − оплаты.
//
// Оплата поставщику — это не расход: товар уже учтён при продаже по закупочной цене,
// и вычесть его из прибыли ещё раз значило бы посчитать дважды. Но если деньги взяты
// из ящика кассы, смена обязана это знать — иначе при закрытии она не сойдётся.
// Такая оплата привязана к открытой смене и живёт по её правилам: отменить её можно,
// пока смена открыта.

const withUser = { user: { select: { id: true, name: true } } }
export const SUPPLIER_EXISTS = 'Поставщик с таким названием уже есть'
export const PAYMENT_SHIFT_CLOSED = 'Смена этой оплаты уже закрыта: она вошла в её отчёт и больше не меняется.'
// Тексты отказа в удалении — те же у кассы без связи
export const SUPPLIER_HAS_DEBT = 'У поставщика есть долг — сначала закройте его'
export const SUPPLIER_HAS_PAYMENTS = 'По поставщику есть история оплат — удалить нельзя'

type Tx = Prisma.TransactionClient

// Кассиру поставщики нужны ради прихода — без долгов: деньги магазина не его дело
export const supplierBrief = (s: { id: string; name: string; phone: string; note: string; createdAt: Date }) => ({
  id: s.id,
  name: s.name,
  phone: s.phone,
  note: s.note,
  createdAt: s.createdAt,
})

// Поставщик под замок: долг меняют приход, оплата и правка прихода, и два из них,
// пришедшие разом, должны идти по очереди
export async function lockSupplier(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string; name: string; debt: Prisma.Decimal }[]>`
    SELECT "id", "name", "debt" FROM "Supplier" WHERE "id" = ${id} FOR UPDATE`
  return rows[0] ? { ...rows[0], debt: D(rows[0].debt) } : null
}

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  async findAll(founder: boolean) {
    const list = await this.prisma.supplier.findMany({ orderBy: { name: 'asc' } })
    return founder ? list : list.map(supplierBrief)
  }

  // Карточка поставщика: долг и откуда он взялся — приходы в долг и оплаты
  async findOne(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } })
    if (!supplier) throw new NotFoundException('Поставщик не найден')
    const [arrivals, payments] = await Promise.all([
      this.prisma.arrival.findMany({
        where: { supplierId: id },
        select: { id: true, date: true, total: true, debt: true, user: { select: { id: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { date: 'desc' },
        take: 500,
      }),
      this.prisma.supplierPayment.findMany({ where: { supplierId: id }, include: withUser, orderBy: { date: 'desc' }, take: 500 }),
    ])
    return {
      ...supplier,
      arrivals: arrivals.map((a) => ({ id: a.id, date: a.date, total: a.total, debt: a.debt, user: a.user, lines: a._count.items })),
      payments,
    }
  }

  async create(dto: CreateSupplierDto, founder: boolean) {
    const name = dto.name.trim()
    if (!name) throw new BadRequestException('Укажите название поставщика')
    const openingDebt = founder ? D(dto.openingDebt || 0).toDecimalPlaces(2) : D(0)
    try {
      return await this.prisma.supplier.create({
        data: { name, phone: (dto.phone || '').trim(), note: (dto.note || '').trim(), openingDebt, debt: openingDebt },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException(SUPPLIER_EXISTS)
      throw e
    }
  }

  async update(id: string, dto: UpdateSupplierDto) {
    const data: Prisma.SupplierUpdateInput = {}
    if (dto.name !== undefined) {
      const name = dto.name.trim()
      if (!name) throw new BadRequestException('Укажите название поставщика')
      data.name = name
    }
    if (dto.phone !== undefined) data.phone = dto.phone.trim()
    if (dto.note !== undefined) data.note = dto.note.trim()
    try {
      return await this.prisma.$transaction(async (tx) => {
        const was = await tx.supplier.findUnique({ where: { id } })
        const updated = await tx.supplier.update({ where: { id }, data })
        // Когда правили: касса без связи сверит по этому свою правку (common/stamps.ts)
        if (was) await stamp(tx, 'Supplier', id, changedFields(was, data as any, ['name', 'phone', 'note']))
        return updated
      }, TX)
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException(SUPPLIER_EXISTS)
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Поставщик не найден')
      throw e
    }
  }

  // История денег не стирается по кнопке: убрать можно только поставщика без долга и
  // без оплат. Его приходы остаются — просто без ссылки на поставщика
  async remove(id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id }, include: { _count: { select: { payments: true } } } })
    if (!s) throw new NotFoundException('Поставщик не найден')
    if (!D(s.debt).isZero()) throw new BadRequestException(SUPPLIER_HAS_DEBT)
    if (s._count.payments > 0) throw new BadRequestException(SUPPLIER_HAS_PAYMENTS)
    await this.prisma.$transaction(async (tx) => {
      await tx.supplier.delete({ where: { id } })
      await forgetStamps(tx, 'Supplier', id)
    }, TX)
    return { ok: true }
  }

  // ── Оплата поставщику ──
  // ── Кому сколько должны ──
  // Сводка для раздела «Долги поставщикам»: сумма долгов, число должников и
  // сколько приходов оформлено в долг — всего и по каждому. Счётчик приходов
  // исторический: погашение долга его не уменьшает, как и сумма самого прихода
  async debts() {
    const sups = await this.prisma.supplier.findMany({ orderBy: [{ debt: 'desc' }, { name: 'asc' }] })
    const counts = await this.prisma.arrival.groupBy({
      by: ['supplierId'],
      where: { debt: { gt: 0 }, supplierId: { not: null } },
      _count: { _all: true },
    })
    const poId = new Map(counts.map((c) => [c.supplierId as string, c._count._all]))
    const dolzhny = sups.filter((s) => D(s.debt).gt(0))
    return {
      total: dolzhny.reduce((a, s) => a.plus(s.debt), D(0)),
      arrivals: counts.reduce((a, c) => a + c._count._all, 0),
      suppliers: dolzhny.map((s) => ({ id: s.id, name: s.name, debt: s.debt, arrivals: poId.get(s.id) || 0 })),
    }
  }

  async pay(id: string, dto: PaySupplierDto, userId?: string) {
    const { clientId } = dto
    if (clientId) {
      const already = await this.prisma.supplierPayment.findUnique({ where: { clientId }, include: withUser })
      if (already) return already
    }
    const fromCash = dto.fromCash === true
    return this.prisma
      .$transaction(async (tx) => {
        // Смена — первой (её замок берут и закрытие, и расход), поставщик — следом
        const shiftId = fromCash ? await openShiftFor(tx, dto.shiftId) : null
        const supplier = await lockSupplier(tx, id)
        if (!supplier) throw new NotFoundException('Поставщик не найден')
        const amount = D(dto.amount).toDecimalPlaces(2)
        // Переплаты не бывает: магазин платит долг, а не вперёд. Иначе долг ушёл бы в
        // минус и числился бы «поставщик должен магазину»
        if (amount.gt(supplier.debt)) {
          throw new BadRequestException(`Сумма больше долга поставщика (${supplier.debt.toFixed(2)})`)
        }
        const payment = await tx.supplierPayment.create({
          data: { clientId: clientId ?? null, supplierId: id, amount, note: (dto.note || '').trim(), fromCash, shiftId, userId: userId ?? null },
          include: withUser,
        })
        await tx.supplier.update({ where: { id }, data: { debt: { decrement: amount } } })
        if (shiftId) await setSupplierCash(tx, shiftId)
        return payment
      }, TX)
      .catch(async (e: any) => {
        if (clientId && e?.code === 'P2002') {
          const existing = await this.prisma.supplierPayment.findUnique({ where: { clientId }, include: withUser })
          if (existing) return existing
        }
        throw e
      })
  }

  // Оплату внесли по ошибке — отменить. Из кассы — только пока смена открыта:
  // закрытая смена уже посчитана с этими деньгами
  async removePayment(id: string) {
    await this.prisma.$transaction(async (tx) => {
      if (!(await removePaymentIn(tx, id))) throw new NotFoundException('Оплата не найдена')
    }, TX)
    return { ok: true }
  }

  listPayments(q: PeriodQuery = {}) {
    return this.prisma.supplierPayment.findMany({
      where: periodFilter(q, 180),
      include: { ...withUser, supplier: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }
}

// ── Отменить оплату поставщику ──
// Общая часть для сайта и для отмены, сделанной на кассе без связи (sync). Оплаты уже
// нет — false. Из кассы — только пока смена открыта: закрытая уже посчитана с этими деньгами
export async function removePaymentIn(tx: Tx, id: string): Promise<boolean> {
  const payment = await tx.supplierPayment.findUnique({ where: { id } })
  if (!payment) return false
  if (payment.fromCash && payment.shiftId) {
    const shift = await lockShift(tx, payment.shiftId)
    if (shift?.closedAt) throw new BadRequestException(PAYMENT_SHIFT_CLOSED)
  }
  const supplier = await lockSupplier(tx, payment.supplierId)
  await tx.supplierPayment.delete({ where: { id } })
  if (supplier) await tx.supplier.update({ where: { id: supplier.id }, data: { debt: { increment: payment.amount } } })
  if (payment.fromCash && payment.shiftId) await setSupplierCash(tx, payment.shiftId)
  return true
}
