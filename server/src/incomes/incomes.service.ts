import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { dayKeyTj, storableDate } from '../common/time'
import { changedFields, forgetStamps, stamp } from '../common/stamps'
import { CreateIncomeCategoryDto, CreateIncomeDto, UpdateIncomeDto } from './dto'

// ── Доходы вне продаж ──
// Деньги, которые магазин получает не за проданный товар: сдал часть помещения,
// оказал услугу, получил бонус от поставщика. Отчёт ОПУ прибавляет их к чистому
// доходу. В денежный ящик смены доход не попадает: наличные, положенные в ящик,
// вносятся в смене «Внесением». Поэтому доход правится и удаляется когда угодно,
// и дату ему можно поставить прошедшую.

const withUser = { user: { select: { id: true, name: true } } }
type Tx = Prisma.TransactionClient

// Поля дохода, у которых сервер помнит время правки (common/stamps.ts)
export const INCOME_FIELDS = ['category', 'amount', 'note', 'date'] as const

// Часы сервера и устройства расходятся не больше чем на минуты
const FUTURE_SLACK_MS = 5 * 60 * 1000

// День без времени ставим на полдень по Душанбе: в какой бы часовой пояс ни попал
// отчёт, доход останется в своём дне. Сегодняшний день — это «сейчас»; будущим
// числом доход не вносят
export function incomeDate(raw: string | undefined | null, now = new Date()): Date {
  if (raw === undefined || raw === null || raw === '') return now
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  if (plainDay && raw === dayKeyTj(now)) return now
  const d = plainDay ? new Date(raw + 'T12:00:00.000+05:00') : new Date(raw)
  if (Number.isNaN(d.getTime()) || !storableDate(d.getTime())) throw new BadRequestException('Дата дохода: неверная дата')
  if (d.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new BadRequestException('Дата дохода не может быть в будущем')
  return d
}

@Injectable()
export class IncomesService {
  constructor(private prisma: PrismaService) {}

  findAll(q: PeriodQuery = {}) {
    return this.prisma.income.findMany({
      where: periodFilter(q, 180),
      include: withUser,
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  private async categoryOf(tx: Tx, raw: string) {
    const name = (raw || '').trim()
    if (!name) throw new BadRequestException('Укажите статью дохода')
    const known = await tx.incomeCategory.findUnique({ where: { name }, select: { id: true } })
    if (!known) throw new BadRequestException('Этой статьи доходов уже нет в списке — добавьте её в настройках')
    return name
  }

  async create(dto: CreateIncomeDto, userId?: string) {
    const { clientId } = dto
    if (clientId) {
      const already = await this.prisma.income.findUnique({ where: { clientId }, include: withUser })
      if (already) return already
    }
    const now = new Date()
    return this.prisma
      .$transaction(async (tx) => {
        const category = await this.categoryOf(tx, dto.category)
        return tx.income.create({
          data: {
            clientId: clientId ?? null,
            date: incomeDate(dto.date, now),
            category,
            amount: D(dto.amount).toDecimalPlaces(2),
            note: (dto.note || '').trim(),
            userId: userId ?? null,
          },
          include: withUser,
        })
      }, TX)
      .catch(async (e: any) => {
        // Тот же запрос пришёл дважды разом — второй видит ключ первого
        if (clientId && e?.code === 'P2002') {
          const existing = await this.prisma.income.findUnique({ where: { clientId }, include: withUser })
          if (existing) return existing
        }
        throw e
      })
  }

  async update(id: string, dto: UpdateIncomeDto) {
    return this.prisma.$transaction(async (tx) => {
      const income = await tx.income.findUnique({ where: { id } })
      if (!income) throw new NotFoundException('Доход не найден')
      const data: Prisma.IncomeUpdateInput = {}
      if (dto.category !== undefined && dto.category.trim() !== income.category) data.category = await this.categoryOf(tx, dto.category)
      if (dto.amount !== undefined) data.amount = D(dto.amount).toDecimalPlaces(2)
      if (dto.note !== undefined) data.note = dto.note.trim()
      if (dto.date !== undefined) data.date = incomeDate(dto.date)
      const updated = await tx.income.update({ where: { id }, data, include: withUser })
      // Когда правили: касса без связи сверит по этому свою правку (common/stamps.ts). Отметка —
      // только полям, которые правда поменялись
      await stamp(tx, 'Income', id, changedFields(income, data as any, INCOME_FIELDS))
      return updated
    }, TX)
  }

  async remove(id: string) {
    const income = await this.prisma.income.findUnique({ where: { id }, select: { id: true } })
    if (!income) throw new NotFoundException('Доход не найден')
    await this.prisma.$transaction(async (tx) => {
      await tx.income.delete({ where: { id } })
      await forgetStamps(tx, 'Income', id)
    }, TX)
    return { ok: true }
  }

  // ── Статьи доходов ──
  categories() {
    return this.prisma.incomeCategory.findMany({ orderBy: { name: 'asc' } })
  }

  async addCategory(dto: CreateIncomeCategoryDto) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название статьи')
    try {
      return await this.prisma.incomeCategory.create({ data: { name } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Такая статья доходов уже есть')
      }
      throw e
    }
  }

  // Статью можно убрать, даже если по ней есть доходы: они хранят её название и
  // остаются в истории как были
  async removeCategory(id: string) {
    const cat = await this.prisma.incomeCategory.findUnique({ where: { id } })
    if (!cat) throw new NotFoundException('Статья доходов не найдена')
    await this.prisma.incomeCategory.delete({ where: { id } })
    return { ok: true }
  }
}
