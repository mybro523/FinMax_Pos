import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { dayKeyTj, storableDate } from '../common/time'
import { setExpenseCash } from '../shifts/totals'
import { withDeviceNames } from '../shifts/shifts.service'
import { lockShift, NO_OPEN_SHIFT, openShiftFor, SHIFT_CLOSED } from '../shifts/till'
import { CreateExpenseCategoryDto, CreateExpenseDto, UpdateExpenseDto } from './dto'

// ── Расходы магазина ──
// Всё, на что магазин тратит деньги помимо закупки товара: аренда, зарплата, свет,
// налоги. Из них и из прибыли от продаж отчёты считают чистую прибыль.
//
// Расход бывает оплачен наличными из кассы. Тогда он привязан к открытой смене и
// уменьшает наличные, которые в ней ждут при закрытии: денег в ящике нет, и смена
// обязана это знать. Такой расход живёт по правилам смены:
//   • заводится только в открытую смену и датой «сейчас»;
//   • править и удалять его можно, пока смена открыта. Закрыли — он вошёл в её отчёт,
//     и менять его задним числом значило бы переписать уже посчитанную кассу.
// Обычный расход (оплачен не из кассы) правится и удаляется когда угодно, и дату ему
// можно поставить прошедшую: аренду за месяц вносят не обязательно в день оплаты.

const withUser = { user: { select: { id: true, name: true } } }
type Tx = Prisma.TransactionClient

// Часы сервера и устройства расходятся не больше чем на минуты
const FUTURE_SLACK_MS = 5 * 60 * 1000

// Тексты отказов — общие со всеми операциями над ящиком (shifts/till.ts)
export { NO_OPEN_SHIFT, SHIFT_CLOSED }

// День без времени (так его отдаёт поле даты) ставим на полдень по Душанбе: в какой бы
// часовой пояс ни попал отчёт, расход останется в своём дне. Сегодняшний день — это
// «сейчас»; будущим числом расход не вносят
export function expenseDate(raw: string | undefined | null, now = new Date()): Date {
  if (raw === undefined || raw === null || raw === '') return now
  const plainDay = /^\d{4}-\d{2}-\d{2}$/.test(raw)
  if (plainDay && raw === dayKeyTj(now)) return now
  const d = plainDay ? new Date(raw + 'T12:00:00.000+05:00') : new Date(raw)
  if (Number.isNaN(d.getTime()) || !storableDate(d.getTime())) throw new BadRequestException('Дата расхода: неверная дата')
  if (d.getTime() > now.getTime() + FUTURE_SLACK_MS) throw new BadRequestException('Дата расхода не может быть в будущем')
  return d
}

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  findAll(q: PeriodQuery = {}) {
    return this.prisma.expense.findMany({
      where: periodFilter(q, 180),
      include: withUser,
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  // ── Из какой кассы можно взять деньги ──
  // Открытые смены: смена сайта и смены касс с программой. Владелец, вносящий расход с
  // сайта, выбирает, из чьего ящика взяты деньги
  async cashSources() {
    const open = await this.prisma.shift.findMany({ where: { closedAt: null }, orderBy: { openedAt: 'asc' } })
    return (await withDeviceNames(this.prisma, open)).map((s) => ({
      shiftId: s.id,
      deviceId: s.deviceId,
      deviceName: s.deviceName || '',
      openedAt: s.openedAt,
    }))
  }

  private async categoryOf(tx: Tx, raw: string) {
    const name = (raw || '').trim()
    if (!name) throw new BadRequestException('Укажите статью расхода')
    const known = await tx.expenseCategory.findUnique({ where: { name }, select: { id: true } })
    if (!known) throw new BadRequestException('Этой статьи расходов уже нет в списке — добавьте её в настройках')
    return name
  }

  // Период бонуса: обе даты или ни одной (одна без другой — не период), «с» не позже «по»
  private bonusPeriod(from?: string | null, to?: string | null) {
    const f = String(from || '')
    const t = String(to || '')
    if (!f || !t) return { bonusFrom: '', bonusTo: '' }
    if (f > t) throw new BadRequestException('Период бонуса: дата «с» позже даты «по»')
    return { bonusFrom: f, bonusTo: t }
  }

  // Кому выдана зарплата: сотрудник должен быть в этом магазине. Имя запоминаем
  // снимком — ФИО, а если его нет, логин
  private async employeeOf(tx: Tx, raw?: string | null) {
    const id = String(raw || '').trim()
    if (!id) return { employeeId: null as string | null, employeeName: '' }
    const u = await tx.user.findUnique({ where: { id }, select: { id: true, name: true, fullName: true } })
    if (!u) throw new BadRequestException('Сотрудник не найден — обновите страницу')
    return { employeeId: u.id, employeeName: (u.fullName || '').trim() || u.name }
  }

  // ── Кому можно выдать зарплату ──
  // Сотрудники магазина с окладом и бонусом: форма расхода считает «оклад + бонус»
  staff() {
    return this.prisma.user
      .findMany({
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, fullName: true, role: true, active: true, salary: true, bonusPercent: true, salaryDay: true },
      })
      .then((rows) => rows.map((u) => ({ ...u, salary: Number(u.salary) || 0, bonusPercent: Number(u.bonusPercent) || 0, salaryDay: Number(u.salaryDay) || 1 })))
  }

  async create(dto: CreateExpenseDto, userId?: string) {
    const { clientId } = dto
    if (clientId) {
      const already = await this.prisma.expense.findUnique({ where: { clientId }, include: withUser })
      if (already) return already
    }
    const fromCash = dto.fromCash === true
    const now = new Date()

    return this.prisma
      .$transaction(async (tx) => {
        const category = await this.categoryOf(tx, dto.category)
        const employee = await this.employeeOf(tx, dto.employeeId)
        // Смена под замок — и только потом читается (см. shifts/till.ts): «расход попал
        // в уже закрытую смену» не бывает
        const shiftId = fromCash ? await openShiftFor(tx, dto.shiftId) : null
        const expense = await tx.expense.create({
          data: {
            clientId: clientId ?? null,
            // Расход из кассы принадлежит смене, а смена идёт сейчас
            date: fromCash ? now : expenseDate(dto.date, now),
            category,
            amount: D(dto.amount).toDecimalPlaces(2),
            note: (dto.note || '').trim(),
            fromCash,
            shiftId,
            userId: userId ?? null,
            ...employee,
            // Месяц и дни бонуса — только у зарплаты: без сотрудника они ничего не значат
            salaryMonth: employee.employeeId ? dto.salaryMonth || '' : '',
            ...(employee.employeeId ? this.bonusPeriod(dto.bonusFrom, dto.bonusTo) : { bonusFrom: '', bonusTo: '' }),
          },
          include: withUser,
        })
        if (shiftId) await setExpenseCash(tx, shiftId)
        return expense
      }, TX)
      .catch(async (e: any) => {
        // Тот же запрос пришёл дважды разом — второй видит ключ первого
        if (clientId && e?.code === 'P2002') {
          const existing = await this.prisma.expense.findUnique({ where: { clientId }, include: withUser })
          if (existing) return existing
        }
        throw e
      })
  }

  // Расход, который собираются изменить. Если он из кассы — его смена под замком и
  // обязана быть открытой
  private async editable(tx: Tx, id: string) {
    const expense = await tx.expense.findUnique({ where: { id } })
    if (!expense) throw new NotFoundException('Расход не найден')
    if (expense.fromCash && expense.shiftId) {
      const shift = await lockShift(tx, expense.shiftId)
      if (shift?.closedAt) throw new BadRequestException(SHIFT_CLOSED)
    }
    return expense
  }

  async update(id: string, dto: UpdateExpenseDto) {
    return this.prisma.$transaction(async (tx) => {
      const expense = await this.editable(tx, id)
      const data: Prisma.ExpenseUpdateInput = {}
      if (dto.category !== undefined && dto.category.trim() !== expense.category) data.category = await this.categoryOf(tx, dto.category)
      if (dto.amount !== undefined) data.amount = D(dto.amount).toDecimalPlaces(2)
      if (dto.note !== undefined) data.note = dto.note.trim()
      // Дата расхода из кассы — это время в смене, её не переносят
      if (dto.date !== undefined && !expense.fromCash) data.date = expenseDate(dto.date)
      if (dto.employeeId !== undefined) Object.assign(data, await this.employeeOf(tx, dto.employeeId))
      if (dto.salaryMonth !== undefined) data.salaryMonth = dto.salaryMonth
      // Дни бонуса меняют парой: недостающую берём из прежней выдачи
      if (dto.bonusFrom !== undefined || dto.bonusTo !== undefined) {
        Object.assign(data, this.bonusPeriod(dto.bonusFrom ?? expense.bonusFrom, dto.bonusTo ?? expense.bonusTo))
      }
      // Сотрудника сняли (статья больше не «Зарплата») — месяц и дни уходят вместе с ним
      if (dto.employeeId !== undefined && !String(dto.employeeId).trim()) Object.assign(data, { salaryMonth: '', bonusFrom: '', bonusTo: '' })
      const updated = await tx.expense.update({ where: { id }, data, include: withUser })
      if (expense.fromCash && expense.shiftId) await setExpenseCash(tx, expense.shiftId)
      return updated
    }, TX)
  }

  async remove(id: string) {
    await this.prisma.$transaction(async (tx) => {
      const expense = await this.editable(tx, id)
      await tx.expense.delete({ where: { id } })
      if (expense.fromCash && expense.shiftId) await setExpenseCash(tx, expense.shiftId)
    }, TX)
    return { ok: true }
  }

  // ── Статьи расходов ──
  categories() {
    return this.prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } })
  }

  async addCategory(dto: CreateExpenseCategoryDto) {
    const name = (dto.name || '').trim()
    if (!name) throw new BadRequestException('Укажите название статьи')
    try {
      return await this.prisma.expenseCategory.create({ data: { name } })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Такая статья расходов уже есть')
      }
      throw e
    }
  }

  // Статью можно убрать, даже если по ней есть расходы: они хранят её название и
  // остаются в истории как были. Убирается только строка из списка для новых расходов
  async removeCategory(id: string) {
    const cat = await this.prisma.expenseCategory.findUnique({ where: { id } })
    if (!cat) throw new NotFoundException('Статья расходов не найдена')
    await this.prisma.expenseCategory.delete({ where: { id } })
    return { ok: true }
  }
}
