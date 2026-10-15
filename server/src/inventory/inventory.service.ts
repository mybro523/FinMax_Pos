import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { lockProducts, setUnits, shortageWorth, totalUnits, uppOf } from '../common/stock'
import { Counted, lockInventories, markCounted, rememberShortageDoc } from '../common/counted'
import { TX, TX_LONG } from '../common/tx'
import { CreateInventoryDto, SaveCountDto } from './dto'

// Сколько строк переписываем одним запросом. Postgres ограничивает число
// подставляемых значений, поэтому длинные листы режем на части.
const CHUNK = 500

// ── Инвентаризация (пересчёт остатков) ──
// 1) Создаём лист: система записывает, сколько товара должно быть по учёту.
// 2) Сотрудник пересчитывает и вносит фактическое количество.
// 3) Применяем: остатки приводятся к факту, недостача оформляется списанием,
//    излишек просто добавляется. Пока лист не применён — на складе ничего не меняется.

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.inventory.findMany({
      include: { items: true, user: { select: { id: true, name: true } } },
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
    const include = { items: true, user: { select: { id: true, name: true } } }
    const inv = wait
      ? await this.prisma.$transaction(async (tx) => {
          await lockInventories(tx, [id])
          return tx.inventory.findUnique({ where: { id }, include })
        }, TX_LONG)
      : await this.prisma.inventory.findUnique({ where: { id }, include })
    if (!inv) throw new BadRequestException('Лист не найден')
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

    return this.prisma.inventory.create({
      data: {
        userId: userId ?? null,
        scope,
        note: dto.note || '',
        status: 'draft',
        items: {
          create: products.map((p) => ({
            productId: p.id,
            name: p.name,
            expectedUnits: totalUnits(p),
            actualUnits: null,
            cost: p.cost,
          })),
        },
      },
      include: { items: true, user: { select: { id: true, name: true } } },
    })
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
    return this.prisma.inventory.findUnique({
      where: { id },
      include: { items: true, user: { select: { id: true, name: true } } },
    })
  }

  private async writeCounts(id: string, items: SaveCountDto['items']) {
    await this.prisma.$transaction(async (tx) => {
      await lockInventories(tx, [id])
      const inv = await tx.inventory.findUnique({ where: { id }, select: { id: true, status: true } })
      if (!inv) throw new BadRequestException('Лист не найден')
      if (inv.status === 'applied') throw new BadRequestException('Этот пересчёт уже применён')
      await this.putCounts(tx, id, items)
    }, TX_LONG)
  }

  // Записать насчитанное в строки листа. Лист к этому моменту под замком
  private async putCounts(tx: Prisma.TransactionClient, id: string, items: SaveCountDto['items']) {
    // Пустое значение означает «эту позицию ещё не считали» — это не то же самое,
    // что «насчитали ноль», и такую строку применение обходит стороной
    const rows = (items || [])
      .filter((it) => it && typeof it.id === 'string' && it.id)
      .map((it) => ({
        id: it.id,
        units: it.actualUnits === null || it.actualUnits === undefined ? null : Math.max(0, Math.trunc(it.actualUnits)),
      }))
    for (let at = 0; at < rows.length; at += CHUNK) {
      const part = rows.slice(at, at + CHUNK)
      const values = part.map((r) => Prisma.sql`(${r.id}::text, ${r.units}::int)`)
      await tx.$executeRaw(Prisma.sql`
        UPDATE "InventoryItem" AS it
        SET "actualUnits" = v.units
        FROM (VALUES ${Prisma.join(values)}) AS v(id, units)
        WHERE it.id = v.id AND it."inventoryId" = ${id}
      `)
    }
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
  async apply(id: string, userId?: string, counts?: SaveCountDto['items']) {
    try {
      return await this.applyNow(id, userId, counts)
    } catch (e) {
      // Лист уже применён или удалён — сохранять некуда, и это не новость: о причине
      // скажет сам отказ применения
      if (Array.isArray(counts)) await this.writeCounts(id, counts).catch(() => undefined)
      throw e
    }
  }

  private applyNow(id: string, userId?: string, counts?: SaveCountDto['items']) {
    return this.prisma.$transaction(async (tx) => {
      // Лист — под замок, и только потом читается. Применение дожидается сохранения,
      // которое идёт в эту же секунду, и видит именно сохранённые числа. А второе
      // применение того же листа (нажали дважды, повторили после обрыва связи) ждёт
      // первого и получает «уже применён», а не проводит лист ещё раз
      await lockInventories(tx, [id])
      const state = await tx.inventory.findUnique({ where: { id }, select: { status: true } })
      if (!state) throw new BadRequestException('Лист не найден')
      if (state.status === 'applied') throw new BadRequestException('Этот пересчёт уже применён')
      if (Array.isArray(counts)) await this.putCounts(tx, id, counts)
      const inv = await tx.inventory.findUnique({ where: { id }, include: { items: true } })
      if (!inv) throw new BadRequestException('Лист не найден')

      const shortage: any[] = []
      let shortageCost = D(0)
      // У каких товаров остаток приведён к пересчитанному — и какой строкой листа
      const counted: Counted[] = []
      // В каких строках «по учёту» с создания листа изменилось
      const was: { id: string; units: number }[] = []

      // Строки, которые не считали (пусто), пересчёт не трогает
      const place = new Map(inv.items.map((it, n) => [it.id, n]))
      const lines = inv.items
        .filter((it) => it.actualUnits !== null && it.actualUnits !== undefined && !!it.productId)
        .sort((a, b) => (a.productId! < b.productId! ? -1 : a.productId! > b.productId! ? 1 : 0))

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
      const ids = [...new Set(lines.map((it) => it.productId!))]
      await lockProducts(tx, ids)
      const products = new Map<string, Prisma.ProductGetPayload<{ include: { batches: true } }>>()
      for (let at = 0; at < ids.length; at += CHUNK) {
        const part = await tx.product.findMany({ where: { id: { in: ids.slice(at, at + CHUNK) } }, include: { batches: true } })
        for (const p of part) products.set(p.id, p)
      }

      const done = new Set<string>()
      for (const it of lines) {
        if (it.actualUnits === null || !it.productId) continue
        // Товар в листе один раз. Если всё же дважды — вторая строка читает его заново:
        // первая уже изменила остаток
        const product = done.has(it.productId)
          ? await tx.product.findUnique({ where: { id: it.productId }, include: { batches: true } })
          : products.get(it.productId)
        if (!product) continue
        done.add(product.id)
        const upp = uppOf(product)
        counted.push({ productId: product.id, inventoryId: id, itemId: it.id, upp })

        const before = totalUnits(product)
        // Остаток считается по партиям; у товара, заведённого до появления партий, — по карточке
        const have = product.batches.length ? product.batches.reduce((s, b) => s + Math.max(0, b.units), 0) : before
        if (have !== it.actualUnits) {
          const { diff, taken } = await setUnits(tx, product.id, it.actualUnits, product.name)
          if (diff < 0) {
            // Недостачу оцениваем по закупочной цене из карточки — как и продажи
            // со списаниями, чтобы один товар везде стоил одинаково. Сумма по товару —
            // той же формулой, какой её потом поправляет обмен с кассами (shortageWorth)
            shortageCost = shortageCost.plus(shortageWorth(taken.map((t: any) => ({ cost: product.cost, units: t.units })), upp))
            for (const t of taken) {
              shortage.push({
                n: place.get(it.id) ?? 0,
                productId: product.id,
                name: product.name,
                units: t.units,
                cost: product.cost,
                expiryDate: t.expiryDate,
              })
            }
          }
        }
        // Фиксируем, что было на момент применения (для истории)
        if (before !== it.expectedUnits) was.push({ id: it.id, units: before })
      }

      for (let at = 0; at < was.length; at += CHUNK) {
        const values = was.slice(at, at + CHUNK).map((r) => Prisma.sql`(${r.id}::text, ${r.units}::int)`)
        await tx.$executeRaw(Prisma.sql`
          UPDATE "InventoryItem" AS it
          SET "expectedUnits" = v.units
          FROM (VALUES ${Prisma.join(values)}) AS v(id, units)
          WHERE it.id = v.id AND it."inventoryId" = ${id}
        `)
      }

      // Недостача — это убыток, поэтому оформляем списанием с причиной «недостача»
      const appliedAt = new Date()
      if (shortage.length) {
        // В списании позиции идут как в листе, а не в порядке обхода
        shortage.sort((a, b) => a.n - b.n)
        const doc = await tx.writeOff.create({
          data: {
            userId: userId ?? null,
            date: appliedAt,
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
      await markCounted(tx, counted, appliedAt)

      return tx.inventory.update({
        where: { id },
        data: { status: 'applied', appliedAt },
        include: { items: true, user: { select: { id: true, name: true } } },
      })
    }, TX_LONG)
  }

  async remove(id: string) {
    // Под тем же замком, что применение: иначе лист, который в эту секунду применяют,
    // прошёл бы проверку «ещё не применён» и был бы удалён уже применённым — остатки
    // изменены, а записи об этом нет
    await this.prisma.$transaction(async (tx) => {
      await lockInventories(tx, [id])
      const inv = await tx.inventory.findUnique({ where: { id }, select: { status: true } })
      if (!inv) throw new BadRequestException('Лист не найден')
      if (inv.status === 'applied') throw new BadRequestException('Применённый пересчёт удалять нельзя — это история')
      await tx.inventory.delete({ where: { id } })
    }, TX)
    return { ok: true }
  }
}
