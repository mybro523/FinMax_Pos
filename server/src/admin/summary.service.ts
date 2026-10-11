import { Injectable } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { subscriptionOf } from './subscription'

// ── Сводка для владельца сервиса ──
//
// Список аптек отвечает на вопрос «кому звонить сегодня». Сводка отвечает на
// другой: «как идут дела вообще». Сколько пришло денег, сколько ожидается,
// сколько клиентов и в каком они состоянии.
//
// Считается ОДНИМ походом в базу панели, без обращения к схемам самих аптек.
// Иначе страница, которую владелец держит открытой весь день, стоила бы три
// сотни запросов при каждом обновлении.
//
// Состояние клиента здесь не хранится и не может храниться: оно считается из даты
// оплаты. Поэтому и сводка считается на лету — вчерашняя, сохранённая где-то,
// разошлась бы с действительностью на следующее же утро.

const DAY = 86400000

export interface Summary {
  clients: {
    total: number
    paying: number // оплачено и работает
    trial: number // идёт пробный период
    expired: number // срок вышел, работа остановлена
    blocked: number // приостановлена вручную
    newThisMonth: number
    silent: number // оплачена, но давно не торгует
  }
  money: {
    thisMonth: number
    prevMonth: number
    allTime: number
    expected30: number // сколько должны продлить в ближайшие 30 дней
    avgPayment: number
  }
  byMonth: { month: string; amount: number }[] // 12 месяцев, от старого к новому
}

// Сколько дней без единого чека считаем тревогой
export const SILENT_DAYS = Number(process.env.SILENT_DAYS || 7)

const num = (d: any) => (d == null ? 0 : Number(d))
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

@Injectable()
export class SummaryService {
  constructor(private admin: AdminDbService) {}

  async build(now = new Date()): Promise<Summary> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    // Двенадцать месяцев назад — от начала того месяца, иначе первый столбик
    // графика был бы обрезан по сегодняшнее число
    const yearStart = new Date(now.getFullYear(), now.getMonth() - 11, 1)

    const [pharmacies, payments, all] = await Promise.all([
      this.admin.pharmacy.findMany({
        select: { id: true, paidUntil: true, trial: true, blocked: true, createdAt: true, lastSaleAt: true },
      }),
      // Для графика и для сумм за месяцы хватает года. Всё остальное время
      // считаем отдельно одной свёрткой — тянуть все платежи за годы незачем.
      this.admin.payment.findMany({
        where: { createdAt: { gte: yearStart } },
        select: { amount: true, createdAt: true },
      }),
      this.admin.payment.aggregate({ _sum: { amount: true }, _count: true }),
    ])

    // ── Клиенты по состояниям ──
    const clients = {
      total: pharmacies.length,
      paying: 0,
      trial: 0,
      expired: 0,
      blocked: 0,
      newThisMonth: 0,
      silent: 0,
    }
    let expected30 = 0
    for (const p of pharmacies) {
      const s = subscriptionOf(p, now)
      if (s.status === 'suspended') clients.blocked++
      else if (s.status === 'trial') clients.trial++
      else if (s.status === 'active') clients.paying++
      else clients.expired++

      if (p.createdAt >= monthStart) clients.newThisMonth++

      // Оплачена, работает — но чеков нет давно. Деньги получены, а клиент
      // уже ушёл, просто ещё не сказал об этом.
      const quiet = p.lastSaleAt ? now.getTime() - p.lastSaleAt.getTime() > SILENT_DAYS * DAY : false
      if (quiet && (s.status === 'active' || s.status === 'trial')) clients.silent++

      // Кому продлевать в ближайший месяц: и те, у кого срок подходит,
      // и те, кто уже просрочил, — заплатить должны и они
      const left = (new Date(p.paidUntil).getTime() - now.getTime()) / DAY
      if (!p.blocked && left <= 30) expected30++
    }

    // ── Деньги ──
    let thisMonth = 0
    let prevMonth = 0
    const months = new Map<string, number>()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      months.set(monthKey(d), 0)
    }
    for (const pay of payments) {
      const v = num(pay.amount)
      const k = monthKey(pay.createdAt)
      if (months.has(k)) months.set(k, (months.get(k) || 0) + v)
      if (pay.createdAt >= monthStart) thisMonth += v
      else if (pay.createdAt >= prevStart) prevMonth += v
    }

    const allTime = num(all._sum.amount)
    const avgPayment = all._count ? Math.round((allTime / all._count) * 100) / 100 : 0

    return {
      clients,
      money: {
        thisMonth: round(thisMonth),
        prevMonth: round(prevMonth),
        allTime: round(allTime),
        // Ожидаемое — оценка: сколько клиентов должны продлить, умноженное
        // на средний платёж. Точнее не посчитать: на сколько месяцев продлит
        // каждый, известно только ему самому.
        expected30: round(expected30 * avgPayment),
        avgPayment,
      },
      byMonth: [...months].map(([month, amount]) => ({ month, amount: round(amount) })),
    }
  }
}

const round = (n: number) => Math.round(n * 100) / 100
