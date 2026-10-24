import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { lockProducts, setUnits, shortageWorth, totalUnits, uppOf } from '../common/stock'
import { Counted, firstCountAfter, lockInventories, markCounted, rememberShortageDoc } from '../common/counted'
import { forgetStampsOfRows, stampMany, stampsOfRows } from '../common/stamps'
import { TX, TX_LONG } from '../common/tx'
import { unitsMovedAfterMany } from '../common/moved'
import { CreateInventoryDto, SaveCountDto } from './dto'

type Tx = Prisma.TransactionClient

// Сколько строк переписываем одним запросом. Postgres ограничивает число
// подставляемых значений, поэтому длинные листы режем на части.
const CHUNK = 500

// Тексты отказов — слово в слово одни и те же для сайта и кассы без связи (sync)
export const SHEET_NOT_FOUND = 'Лист не найден'
export const SHEET_APPLIED = 'Этот пересчёт уже применён'
export const SHEET_APPLIED_NO_DELETE = 'Применённый пересчёт удалять нельзя — это история'

const INCLUDE = { items: true, user: { select: { id: true, name: true } } } as const

// ── Инвентаризация (пересчёт остатков) ──
// 1) Создаём лист: система записывает, сколько товара должно быть по учёту.
// 2) Сотрудник пересчитывает и вносит фактическое количество.
// 3) Применяем: остатки приводятся к факту, недостача оформляется списанием,
//    излишек просто добавляется. Пока лист не применён — на складе ничего не меняется.
//
// С версии 1.4.15 листы заводят, считают и применяют и кассы без интернета (sync/edits.ts):
// общие части ниже (…In) работают и для сайта, и для операции кассы, пришедшей позже.

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.inventory.findMany({
      include: INCLUDE,
      orderBy: { date: 'desc' },
      take: 100000, // вся история пересчётов — без «потолка», как и остальные журналы
    })
  }

  // Один лист. wait — «дождись, чем кончится»: запрос встаёт в очередь за сохранением
  // или применением этого листа, которое идёт прямо сейчас, и отвечает уже после него.
  // Так страница узнаёт судьбу применения, ответ на которое потерялся. Без этого она
  // спросила бы, пока сервер ещё применяет, увидела бы «не закончен» и сообщила об
  // отказе — а через секунду лист применился бы.
  async findOne(id: string, wait = false) {
    const inv = wait
      ? await this.prisma.$transaction(async (tx) => {
          await lockInventories(tx, [id])
          return tx.inventory.findUnique({ where: { id }, include: INCLUDE })
        }, TX_LONG)
      : await this.prisma.inventory.findUnique({ where: { id }, include: INCLUDE })
    if (!inv) throw new BadRequestException(SHEET_NOT_FOUND)
    return inv
  }

  // Новый лист пересчёта: все товары или одна категория
  async create(dto: CreateInventoryDto, userId?: string) {
    const scope = dto.scope || 'all'
    const products = await this.prisma.product.findMany({
      where: scope === 'all' ? {} : { category: scope },
      orderBy: { name: 'asc' },
    })
    if (!products.length) throw new BadRequestException('В этой категории нет товаров')

    // Строки — пачками по CHUNK одним запросом: построчные вставки (вложенное create) на
    // складе в тысячи товаров были бы тысячами записей в журнале изменений для касс
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.inventory.create({ data: { userId: userId ?? null, scope, note: dto.note || '', status: 'draft' } })
      for (let at = 0; at < products.length; at += CHUNK) {
        await tx.inventoryItem.createMany({
          data: products.slice(at, at + CHUNK).map((p) => ({
            inventoryId: inv.id,
            productId: p.id,
            name: p.name,
            expectedUnits: totalUnits(p),
            actualUnits: null,
            cost: p.cost,
          })),
        })
      }
      return tx.inventory.findUnique({ where: { id: inv.id }, include: INCLUDE })
    }, TX_LONG)
  }

  // Сохранение пересчитанных количеств (можно возвращаться и дополнять).
  //
  // Раньше на каждую строку листа уходил отдельный запрос к базе, и всё это шло
  // одной транзакцией со стандартным пятисекундным лимитом. Пересчёт всего склада —
  // это сотни позиций, то есть сотни обращений подряд: сотрудник, который весь день
  // считал товар на полках, в конце получал отказ базы вместо сохранения.
  // Теперь строки переписываются пачками, одним запросом на пачку.
  //
  // И второе: принадлежность строки листу раньше не проверялась вовсе — можно было
  // прислать чужой идентификатор и переписать позицию другого пересчёта. Условие по
  // листу встроено прямо в запрос, поэтому чужая строка просто не найдётся.
  //
  // И третье: лист берётся под замок, а «не применён ли он уже» проверяется под ним.
  // Раньше проверка шла до записи и без замка: сохранение, пришедшее в ту же секунду,
  // что и применение, могло записать насчитанное в уже применённый лист — в истории
  // остались бы числа, по которым остаток никто не выставлял. А строки листа оба
  // запроса брали в разном порядке и могли запереть друг друга.
  async saveCount(id: string, dto: SaveCountDto) {
    await this.writeCounts(id, dto.items)
    return this.prisma.inventory.findUnique({ where: { id }, include: INCLUDE })
  }

  private async writeCounts(id: string, items: SaveCountDto['items']) {
    await this.prisma.$transaction((tx) => saveCountsIn(tx, id, items), TX_LONG)
  }

  // Применение: остатки становятся такими, как насчитали.
  //
  // counts — насчитанное, присланное вместе с просьбой применить. Страница шлёт его
  // именно так, одним запросом: пока сохранение и применение были двумя запросами,
  // между ними помещалось что угодно — вкладку закрыли, связь пропала, — и лист
  // оставался неприменённым, хотя человеку уже показали «остатки обновлены». А ещё
  // раньше оба запроса уходили разом, и применялись прежние числа.
  //
  // Насчитанное пишется внутри самого применения, под тем же замком. Пока это были
  // две записи подряд, между ними успевало вклиниться сохранение черновика,
  // отправленное раньше (большой запрос по слабой связи), — и лист применялся по его
  // числам. И запрос «чем кончилось применение» (findOne с wait), попав в этот
  // промежуток, честно отвечал «не закончен» за миг до применения.
  //
  // Если применить не вышло, насчитанное сохраняется отдельно, уже после отказа:
  // работа за день должна остаться в листе, чем бы ни кончилось применение.
  async apply(id: string, userId?: string, counts?: CountLine[]) {
    try {
      return await this.prisma.$transaction((tx) => applyInventoryIn(tx, id, { userId: userId ?? null, counts }), TX_LONG)
    } catch (e) {
      // Лист уже применён или удалён — сохранять некуда, и это не новость: о причине
      // скажет сам отказ применения
      if (Array.isArray(counts)) await this.writeCounts(id, counts).catch(() => undefined)
      throw e
    }
  }

  async remove(id: string) {
    await this.prisma.$transaction(async (tx) => {
      if (!(await removeInventoryIn(tx, id))) throw new BadRequestException(SHEET_NOT_FOUND)
    }, TX)
    return { ok: true }
  }
}

// ── Завести лист с готовыми строками ──
// Касса без связи заводит лист у себя — со своими номерами листа и строк (по ним придут
// её пересчёт и применение) и тем, что было по учёту у неё
export async function createInventoryIn(
  tx: Tx,
  data: {
    id: string
    scope: string
    note: string
    date: Date
    userId: string | null
    items: { id: string; productId: string | null; name: string; expectedUnits: number; cost: number; actualUnits: number | null }[]
  },
) {
  // Товары, которых на сервере нет (удалили, пока касса была без связи), — без ссылки:
  // строка остаётся в листе для истории, а применение её обходит
  const ids = [...new Set(data.items.map((i) => i.productId).filter(Boolean) as string[])]
  const alive = new Set<string>()
  for (let at = 0; at < ids.length; at += CHUNK) {
    for (const p of await tx.product.findMany({ where: { id: { in: ids.slice(at, at + CHUNK) } }, select: { id: true } })) alive.add(p.id)
  }
  await tx.inventory.create({ data: { id: data.id, userId: data.userId, scope: data.scope, note: data.note, status: 'draft', date: data.date } })
  for (let at = 0; at < data.items.length; at += CHUNK) {
    await tx.inventoryItem.createMany({
      data: data.items.slice(at, at + CHUNK).map((i) => ({
        id: i.id,
        inventoryId: data.id,
        productId: i.productId && alive.has(i.productId) ? i.productId : null,
        name: i.name,
        expectedUnits: i.expectedUnits,
        actualUnits: i.actualUnits,
        cost: D(i.cost).toDecimalPlaces(2),
      })),
    })
  }
  // Насчитанное, которое пришло с листом, — тоже с моментом на кассе
  const counted = data.items.filter((i) => i.actualUnits !== null).map((i) => i.id)
  if (counted.length) await stampMany(tx, 'InventoryItem', counted, 'actual', data.date)
}

// ── Сохранить насчитанное ──
// at — когда насчитали на кассе без связи (у строки может быть свой момент — пересчёт
// соседней кассы, пришедший с применением). Строку, которую с тех пор считали позже (на
// сайте или другой кассе), касса не перекрывает: остаётся более поздний пересчёт. Без at —
// сайт, «сейчас». Лист берётся под замок, применённый не трогается.
// Возвращает, сколько строк кассы не легло (их посчитали позже).
// Пересчёт с кассы, пришедший в уже применённый лист, но с теми же числами, что в нём, —
// не отказ: так бывает, когда соседняя касса применила лист вместе с его строками раньше,
// чем эта касса отправила свой пересчёт
export async function saveCountsIn(tx: Tx, id: string, items: CountLine[], at?: Date): Promise<number> {
  await lockInventories(tx, [id])
  const inv = await tx.inventory.findUnique({ where: { id }, select: { id: true, status: true } })
  if (!inv) throw new BadRequestException(SHEET_NOT_FOUND)
  if (inv.status === 'applied') {
    if (at && (await countsAlreadyThere(tx, id, items))) return 0
    throw new BadRequestException(SHEET_APPLIED)
  }
  return putCounts(tx, id, items, at)
}

async function countsAlreadyThere(tx: Tx, id: string, items: CountLine[]): Promise<boolean> {
  const list = (items || []).filter((it) => it && typeof it.id === 'string' && it.id)
  const have = new Map<string, number | null>()
  for (let n = 0; n < list.length; n += CHUNK) {
    const part = list.slice(n, n + CHUNK).map((it) => it.id)
    for (const r of await tx.inventoryItem.findMany({ where: { inventoryId: id, id: { in: part } }, select: { id: true, actualUnits: true } })) have.set(r.id, r.actualUnits)
  }
  return list.every((it) => have.has(it.id) && (have.get(it.id) ?? null) === (it.actualUnits === undefined ? null : it.actualUnits))
}

// Строка насчитанного: сайт присылает номер и число; касса — ещё и момент строки
export type CountLine = { id: string; actualUnits?: number | null; at?: Date }

// Записать насчитанное в строки листа. Лист к этому моменту под замком. Возвращает, сколько
// строк с кассы пропущено: их с тех пор посчитали позже
async function putCounts(tx: Tx, id: string, items: CountLine[], at?: Date): Promise<number> {
  // Пустое значение означает «эту позицию ещё не считали» — это не то же самое,
  // что «насчитали ноль», и такую строку применение обходит стороной
  let rows = (items || [])
    .filter((it) => it && typeof it.id === 'string' && it.id)
    .map((it) => ({
      id: it.id,
      units: it.actualUnits === null || it.actualUnits === undefined ? null : Math.max(0, Math.trunc(it.actualUnits)),
      // Момент строки: свой у строки, иначе общий у операции кассы, иначе (сайт) — сейчас
      at: it.at ?? at ?? null,
    }))
  if (!rows.length) return 0
  let skipped = 0
  if (at) {
    const stamps = await stampsOfRows(tx, 'InventoryItem', rows.map((r) => r.id), 'actual')
    rows = rows.filter((r) => {
      const last = stamps.get(r.id)
      // Тот же момент — тот же пересчёт (строку соседней кассы привезло применение, а потом
      // пришёл и её собственный пересчёт): не пропуск
      const keep = !last || last.getTime() <= r.at!.getTime()
      if (!keep) skipped++
      return keep
    })
    if (!rows.length) return skipped
  }
  const now = new Date()
  const written: { id: string; at: Date }[] = []
  for (let n = 0; n < rows.length; n += CHUNK) {
    const part = rows.slice(n, n + CHUNK)
    const values = part.map((r) => Prisma.sql`(${r.id}::text, ${r.units}::int)`)
    // Строки только этого листа; какие действительно переписаны — те и отмечаются
    const done = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "InventoryItem" AS it
      SET "actualUnits" = v.units
      FROM (VALUES ${Prisma.join(values)}) AS v(id, units)
      WHERE it.id = v.id AND it."inventoryId" = ${id}
      RETURNING it.id
    `)
    const ok = new Set(done.map((d) => d.id))
    for (const r of part) if (ok.has(r.id)) written.push({ id: r.id, at: r.at ?? now })
  }
  // Когда строку считали: по этому решается, чей пересчёт новее (касса без связи). Строки с
  // одним моментом — одним запросом
  const byMoment = new Map<number, string[]>()
  for (const w of written) {
    const k = w.at.getTime()
    if (!byMoment.has(k)) byMoment.set(k, [])
    byMoment.get(k)!.push(w.id)
  }
  for (const [k, ids] of byMoment) await stampMany(tx, 'InventoryItem', ids, 'actual', new Date(k))
  return skipped
}

// ── Применить лист ──
// at — момент применения. На сайте — «сейчас». Касса без связи применяет лист у себя и
// присылает момент на кассе: это пересчёт на тот момент. Всё, что случилось с товаром
// после него (продажи других касс, приход на сайте), прибавляется к насчитанному; если
// товар после него пересчитали ещё раз — остаётся тот пересчёт (onCounted скажет о строке).
// Строку, которую после момента кассы посчитали на сайте или другой кассе (её число новее и
// легло вместо числа кассы), считаем на момент того пересчёта: проданное до него в нём уже
// учтено, и вычитать это второй раз нельзя.
// counts — насчитанное вместе с применением (пишется под тем же замком)
export async function applyInventoryIn(
  tx: Tx,
  id: string,
  opts: {
    at?: Date
    userId?: string | null
    counts?: CountLine[]
    onCounted?: (product: { id: string; name: string }, line: { id: string; actualUnits: number; units: number }) => Promise<void>
    // Что из присланного не легло: строки, которые позже посчитали в другом месте, и товары,
    // которые позже пересчитали (касса тогда заберёт лист заново, а не оставит свои числа)
    report?: { skipped: number }
  } = {},
) {
  const offline = !!opts.at
  const at = opts.at ?? new Date()
  // Лист — под замок, и только потом читается. Применение дожидается сохранения,
  // которое идёт в эту же секунду, и видит именно сохранённые числа. А второе
  // применение того же листа (нажали дважды, повторили после обрыва связи) ждёт
  // первого и получает «уже применён», а не проводит лист ещё раз
  await lockInventories(tx, [id])
  const state = await tx.inventory.findUnique({ where: { id }, select: { status: true } })
  if (!state) throw new BadRequestException(SHEET_NOT_FOUND)
  if (state.status === 'applied') throw new BadRequestException(SHEET_APPLIED)
  if (Array.isArray(opts.counts)) {
    const skipped = await putCounts(tx, id, opts.counts, opts.at)
    if (opts.report) opts.report.skipped += skipped
  }
  const inv = await tx.inventory.findUnique({ where: { id }, include: { items: true } })
  if (!inv) throw new BadRequestException(SHEET_NOT_FOUND)

  const shortage: any[] = []
  let shortageCost = D(0)
  // У каких товаров остаток приведён к пересчитанному — какой строкой листа и на какой момент
  const counted = new Map<number, Counted[]>()
  // В каких строках «по учёту» с создания листа изменилось
  const was: { id: string; units: number }[] = []

  // ── Один товар — одна запись ──
  // Две строки одного товара бывают, когда на сайте объединили две карточки: строка лишней
  // перешла к основной. Это один товар на одной полке — насчитанное по строкам складывается,
  // и остаток выставляется один раз. Строки остаются в листе как были (по их номерам ещё
  // приходят числа с касс); «по учёту» после применения — у первой строки, у остальных 0.
  // Строки, которые не считали (пусто), пересчёт не трогает
  type Line = (typeof inv.items)[number]
  const place = new Map(inv.items.map((it, n) => [it.id, n]))
  const groups = new Map<string, { lines: Line[]; actual: number; all: Line[] }>()
  for (const it of inv.items) {
    if (!it.productId || it.actualUnits === null || it.actualUnits === undefined) continue
    const g = groups.get(it.productId)
    if (g) {
      g.lines.push(it)
      g.actual += it.actualUnits
    } else groups.set(it.productId, { lines: [it], actual: it.actualUnits, all: [] })
  }
  for (const it of inv.items) if (it.productId && groups.has(it.productId)) groups.get(it.productId)!.all.push(it)

  // Все товары листа берутся под замок сразу, по порядку номеров: продажа того же
  // товара ждёт, пока его остаток приводится к насчитанному, а не записывает своё
  // число поверх. Порядок единый со всеми операциями (см. lockProducts) — иначе
  // пересчёт и продажа нескольких товаров могли бы запереть друг друга.
  //
  // Замки держатся до конца применения, поэтому само применение обязано быть
  // коротким. Раньше на каждую строку листа уходило четыре обращения к базе —
  // пересчёт всего склада шёл десятки секунд, и всё это время продажа любого уже
  // пройденного товара ждала, занимая подключение; остальным запросам магазина
  // подключений не оставалось. Теперь товары читаются пачками, а записывается
  // только то, что действительно изменилось: расхождений обычно немного
  const ids = [...groups.keys()].sort()
  await lockProducts(tx, ids)
  const products = new Map<string, Prisma.ProductGetPayload<{ include: { batches: true } }>>()
  for (let n = 0; n < ids.length; n += CHUNK) {
    const part = await tx.product.findMany({ where: { id: { in: ids.slice(n, n + CHUNK) } }, include: { batches: true } })
    for (const p of part) products.set(p.id, p)
  }

  // На какой момент насчитан товар. На сайте — «сейчас». С кассы без связи — момент её
  // применения или более поздний пересчёт строки на сайте или другой кассе
  const moment = new Map<string, number>()
  if (offline) {
    const stamps = await stampsOfRows(tx, 'InventoryItem', [...groups.values()].flatMap((g) => g.lines.map((l) => l.id)), 'actual')
    for (const [pid, g] of groups) {
      let m = at.getTime()
      for (const l of g.lines) {
        const s = stamps.get(l.id)
        if (s && s.getTime() > m) m = s.getTime()
      }
      moment.set(pid, m)
    }
  }
  const momentOf = (pid: string) => moment.get(pid) ?? at.getTime()
  // Что случилось с товаром после его момента и не пересчитывали ли его позже — по моментам
  const moved = new Map<string, number>()
  const later = new Set<string>()
  if (offline) {
    const byMoment = new Map<number, string[]>()
    for (const pid of ids) {
      if (!products.has(pid)) continue
      const k = momentOf(pid)
      if (!byMoment.has(k)) byMoment.set(k, [])
      byMoment.get(k)!.push(pid)
    }
    for (const [k, pids] of byMoment) {
      for (const [pid, units] of await unitsMovedAfterMany(tx, pids.map((p) => products.get(p)!), new Date(k))) moved.set(pid, units)
      for (const pid of (await firstCountAfter(tx, pids, new Date(k))).keys()) later.add(pid)
    }
  }

  for (const pid of ids) {
    const g = groups.get(pid)!
    const first = g.lines[0]
    const product = products.get(pid)
    if (!product) {
      // Товар исчез, пока лист применяли (карточку объединили или удалили): число этой
      // строки не легло — касса заберёт всё заново
      if (opts.report) opts.report.skipped++
      continue
    }
    const upp = uppOf(product)
    const before = totalUnits(product)
    // Остаток считается по партиям; у товара, заведённого до появления партий, — по карточке
    const have = product.batches.length ? product.batches.reduce((s, b) => s + Math.max(0, b.units), 0) : before
    if (later.has(product.id)) {
      // Товар пересчитали позже момента этого листа — тот пересчёт новее. Строка остаётся
      // в листе для истории, остаток не трогаем
      await opts.onCounted?.({ id: product.id, name: product.name }, { id: first.id, actualUnits: g.actual, units: have })
      if (opts.report) opts.report.skipped++
      continue
    }
    const k = momentOf(pid)
    if (!counted.has(k)) counted.set(k, [])
    counted.get(k)!.push({ productId: product.id, inventoryId: id, itemId: first.id, upp })
    const after = moved.get(product.id) || 0
    // Насчитали в момент пересчёта — и всё, что было после, ложится сверху
    const target = Math.max(0, g.actual + after)
    if (have !== target) {
      const { diff, taken } = await setUnits(tx, product.id, target, product.name)
      if (diff < 0) {
        // Недостачу оцениваем по закупочной цене из карточки — как и продажи
        // со списаниями, чтобы один товар везде стоил одинаково. Сумма по товару —
        // той же формулой, какой её потом поправляет обмен с кассами (shortageWorth)
        shortageCost = shortageCost.plus(shortageWorth(taken.map((t: any) => ({ cost: product.cost, units: t.units })), upp))
        for (const t of taken) {
          shortage.push({
            n: place.get(first.id) ?? 0,
            productId: product.id,
            name: product.name,
            units: t.units,
            cost: product.cost,
            expiryDate: t.expiryDate,
          })
        }
      }
    }
    // Фиксируем, что было на момент применения (для истории): у пересчёта с кассы — на его момент
    const expectedNow = (offline ? have : before) - after
    for (const line of g.all) {
      const units = line.id === first.id ? expectedNow : 0
      if (units !== line.expectedUnits) was.push({ id: line.id, units })
    }
  }

  for (let n = 0; n < was.length; n += CHUNK) {
    const values = was.slice(n, n + CHUNK).map((r) => Prisma.sql`(${r.id}::text, ${r.units}::int)`)
    await tx.$executeRaw(Prisma.sql`
      UPDATE "InventoryItem" AS it
      SET "expectedUnits" = v.units
      FROM (VALUES ${Prisma.join(values)}) AS v(id, units)
      WHERE it.id = v.id AND it."inventoryId" = ${id}
    `)
  }

  // Недостача — это убыток, поэтому оформляем списанием с причиной «недостача»
  if (shortage.length) {
    // В списании позиции идут как в листе, а не в порядке обхода
    shortage.sort((a, b) => a.n - b.n)
    const doc = await tx.writeOff.create({
      data: {
        userId: opts.userId ?? null,
        date: at,
        reason: 'lost',
        source: 'inventory',
        note: 'Недостача по итогам пересчёта',
        totalCost: shortageCost,
        items: { create: shortage.map(({ n: _n, ...row }) => row) },
      },
    })
    // Каким списанием закрыта недостача этого листа — на случай, если её придётся
    // поправить (см. ниже)
    await rememberShortageDoc(tx, id, doc.id)
  }

  // Касса без интернета могла продать этот товар ДО пересчёта, а чек прислать
  // после: пересчёт такую продажу уже учёл, и вычитать её второй раз нельзя.
  // Запоминаем, когда и каким листом товар пересчитан: по этому сервер поймёт,
  // что операция уже учтена, и поправит недостачу листа — проданное недостачей
  // не было (см. common/counted.ts)
  for (const [k, list] of counted) await markCounted(tx, list, new Date(k))

  // Строки применённого листа больше не меняются — когда их считали, помнить незачем
  await forgetStampsOfRows(tx, 'InventoryItem', inv.items.map((i) => i.id))

  return tx.inventory.update({ where: { id }, data: { status: 'applied', appliedAt: at }, include: INCLUDE })
}

// ── Удалить незаконченный лист ──
// Под тем же замком, что применение: иначе лист, который в эту секунду применяют,
// прошёл бы проверку «ещё не применён» и был бы удалён уже применённым — остатки
// изменены, а записи об этом нет. Листа уже нет — false
export async function removeInventoryIn(tx: Tx, id: string): Promise<boolean> {
  await lockInventories(tx, [id])
  const inv = await tx.inventory.findUnique({ where: { id }, select: { status: true, items: { select: { id: true } } } })
  if (!inv) return false
  if (inv.status === 'applied') throw new BadRequestException(SHEET_APPLIED_NO_DELETE)
  await forgetStampsOfRows(tx, 'InventoryItem', inv.items.map((i) => i.id))
  await tx.inventory.delete({ where: { id } })
  return true
}
