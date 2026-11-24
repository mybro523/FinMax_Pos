import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { CategoriesService } from '../categories/categories.service'
import { SeedService } from '../seed/seed.service'
import { EventsGateway } from '../events/events.gateway'
import { currentTenantSchema } from '../prisma/tenant-context'

// ── Начать с чистого листа (1.8.11) ──
// После того как магазин настроили и показали на тестовых данных, владелец магазина
// («мы» при установке заходим под ним) одним действием стирает все рабочие данные и
// справочники, чтобы клиент начал работать с пустой, но настроенной системы.
//
// Что ОСТАЁТСЯ:
//   • сотрудники (их учётки в схеме магазина) и зарегистрированные кассы (Device);
//   • роли и настройки магазина — они живут в отдельной базе панели управления,
//     к ней этот раздел не обращается вовсе, поэтому они сохраняются сами собой.
// Что УДАЛЯЕТСЯ: всё остальное в схеме магазина — товары, остатки, продажи, приходы,
//   поставщики, клиенты и долги, расходы/доходы, смены, склад, журналы, служебные
//   отметки синхронизации, а также справочники (категории, виды товара, статьи,
//   сервисы оплаты).
// После очистки магазин возвращается в состояние только что заведённого: заново
// заводятся стартовые категории.

// Подтверждающее слово — совпадает с полем ввода в «Опасной зоне» настроек.
export const RESET_CONFIRM = 'ОЧИСТИТЬ'

// Таблицы, которые НЕ трогаем. Внутренняя таблица истории миграций Prisma — тоже.
const KEEP = new Set(['User', 'Device', '_prisma_migrations'])

// Разделы, которые надо перезапросить на всех устройствах после очистки — чтобы на
// экране стало пусто без перезагрузки (имена совпадают с коллекциями фронта).
const SECTIONS = [
  'products', 'sales', 'arrivals', 'customers', 'deferred', 'shifts', 'payments', 'returns',
  'writeoffs', 'categories', 'expenses', 'expenseCategories', 'suppliers', 'supplierPayments',
  'cashMoves', 'payServices', 'productTypes', 'incomes', 'incomeCategories', 'supplierReturns',
  'skladBatches', 'skladMoves', 'discrepancies',
]

@Injectable()
export class ResetService {
  private readonly log = new Logger('Reset')
  constructor(
    private prisma: PrismaService,
    private categories: CategoriesService,
    private seed: SeedService,
    private events: EventsGateway,
  ) {}

  async wipeKeepStaff(confirm: string) {
    if ((confirm || '').trim().toUpperCase() !== RESET_CONFIRM) {
      throw new BadRequestException('Для очистки введите слово «ОЧИСТИТЬ»')
    }
    const schema = currentTenantSchema()
    if (!schema) throw new BadRequestException('Магазин не определён')

    // Все таблицы схемы магазина, кроме тех, что оставляем. Берём из каталога базы,
    // а не из списка в коде: новый раздел добавится — чистка подхватит его сама.
    const rows = await this.prisma.$queryRawUnsafe<{ tablename: string }[]>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1',
      schema,
    )
    const tables = rows.map((r) => r.tablename).filter((t) => !KEEP.has(t))
    if (!tables.length) return { ok: true, cleared: 0 }

    // Одним TRUNCATE: порядок внешних ключей (CASCADE) и сброс последовательностей
    // (RESTART IDENTITY) — на стороне базы. TRUNCATE не вызывает построчных триггеров,
    // поэтому журналы (ChangeLog, StockMove, PriceLog) не наполняются заново удалением.
    // Имена схемы и таблиц берём из каталога базы — чужого в них попасть не может.
    const list = tables.map((t) => `"${schema}"."${t}"`).join(', ')
    await this.prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
    this.log.warn(
      `Очистка данных магазина «${schema}»: очищено таблиц ${tables.length}; сотрудники и кассы сохранены`,
    )

    // Возвращаем магазин в состояние только что заведённого: стартовые категории и
    // защита «одна открытая смена» (индекс переживает TRUNCATE, но перестрахуемся)
    await this.categories.ensureSeeded()
    await this.seed.ensureOneOpenShift()

    // Все устройства магазина перезапрашивают разделы — списки станут пустыми сразу
    this.events.changed(...SECTIONS)
    return { ok: true, cleared: tables.length }
  }
}
