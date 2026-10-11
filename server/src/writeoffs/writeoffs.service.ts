import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { consumeUnits, lockProducts, uppOf } from '../common/stock'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { CreateWriteOffDto } from './dto'

// ── Списание ──
// Просрочка, брак, порча, недостача. Уменьшает остаток (списывая партии с ближайшим
// сроком) и фиксирует убыток по себестоимости — чтобы было видно, сколько потеряно.

@Injectable()
export class WriteOffsService {
  constructor(private prisma: PrismaService) {}

  findAll(q: PeriodQuery = {}) {
    return this.prisma.writeOff.findMany({
      where: periodFilter(q, 180),
      include: { items: true, user: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  async create(dto: CreateWriteOffDto, userId?: string) {
    const { items, reason, note } = dto
    if (!items?.length) throw new BadRequestException('Укажите, что списываем')

    return this.prisma.$transaction(async (tx) => {
      let totalCost = D(0)
      const rows: any[] = []

      // Одновременная продажа того же товара не должна записать свой остаток
      // поверх нашего (см. lockProducts)
      await lockProducts(tx, items.map((i) => i.productId))

      for (const it of items) {
        const product = await tx.product.findUnique({ where: { id: it.productId } })
        if (!product) throw new BadRequestException('Товар не найден')
        const units = Math.max(0, Math.trunc(it.units || 0))
        if (units <= 0) continue

        // Списываем по партиям: первой уходит та, у которой срок ближе
        const taken = await consumeUnits(tx, product.id, units, product.name)
        const upp = uppOf(product)

        // Убыток считаем по закупочной цене из карточки товара — той самой, что
        // видна владельцу и используется во всех отчётах. Так одна и та же
        // единица товара везде оценивается одинаково: и в продаже, и в списании.
        for (const t of taken) {
          totalCost = totalCost.plus(D(product.cost).dividedBy(upp).times(t.units))
          rows.push({
            productId: product.id,
            name: product.name,
            units: t.units,
            cost: product.cost,
            expiryDate: t.expiryDate, // срок берём у партии — он для истории
          })
        }
      }

      if (!rows.length) throw new BadRequestException('Укажите количество для списания')

      return tx.writeOff.create({
        data: {
          userId: userId ?? null,
          reason: reason || 'expired',
          note: note || '',
          source: 'manual',
          totalCost,
          items: { create: rows },
        },
        include: { items: true, user: { select: { id: true, name: true } } },
      })
    }, TX)
  }
}
