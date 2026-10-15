import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { AdminDbService } from '../admin/admin-db.service'
import { EventsGateway } from '../events/events.gateway'
import { runInTenant } from '../prisma/tenant-context'
import { startOfTodayTj } from '../common/time'

// ── Пересчёт просроченного остатка ──
// Сколько штук товара просрочено, карточка запоминает при каждом движении склада.
// Но партия портится сама по себе: вчера у неё был последний день годности, сегодня
// она уже негодна, а на складе за ночь ничего не происходило. Без пересчёта по
// времени касса до первой операции считала бы вчерашнюю просрочку годным товаром.
//
// Поэтому раз в час сверяем всё разом. Запрос дешёвый: две записи по индексу
// (productId, expiryDate), и обновляются только те товары, где число изменилось.
// Час выбран не случайно — сутки в Душанбе начинаются, когда сервер живёт по UTC,
// и «поймать полночь» ровно надёжнее коротким регулярным проходом, чем таймером
// до конкретного момента, который переживёт перезапуск сервиса.

const EVERY_MS = 60 * 60 * 1000

@Injectable()
export class ExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Expiry')
  private timer: NodeJS.Timeout | null = null

  constructor(private prisma: PrismaService, private admin: AdminDbService, private events: EventsGateway) {}

  async onModuleInit() {
    // Первый проход не должен мешать запуску: магазинов может быть много, а база
    // ещё прогревается. Ошибку показываем, но сервер поднимаем в любом случае —
    // просрочка подождёт час, продажи ждать не могут.
    this.refreshAll().catch((e) => this.log.error('первый пересчёт не удался: ' + (e?.message || e)))
    this.timer = setInterval(() => {
      this.refreshAll().catch((e) => this.log.error('пересчёт не удался: ' + (e?.message || e)))
    }, EVERY_MS)
    // Пересчёт не должен удерживать процесс при остановке сервера
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  // ── Обход всех магазинов ──
  // Партия портится сама по себе, в каждом магазине своя. Схем много, поэтому идём
  // по ним по очереди, а не разом: одновременные подключения ко всем сразу упёрлись
  // бы в предел базы, а спешить здесь некуда — это фоновая работа раз в час.
  //
  // Сорвавшийся магазин не останавливает остальные: у одного может идти обновление
  // схемы, и это не повод оставить все прочие с вчерашней просрочкой.
  async refreshAll(now?: Date): Promise<number> {
    const list = await this.admin.pharmacy.findMany({
      where: { blocked: false },
      select: { id: true, code: true, schemaName: true },
    })
    let total = 0
    for (const ph of list) {
      try {
        total += await runInTenant(ph.schemaName, () => this.refresh(now))
        await this.noteLastSale(ph.id, ph.schemaName)
      } catch (e: any) {
        this.log.error(`«${ph.code}»: пересчёт не удался — ${e?.message || e}`)
      }
    }
    return total
  }

  // ── Живой ли клиент ──
  // Заодно с пересчётом просрочки запоминаем дату последнего чека. Не ради самой
  // магазина, а ради владельца сервиса: «оплачена, но не торгует восьмой день» —
  // самый честный признак того, что клиент уходит. Деньги уже получены, а работать
  // он перестал и скажет об этом только через месяц.
  //
  // Считаем здесь, потому что этот обход и так открывает каждую схему. Отдельный
  // проход стоил бы второго подключения к каждому магазину — на трёх сотнях клиентов
  // это заметно, а узнаём мы ровно то же самое.
  private async noteLastSale(pharmacyId: string, schema: string) {
    try {
      const last = await runInTenant(schema, () =>
        this.prisma.sale.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
      )
      await this.admin.pharmacy.update({
        where: { id: pharmacyId },
        data: { lastSaleAt: last?.date ?? null, lastSaleSeen: new Date() },
      })
    } catch (e: any) {
      // Не смогли посмотреть — не беда: панель отличит «не считали» от «не торгует»
      // по отметке lastSaleSeen и не станет выдумывать тревогу
      this.log.error(`не удалось узнать дату последнего чека: ${e?.message || e}`)
    }
  }

  // Пересчёт одного магазина — того, в чьей схеме мы сейчас находимся.
  // Возвращает, сколько карточек изменилось.
  async refresh(now?: Date): Promise<number> {
    const today = startOfTodayTj(now)

    // Товары, где просрочка есть: приводим число к сумме негодных партий
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Product" p
      SET "expiredUnits" = x.u
      FROM (
        SELECT b."productId" AS pid, SUM(b.units)::int AS u
        FROM "Batch" b
        WHERE b.units > 0 AND b."expiryDate" IS NOT NULL AND b."expiryDate" < ${today}
        GROUP BY b."productId"
      ) x
      WHERE p.id = x.pid AND p."expiredUnits" <> x.u
    `)

    // Товары, где просрочки уже нет (списали или продали): обнуляем
    const cleared = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Product" p
      SET "expiredUnits" = 0
      WHERE p."expiredUnits" <> 0
        AND NOT EXISTS (
          SELECT 1 FROM "Batch" b
          WHERE b."productId" = p.id AND b.units > 0
            AND b."expiryDate" IS NOT NULL AND b."expiryDate" < ${today}
        )
    `)

    const changed = updated + cleared
    if (changed > 0) {
      this.log.log(`Просроченный остаток пересчитан: карточек изменено ${changed}`)
      // Устройства должны увидеть новый остаток к продаже сразу, а не после
      // следующей продажи — иначе кассир до утра работает по вчерашним данным
      this.events.changed('products')
    }
    return changed
  }
}
