import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { TX } from '../common/tx'

const SEED_PRODUCTS = [
  ['Парацетамол 500мг №20', '4870204010015', 'Анальгетики', 18, 35, 120, 30, 'уп'],
  ['Анальгин 500мг №10', '4870204010022', 'Анальгетики', 12, 22, 85, 20, 'уп'],
  ['Цитрамон П №10', '4870204010039', 'Анальгетики', 15, 28, 64, 20, 'уп'],
  ['Нурофен 200мг №10', '4870204010046', 'Анальгетики', 95, 150, 48, 15, 'уп'],
  ['Линекс капсулы №16', '4870204010053', 'ЖКТ', 180, 280, 42, 10, 'уп'],
  ['Активированный уголь №10', '4870204010060', 'ЖКТ', 8, 18, 200, 40, 'уп'],
  ['Но-Шпа 40мг №24', '4870204010077', 'Спазмолитики', 120, 195, 37, 12, 'уп'],
  ['Аспирин 500мг №10', '4870204010084', 'Анальгетики', 14, 26, 90, 25, 'уп'],
  ['Амоксициллин 500мг №16', '4870204010091', 'Антибиотики', 85, 140, 55, 15, 'уп'],
  ['Аугментин 625мг №14', '4870204010107', 'Антибиотики', 320, 480, 28, 8, 'уп'],
  ['Витамин C 500мг №20', '4870204010114', 'Витамины', 45, 80, 110, 25, 'уп'],
  ['Ревит драже №100', '4870204010121', 'Витамины', 22, 45, 70, 20, 'уп'],
  ['Лоратадин 10мг №10', '4870204010138', 'Антигистамины', 35, 65, 60, 15, 'уп'],
  ['Супрастин 25мг №20', '4870204010145', 'Антигистамины', 95, 155, 33, 10, 'уп'],
  ['Бинт стерильный 5м', '4870204010152', 'Перевязка', 18, 40, 150, 30, 'шт'],
  ['Вата стерильная 100г', '4870204010169', 'Перевязка', 40, 75, 80, 20, 'шт'],
  ['Пластырь бактерицидный №10', '4870204010176', 'Перевязка', 25, 50, 95, 25, 'уп'],
  ['Термометр электронный', '4870204010183', 'Приборы', 180, 320, 18, 5, 'шт'],
  ['Маска медицинская №50', '4870204010190', 'Расходники', 90, 160, 65, 15, 'уп'],
  ['Спирт этиловый 100мл', '4870204010206', 'Антисептики', 30, 60, 130, 30, 'шт'],
] as const

@Injectable()
export class SeedService {
  private readonly logger = new Logger('Seed')
  constructor(private prisma: PrismaService) {}

  // Владельца аптеки здесь больше не заводят: вход общий на весь сервис, и учётные
  // записи живут в панели управления. Владелец создаётся вместе с самой аптекой —
  // см. PharmaciesService, — а владелец сервиса при первом запуске (AccountsService).

  // Одна открытая смена — гарантия на уровне базы.
  // Проверки «нет ли уже открытой смены» в коде мало: два кассира могут нажать
  // «Открыть смену» одновременно, обе проверки пройдут, и чеки разойдутся по двум
  // сменам — Z-отчёт после этого не сходится. Частичный уникальный индекс Prisma
  // в схеме описать не умеет, поэтому заводим его сами.
  //
  // Запретов два: одна открытая смена на сайте и по одной на каждую кассу
  // (программа для Windows работает без интернета, и смена у неё своя). Обычно их
  // создаёт миграция; здесь — страховка для аптеки, где на момент миграции было
  // открыто несколько смен и первый индекс построить не удалось.
  async ensureOneOpenShift() {
    try {
      const open = await this.prisma.shift.count({ where: { closedAt: null, deviceId: null } })
      if (open > 1) {
        this.logger.warn(
          `Открытых смен: ${open}. Пока они не закрыты, защита от второй смены не включится — закройте лишние в разделе «Смена кассы».`,
        )
        return
      }
      // Прежний запрет «одна на всю аптеку» не дал бы кассе открыть свою смену,
      // пока открыта смена на сайте
      await this.prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "Shift_one_open_idx"')
      // Индексируем выражение «смена не закрыта»: у всех открытых смен оно даёт
      // одно и то же значение, поэтому уникальность допускает максимум одну такую строку
      await this.prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_web_idx" ON "Shift" ((("closedAt" IS NULL))) WHERE "closedAt" IS NULL AND "deviceId" IS NULL',
      )
      await this.prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_device_idx" ON "Shift" ("deviceId") WHERE "closedAt" IS NULL AND "deviceId" IS NOT NULL',
      )
      this.logger.log('Защита от второй открытой смены включена')
    } catch (e: any) {
      this.logger.error('ensureOneOpenShift failed: ' + (e?.message || e))
    }
  }

  // Перенос остатков в партии: у товаров, заведённых до появления партий, остаток
  // лежал только в карточке. Создаём для каждого начальную партию с его сроком годности,
  // чтобы учёт стал единым. Выполняется один раз — повторные запуски ничего не меняют.
  async ensureBatches() {
    try {
      const products = await this.prisma.product.findMany()
      let created = 0
      let fixed = 0
      for (const p of products) {
        const units = p.stock * Math.max(1, p.unitsPerPack || 1) + (p.looseUnits || 0)
        const rows = await this.prisma.batch.findMany({ where: { productId: p.id }, orderBy: { createdAt: 'asc' } })
        const inBatches = rows.reduce((s, b) => s + b.units, 0)
        if (inBatches === units) continue

        if (rows.length === 0) {
          if (units <= 0) continue
          await this.prisma.batch.create({
            data: { productId: p.id, units, cost: p.cost, expiryDate: p.expiryDate, note: 'Остаток до перехода на партии' },
          })
          created++
          continue
        }

        // Партии разошлись с карточкой (например, остаток правили вручную).
        // Верным считаем то, что видит владелец в карточке: подгоняем партии к ней.
        let diff = units - inBatches
        if (diff > 0) {
          const last = rows[rows.length - 1]
          await this.prisma.batch.update({ where: { id: last.id }, data: { units: last.units + diff } })
        } else {
          // Убираем лишнее, начиная с партии с самым дальним сроком
          const byFar = [...rows].sort((a, b) => {
            const ax = a.expiryDate ? a.expiryDate.getTime() : Number.MAX_SAFE_INTEGER
            const bx = b.expiryDate ? b.expiryDate.getTime() : Number.MAX_SAFE_INTEGER
            return bx - ax
          })
          let left = -diff
          for (const b of byFar) {
            if (left <= 0) break
            const take = Math.min(left, b.units)
            await this.prisma.batch.update({ where: { id: b.id }, data: { units: b.units - take } })
            left -= take
          }
        }
        fixed++
        this.logger.warn(`Остаток «${p.name}» приведён к карточке: было ${inBatches} шт в партиях, стало ${units} шт`)
      }
      if (created) this.logger.log(`Остатки перенесены в партии: ${created} товар(ов)`)
      if (fixed) this.logger.log(`Расхождения партий с карточкой исправлены: ${fixed} товар(ов)`)
    } catch (e) {
      this.logger.error('ensureBatches failed', e as any)
    }
  }

  // Демо-данные — только при AUTO_SEED=true и пустой базе. По умолчанию выключено
  // (в проде база не засоряется). Схема создаётся миграциями, не здесь.
  // force=true — заполнить демо-данными независимо от AUTO_SEED. Так делает
  // заведение показательной аптеки: демо нужно этой одной, а не всем подряд.
  async run(force = false) {
    if (!force && process.env.AUTO_SEED !== 'true') return
    const count = await this.prisma.product.count()
    if (count > 0) return

    this.logger.log('AUTO_SEED=true, база пуста — заполняю демо-данными…')
    const products = []
    for (const [name, barcode, category, cost, price, stock, minStock, unit] of SEED_PRODUCTS) {
      const p = await this.prisma.product.create({
        data: {
          name: name as string,
          barcode: barcode as string,
          category: category as string,
          cost: cost as number,
          price: price as number,
          stock: stock as number,
          minStock: minStock as number,
          unit: unit as string,
        },
      })
      products.push(p)
    }

    // Демо-продажи за 10 дней — СО списанием склада (данные консистентны с остатками)
    const now = new Date()
    for (let d = 9; d >= 0; d--) {
      const day = new Date(now)
      day.setDate(now.getDate() - d)
      const perDay = 2 + Math.floor(Math.abs(Math.sin(d * 1.7)) * 5)
      for (let s = 0; s < perDay; s++) {
        const n = 1 + Math.floor(Math.abs(Math.cos(d + s)) * 3)
        const items: { productId: string; name: string; qty: number; price: number; cost: number }[] = []
        let total = 0
        let cost = 0
        for (let k = 0; k < n; k++) {
          const p = products[(d * 3 + s * 5 + k * 7) % products.length]
          const qty = 1 + ((s + k) % 3)
          items.push({ productId: p.id, name: p.name, qty, price: Number(p.price), cost: Number(p.cost) })
          total += Number(p.price) * qty
          cost += Number(p.cost) * qty
        }
        const t = new Date(day)
        t.setHours(9 + (s % 10), (s * 13) % 60, 0, 0)
        await this.prisma.$transaction(async (tx) => {
          for (const it of items) {
            // Списываем только если хватает остатка (склад остаётся неотрицательным)
            const r = await tx.product.updateMany({
              where: { id: it.productId, stock: { gte: it.qty } },
              data: { stock: { decrement: it.qty } },
            })
            if (r.count !== 1) throw new Error('skip')
          }
          await tx.sale.create({
            data: {
              date: t,
              total,
              cost,
              profit: total - cost,
              // только cash/card — «долг» требует клиента
              payment: ['cash', 'card'][(d + s) % 2],
              items: { create: items },
            },
          })
        }, TX).catch(() => { /* недостаточно остатка для демо-чека — пропускаем */ })
      }
    }
    this.logger.log(`Готово: ${products.length} товаров и демо-продажи за 10 дней.`)
  }
}
