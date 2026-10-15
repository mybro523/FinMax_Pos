import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { withSchema } from '../common/db-url'
import { currentTenantSchema } from './tenant-context'

// ── Подключения к схемам магазинов ──
// База одна, схем в ней много: у каждого магазина своя. Набор таблиц везде одинаковый,
// поэтому клиент Prisma один и тот же — меняется только схема в адресе подключения.
//
// ── Про число подключений ──
// Это главное ограничение всей затеи. У каждого клиента свой запас подключений,
// а Postgres по умолчанию отдаёт сотню на всех. Держать открытыми все схемы сразу
// нельзя, поэтому давно не нужные закрываются.
//
// ── Почему предел мягкий ──
// Сначала он был жёстким: стало больше разрешённого — закрываем самое давнее, и точка.
// Нагрузочная проверка показала, чем это кончается. Пятнадцать магазинов при пределе
// в десять: подключение закрывается ровно тогда, когда по нему идёт запрос, тот
// падает по времени, магазин открывает подключение заново — и так по кругу. Тридцать
// семь отказов из двухсот запросов и отклик до тридцати секунд. Восемь магазинов при том
// же пределе — ноль отказов.
//
// Поэтому закрываем только то, чем давно не пользовались. Если все подключения
// в работе, предел ненадолго превышается — и это правильный выбор: сорвать продажу
// ради соблюдения числа хуже, чем подержать лишнее подключение минуту.

const MAX_LIVE = Number(process.env.TENANT_MAX_CLIENTS || 25)
const PER_CLIENT = Number(process.env.TENANT_CONNECTION_LIMIT || 2)

// Сколько подключение считается «в работе» после последнего обращения. Дольше
// самой длинной денежной операции: пересчёту остатков отведено три минуты, и
// закрыть под ним подключение значит оборвать инвентаризацию всего склада.
const BUSY_MS = Number(process.env.TENANT_BUSY_MS || 4 * 60_000)

// Через сколько простоя подключение закрывается само, даже если место есть.
// Магазин закрылся на ночь — незачем держать его подключение до утра.
const IDLE_MS = Number(process.env.TENANT_IDLE_MS || 15 * 60_000)
const SWEEP_MS = 60_000

// Схема по умолчанию — для работы вне контекста магазина: миграции, обслуживание.
export const DEFAULT_SCHEMA = process.env.DEFAULT_TENANT_SCHEMA || 'public'

interface Live {
  client: PrismaClient
  usedAt: number
}

@Injectable()
export class TenantPool implements OnModuleDestroy {
  private readonly log = new Logger('TenantPool')
  // Порядок в Map — это порядок обращения: к кому обратились, тот переставляется
  // в конец. Часы для этого не годятся, они слишком грубы: внутри одной миллисекунды
  // успевает пройти несколько запросов, и у всех оказывается одинаковая отметка.
  // А вот «давно ли им пользовались» без часов не узнать — поэтому и то, и другое.
  private readonly live = new Map<string, Live>()
  // Магазины, у которых кто-то сейчас за кассой. Их подключения не закрываем
  // по простою: между покупателями бывает и полчаса, а платить полторы секунды
  // за пробуждение будет тот, кто как раз стоит у стойки.
  private readonly warm = new Set<string>()
  private sweeper: NodeJS.Timeout | null = null

  constructor() {
    this.sweeper = setInterval(() => this.sweepIdle(), SWEEP_MS)
    this.sweeper.unref?.()
  }

  // Отдельным методом, чтобы проверки могли подставить свой клиент и не поднимать
  // ради этого настоящую базу
  protected createClient(url: string): PrismaClient {
    return new PrismaClient({ datasourceUrl: url })
  }

  protected now(): number {
    return Date.now()
  }

  // Адрес подключения к схеме. Запас подключений задаём сами: у Prisma он
  // рассчитан на одну базу и одно приложение, а здесь клиентов десятки.
  url(schema: string): string {
    const base = withSchema(process.env.DATABASE_URL || '', schema)
    if (!base) return base
    const u = new URL(base)
    if (!u.searchParams.has('connection_limit')) {
      u.searchParams.set('connection_limit', String(PER_CLIENT))
    }
    return u.toString()
  }

  // Клиент для схемы. Уже открытый переиспользуется.
  for(schema: string): PrismaClient {
    const found = this.live.get(schema)
    if (found) {
      found.usedAt = this.now()
      // Переставляем в конец очереди: этим магазином только что пользовались
      this.live.delete(schema)
      this.live.set(schema, found)
      return found.client
    }
    const client = this.createClient(this.url(schema))
    this.live.set(schema, { client, usedAt: this.now() })
    this.makeRoom(schema)
    return client
  }

  // ── Магазин вышел на связь ──
  // Открываем подключение заранее, не дожидаясь первого запроса. Prisma подключается
  // лениво, и раньше за это платил первый же покупатель дня: замер показал 1,7 с
  // на первое обращение против 0,5 с на все последующие.
  //
  // Тепло — привилегия, а не право: когда подключений и так больше предела,
  // держать их про запас нельзя.
  keepWarm(schema: string): void {
    if (!schema) return
    this.warm.add(schema)
    if (this.live.size > MAX_LIVE) return
    const client = this.for(schema)
    client.$connect().catch(() => {
      // Не получилось — не беда: подключится при первом настоящем запросе
    })
  }

  // Все ушли с кассы. Подключение не закрываем сразу: рабочий день кончился
  // не обязательно, а закрыть и открыть заново дороже, чем подождать простоя.
  letCool(schema: string): void {
    if (schema) this.warm.delete(schema)
  }

  // Клиент для магазина, который обслуживает текущий запрос
  current(): PrismaClient {
    return this.for(currentTenantSchema() || DEFAULT_SCHEMA)
  }

  // Сколько подключений открыто сейчас — для наблюдения за нагрузкой
  get size(): number {
    return this.live.size
  }

  // Что происходит с подключениями. Показывается владельцу сервиса: упереться
  // в предел базы — это то, о чём хочется узнать заранее, а не по отказам.
  stats() {
    const now = this.now()
    const rows = [...this.live].map(([schema, e]) => ({ schema, idleMs: now - e.usedAt }))
    return {
      open: this.live.size,
      softLimit: MAX_LIVE,
      perClient: PER_CLIENT,
      // Сколько подключений к базе занято в худшем случае
      connections: this.live.size * PER_CLIENT,
      busy: rows.filter((r) => r.idleMs < BUSY_MS).length,
      // Сколько магазинов сейчас за кассой — их подключения держим тёплыми
      warm: this.warm.size,
      overLimit: Math.max(0, this.live.size - MAX_LIVE),
    }
  }

  // Закрыть подключение к схеме (магазин приостановили или удалили)
  async close(schema: string): Promise<void> {
    this.warm.delete(schema)
    const found = this.live.get(schema)
    if (!found) return
    this.live.delete(schema)
    await found.client.$disconnect().catch(() => {})
  }

  // ── Освободить место ──
  // Закрываем только то, чем давно не пользовались. Подключение «в работе»
  // не трогаем ни при каких обстоятельствах: закрыть его — значит оборвать
  // чужую продажу, и именно на этом рассыпалась первая, жёсткая версия.
  private makeRoom(keep: string): void {
    if (this.live.size <= MAX_LIVE) return
    const now = this.now()
    let closed = 0

    // Перебираем снимок: сам список меняется по ходу, и считать оставшееся надо
    // по нему же, а не по счётчику закрытых — иначе цикл останавливается вдвое
    // раньше, чем нужно, и место так и не освобождается
    for (const [schema, entry] of [...this.live]) {
      if (this.live.size <= MAX_LIVE) break
      if (schema === keep) continue
      if (now - entry.usedAt < BUSY_MS) continue // в работе — не трогаем
      this.live.delete(schema)
      closed++
      entry.client.$disconnect().catch(() => {})
    }

    if (closed) this.log.log(`Закрыто подключений: ${closed}, осталось ${this.live.size}`)
    if (this.live.size > MAX_LIVE) {
      // Все в работе. Превышаем предел намеренно и говорим об этом: если это
      // повторяется, значит магазинов стало больше, чем рассчитано, и пора поднимать
      // TENANT_MAX_CLIENTS — или ставить перед базой общий пул подключений.
      this.log.warn(
        `Открыто подключений ${this.live.size} при пределе ${MAX_LIVE} — все заняты работой. ` +
          `К базе занято около ${this.live.size * PER_CLIENT} подключений.`,
      )
    }
  }

  // Раз в минуту закрываем то, чем давно никто не пользуется, даже если место есть:
  // магазин закрылся на ночь — незачем держать его подключение до утра
  private sweepIdle(): void {
    const now = this.now()
    let closed = 0
    const crowded = this.live.size > MAX_LIVE
    for (const [schema, entry] of [...this.live]) {
      if (now - entry.usedAt < IDLE_MS) continue
      // За этой кассой кто-то стоит — не закрываем, пока есть место
      if (this.warm.has(schema) && !crowded) continue
      this.live.delete(schema)
      closed++
      entry.client.$disconnect().catch(() => {})
    }
    if (closed) this.log.log(`Простаивающих подключений закрыто: ${closed}, осталось ${this.live.size}`)
  }

  async onModuleDestroy() {
    if (this.sweeper) clearInterval(this.sweeper)
    const all = [...this.live.values()]
    this.live.clear()
    await Promise.all(all.map((e) => e.client.$disconnect().catch(() => {})))
  }
}
