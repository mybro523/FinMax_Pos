import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'
import { AccountCache } from '../admin/account-cache.service'
import { AuthService } from '../auth/auth.service'
import { EventsGateway } from '../events/events.gateway'
import { D } from '../common/money'
import { weightedPackCost } from '../common/cost'
import { addUnits, consumeUnitsTolerant, lockProducts, returnExpiry, shortageWorth, uppOf } from '../common/stock'
import { Count, firstCountAfter, forgetShortageDoc, lockInventories, pruneCounted, rememberShortageDoc, shortageDocOf } from '../common/counted'
import { TX, TX_SNAPSHOT } from '../common/tx'
import { setCashMoves, setExpenseCash, shiftTotals } from '../shifts/totals'
import { withDeviceNames } from '../shifts/shifts.service'
import { lockSupplier, supplierBrief } from '../suppliers/suppliers.service'
import { CASHIER_DEFAULT, OP_PERMISSIONS, hasPerm, permissionsOf } from '../auth/permissions'
import {

  OP_TYPES,
  OpType,
  Reject,
  parseArrival,
  parseCashMove,
  parseCustomer,
  parseDebtPay,
  parseDeferredAdd,
  parseDeferredRemove,
  parseExpense,
  parseReturn,
  parseSale,
  parseShiftClose,
  parseShiftOpen,
  parseWriteOff,
  when,
} from './payload'
import { PushDto, PushOpDto } from './dto'
import { mark, sinceOf } from './cursor'

// ── Обмен с кассами, которые работают без интернета ──
//
// Касса продаёт и без связи, а потом присылает сделанное пачкой (push) и спрашивает,
// что изменилось с прошлого раза (pull). Два правила, на которых всё держится.
//
// 1. Одна операция — один номер, созданный на кассе. Принимаем её в транзакции,
//    первой строкой которой номер записывается в таблицу принятых. Пришла второй
//    раз — упирается в уникальность, и сервер отвечает тем же, чем в первый.
//    Поэтому касса может повторять отправку сколько угодно: после обрыва связи
//    посреди пачки она просто шлёт её заново.
//
// 2. Операция уже СЛУЧИЛАСЬ: чек напечатан, товар отдан. Сервер её не «разрешает»,
//    а записывает. Не хватило остатка — берёт сколько есть; цена в чеке не та, что
//    была в базе, — чек всё равно принят. Но всё, что не сошлось, попадает в список
//    расхождений, который видит владелец. Отказ — только для того, что нельзя
//    записать без вранья.

type Tx = Prisma.TransactionClient

export interface SyncUser {
  sub: string
  role: string
  // Права из роли — по ним принимаются операции, сделанные без связи
  permissions?: string[]
  tenantUserId?: string | null
  pharmacyId?: string | null
  name?: string
}

interface Ctx {
  deviceId: string
  // Сотрудник в базе аптеки, на которого записываются документы
  tenantUserId: string | null
  // Операция принята, но что-то в ней не сошлось — владельцу есть на что посмотреть
  flagged: boolean
  // Разделы, которые операция задела сверх обычного (поправила итог пересчёта)
  extra: Set<string>
}

// Виды расхождений:
//   sale, writeoff — продано или списано больше, чем было;
//   price          — цена в чеке не та, что была в базе;
//   return         — по чеку вернули больше, чем продали;
//   counted        — операция сделана ДО пересчёта остатка, а пришла после: пересчёт
//                    её уже учёл, остаток не двигался (см. common/counted.ts);
//   debt           — клиент заплатил (или ему зачли) больше, чем он был должен:
//                    checkPrice — сумма операции, basePrice — долг на тот момент.
type Flag = {
  kind: 'sale' | 'writeoff' | 'price' | 'return' | 'counted' | 'debt'
  productId?: string | null
  name: string
  units: number
  checkPrice?: Prisma.Decimal
  basePrice?: Prisma.Decimal
}

// Строка документа, цену которой надо сверить с историей цен
type PricedLine = { productId: string; name: string; price: number; unitsPerPack: number; units: number }

export interface OpResult {
  id: string
  // ok — принята сейчас; duplicate — была принята раньше; rejected — отказ по
  // существу, повторять бессмысленно; retry — не вышло, пришлите ещё раз
  status: 'ok' | 'duplicate' | 'rejected' | 'retry'
  error?: string
  docId?: string | null
}

// Какие разделы устаревают после операции — чтобы сайт и другие кассы перечитали их
const TOUCHES: Record<OpType, string[]> = {
  sale: ['sales', 'products', 'customers'],
  return: ['returns', 'products', 'sales', 'customers', 'writeoffs'],
  writeoff: ['writeoffs', 'products'],
  arrival: ['arrivals', 'products'],
  'shift.open': ['shifts'],
  'shift.close': ['shifts', 'sales'],
  'debt.pay': ['customers', 'payments'],
  'customer.create': ['customers'],
  'deferred.add': ['deferred'],
  'deferred.remove': ['deferred'],
  // Расход из кассы меняет и ожидаемые наличные в смене
  expense: ['expenses', 'shifts'],
  'cash.move': ['cashMoves', 'shifts'],
}

// Сколько журнал изменений хранится. Касса без связи работает не больше недели;
// полтора месяца — запас на компьютер, который включили после отпуска
const KEEP_DAYS = 45
const PRUNE_EVERY_MS = 24 * 3600 * 1000
// Изменений больше этого — быстрее отдать всё заново, чем перебирать по одному
const MAX_CHANGES = 20000
const SALES_DAYS = 60
const JOURNAL_DAYS = 180
const DAY = 86400000
// Часы кассы сверены с сервером, но не до секунды. Цена, действовавшая в пределах
// пары минут от момента продажи, считается верной
const PRICE_SLACK_MS = 2 * 60 * 1000
// Номер операции — как его проверяет приём (см. dto.ts)
const OP_ID = /^[A-Za-z0-9_:.-]{1,64}$/
// Под этим именем сервер помнит, какую отметку обмена он выдал кассе в прошлый раз
const MARK = 'cursor:'
// А под этим — отпечаток ключа кассы (см. checkKey)
const KEY = 'devkey:'
const KEY_OK = /^[A-Za-z0-9_-]{20,128}$/
// Штук в партии и в расхождении база хранит целым числом; больше этого в него не помещается
const MAX_UNITS = 2_000_000_000
// Сколько операций касса может назвать в одном обмене, спрашивая об их судьбе
const MAX_ASKED = 120

// ── Ошибки базы, которые повтором не лечатся ──
// Число не помещается в поле, значение не того вида, пусто там, где пусто быть не может.
// Причина — в самих данных операции: сколько её ни присылай, ответ будет тем же. А касса
// шлёт по порядку, и за такой операцией встала бы вся её очередь — навсегда и молча.
//
// Сюда намеренно НЕ входят «ссылка ведёт в никуда» и «такая запись уже есть». Это следы
// гонки: клиента удалили между проверкой и записью, тот же документ в ту же секунду
// записал соседний запрос. Повтор такой операции даёт уже осмысленный ответ — отказ
// «клиент не найден» или «принято раньше», — а отвергнув её сразу, сервер потерял бы
// настоящий чек из-за совпадения во времени.
const DATA_ERRORS = new Set(['P2000', 'P2005', 'P2006', 'P2007', 'P2011', 'P2012', 'P2013', 'P2019', 'P2020'])
// Коды самой базы: 22… — данные не годятся для поля; 23502 и 23514 — пустое значение
// и нарушенное условие поля
const DATA_SQLSTATE = /^(22|23502$|23514$)/
export function isDataError(e: any): boolean {
  if (e instanceof Prisma.PrismaClientValidationError) return true
  // Значение, которое не удалось даже передать базе (дата с годом из пяти цифр).
  // У такой ошибки нет кода — узнаём её по словам
  if (e instanceof Prisma.PrismaClientUnknownRequestError && /Could not convert argument value/i.test(String(e.message))) return true
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (DATA_ERRORS.has(e.code)) return true
    if (e.code === 'P2010' && DATA_SQLSTATE.test(String((e.meta as any)?.code || ''))) return true
  }
  return false
}

const saleInclude = { items: true, customer: true, user: { select: { id: true, name: true } } }
const withUser = { items: true, user: { select: { id: true, name: true } } }
// Для документов без позиций: движения наличных, оплаты поставщикам
const userOnly = { user: { select: { id: true, name: true } } }

const chunks = <T>(arr: T[], n = 500): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// До дирама, половина — от нуля: так округляет и база, и касса
const cents = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

@Injectable()
export class SyncService {
  private readonly log = new Logger('Sync')

  constructor(
    private prisma: PrismaService,
    private accounts: AccountCache,
    private auth: AuthService,
    private events: EventsGateway,
  ) {}

  // ── Принять пачку операций ──
  async push(dto: PushDto, user: SyncUser, key?: string): Promise<{ results: OpResult[] }> {
    await this.touchDevice(dto.deviceId, user, dto.appVersion, key)

    const results: OpResult[] = []
    const touched = new Set<string>()
    for (const op of dto.ops) {
      const r = await this.applyOne(op, dto.deviceId, user, touched)
      results.push(r)
      // Порядок важен: возврат не может лечь раньше своего чека. Не вышло с одной —
      // дальше не идём, касса пришлёт остаток пачки ещё раз
      if (r.status === 'retry') break
    }
    if (touched.size) this.events.changed(...touched)
    return { results }
  }

  // touched — разделы, которые после этой операции устарели у сайта и других касс
  private async applyOne(op: PushOpDto, deviceId: string, user: SyncUser, touched: Set<string>): Promise<OpResult> {
    // Уже принимали? Отвечаем тем же, чем в первый раз
    const seen = await this.prisma.syncOp.findUnique({ where: { id: op.id } })
    if (seen) return this.replay(seen)

    const type = op.type as OpType
    let createdAt: Date
    try {
      if (!OP_TYPES.includes(type)) throw new Reject('Неизвестная операция')
      createdAt = when(op.createdAt, 'операция')
    } catch (e: any) {
      return this.reject(op, deviceId, user, new Date(), e.message)
    }

    // ── Кто сделал и кто прислал ──
    // Обычно это один человек. Чужую операцию может прислать только владелец:
    // иначе кассир записал бы свою недостачу на соседа — или списание на владельца.
    let performer = { accountId: user.sub, role: user.role, tenantUserId: user.tenantUserId ?? null, permissions: user.permissions || [] }
    if (op.accountId && op.accountId !== user.sub) {
      if (user.role !== 'founder') {
        return this.reject(op, deviceId, user, createdAt, 'Операцию другого сотрудника может отправить только он сам или владелец')
      }
      const acc: any = await this.accounts.get(op.accountId)
      performer =
        acc && acc.pharmacyId === user.pharmacyId
          ? { accountId: acc.id, role: acc.role, tenantUserId: acc.tenantUserId ?? null, permissions: permissionsOf(acc) }
          : // Сотрудника уже удалили — операция остаётся, просто без имени; права — как у кассира
            { accountId: op.accountId, role: 'cashier', tenantUserId: null, permissions: CASHIER_DEFAULT }
    }
    // Права на операцию — те же, что на сайте: по роли того, кто её сделал
    for (const alternatives of requiredPermissions(type, op.payload)) {
      if (!hasPerm(performer, ...alternatives)) return this.reject(op, deviceId, user, createdAt, 'Недостаточно прав')
    }

    const ctx: Ctx = { deviceId, tenantUserId: performer.tenantUserId, flagged: false, extra: new Set() }
    try {
      const docId = await this.prisma.$transaction(async (tx) => {
        // Первым делом — номер операции. Если она уже принята (или принимается
        // прямо сейчас соседним запросом), транзакция упадёт на уникальности
        // и ничего не запишет
        await tx.syncOp.create({
          data: { id: op.id, type, deviceId, accountId: performer.accountId, submittedBy: user.sub, createdAt, status: 'ok' },
        })
        const doc = await this.apply(tx, type, op.payload, ctx)
        if (doc) await tx.syncOp.update({ where: { id: op.id }, data: { docId: doc } })
        return doc
      }, TX)
      ;(TOUCHES[type] || []).forEach((k) => touched.add(k))
      ctx.extra.forEach((k) => touched.add(k))
      if (ctx.flagged) touched.add('discrepancies')
      return { id: op.id, status: 'ok', docId: docId ?? null }
    } catch (e: any) {
      // Отказ по существу — запоминаем, чтобы повтор получил тот же ответ
      if (e instanceof Reject) return this.reject(op, deviceId, user, createdAt, e.message, performer.accountId)
      if (e instanceof HttpException && e.getStatus() < 500) {
        const r: any = e.getResponse()
        const msg = typeof r === 'string' ? r : Array.isArray(r?.message) ? r.message.join(', ') : r?.message || e.message
        return this.reject(op, deviceId, user, createdAt, String(msg), performer.accountId)
      }
      // Та же операция пришла двумя запросами разом — второй видит уникальность
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const now = await this.prisma.syncOp.findUnique({ where: { id: op.id } })
        if (now) return this.replay(now)
      }
      // База отказала из-за самих данных операции — повтор ничего не изменит
      if (isDataError(e)) {
        this.log.error(`операция ${op.id} (${type}) не помещается в базу: ${e?.code || ''} ${e?.message || e}`)
        return this.reject(op, deviceId, user, createdAt, 'Операцию нельзя записать: её данные не помещаются в базу', performer.accountId)
      }
      // Всё остальное — беда не в операции, а в сервере или базе. Пусть пришлют ещё раз
      this.log.error(`операция ${op.id} (${type}) не записалась: ${e?.code || ''} ${e?.message || e}`)
      return { id: op.id, status: 'retry', error: 'Сервер не смог записать операцию. Она будет отправлена повторно.' }
    }
  }

  private replay(seen: { id: string; status: string; error: string; docId: string | null }): OpResult {
    return seen.status === 'ok'
      ? { id: seen.id, status: 'duplicate', docId: seen.docId }
      : { id: seen.id, status: 'rejected', error: seen.error }
  }

  private async reject(op: PushOpDto, deviceId: string, user: SyncUser, createdAt: Date, error: string, accountId?: string): Promise<OpResult> {
    try {
      await this.prisma.syncOp.create({
        data: {
          id: op.id,
          type: String(op.type).slice(0, 40),
          deviceId,
          accountId: accountId ?? op.accountId ?? user.sub,
          submittedBy: user.sub,
          createdAt,
          status: 'rejected',
          error: error.slice(0, 500),
        },
      })
    } catch (e: any) {
      // Запись об отказе уже есть (повтор) — не беда. Другая ошибка — отказ всё
      // равно возвращаем: касса не должна слать отвергнутое по кругу
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
        this.log.error(`отказ по операции ${op.id} не записался: ${e?.message || e}`)
      }
    }
    this.log.warn(`операция ${op.id} (${op.type}) отвергнута: ${error}`)
    return { id: op.id, status: 'rejected', error }
  }

  private apply(tx: Tx, type: OpType, payload: any, ctx: Ctx): Promise<string | null> {
    switch (type) {
      case 'sale':
        return this.applySale(tx, parseSale(payload), ctx)
      case 'return':
        return this.applyReturn(tx, parseReturn(payload), ctx)
      case 'writeoff':
        return this.applyWriteOff(tx, parseWriteOff(payload), ctx)
      case 'arrival':
        return this.applyArrival(tx, parseArrival(payload), ctx)
      case 'shift.open':
        return this.applyShiftOpen(tx, parseShiftOpen(payload), ctx)
      case 'shift.close':
        return this.applyShiftClose(tx, parseShiftClose(payload), ctx)
      case 'debt.pay':
        return this.applyDebtPay(tx, parseDebtPay(payload), ctx)
      case 'customer.create':
        return this.applyCustomer(tx, parseCustomer(payload))
      case 'deferred.add':
        return this.applyDeferredAdd(tx, parseDeferredAdd(payload))
      case 'deferred.remove':
        return this.applyDeferredRemove(tx, parseDeferredRemove(payload))
      case 'expense':
        return this.applyExpense(tx, parseExpense(payload), ctx)
      case 'cash.move':
        return this.applyCashMove(tx, parseCashMove(payload), ctx)
    }
  }

  // Смена, к которой привязан документ. Её могло не оказаться (операцию открытия
  // отвергли) — тогда документ остаётся без смены, но сам не теряется.
  // Смена — только своя: вписать чек в отчёт соседней кассы или сайта касса не может
  //
  // Смена берётся под замок. Её могут в эту же секунду закрывать с сайта, а итоги
  // закрытия обязаны учесть этот документ: либо закрытие дождётся нас и посчитает
  // с ним, либо мы увидим смену уже закрытой и пересчитаем итоги сами (recountClosed)
  private async shiftRef(tx: Tx, shiftId: string | null, ctx: Ctx): Promise<string | null> {
    if (!shiftId) return null
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Shift" WHERE "id" = ${shiftId} AND "deviceId" = ${ctx.deviceId} FOR UPDATE`
    return rows[0]?.id ?? null
  }

  // ── Какие пересчёты уже учли операцию ──
  // По каждому товару — первый пересчёт после момента операции (см. common/counted.ts).
  // Листы этих пересчётов сразу берутся под замок: их итог будет поправляться, и две
  // кассы, приславшие операции по разным товарам одного листа, должны делать это по
  // очереди. Замок на листы — после замка на товары и до всего остального.
  private async countsAfter(tx: Tx, productIds: string[], moment: Date): Promise<Map<string, Count>> {
    const counted = await firstCountAfter(tx, productIds, moment)
    await lockInventories(tx, [...counted.values()].map((c) => c.inventoryId))
    return counted
  }

  // ── Операция пришла после пересчёта остатка ──
  // delta — на сколько штук она изменила бы остаток: минус — товар ушёл, плюс — пришёл.
  // Остаток не двигаем: пересчёт её уже учёл. Но сам пересчёт считал «сколько должно
  // быть» без этой операции — и записал в недостачу то, что на самом деле продано
  // (или не увидел недостачи, которую закрыл неучтённый приход). Поэтому итог листа
  // инвентаризации поправляется: «должно было быть» и недостача по этому товару.
  // У правки остатка в карточке листа нет — там поправлять нечего.
  //
  // «Должно было быть» может временно уйти в минус: продажа пришла раньше прихода,
  // который был до неё. Обрезать его нулём нельзя — итог зависел бы от того, в каком
  // порядке кассы прислали свои операции: продали 5 при двух на учёте (стало бы 0),
  // потом дошёл приход 10 — вышло бы 10 вместо 7, и три штуки записались бы недостачей,
  // которой не было.
  private async absorb(tx: Tx, ctx: Ctx, doc: { id: string; date: Date }, count: Count, product: { id: string; name: string }, delta: number) {
    await this.flag(tx, ctx, doc, { kind: 'counted', productId: product.id, name: product.name, units: Math.abs(delta) })
    if (!count.inventoryId || !count.itemId) return
    const item = await tx.inventoryItem.findUnique({ where: { id: count.itemId } })
    if (!item || item.inventoryId !== count.inventoryId || item.actualUnits === null) return
    const expected = item.expectedUnits + delta
    await tx.inventoryItem.update({ where: { id: item.id }, data: { expectedUnits: expected } })
    await this.setShortage(tx, count, product.id, Math.max(0, expected - item.actualUnits))
    ctx.extra.add('writeoffs')
  }

  // Недостача листа инвентаризации по одному товару должна стать такой-то (в штуках).
  // Недостача оформлена списанием — его позиции и сумму и приводим к этому числу.
  // Лист к этому моменту под замком (countsAfter): сумму списания читают и пишут по одному.
  private async setShortage(tx: Tx, count: Count, productId: string, target: number) {
    const inventoryId = count.inventoryId!
    const product = await tx.product.findUnique({ where: { id: productId } })
    if (!product) return
    // Цена штуки — как при применении листа: по числу штук в упаковке на тот момент
    const upp = count.upp ?? uppOf(product)
    let doc = await shortageDocOf(tx, inventoryId)
    const mine = (doc?.items || []).filter((i) => i.productId === productId).map((i) => ({ id: i.id, units: i.units, cost: i.cost }))
    const booked = mine.reduce((s, i) => s + i.units, 0)
    if (target === booked) return

    // Сколько стоят позиции этого товара в списании — до дирама, как хранится сумма.
    // Сумма списания меняется на разницу «стало − было». Считать её по штуке (отнять
    // цену одной, округлить, снова отнять…) нельзя: ошибка округления копилась бы с
    // каждой поправкой, и сумма документа разошлась бы с его позициями.
    // Формула — та же, какой недостачу оценило применение листа (shortageWorth): иначе
    // «было» здесь не совпало бы с тем, что лежит в сумме документа
    const worth = (rows: { units: number; cost: Prisma.Decimal }[]) => shortageWorth(rows, upp)
    const before = worth(mine)
    let rows = mine

    if (target < booked) {
      // Убираем с конца: первыми записаны партии с ближайшим сроком — их и оставляем
      let cut = booked - target
      const kept: typeof mine = []
      for (const row of [...mine].reverse()) {
        const take = Math.min(cut, row.units)
        cut -= take
        if (take === row.units) await tx.writeOffItem.delete({ where: { id: row.id } })
        else {
          if (take > 0) await tx.writeOffItem.update({ where: { id: row.id }, data: { units: row.units - take } })
          kept.push({ ...row, units: row.units - take })
        }
      }
      rows = kept
    } else {
      if (!doc) {
        // Недостачи у листа не было вовсе — теперь есть
        const inv = await tx.inventory.findUnique({ where: { id: inventoryId }, select: { userId: true, appliedAt: true } })
        doc = await tx.writeOff.create({
          data: { userId: inv?.userId ?? null, date: inv?.appliedAt ?? new Date(), reason: 'lost', source: 'inventory', note: 'Недостача по итогам пересчёта', totalCost: 0 },
          include: { items: true },
        })
        await rememberShortageDoc(tx, inventoryId, doc.id)
      }
      const add = target - booked
      // Цена в строке — за упаковку ТОГО размера, каким он был при применении листа:
      // по нему оценены остальные строки документа. Нынешняя цена штуки, умноженная на
      // прежнее число штук в упаковке, — иначе после правки карточки (упаковка стала
      // вдвое больше и вдвое дороже) новая строка стоила бы вдвое больше, чем должна
      const packCost = D(product.cost).dividedBy(uppOf(product)).times(upp).toDecimalPlaces(2)
      const made = await tx.writeOffItem.create({ data: { writeOffId: doc.id, productId, name: product.name, units: add, cost: packCost, expiryDate: null } })
      rows = [...mine, { id: made.id, units: made.units, cost: made.cost }]
    }
    if (!doc) return
    if ((await tx.writeOffItem.count({ where: { writeOffId: doc.id } })) === 0) {
      // Вся «недостача» оказалась проданной — списания не остаётся
      await tx.writeOff.delete({ where: { id: doc.id } })
      await forgetShortageDoc(tx, inventoryId)
    } else {
      const totalCost = D(doc.totalCost).minus(before).plus(worth(rows))
      await tx.writeOff.update({ where: { id: doc.id }, data: { totalCost: Prisma.Decimal.max(0, totalCost) } })
    }
  }

  // Записать расхождение — то, на что владельцу стоит посмотреть
  private async flag(tx: Tx, ctx: Ctx, doc: { id: string; date: Date }, data: Flag) {
    await tx.discrepancy.create({
      data: { ...data, productId: data.productId ?? null, docId: doc.id, deviceId: ctx.deviceId, userId: ctx.tenantUserId, date: doc.date },
    })
    ctx.flagged = true
  }

  // ── Цена в документе и цена в базе ──
  // На сайте кассир цену не выбирает: её берёт сервер. Касса без интернета присылает
  // цену сама — ту, что знала в момент продажи. Сервер сверяет её с историей цен:
  // была ли у товара такая цена в тот момент. Не было — значит, касса продавала по
  // устаревшей цене (её сменили, пока не было связи) или цену подправили на самой
  // кассе. Отличить одно от другого сервер не может. Поэтому чек он принимает —
  // тот уже напечатан, — а расхождение показывает владельцу: он-то знает, менял ли цену.
  private async checkPrices(tx: Tx, ctx: Ctx, doc: { id: string; date: Date }, lines: PricedLine[]) {
    const ids = [...new Set(lines.map((l) => l.productId))]
    if (!ids.length) return
    const history = await tx.priceLog.findMany({ where: { productId: { in: ids } }, orderBy: [{ at: 'asc' }, { seq: 'asc' }] })
    const byProduct = new Map<string, typeof history>()
    for (const h of history) {
      if (!byProduct.has(h.productId)) byProduct.set(h.productId, [])
      byProduct.get(h.productId)!.push(h)
    }

    const from = doc.date.getTime() - PRICE_SLACK_MS
    const to = doc.date.getTime() + PRICE_SLACK_MS
    for (const l of lines) {
      const rows = byProduct.get(l.productId)
      // Истории нет — сверять не с чем
      if (!rows?.length) continue
      // Цены, действовавшие около момента продажи: та, что была к его началу
      // (а если история начинается позже — самая ранняя), и все смены внутри
      const before = rows.filter((h) => h.at.getTime() <= from)
      const valid = [before.length ? before[before.length - 1] : rows[0], ...rows.filter((h) => h.at.getTime() > from && h.at.getTime() <= to)]
      // Сравниваем цену за штуку: число штук в упаковке тоже могли сменить.
      // Перемножением, а не делением — чтобы не упереться в округление
      if (valid.some((h) => D(l.price).times(h.unitsPerPack).equals(D(h.price).times(l.unitsPerPack)))) continue
      const base = valid[valid.length - 1]
      await this.flag(tx, ctx, doc, {
        kind: 'price',
        productId: l.productId,
        name: l.name,
        units: l.units,
        checkPrice: cents(D(l.price)),
        // Цена из базы — в пересчёте на упаковку того же размера, что в документе
        basePrice: cents(D(base.price).dividedBy(base.unitsPerPack).times(l.unitsPerPack)),
      })
    }
  }

  // Клиент под замком: долг читается и записывается так, что вторая операция с тем же
  // клиентом ждёт первую. Иначе два погашения, пришедшие разом с двух касс, прочли бы
  // один и тот же долг — и одно из них пропало бы
  private async lockCustomer(tx: Tx, id: string): Promise<{ name: string; debt: Prisma.Decimal } | null> {
    const rows = await tx.$queryRaw<{ name: string; debt: Prisma.Decimal }[]>`SELECT "name", "debt" FROM "Customer" WHERE "id" = ${id} FOR UPDATE`
    return rows[0] ? { name: rows[0].name, debt: D(rows[0].debt) } : null
  }

  // Документ пришёл в смену, которая уже закрыта (владелец закрыл её с сайта, а касса
  // всё ещё была без связи). Он сделан в этой смене — значит, должен быть в её итогах
  private async recountClosed(tx: Tx, shiftId: string | null) {
    if (!shiftId) return
    const shift = await tx.shift.findUnique({ where: { id: shiftId } })
    if (!shift?.closedAt) return
    await tx.shift.update({ where: { id: shift.id }, data: await shiftTotals(tx, shift, shift.countedCash ?? 0) })
  }

  // ── Продажа ──
  private async applySale(tx: Tx, p: ReturnType<typeof parseSale>, ctx: Ctx): Promise<string> {
    const already = await tx.sale.findFirst({
      where: { OR: [{ id: p.id }, ...(p.clientId ? [{ clientId: p.clientId }] : [])] },
      select: { id: true },
    })
    if (already) return already.id

    // Суммы пересчитываем по позициям чека — той же формулой, что и при продаже
    // на сайте. Не сошлось с тем, что прислала касса, — чек испорчен или подделан
    let total = D(0)
    let cost = D(0)
    const lines = p.items.map((i) => {
      const units = i.qty * i.unitsPerPack + i.pieces
      const gross = D(i.price).dividedBy(i.unitsPerPack).times(units)
      const discount = Prisma.Decimal.min(Prisma.Decimal.max(0, D(i.discount)), gross)
      total = total.plus(gross.minus(discount))
      cost = cost.plus(D(i.cost).dividedBy(i.unitsPerPack).times(units))
      return { ...i, units, discount }
    })
    // Скидку, срезанную до суммы позиции, касса считает точно, а присылает уже
    // округлённой — и итог расходится на дирам с позиции. Это не порча и не подделка.
    // Чек напечатан с суммой кассы — она и записывается; отказ — когда разница больше
    const slack = D(0.01).times(lines.length)
    if (cents(total).minus(p.total).abs().gt(slack) || cents(cost).minus(p.cost).abs().gt(slack)) {
      throw new Reject('Суммы чека не сходятся с его позициями')
    }
    total = D(p.total)
    cost = D(p.cost)

    const ids = [...new Set(lines.map((l) => l.productId))]
    await lockProducts(tx, ids)
    const known = new Map((await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((x) => [x.id, x]))

    await this.checkPrices(
      tx,
      ctx,
      p,
      lines.filter((l) => known.has(l.productId)).map((l) => ({ ...l, name: known.get(l.productId)!.name })),
    )

    const unitsById = new Map<string, number>()
    for (const l of lines) unitsById.set(l.productId, (unitsById.get(l.productId) || 0) + l.units)
    // Остаток этих товаров пересчитали уже после продажи: пересчёт её учёл
    const counted = await this.countsAfter(tx, ids, p.date)

    // Списываем годные партии с ближайшим сроком — сколько есть. Чего не хватило,
    // записываем отдельно: товар уже отдан покупателю, и чек от этого не отменить
    for (const [productId, units] of unitsById) {
      const product = known.get(productId)
      // Товар убрали из справочника, пока чек ждал отправки. Чек остаётся, списывать нечего
      if (!product) continue
      if (units > MAX_UNITS) throw new Reject('В чеке слишком большое количество')
      const count = counted.get(productId)
      if (count) {
        await this.absorb(tx, ctx, p, count, product, -units)
        continue
      }
      const { short } = await consumeUnitsTolerant(tx, productId, units, { skipExpired: true, atDate: p.date })
      if (short > 0) await this.flag(tx, ctx, p, { kind: 'sale', productId, name: product.name, units: short })
    }

    let customerId: string | null = null
    if (p.payment === 'debt') {
      if (!p.customerId) throw new Reject('Для продажи в долг укажите клиента')
      const c = await tx.customer.findUnique({ where: { id: p.customerId }, select: { id: true } })
      if (!c) throw new Reject('Клиент не найден')
      await tx.customer.update({ where: { id: c.id }, data: { debt: { increment: total } } })
      customerId = c.id
    }

    const shiftId = await this.shiftRef(tx, p.shiftId, ctx)
    await tx.sale.create({
      data: {
        id: p.id,
        clientId: p.clientId,
        date: p.date,
        total,
        cost,
        profit: total.minus(cost),
        payment: p.payment,
        payVia: p.payVia,
        customerId,
        shiftId,
        userId: ctx.tenantUserId,
        items: {
          create: lines.map((l) => ({
            id: l.id,
            productId: known.has(l.productId) ? l.productId : null,
            name: l.name,
            qty: l.qty,
            pieces: l.pieces,
            unitsPerPack: l.unitsPerPack,
            price: D(l.price),
            cost: D(l.cost),
            discount: l.discount,
          })),
        },
      },
    })
    await this.recountClosed(tx, shiftId)
    return p.id
  }

  // ── Возврат ──
  private async applyReturn(tx: Tx, p: ReturnType<typeof parseReturn>, ctx: Ctx): Promise<string> {
    const already = await tx.saleReturn.findFirst({
      where: { OR: [{ id: p.id }, ...(p.clientId ? [{ clientId: p.clientId }] : [])] },
      select: { id: true },
    })
    if (already) return already.id

    // Замок на товары — до чтения чека: два возврата одной позиции, пришедшие разом
    // (с двух касс или с кассы и с сайта), должны идти по очереди, и второй обязан
    // увидеть первый — иначе оба решат, что по чеку ещё ничего не возвращали
    const ids = [...new Set(p.items.map((i) => i.productId))]
    await lockProducts(tx, ids)

    const sale = p.saleId
      ? await tx.sale.findUnique({ where: { id: p.saleId }, include: { items: true, returns: { include: { items: true } } } })
      : null
    if (p.saleId && !sale) throw new Reject('Чек не найден')

    // Остаток этих товаров пересчитали уже после возврата: вернувшееся на полку учтено
    const counted = await this.countsAfter(tx, ids, p.date)

    // Сколько по этому чеку уже вернули — другой кассой или на сайте
    const returnedBefore = new Map<string, number>()
    for (const r of sale?.returns || []) {
      for (const ri of r.items) {
        if (ri.productId) returnedBefore.set(ri.productId, (returnedBefore.get(ri.productId) || 0) + ri.units)
      }
    }

    let sum = D(0)
    let lost = D(0)
    const rows: Prisma.SaleReturnItemCreateWithoutRetInput[] = []
    // Возврат без чека: цену касса берёт из карточки товара — её и сверяем с историей
    const unchecked: PricedLine[] = []
    for (const it of p.items) {
      // Карточку читаем на каждой позиции заново: предыдущая могла положить штуки
      // на полку и изменить ближайший срок. Вместе с ней — сроки всех партий товара
      const product = await tx.product.findUnique({ where: { id: it.productId }, include: { batches: { select: { expiryDate: true } } } })
      const line = sale?.items.find((si) => si.productId === it.productId)
      // Товара в чеке нет — такой возврат касса оформить не могла. (Если товар уже
      // убрали из справочника, строка чека потеряла на него ссылку — тогда верим кассе.)
      if (sale && product && !line) throw new Reject(`«${product.name}» нет в этом чеке`)

      // Цена, закупочная и размер упаковки — из чека на сервере, а не из присланного:
      // касса считала возврат по тому же чеку, и расходиться им не с чего
      const upp = line ? uppOf(line) : it.unitsPerPack
      const price = line ? D(line.price) : D(it.price)
      const cost = line ? D(line.cost) : D(it.cost)

      // Вернуть больше, чем за товар заплатили, нельзя — такое число не от кассы.
      // Заплачено за штуку — с учётом скидки на позицию, как считает и сайт
      const soldUnits = line ? line.qty * upp + line.pieces : it.units
      const gross = price.dividedBy(upp).times(soldUnits)
      const paid = line ? gross.minus(D(line.discount)) : gross
      const ceiling = soldUnits > 0 ? paid.dividedBy(soldUnits).times(it.units) : D(0)
      if (D(it.amount).gt(ceiling.plus(0.01))) throw new Reject('Сумма возврата больше цены товара')
      sum = sum.plus(it.amount)

      if (line) {
        // Вернули больше, чем продали: тот же чек уже возвращали на другой кассе
        // или на сайте. Деньги покупателю отданы — записываем, но владелец увидит
        const already = returnedBefore.get(it.productId) || 0
        const over = already + it.units - soldUnits
        if (over > 0) {
          await this.flag(tx, ctx, p, { kind: 'return', productId: it.productId, name: product?.name || it.name, units: Math.min(over, it.units) })
        }
        returnedBefore.set(it.productId, already + it.units)
      } else if (product) {
        unchecked.push({ productId: product.id, name: product.name, price: it.price, unitsPerPack: it.unitsPerPack, units: it.units })
      }

      rows.push({
        id: it.id,
        name: it.name,
        units: it.units,
        unitsPerPack: upp,
        price,
        cost,
        amount: D(it.amount),
        restock: it.restock,
        ...(product ? { product: { connect: { id: product.id } } } : {}),
      })
      if (it.restock) {
        const count = product ? counted.get(product.id) : undefined
        if (product && count) {
          await this.absorb(tx, ctx, p, count, product, it.units)
        } else if (product) {
          // Срок — вписанный кассиром с упаковки. Не вписал — по правилу, и считает его
          // сервер, а не касса: он знает все партии товара, в том числе распроданные,
          // а касса — не все (см. returnExpiry). Истёкший срок здесь не повод для
          // отказа: товар уже принят у покупателя, и на полке он встанет просроченным
          const expiry = it.expiryDate ?? returnExpiry(product.batches, sale?.date ?? p.date, product.expiryDate)
          await addUnits(tx, product.id, it.units, cost, expiry, null, 'Возврат от покупателя')
        }
      } else {
        lost = lost.plus(cost.dividedBy(upp).times(it.units))
      }
    }
    await this.checkPrices(tx, ctx, p, unchecked)
    if (sum.minus(p.total).abs().gt(D(0.01).times(p.items.length))) {
      throw new Reject('Сумма возврата не сходится с его позициями')
    }

    // Возврат «в долг» уменьшает долг клиента. В минус не уводим: если долг успели
    // погасить на сайте, касса зачла больше, чем клиент был должен. Отвергать поздно —
    // товар принят. Но разницу клиенту надо отдать деньгами, и владелец должен это увидеть
    if (p.refund === 'debt' && sale?.customerId) {
      const c = await this.lockCustomer(tx, sale.customerId)
      if (c) {
        if (D(p.total).gt(c.debt)) {
          await this.flag(tx, ctx, p, { kind: 'debt', name: c.name, units: 0, checkPrice: cents(D(p.total)), basePrice: cents(c.debt) })
        }
        const next = Prisma.Decimal.max(0, c.debt.minus(p.total))
        await tx.customer.update({ where: { id: sale.customerId }, data: { debt: next } })
      }
    }

    // Позиции, не вернувшиеся в продажу, — сразу списанием, для учёта убытка
    if (p.writeOff && !(await tx.writeOff.findUnique({ where: { id: p.writeOff.id }, select: { id: true } }))) {
      const have = new Set(
        (await tx.product.findMany({ where: { id: { in: p.writeOff.items.map((i) => i.productId) } }, select: { id: true } })).map((x) => x.id),
      )
      await tx.writeOff.create({
        data: {
          id: p.writeOff.id,
          date: p.date,
          userId: ctx.tenantUserId,
          reason: 'damaged',
          source: 'return',
          note: p.writeOff.note || 'Возврат покупателя без возврата в продажу',
          totalCost: lost,
          items: {
            create: p.writeOff.items.map((i) => ({
              id: i.id,
              productId: have.has(i.productId) ? i.productId : null,
              name: i.name,
              units: i.units,
              cost: D(i.cost),
              expiryDate: i.expiryDate,
            })),
          },
        },
      })
    }

    const shiftId = await this.shiftRef(tx, p.shiftId, ctx)
    await tx.saleReturn.create({
      data: {
        id: p.id,
        clientId: p.clientId,
        date: p.date,
        saleId: sale?.id ?? null,
        userId: ctx.tenantUserId,
        shiftId,
        refund: p.refund,
        refundVia: p.refund === 'transfer' ? p.refundVia || sale?.payVia || null : null,
        total: D(p.total),
        note: p.note,
        items: { create: rows },
      },
    })
    await this.recountClosed(tx, shiftId)
    return p.id
  }

  // ── Списание ──
  private async applyWriteOff(tx: Tx, p: ReturnType<typeof parseWriteOff>, ctx: Ctx): Promise<string | null> {
    if (await tx.writeOff.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id

    const ids = [...new Set(p.ask.map((a) => a.productId))]
    await lockProducts(tx, ids)
    // Остаток этих товаров пересчитали уже после списания: на полке их и не было
    const counted = await this.countsAfter(tx, ids, p.date)

    let totalCost = D(0)
    const rows: Prisma.WriteOffItemUncheckedCreateWithoutWriteOffInput[] = []
    for (const a of p.ask) {
      const product = await tx.product.findUnique({ where: { id: a.productId } })
      if (!product) continue
      const count = counted.get(product.id)
      if (count) {
        // Остаток не двигаем, но само списание — запись об убытке с его причиной — в
        // журнале остаётся. Иначе после правки остатка в карточке убыток не попал бы
        // ни в один отчёт. (Если пересчёт был инвентаризацией, эти же штуки она записала
        // недостачей — и недостача уменьшится на них: убыток считается один раз.)
        totalCost = totalCost.plus(D(product.cost).dividedBy(uppOf(product)).times(a.units))
        rows.push({ productId: product.id, name: product.name, units: a.units, cost: product.cost, expiryDate: null })
        await this.absorb(tx, ctx, p, count, product, -a.units)
        continue
      }
      // Первой уходит партия с ближайшим сроком — в том числе просроченная
      const { taken, short } = await consumeUnitsTolerant(tx, product.id, a.units, { atDate: p.date })
      const upp = uppOf(product)
      for (const t of taken) {
        totalCost = totalCost.plus(D(product.cost).dividedBy(upp).times(t.units))
        rows.push({ productId: product.id, name: product.name, units: t.units, cost: product.cost, expiryDate: t.expiryDate })
      }
      // Списали больше, чем числилось: учёт расходился с полкой ещё до списания
      if (short > 0) await this.flag(tx, ctx, p, { kind: 'writeoff', productId: product.id, name: product.name, units: short })
    }
    // Списывать оказалось нечего — документа не будет, но расхождение записано
    if (!rows.length) return null

    await tx.writeOff.create({
      data: { id: p.id, date: p.date, userId: ctx.tenantUserId, reason: p.reason, note: p.note, source: 'manual', totalCost, items: { create: rows } },
    })
    return p.id
  }

  // ── Приход ──
  private async applyArrival(tx: Tx, p: ReturnType<typeof parseArrival>, ctx: Ctx): Promise<string> {
    if (await tx.arrival.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id

    const ids = [...new Set(p.items.map((i) => i.productId))]
    await lockProducts(tx, ids)
    const byId = new Map((await tx.product.findMany({ where: { id: { in: ids } } })).map((x) => [x.id, x]))
    for (const it of p.items) {
      // Принять товар, которого нет в справочнике, некуда: карточку успели удалить
      if (!byId.has(it.productId)) throw new Reject(`Товар не найден: ${it.name}`)
    }

    // Средневзвешенная цена — один раз на товар, от остатка ДО прихода.
    // Всё в штуках (у весового товара — в граммах): граммы оплачиваются долей цены
    const unitsOf = (it: { qty: number; pieces?: number }, upp: number) => it.qty * upp + Math.max(0, it.pieces || 0)
    const agg = new Map<string, { units: number; value: Prisma.Decimal }>()
    let total = D(0)
    for (const it of p.items) {
      const upp = uppOf(byId.get(it.productId)!)
      const dolya = D(unitsOf(it, upp)).div(upp)
      const a = agg.get(it.productId) || { units: 0, value: D(0) }
      a.units += unitsOf(it, upp)
      a.value = a.value.plus(D(it.cost).times(dolya))
      agg.set(it.productId, a)
      total = total.plus(D(it.cost).times(dolya))
    }
    // Закупочную цену касса присылает как ввели, без округления, и сумма сходится
    // точно. Допуск в дирам на строку — на случай, если по дороге её всё же округлили
    if (cents(total).minus(p.total).abs().gt(D(0.01).times(p.items.length))) throw new Reject('Сумма прихода не сходится с его позициями')
    total = D(p.total)

    for (const it of p.items) {
      if (unitsOf(it, uppOf(byId.get(it.productId)!)) > MAX_UNITS) throw new Reject('В приходе слишком большое количество')
    }
    // Остаток этих товаров пересчитали уже после прихода: привезённое лежало на полке
    // и в пересчёт попало. Документ остаётся, а класть товар второй раз нельзя
    const counted = await this.countsAfter(tx, ids, p.date)
    for (const [productId, a] of agg) {
      const count = counted.get(productId)
      if (!count) continue
      const product = byId.get(productId)!
      await this.absorb(tx, ctx, p, count, product, a.units)
    }

    for (const [productId, a] of agg) {
      if (counted.has(productId)) continue
      const product = byId.get(productId)!
      const weighted = weightedPackCost({
        stock: product.stock,
        looseUnits: product.looseUnits,
        unitsPerPack: product.unitsPerPack,
        cost: product.cost,
        addPacks: Number(D(a.units).div(uppOf(product))),
        addValue: a.value,
      })
      await tx.product.update({ where: { id: productId }, data: { cost: weighted } })
    }

    // Поставщик и неоплаченная часть. Поставщика могли удалить, пока касса была без
    // связи: приход остаётся (товар принят), а долг записать некому — владелец увидит
    // приход без поставщика
    let supplierId: string | null = null
    let supplierName = p.supplier
    let debt = D(0)
    if (p.supplierId) {
      const s = await lockSupplier(tx, p.supplierId)
      if (s) {
        supplierId = s.id
        supplierName = s.name
        debt = Prisma.Decimal.min(D(p.debt), total).toDecimalPlaces(2)
      } else {
        ctx.extra.add('suppliers')
      }
    }
    await tx.arrival.create({
      data: {
        id: p.id,
        date: p.date,
        supplier: supplierName,
        supplierId,
        debt,
        userId: ctx.tenantUserId,
        total,
        items: { create: p.items.map((i) => ({ id: i.id, productId: i.productId, name: i.name, qty: i.qty, pieces: i.pieces || 0, cost: D(i.cost) })) },
      },
    })
    if (supplierId && debt.gt(0)) {
      await tx.supplier.update({ where: { id: supplierId }, data: { debt: { increment: debt } } })
      ctx.extra.add('suppliers')
    }
    for (const it of p.items) {
      if (counted.has(it.productId)) continue
      await addUnits(tx, it.productId, unitsOf(it, uppOf(byId.get(it.productId)!)), D(it.cost), it.expiryDate, p.id)
    }
    return p.id
  }

  // ── Смена кассы ──
  private async applyShiftOpen(tx: Tx, p: ReturnType<typeof parseShiftOpen>, ctx: Ctx): Promise<string> {
    if (await tx.shift.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
    // У кассы одна открытая смена. Вторая означает, что локальную базу кассы
    // стёрли или подменили, — разбираться с этим должен человек
    const open = await tx.shift.findFirst({ where: { deviceId: ctx.deviceId, closedAt: null }, select: { id: true } })
    if (open) throw new Reject('На этой кассе уже открыта другая смена')
    await tx.shift.create({
      data: { id: p.id, openedAt: p.openedAt, openingCash: D(p.openingCash), userId: ctx.tenantUserId, deviceId: ctx.deviceId },
    })
    return p.id
  }

  private async applyShiftClose(tx: Tx, p: ReturnType<typeof parseShiftClose>, ctx: Ctx): Promise<string> {
    await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id" = ${p.id} FOR UPDATE`
    const shift = await tx.shift.findUnique({ where: { id: p.id } })
    // Эти два отказа касса узнаёт по тексту (desktop/src/local/outbox.mjs, SHIFT_GONE):
    // после них она не открывает смену у себя заново — у сервера её для этой кассы нет.
    // Менять слова можно только вместе с ней
    if (!shift) throw new Reject('Смена не найдена')
    if (shift.deviceId !== ctx.deviceId) throw new Reject('Эта смена открыта на другой кассе')
    if (shift.closedAt) return shift.id
    // Итоги считает сервер — по документам, которые к этому моменту уже пришли
    // (они идут в той же очереди раньше закрытия). Формула та же, что у сайта
    const totals = await shiftTotals(tx, shift, p.countedCash)
    await tx.shift.update({ where: { id: shift.id }, data: { closedAt: p.closedAt, ...totals } })
    return shift.id
  }

  // ── Долги и клиенты ──
  private async applyDebtPay(tx: Tx, p: ReturnType<typeof parseDebtPay>, ctx: Ctx): Promise<string> {
    if (await tx.debtPayment.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
    const c = await this.lockCustomer(tx, p.customerId)
    if (!c) throw new Reject('Клиент не найден')
    // Деньги уже в кассе. Долг в минус не уводим — но если клиент заплатил больше, чем
    // был должен (долг успели погасить на сайте или на другой кассе), лишнее надо
    // вернуть. Молча это оставить нельзя: владелец должен увидеть
    if (D(p.amount).gt(c.debt)) {
      await this.flag(tx, ctx, { id: p.id, date: p.createdAt }, { kind: 'debt', name: c.name, units: 0, checkPrice: cents(D(p.amount)), basePrice: cents(c.debt) })
    }
    const next = Prisma.Decimal.max(0, c.debt.minus(p.amount))
    await tx.customer.update({ where: { id: p.customerId }, data: { debt: next } })
    const shiftId = await this.shiftRef(tx, p.shiftId, ctx)
    await tx.debtPayment.create({
      data: { id: p.id, customerId: p.customerId, amount: D(p.amount), shiftId, createdAt: p.createdAt },
    })
    await this.recountClosed(tx, shiftId)
    return p.id
  }

  private async applyCustomer(tx: Tx, p: ReturnType<typeof parseCustomer>): Promise<string> {
    if (await tx.customer.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
    await tx.customer.create({ data: { id: p.id, name: p.name, phone: p.phone, debt: D(p.debt), createdAt: p.createdAt } })
    return p.id
  }

  // ── Расход ──
  // Владелец внёс расход в программе, возможно без связи. Расход «из кассы» ложится в
  // смену этой кассы и уменьшает наличные, которые в ней ждут.
  private async applyExpense(tx: Tx, p: ReturnType<typeof parseExpense>, ctx: Ctx): Promise<string> {
    if (await tx.expense.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
    // Смены сервер может не знать (её открытие он не принял). Расход всё равно
    // остаётся: деньги потрачены, и пропасть из отчётов из-за смены он не должен —
    // просто смена у него не указана
    const shiftId = p.fromCash ? await this.shiftRef(tx, p.shiftId, ctx) : null
    await tx.expense.create({
      data: { id: p.id, date: p.date, category: p.category, amount: D(p.amount), note: p.note, fromCash: p.fromCash, shiftId, userId: ctx.tenantUserId },
    })
    if (shiftId) {
      await setExpenseCash(tx, shiftId)
      // Смену могли закрыть раньше, чем расход дошёл (её закрыл владелец с сайта) —
      // тогда итоги закрытой смены пересчитываются вместе с ним
      await this.recountClosed(tx, shiftId)
    }
    return p.id
  }

  // ── Внесение и изъятие наличных ──
  // Операция живёт в смене: без неё денег не внести и не изъять. Смену сервер может
  // не знать (её открытие он отверг) — тогда отвергается и это, и владелец увидит
  private async applyCashMove(tx: Tx, p: ReturnType<typeof parseCashMove>, ctx: Ctx): Promise<string> {
    if (await tx.cashMove.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
    const shiftId = await this.shiftRef(tx, p.shiftId, ctx)
    if (!shiftId) throw new Reject('Смена не найдена')
    await tx.cashMove.create({
      data: { id: p.id, shiftId, kind: p.kind, amount: D(p.amount), note: p.note, userId: ctx.tenantUserId, date: p.date },
    })
    await setCashMoves(tx, shiftId)
    await this.recountClosed(tx, shiftId)
    return p.id
  }

  // ── Отложенные штрихкоды ──
  private async applyDeferredAdd(tx: Tx, p: ReturnType<typeof parseDeferredAdd>): Promise<string | null> {
    // Пока касса была без связи, товар с этим штрихкодом могли уже завести
    if (await tx.product.findUnique({ where: { barcode: p.barcode }, select: { id: true } })) return null
    const row = await tx.deferredBarcode.upsert({
      where: { barcode: p.barcode },
      update: {},
      create: { id: p.id, barcode: p.barcode, createdAt: p.createdAt },
    })
    return row.id
  }

  private async applyDeferredRemove(tx: Tx, p: ReturnType<typeof parseDeferredRemove>): Promise<string | null> {
    await tx.deferredBarcode.deleteMany({ where: { OR: [{ id: p.id }, ...(p.barcode ? [{ barcode: p.barcode }] : [])] } })
    return null
  }

  // ── Касса отметилась ──
  async touchDevice(deviceId: string, user: SyncUser, appVersion = '', key?: string) {
    await this.checkKey(deviceId, key)
    const data = { lastSeenAt: new Date(), lastLogin: user.name || '', appVersion: String(appVersion || '').slice(0, 40) }
    const known = await this.prisma.device.findUnique({ where: { id: deviceId } })
    if (known) return this.prisma.device.update({ where: { id: deviceId }, data })
    try {
      const n = await this.prisma.device.count()
      return await this.prisma.device.create({ data: { id: deviceId, name: `Касса ${n + 1}`, ...data } })
    } catch (e: any) {
      // Два первых запроса одной кассы разом — второй видит уже созданную запись
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.device.update({ where: { id: deviceId }, data })
      }
      throw e
    }
  }

  // ── Ключ кассы ──
  // Номер кассы знают все сотрудники аптеки: он стоит в сменах, а смены получает каждая
  // касса. Одного номера мало, чтобы говорить от имени кассы. При первом обмене касса
  // называет свой ключ — он создан на ней и никуда, кроме сервера, не уходит. Сервер
  // запоминает отпечаток ключа и дальше принимает под этим номером только того, кто
  // назвал тот же ключ. Иначе кассир с соседней кассы закрыл бы чужую смену или
  // вписал в неё свои чеки.
  private async checkKey(deviceId: string, key?: string) {
    if (key && !KEY_OK.test(key)) throw new BadRequestException('Недопустимый ключ кассы')
    const name = KEY + deviceId
    const print = key ? createHash('sha256').update(key).digest('hex') : ''
    const refuse = () => new ConflictException('Номер этой кассы закреплён за другой установкой программы. Обратитесь к поставщику программы.')
    const have = (await this.prisma.syncMeta.findUnique({ where: { key: name } }))?.value
    if (have) {
      if (print !== have) throw refuse()
      return
    }
    // Ключа нет ни у нас, ни в запросе — так ходят проверки и старые сборки
    if (!print) return
    try {
      await this.prisma.syncMeta.create({ data: { key: name, value: print } })
    } catch (e: any) {
      // Два первых запроса кассы разом: второй видит уже записанный отпечаток
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
      const now = (await this.prisma.syncMeta.findUnique({ where: { key: name } }))?.value
      if (now !== print) throw refuse()
    }
  }

  // ── Что изменилось с прошлого раза ──
  async pull(q: { cursor?: string; wcursor?: string; deviceId: string; appVersion?: string; ops?: string }, user: SyncUser, key?: string) {
    const device = await this.touchDevice(q.deviceId, user, q.appVersion, key)
    await this.forgetIfRewound()
    await this.pruneIfDue()

    // Журнал списаний и расходы сервер отдаёт только владельцу — как и на сайте
    const scope = pullScope(user)
    const asked = mark(q.cursor)
    // Пока за кассой работал кассир, списания и расходы менялись мимо неё: в его обменах
    // этих разделов нет, а общая отметка двигалась. Владелец добирает их со своей отметки.
    // Поставщиков кассир получает, но без долгов — их владелец тоже добирает заново
    const askedW = scope.wide ? mark(q.wcursor) : null
    const markKey = MARK + q.deviceId
    // Операции, которые касса отправляла, а ответа не дождалась: она спрашивает,
    // приняты ли они. Ответ берётся из того же снимка, что и данные, — поэтому касса
    // точно знает, какие из её операций в этих данных уже есть, а какие ещё нет
    const askedOps = [...new Set(String(q.ops || '').split(','))].filter((x) => OP_ID.test(x)).slice(0, MAX_ASKED)

    // Один снимок на всё: и «до какой транзакции смотрим», и сами данные берутся
    // из одного состояния базы. Иначе между двумя запросами могла бы вклиниться
    // продажа, и её изменения касса не увидела бы никогда
    const snap = await this.prisma.$transaction(async (tx) => {
      // Все транзакции с номером меньше этого уже завершены и видны. Те, что
      // ещё идут, касса заберёт в следующий раз — их номера не меньше
      const [{ horizon }] = await tx.$queryRaw<{ horizon: bigint }[]>`SELECT txid_snapshot_xmin(txid_current_snapshot()) AS horizon`
      const fates = askedOps.length
        ? await tx.syncOp.findMany({ where: { id: { in: askedOps }, deviceId: q.deviceId }, select: { id: true, status: true, error: true, docId: true } })
        : []
      const meta = new Map((await tx.syncMeta.findMany({ where: { key: { in: ['prunedTxid', markKey] } } })).map((m) => [m.key, m.value]))
      // Досылать изменения или отдать всё заново — см. cursor.ts
      const since = sinceOf({
        asked,
        askedW,
        pruned: BigInt(meta.get('prunedTxid') || '0'),
        horizon,
        // Отметка, которую сервер выдал этой кассе в прошлый раз
        given: mark(meta.get(markKey)),
      })
      if (since === null) return { full: true, cursor: horizon, fates, data: trimPull(await this.loadAll(tx, scope.wide), scope) }

      // Берём всё, что видно, начиная с отметки, — а не только «до горизонта». Записи
      // читаются в нынешнем виде, со всеми завершёнными операциями, и касса должна
      // получить каждую, которую они затронули: она только что отправила чек и вправе
      // увидеть его в ответе, даже если где-то рядом ещё идёт давно начатая чужая
      // операция и держит горизонт. Что завершилось позже горизонта, придёт и в
      // следующий раз — второй раз те же записи, от этого ничего не портится
      const rows = await tx.$queryRaw<{ tbl: string; rowId: string; op: string }[]>`
        SELECT "tbl", "rowId", "op" FROM "ChangeLog" WHERE "txid" >= ${since} ORDER BY "seq"`
      if (askedW !== null && askedW < since) {
        rows.push(
          ...(await tx.$queryRaw<{ tbl: string; rowId: string; op: string }[]>`
            SELECT "tbl", "rowId", "op" FROM "ChangeLog"
            WHERE "tbl" IN ('WriteOff', 'Expense', 'ExpenseCategory', 'SupplierPayment', 'Supplier') AND "txid" >= ${askedW} AND "txid" < ${since} ORDER BY "seq"`),
        )
      }
      if (rows.length > MAX_CHANGES) return { full: true, cursor: horizon, fates, data: trimPull(await this.loadAll(tx, scope.wide), scope) }
      return { full: false, cursor: horizon, fates, data: trimPull(await this.loadChanged(tx, rows, scope.wide), scope) }
    }, TX_SNAPSHOT)

    // Запоминаем, что выдали. Не записалось — не беда: следующий обмен этой кассы
    // будет полным, и только
    const cursor = snap.cursor.toString()
    try {
      await this.prisma.syncMeta.upsert({ where: { key: markKey }, update: { value: cursor }, create: { key: markKey, value: cursor } })
    } catch (e: any) {
      this.log.warn(`отметка кассы ${q.deviceId} не записалась: ${e?.message || e}`)
    }

    const me = await this.auth.me(user.sub, null)
    return {
      full: snap.full,
      // Числом в JSON такое не передать: оно больше, чем умеет JavaScript
      cursor,
      serverTime: new Date().toISOString(),
      device: { id: device.id, name: device.name },
      me: { ...me, tenantUserId: user.tenantUserId ?? null },
      // Судьба операций, о которых спросила касса. Нет в списке — сервер её не принимал
      ops: Object.fromEntries(
        snap.fates.map((f) => [f.id, f.status === 'ok' ? { status: 'ok', docId: f.docId } : { status: 'rejected', error: f.error }]),
      ),
      data: snap.data,
    }
  }

  // ── Давний чек — для возврата на кассе ──
  // Касса держит у себя чеки за два месяца. Товар могут принести и позже: тогда она
  // забирает чек (и прежние возвраты по нему) отсюда и оформляет возврат у себя, как
  // любой другой, — в своей смене и из своего денежного ящика
  async saleForReturn(id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: saleInclude })
    if (!sale) throw new NotFoundException('Чек не найден')
    const returns = await this.prisma.saleReturn.findMany({ where: { saleId: id }, include: withUser })
    return { sale, returns }
  }

  private async loadAll(tx: Tx, founder: boolean) {
    const salesFrom = new Date(Date.now() - SALES_DAYS * DAY)
    const journalFrom = new Date(Date.now() - JOURNAL_DAYS * DAY)
    const all = <T>(rows: T[]) => ({ upsert: rows, remove: [] as string[] })
    return {
      products: all(await tx.product.findMany({ orderBy: { name: 'asc' } })),
      batches: all(await tx.batch.findMany({ where: { units: { gt: 0 } } })),
      categories: all(await tx.category.findMany({ orderBy: { name: 'asc' } })),
      customers: all(await tx.customer.findMany({ orderBy: { createdAt: 'desc' } })),
      deferred: all(await tx.deferredBarcode.findMany({ orderBy: { createdAt: 'desc' } })),
      shifts: all(await withDeviceNames(tx, await tx.shift.findMany({ orderBy: { openedAt: 'desc' }, include: { user: { select: { id: true, name: true } } } }))),
      sales: all(await tx.sale.findMany({ where: { date: { gte: salesFrom } }, include: saleInclude, orderBy: { date: 'desc' } })),
      returns: all(await tx.saleReturn.findMany({ where: { date: { gte: journalFrom } }, include: withUser, orderBy: { date: 'desc' } })),
      arrivals: all(await tx.arrival.findMany({ where: { date: { gte: journalFrom } }, include: { items: true }, orderBy: { date: 'desc' } })),
      // Поставщики нужны приходу — всем; долги в них видит только владелец
      suppliers: all((await tx.supplier.findMany({ orderBy: { name: 'asc' } })).map((s) => (founder ? s : supplierBrief(s)))),
      payServices: all(await tx.payService.findMany({ orderBy: [{ ord: 'asc' }, { name: 'asc' }] })),
      cashMoves: all(await tx.cashMove.findMany({ where: { date: { gte: journalFrom } }, include: userOnly, orderBy: { date: 'desc' } })),
      ...(founder
        ? {
            writeoffs: all(await tx.writeOff.findMany({ where: { date: { gte: journalFrom } }, include: withUser, orderBy: { date: 'desc' } })),
            supplierPayments: all(
              await tx.supplierPayment.findMany({
                where: { date: { gte: journalFrom } },
                include: { ...userOnly, supplier: { select: { id: true, name: true } } },
                orderBy: { date: 'desc' },
              }),
            ),
            // Расходы и их статьи — тоже только владельцу. Кассиру от них нужна одна
            // сумма «из кассы», и она приходит внутри самой смены (expenseCash)
            expenses: all(await tx.expense.findMany({ where: { date: { gte: journalFrom } }, include: { user: { select: { id: true, name: true } } }, orderBy: { date: 'desc' } })),
            expenseCategories: all(await tx.expenseCategory.findMany({ orderBy: { name: 'asc' } })),
          }
        : {}),
      payments: all(
        await tx.debtPayment.findMany({
          where: { createdAt: { gte: journalFrom } },
          include: { customer: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ),
    }
  }

  private async loadChanged(tx: Tx, rows: { tbl: string; rowId: string; op: string }[], founder: boolean) {
    // По каждой таблице — какие записи затронуты (что именно с ними было, неважно:
    // касса получит их нынешний вид, а исчезнувшие — списком на удаление)
    const ids = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!ids.has(r.tbl)) ids.set(r.tbl, new Set())
      ids.get(r.tbl)!.add(r.rowId)
    }

    const load = async <T extends { id: string }>(tbl: string, find: (part: string[]) => Promise<T[]>) => {
      const wanted = [...(ids.get(tbl) || [])]
      const upsert: T[] = []
      for (const part of chunks(wanted)) upsert.push(...(await find(part)))
      const found = new Set(upsert.map((x) => x.id))
      return { upsert, remove: wanted.filter((id) => !found.has(id)) }
    }
    const inIds = (part: string[]) => ({ id: { in: part } })

    return {
      products: await load('Product', (part) => tx.product.findMany({ where: inIds(part) })),
      batches: await load('Batch', (part) => tx.batch.findMany({ where: inIds(part) })),
      categories: await load('Category', (part) => tx.category.findMany({ where: inIds(part) })),
      customers: await load('Customer', (part) => tx.customer.findMany({ where: inIds(part) })),
      deferred: await load('DeferredBarcode', (part) => tx.deferredBarcode.findMany({ where: inIds(part) })),
      shifts: await load('Shift', async (part) =>
        withDeviceNames(tx, await tx.shift.findMany({ where: inIds(part), include: { user: { select: { id: true, name: true } } } })),
      ),
      sales: await load('Sale', (part) => tx.sale.findMany({ where: inIds(part), include: saleInclude })),
      returns: await load('SaleReturn', (part) => tx.saleReturn.findMany({ where: inIds(part), include: withUser })),
      arrivals: await load('Arrival', (part) => tx.arrival.findMany({ where: inIds(part), include: { items: true } })),
      suppliers: await load('Supplier', async (part) => (await tx.supplier.findMany({ where: inIds(part) })).map((s) => (founder ? s : supplierBrief(s)))),
      payServices: await load('PayService', (part) => tx.payService.findMany({ where: inIds(part) })),
      cashMoves: await load('CashMove', (part) => tx.cashMove.findMany({ where: inIds(part), include: userOnly })),
      ...(founder
        ? {
            writeoffs: await load('WriteOff', (part) => tx.writeOff.findMany({ where: inIds(part), include: withUser })),
            supplierPayments: await load('SupplierPayment', (part) =>
              tx.supplierPayment.findMany({ where: inIds(part), include: { ...userOnly, supplier: { select: { id: true, name: true } } } }),
            ),
            expenses: await load('Expense', (part) => tx.expense.findMany({ where: inIds(part), include: { user: { select: { id: true, name: true } } } })),
            expenseCategories: await load('ExpenseCategory', (part) => tx.expenseCategory.findMany({ where: inIds(part) })),
          }
        : {}),
      payments: await load('DebtPayment', (part) =>
        tx.debtPayment.findMany({ where: inIds(part), include: { customer: { select: { name: true } } } }),
      ),
    }
  }

  // ── Счёт транзакций начался заново ──
  // Журнал изменений и отметки касс держатся на номерах транзакций базы, а они только
  // растут. Но если базу подняли из копии на новом месте, счёт начинается сначала —
  // а журнал и отметки приехали из прежней базы, с прежними, большими номерами.
  // Узнать это просто: в журнале есть записи «из будущего» — с номером транзакции,
  // которой в этой базе ещё не было. Сверять с таким журналом нечего: выбрасываем
  // его вместе с отметками, и каждая касса заберёт всё заново. Без этого кассы
  // получали бы всю аптеку при каждом обмене — пока новый счёт не догонит прежний.
  private async forgetIfRewound() {
    try {
      const [{ rewound }] = await this.prisma.$queryRaw<{ rewound: boolean }[]>`
        SELECT COALESCE((SELECT max("txid") FROM "ChangeLog") >= txid_snapshot_xmax(txid_current_snapshot()), false)
            OR COALESCE(
                 (SELECT max("value"::bigint) FROM "SyncMeta" WHERE "key" = 'prunedTxid' OR "key" LIKE 'cursor:%')
                   > txid_snapshot_xmax(txid_current_snapshot()),
                 false) AS rewound`
      if (!rewound) return
      this.log.warn('журнал изменений старше самой базы: её подняли из копии. Журнал сброшен, кассы заберут всё заново')
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM "ChangeLog"`
        await tx.$executeRaw`DELETE FROM "SyncMeta" WHERE "key" = 'prunedTxid' OR "key" LIKE 'cursor:%'`
      }, TX)
    } catch (e: any) {
      // Не вышло — обмен всё равно состоится; в худшем случае он будет полным
      this.log.warn('проверка журнала изменений не удалась: ' + (e?.message || e))
    }
  }

  // ── Журнал изменений не растёт вечно ──
  // Раз в сутки убираем записи старше полутора месяцев и запоминаем, до какой
  // транзакции подчищено: касса с более старой отметкой получит всё заново.
  //
  // Вызывается при обмене и раз в сутки по расписанию (sync-janitor.service.ts):
  // журналы пишутся у каждой аптеки, а кассы с программой есть не у всех — без
  // расписания у аптеки, работающей только через сайт, журнал рос бы вечно.
  async pruneIfDue() {
    try {
      const last = Number((await this.prisma.syncMeta.findUnique({ where: { key: 'prunedAt' } }))?.value || 0)
      if (Date.now() - last < PRUNE_EVERY_MS) return
      const before = new Date(Date.now() - KEEP_DAYS * DAY)
      const movesBefore = new Date(Date.now() - JOURNAL_DAYS * DAY)
      await this.prisma.$transaction(async (tx) => {
        const [{ top }] = await tx.$queryRaw<{ top: bigint | null }[]>`SELECT max("txid") AS top FROM "ChangeLog" WHERE "at" < ${before}`
        if (top !== null) {
          await tx.$executeRaw`DELETE FROM "ChangeLog" WHERE "at" < ${before}`
          const value = (top + 1n).toString()
          await tx.syncMeta.upsert({ where: { key: 'prunedTxid' }, update: { value }, create: { key: 'prunedTxid', value } })
        }
        // Журнал движений товара: давние движения каждой партии сворачиваются в одну
        // строку с их суммой. Сумма всех движений товара по-прежнему равна его остатку,
        // а подробности полугодовой давности уже никому не нужны
        await tx.$executeRaw`
          WITH old AS (
            SELECT "productId", "batchId", max("seq") AS keep, sum("delta")::int AS total
            FROM "StockMove" WHERE "at" < ${movesBefore}
            GROUP BY "productId", "batchId" HAVING count(*) > 1
          ), folded AS (
            UPDATE "StockMove" m SET "delta" = old.total FROM old WHERE m."seq" = old.keep RETURNING m."seq"
          )
          DELETE FROM "StockMove" m USING old
          WHERE m."productId" = old."productId" AND m."batchId" = old."batchId" AND m."at" < ${movesBefore} AND m."seq" <> old.keep`
        // Давние отметки «остаток пересчитан» — кроме последней у каждого товара
        await pruneCounted(tx, before)
        const now = String(Date.now())
        await tx.syncMeta.upsert({ where: { key: 'prunedAt' }, update: { value: now }, create: { key: 'prunedAt', value: now } })
      }, TX)
    } catch (e: any) {
      // Уборка не должна мешать обмену: не вышло сейчас — выйдет завтра
      this.log.warn('уборка журнала изменений не удалась: ' + (e?.message || e))
    }
  }

  // ── Расхождения: на что владельцу стоит посмотреть ──
  async discrepancies() {
    const rows = await this.prisma.discrepancy.findMany({ where: { resolvedAt: null }, orderBy: { date: 'desc' }, take: 500 })
    // Номера кассы и сотрудника — в имена: владелец различает их не по номерам
    const [devices, users] = await Promise.all([
      this.prisma.device.findMany({ select: { id: true, name: true } }),
      this.prisma.user.findMany({ select: { id: true, name: true } }),
    ])
    const device = new Map(devices.map((d) => [d.id, d.name]))
    const user = new Map(users.map((u) => [u.id, u.name]))
    return rows.map((r) => ({
      ...r,
      deviceName: (r.deviceId && device.get(r.deviceId)) || '',
      userName: (r.userId && user.get(r.userId)) || '',
    }))
  }

  // Владелец разобрался — запись уходит из списка, но в базе остаётся
  async resolveDiscrepancy(id: string) {
    await this.prisma.discrepancy.updateMany({ where: { id, resolvedAt: null }, data: { resolvedAt: new Date() } })
    return { ok: true }
  }

  // Кассы аптеки — и у какой сейчас открыта смена
  async devices() {
    const [devices, open] = await Promise.all([
      this.prisma.device.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.shift.findMany({
        where: { closedAt: null, deviceId: { not: null } },
        include: { user: { select: { id: true, name: true } } },
      }),
    ])
    const byDevice = new Map(open.map((s) => [s.deviceId, s]))
    return devices.map((d) => {
      const s = byDevice.get(d.id)
      return { ...d, openShift: s ? { id: s.id, openedAt: s.openedAt, openingCash: s.openingCash, userName: s.user?.name || '' } : null }
    })
  }

  // ── Закрыть смену кассы с сайта ──
  // Обычно смену закрывает сама касса. Но компьютер может сломаться, программу могут
  // переустановить — и смена останется открытой навсегда: закрыть её может только та
  // касса, а её больше нет. Тогда смену закрывает владелец. Если касса всё-таки
  // вернётся, её собственное закрытие ничего не изменит, а документы, сделанные в этой
  // смене, попадут в её итоги (см. recountClosed).
  async closeDeviceShift(deviceId: string, countedCash: number) {
    const closed = await this.prisma.$transaction(async (tx) => {
      // Под замком: чек, который касса присылает в эту же секунду, либо уже записан и
      // попадёт в итоги, либо дождётся закрытия и пересчитает их сам (recountClosed)
      const [open] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Shift" WHERE "deviceId" = ${deviceId} AND "closedAt" IS NULL FOR UPDATE`
      const shift = open ? await tx.shift.findUnique({ where: { id: open.id } }) : null
      if (!shift || shift.closedAt) throw new BadRequestException('На этой кассе нет открытой смены')
      const totals = await shiftTotals(tx, shift, countedCash)
      const r = await tx.shift.updateMany({ where: { id: shift.id, closedAt: null }, data: { closedAt: new Date(), ...totals } })
      if (r.count !== 1) throw new BadRequestException('Смена уже закрыта')
      return tx.shift.findUnique({ where: { id: shift.id }, include: { user: { select: { id: true, name: true } } } })
    }, TX)
    this.events.changed('shifts', 'devices', 'sales')
    return closed
  }

  // Имя кассе даёт сервер («Касса 1», «Касса 2»), а владелец может назвать её
  // по-своему — «У входа», «Ночная». Имя видно в сменах и расхождениях
  async renameDevice(id: string, raw: string) {
    const name = String(raw ?? '').trim().slice(0, 40)
    if (!name) throw new BadRequestException('Укажите название кассы')
    const r = await this.prisma.device.updateMany({ where: { id }, data: { name } })
    if (r.count !== 1) throw new NotFoundException('Касса не найдена')
    this.events.changed('devices', 'shifts')
    return this.prisma.device.findUnique({ where: { id } })
  }

  // ── Журнал движений товара ──
  // Последние движения и их сумма. Сумма всех движений товара — это и есть его
  // остаток в штуках: по ней видно, что учёт сходится сам с собой.
  async moves(productId: string) {
    const [{ total }] = await this.prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT sum("delta") AS total FROM "StockMove" WHERE "productId" = ${productId}`
    const rows = await this.prisma.stockMove.findMany({ where: { productId }, orderBy: { seq: 'desc' }, take: 200 })
    return {
      productId,
      // Остаток по журналу, в штуках
      units: Number(total ?? 0n),
      moves: rows.map((m) => ({ batchId: m.batchId, delta: m.delta, units: m.units, at: m.at })),
    }
  }
}

// ── Права и обмен ──
// Что нужно, чтобы касса прислала операцию. Скидка и продажа в долг, приход в долг
// поставщику — отдельные права, как и на сайте
function requiredPermissions(type: string, payload: any): string[][] {
  const need: string[][] = []
  const base = OP_PERMISSIONS[type]
  if (base) need.push(base)
  if (type === 'sale') {
    if (payload?.payment === 'debt') need.push(['pos.debt'])
    if (Array.isArray(payload?.items) && payload.items.some((i: any) => Number(i?.discount) > 0)) need.push(['pos.discount'])
  }
  if (type === 'arrival' && Number(payload?.debt) > 0) need.push(['arrivals.debt'])
  return need
}

// Какие разделы с деньгами аптеки касса получает в обмене: журнал списаний, расходы
// и долги поставщикам видят только те, у кого на это есть право
type PullScope = { wide: boolean; suppliers: boolean; writeoffs: boolean; expenses: boolean }
function pullScope(user: any): PullScope {
  // Те же права, что у журналов на сервере: отчёты и панель тоже читают списания и расходы
  const suppliers = hasPerm(user, 'suppliers.view')
  const writeoffs = hasPerm(user, 'writeoffs.view', 'reports.view', 'dashboard.view')
  const expenses = hasPerm(user, 'expenses.view', 'reports.view')
  return { wide: suppliers || writeoffs || expenses, suppliers, writeoffs, expenses }
}
function trimPull<T extends Record<string, any>>(data: T, scope: PullScope): T {
  if (!scope.wide) return data
  const out: any = { ...data }
  if (!scope.writeoffs) delete out.writeoffs
  if (!scope.expenses) {
    delete out.expenses
    delete out.expenseCategories
  }
  if (!scope.suppliers) {
    delete out.supplierPayments
    if (Array.isArray(out.suppliers?.upsert)) out.suppliers = { ...out.suppliers, upsert: out.suppliers.upsert.map(supplierBrief) }
  }
  return out
}
