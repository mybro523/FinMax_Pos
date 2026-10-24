import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { addUnits, consumeUnits, lockProducts, uppOf } from '../common/stock'
import { openShiftFor } from '../shifts/till'
import { setSupplierRefund } from '../shifts/totals'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { lockSupplier } from '../suppliers/suppliers.service'
import { CreateSupplierReturnDto } from './dto'

type Tx = Prisma.TransactionClient

export const NO_TILL_FOR_REFUND = 'Нет открытой смены — положить деньги в кассу некуда.'
export const CLOSED_SHIFT_REFUND = 'Смена этого возврата уже закрыта: деньги вошли в её отчёт. Удалить возврат нельзя.'

// Партии, из которых ушёл товар, — снимком в строке возврата: удалили возврат —
// товар вернётся в такие же партии, со своими сроками и ценами
export const batchesOf = (taken: { units: number; cost: Prisma.Decimal; expiryDate: Date | null }[]) =>
  taken.map((t) => ({ units: t.units, cost: t.cost.toString(), expiryDate: t.expiryDate ? t.expiryDate.toISOString() : null }))

const include = { items: true, user: { select: { id: true, name: true } } } as const

// ── Возврат товара поставщику ──
// Товар уходит со склада из партий с ближайшим сроком — просроченный тоже: его чаще
// всего и отдают назад. Деньги поставщик возвращает одним из способов: в счёт долга
// (долг уменьшается — не больше, чем он есть), в кассу (наличные в ящик открытой
// смены — видно в её отчёте), наличными мимо кассы, на карту.
//
// Закупочная цена в карточке не меняется — как при списании и продаже: уходят штуки,
// средняя цена оставшегося считается той же.
@Injectable()
export class SupplierReturnsService {
  constructor(private prisma: PrismaService) {}

  findAll(q: PeriodQuery = {}) {
    return this.prisma.supplierReturn.findMany({ where: periodFilter(q, 180), include, orderBy: { date: 'desc' }, take: MAX_ROWS })
  }

  async create(dto: CreateSupplierReturnDto, userId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(dto.items.map((i) => i.productId))]
      // Замок на товары — в едином порядке, как у прихода и продажи: одновременная
      // продажа того же товара не запишет свой остаток поверх нашего
      await lockProducts(tx, ids)
      const products = await tx.product.findMany({ where: { id: { in: ids } } })
      const byId = new Map(products.map((p) => [p.id, p]))

      let total = D(0)
      const lines = dto.items.map((it) => {
        const p = byId.get(it.productId)
        if (!p) throw new BadRequestException('Товар не найден')
        const upp = uppOf(p)
        const pieces = Math.max(0, Math.trunc(it.pieces || 0))
        const units = it.qty * upp + pieces
        if (units <= 0) throw new BadRequestException(`Укажите количество: ${p.name}`)
        total = total.plus(D(it.price).times(D(units).div(upp)))
        return { p, units, qty: it.qty, pieces, price: D(it.price).toDecimalPlaces(2) }
      })
      total = total.toDecimalPlaces(2)

      // Поставщик — после товаров, в том же порядке замков, что у прихода
      const sup = await lockSupplier(tx, dto.supplierId)
      if (!sup) throw new BadRequestException('Поставщик не найден')
      if (dto.refund === 'debt') {
        if (D(sup.debt).plus(D('0.005')).lt(total)) {
          throw new BadRequestException(`Долг поставщику (${D(sup.debt).toFixed(2)}) меньше суммы возврата (${total.toFixed(2)}) — выберите, как поставщик вернул деньги`)
        }
        await tx.supplier.update({ where: { id: sup.id }, data: { debt: { decrement: total } } })
      }
      const shiftId = dto.refund === 'cash' ? await openShiftFor(tx, dto.shiftId, NO_TILL_FOR_REFUND) : null

      // Первой уходит партия с ближайшим сроком — в том числе просроченная
      const items: Prisma.SupplierReturnItemUncheckedCreateWithoutRetInput[] = []
      for (const l of lines) {
        const taken = await consumeUnits(tx, l.p.id, l.units, l.p.name)
        items.push({ productId: l.p.id, name: l.p.name, qty: l.qty, pieces: l.pieces, price: l.price, cost: l.p.cost, batches: batchesOf(taken) })
      }

      const ret = await tx.supplierReturn.create({
        data: {
          supplierId: sup.id,
          supplier: sup.name,
          total,
          refund: dto.refund,
          shiftId,
          note: (dto.note || '').trim(),
          userId: userId ?? null,
          items: { create: items },
        },
        include,
      })
      if (shiftId) await setSupplierRefund(tx, shiftId)
      return ret
    }, TX)
  }

  // ── Удалить возврат (владелец) ──
  // Товар возвращается в те же партии, долг поставщику — назад, деньги в кассе — назад.
  // Деньги, положенные в кассу уже закрытой смены, вошли в её отчёт: такой возврат не
  // удаляется (то же правило, что у оплаты поставщику из кассы)
  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await removeSupplierReturnIn(tx, id))) throw new NotFoundException('Возврат не найден')
      return { ok: true }
    }, TX)
  }
}

// ── Удалить возврат поставщику ──
// Общая часть для сайта и для удаления, сделанного на кассе без связи (sync). Возврата
// уже нет — false
export async function removeSupplierReturnIn(tx: Tx, id: string): Promise<boolean> {
  const ret = await tx.supplierReturn.findUnique({ where: { id }, include: { items: true } })
  if (!ret) return false
  // Замки — в том же порядке, что у продажи: товары, затем смена, затем поставщик. В
  // обратном порядке удаление и продажа того же товара в ту же смену заперли бы друг друга
  await lockProducts(tx, ret.items.map((i) => i.productId))
  if (ret.refund === 'cash' && ret.shiftId) {
    // Под замком, как у оплат: закрытие, идущее в ту же секунду, ждёт нас
    const rows = await tx.$queryRaw<{ closedAt: Date | null }[]>`SELECT "closedAt" FROM "Shift" WHERE "id" = ${ret.shiftId} FOR UPDATE`
    if (rows[0]?.closedAt) throw new BadRequestException(CLOSED_SHIFT_REFUND)
  }
  await restoreItems(tx, ret.items)
  if (ret.refund === 'debt' && ret.supplierId && (await lockSupplier(tx, ret.supplierId))) {
    await tx.supplier.update({ where: { id: ret.supplierId }, data: { debt: { increment: ret.total } } })
  }
  await tx.supplierReturn.delete({ where: { id } }) // строки уходят каскадом
  if (ret.refund === 'cash' && ret.shiftId) await setSupplierRefund(tx, ret.shiftId)
  return true
}

// Вернуть товар возврата на склад — в те же партии. Товар удалили из справочника —
// возвращать некуда. Партий в строке нет (возврат с кассы прежней версии) — одной
// партией без срока по закупочной цене
export async function restoreItems(
  tx: Tx,
  items: { productId: string | null; qty: number; pieces: number; cost: Prisma.Decimal; batches: Prisma.JsonValue | null }[],
) {
  const ids = [...new Set(items.map((i) => i.productId).filter(Boolean) as string[])]
  await lockProducts(tx, ids)
  const alive = new Set((await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((p) => p.id))
  for (const it of items) {
    if (!it.productId || !alive.has(it.productId)) continue
    const parts = Array.isArray(it.batches) ? (it.batches as any[]) : []
    if (parts.length) {
      for (const b of parts) {
        const units = Math.max(0, Math.trunc(Number(b?.units) || 0))
        await addUnits(tx, it.productId, units, D(b?.cost ?? it.cost), b?.expiryDate ? new Date(b.expiryDate) : null, null, 'возврат поставщику отменён')
      }
    } else {
      const p = await tx.product.findUnique({ where: { id: it.productId } })
      const units = it.qty * uppOf(p || {}) + (it.pieces || 0)
      await addUnits(tx, it.productId, units, it.cost, null, null, 'возврат поставщику отменён')
    }
  }
}
