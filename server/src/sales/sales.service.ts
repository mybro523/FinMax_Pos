import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { consumeUnits, lockProducts } from '../common/stock'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { CheckoutDto } from './dto'
import { WEB_SHIFT } from '../shifts/shifts.service'

@Injectable()
export class SalesService {
  constructor(private prisma: PrismaService) {}

  // История продаж. Без параметров касса берёт только свежие продажи (быстрый опрос),
  // а отчёты запрашивают конкретный период — и получают ВСЕ продажи за него,
  // без прежнего «потолка» в 1000 записей, из-за которого старые чеки пропадали.
  findAll(q: PeriodQuery = {}) {
    return this.prisma.sale.findMany({
      where: periodFilter(q, 60),
      include: { items: true, customer: true, user: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  private readonly saleInclude = {
    items: true,
    customer: true,
    user: { select: { id: true, name: true } },
  }

  async checkout(dto: CheckoutDto, userId?: string) {
    const { items, payment, customerId, clientId } = dto
    if (payment === 'debt' && !customerId) {
      throw new BadRequestException('Для продажи в долг укажите клиента')
    }
    // Перевод без сервиса не сверить с выпиской — а ради сверки сервис и спрашивают
    const payVia = payment === 'transfer' ? (dto.payVia || '').trim() : ''
    if (payment === 'transfer' && !payVia) throw new BadRequestException('Укажите сервис перевода')

    // Касса могла повторить запрос из-за обрыва связи, хотя чек уже записан.
    // Возвращаем существующую продажу, чтобы не списать товар и деньги дважды.
    if (clientId) {
      const already = await this.prisma.sale.findUnique({
        where: { clientId },
        include: this.saleInclude,
      })
      if (already) return already
    }

    // Нормализуем позиции: qty — упаковки, pieces — штуки из вскрытой упаковки
    const lines = items.map((it) => ({
      productId: it.productId,
      qty: Math.max(0, Math.trunc(it.qty || 0)),
      pieces: Math.max(0, Math.trunc(it.pieces || 0)),
      discount: it.discount || 0,
    }))
    for (const l of lines) {
      if (l.qty + l.pieces <= 0) throw new BadRequestException('Укажите количество (упаковки или штуки)')
    }

    return this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(lines.map((l) => l.productId))]

      // Блокируем строки товаров (единый порядок по id) — защита от гонок/перепродажи.
      // Замок общий со всеми, кто двигает остаток (см. lockProducts): он не заставляет
      // ждать тех, кто на товар только ссылается. С прежним «полным» замком продажа и
      // создание листа пересчёта по тем же товарам могли запереть друг друга
      await lockProducts(tx, ids)

      const products = await tx.product.findMany({ where: { id: { in: ids } } })
      const byId = new Map(products.map((p) => [p.id, p]))
      for (const l of lines) {
        if (!byId.has(l.productId)) throw new BadRequestException('Товар не найден')
      }

      // Суммарное число ШТУК по каждому товару (упаковки переводим в штуки)
      const unitsById = new Map<string, number>()
      for (const l of lines) {
        const p = byId.get(l.productId)!
        const upp = Math.max(1, p.unitsPerPack || 1)
        unitsById.set(l.productId, (unitsById.get(l.productId) || 0) + l.qty * upp + l.pieces)
      }

      // Позиции чека + суммы. Цена за штуку = цена упаковки / штук в упаковке.
      let total = D(0)
      let cost = D(0)
      const saleItems = lines.map((l) => {
        const p = byId.get(l.productId)!
        const upp = Math.max(1, p.unitsPerPack || 1)
        const units = l.qty * upp + l.pieces
        const unitPrice = D(p.price).dividedBy(upp)
        const unitCost = D(p.cost).dividedBy(upp)
        const gross = unitPrice.times(units)
        const discount = Prisma.Decimal.min(Prisma.Decimal.max(0, D(l.discount)), gross)
        total = total.plus(gross.minus(discount))
        cost = cost.plus(unitCost.times(units))
        return {
          productId: p.id,
          name: p.name,
          qty: l.qty,
          pieces: l.pieces,
          unitsPerPack: upp,
          price: p.price,
          cost: p.cost,
          discount,
        }
      })

      // Списываем по партиям: первой уходит ГОДНАЯ партия с ближайшим сроком (FEFO),
      // поэтому просрочка не залёживается, а кассиру ничего выбирать не нужно.
      // Просроченные партии продажа не трогает: раньше они уходили покупателю
      // первыми — именно у них срок ближе всех.
      for (const [pid, unitsNeeded] of unitsById) {
        const p = byId.get(pid)!
        await consumeUnits(tx, pid, unitsNeeded, p.name, { skipExpired: true })
      }

      // Долг клиента — атомарный инкремент на точной Decimal-колонке
      if (payment === 'debt' && customerId) {
        const c = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } })
        if (!c) throw new NotFoundException('Клиент не найден')
        await tx.customer.update({ where: { id: customerId }, data: { debt: { increment: total } } })
      }

      // Привязка чека к открытой смене (для Z-отчёта). Смена — та, что открыта на
      // сайте: у касс, работающих без интернета, свои смены и свои чеки
      const openShift = await tx.shift.findFirst({ where: WEB_SHIFT, select: { id: true } })

      return tx.sale.create({
        data: {
          clientId: clientId ?? null,
          total,
          cost,
          profit: total.minus(cost),
          payment,
          payVia: payVia || null,
          customerId: payment === 'debt' ? customerId : null,
          shiftId: openShift?.id ?? null,
          userId: userId ?? null,
          items: { create: saleItems },
        },
        include: this.saleInclude,
      })
    }, TX).catch(async (e) => {
      // Два повтора пришли одновременно: один успел создать чек — отдаём его,
      // вместо ошибки о нарушении уникальности
      if (clientId && e?.code === 'P2002') {
        const existing = await this.prisma.sale.findUnique({ where: { clientId }, include: this.saleInclude })
        if (existing) return existing
      }
      throw e
    })
  }
}
