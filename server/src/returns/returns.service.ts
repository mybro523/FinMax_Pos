import { BadRequestException, Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { addUnits, enteredExpiry, lockProducts, returnExpiry, uppOf } from '../common/stock'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { CreateReturnDto } from './dto'
import { WEB_SHIFT } from '../shifts/shifts.service'

// ── Возврат товара ──
// Оформляется на кассе по чеку. По каждой позиции кассир указывает, вернуть товар
// в продажу или сразу списать (вскрытая упаковка). Деньги возвращаются тем же
// способом, каким платили: наличные/карта — из кассы, долг — уменьшением долга.

@Injectable()
export class ReturnsService {
  constructor(private prisma: PrismaService) {}

  findAll(q: PeriodQuery = {}) {
    return this.prisma.saleReturn.findMany({
      where: periodFilter(q, 180),
      include: { items: true, user: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  async create(dto: CreateReturnDto, userId?: string) {
    const { saleId, items, note, clientId } = dto
    if (!items?.length) throw new BadRequestException('Укажите, что возвращают')

    if (clientId) {
      const already = await this.prisma.saleReturn.findUnique({
        where: { clientId },
        include: { items: true, user: { select: { id: true, name: true } } },
      })
      if (already) return already
    }

    return this.prisma
      .$transaction(async (tx) => {
        // Замок на товары — первым делом, ещё до чтения чека. Возврат кладёт товар на
        // полку, и одновременная продажа не должна записать свой остаток поверх. А два
        // возврата одной позиции, пришедшие разом, обязаны идти по очереди: второй
        // должен увидеть первый, иначе оба решат, что «возвращено ноль»
        await lockProducts(tx, items.map((i) => i.productId))

        const sale = saleId
          ? await tx.sale.findUnique({ where: { id: saleId }, include: { items: true, returns: { include: { items: true } } } })
          : null
        if (saleId && !sale) throw new BadRequestException('Чек не найден')

        // Сколько уже возвращали по этому чеку — нельзя вернуть больше, чем покупали
        const returnedBefore = new Map<string, number>()
        for (const r of sale?.returns || []) {
          for (const ri of r.items) {
            if (!ri.productId) continue
            returnedBefore.set(ri.productId, (returnedBefore.get(ri.productId) || 0) + ri.units)
          }
        }

        let total = D(0)
        const returnItems: any[] = []
        const toWriteOff: any[] = []

        for (const it of items) {
          // Вместе с товаром — сроки всех его партий, и распроданных тоже: по ним
          // выбирается срок возвращённого (см. returnExpiry)
          const product = await tx.product.findUnique({ where: { id: it.productId }, include: { batches: { select: { expiryDate: true } } } })
          if (!product) throw new BadRequestException('Товар не найден')
          const units = Math.max(0, Math.trunc(it.units || 0))
          if (units <= 0) continue
          const restock = it.restock !== false
          // Срок годности возвращённого: вписанный кассиром с упаковки, а если он его
          // не вписал — самый ранний из тех, с какими товар продавался в день покупки
          const expiry = enteredExpiry(it.expiryDate, restock) ?? returnExpiry(product.batches, sale?.date ?? new Date(), product.expiryDate)

          const line = sale?.items.find((si) => si.productId === it.productId)
          if (sale && !line) throw new BadRequestException(`«${product.name}» нет в этом чеке`)

          if (line) {
            const upp = Math.max(1, line.unitsPerPack || 1)
            const sold = line.qty * upp + line.pieces
            const already = returnedBefore.get(it.productId) || 0
            if (already + units > sold) {
              throw new BadRequestException(`По «${product.name}» уже возвращено ${already} из ${sold} шт`)
            }
          }

          // Возвращаем деньги пропорционально тому, сколько реально заплатили за штуку
          // (с учётом скидки на позицию) — иначе при скидке касса не сошлась бы.
          const upp = line ? Math.max(1, line.unitsPerPack || 1) : uppOf(product)
          const price = line ? D(line.price) : D(product.price)
          const cost = line ? D(line.cost) : D(product.cost)
          const soldUnits = line ? line.qty * upp + line.pieces : units
          const gross = price.dividedBy(upp).times(soldUnits)
          const paid = line ? gross.minus(D(line.discount)) : gross
          const perUnit = soldUnits > 0 ? paid.dividedBy(soldUnits) : D(0)
          const amount = perUnit.times(units)
          total = total.plus(amount)

          returnItems.push({
            productId: product.id,
            name: product.name,
            units,
            unitsPerPack: upp,
            price,
            cost,
            amount,
            restock,
          })

          if (restock) {
            // Обратно в продажу — партией со своим сроком
            await addUnits(tx, product.id, units, cost, expiry, null, 'Возврат от покупателя')
          } else {
            toWriteOff.push({
              productId: product.id,
              name: product.name,
              units,
              cost,
              expiryDate: expiry,
              _upp: upp, // нужно только для подсчёта убытка, в базу не пишем
            })
          }
        }

        if (!returnItems.length) throw new BadRequestException('Укажите количество для возврата')

        const openShift = await tx.shift.findFirst({ where: WEB_SHIFT, select: { id: true } })
        const refund = dto.refund || sale?.payment || 'cash'
        // Деньги вернули переводом: сервис — названный кассиром, а если не назвал, тот,
        // каким платили по чеку
        const refundVia = refund === 'transfer' ? (dto.refundVia || '').trim() || sale?.payVia || null : null

        // Возврат «в долг» уменьшает долг клиента, а не выдаёт наличные.
        // Списать больше текущего долга нельзя: клиент ушёл бы в минус и числился бы
        // «должным» аптеке отрицательную сумму. Так бывает, когда долг уже погасили,
        // а товар принесли позже — в этом случае деньги отдают из кассы.
        if (refund === 'debt') {
          const customerId = sale?.customerId
          if (!customerId) {
            throw new BadRequestException('Возврат в долг возможен только по чеку, оформленному на клиента')
          }
          const c = await tx.customer.findUnique({ where: { id: customerId }, select: { debt: true } })
          const debt = D(c?.debt ?? 0)
          if (debt.lt(total)) {
            throw new BadRequestException(
              `Долг клиента ${debt.toFixed(2)} меньше суммы возврата ${total.toFixed(2)} — верните деньги наличными или картой`,
            )
          }
          // Условный декремент: если долг успели изменить параллельно — count=0
          const r = await tx.customer.updateMany({
            where: { id: customerId, debt: { gte: total } },
            data: { debt: { decrement: total } },
          })
          if (r.count !== 1) throw new BadRequestException('Долг клиента изменился, обновите данные и повторите')
        }

        // Невозвратные в продажу позиции сразу оформляем списанием — для учёта убытка
        if (toWriteOff.length) {
          // Убыток = себестоимость штуки (цена упаковки / штук в упаковке) × число штук
          const totalCost = toWriteOff.reduce(
            (s, w) => s.plus(D(w.cost).dividedBy(Math.max(1, w._upp)).times(w.units)),
            D(0),
          )
          await tx.writeOff.create({
            data: {
              userId: userId ?? null,
              reason: 'damaged',
              source: 'return',
              note: 'Возврат покупателя без возврата в продажу',
              totalCost,
              items: { create: toWriteOff.map(({ _upp, ...rest }) => rest) },
            },
          })
        }

        return tx.saleReturn.create({
          data: {
            clientId: clientId ?? null,
            saleId: saleId ?? null,
            userId: userId ?? null,
            shiftId: openShift?.id ?? null,
            refund,
            refundVia,
            total,
            note: note || '',
            items: { create: returnItems },
          },
          include: { items: true, user: { select: { id: true, name: true } } },
        })
      }, TX)
      .catch(async (e: any) => {
        if (clientId && e?.code === 'P2002') {
          const existing = await this.prisma.saleReturn.findUnique({
            where: { clientId },
            include: { items: true, user: { select: { id: true, name: true } } },
          })
          if (existing) return existing
        }
        throw e
      })
  }
}
