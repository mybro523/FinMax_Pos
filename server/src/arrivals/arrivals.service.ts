import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { isDrob, KG, lineUpp, oldLineOnSack, OLD_WINDOW_SACK, opensPack, packFor, piecePriceIn } from '../common/piece'
import { D, discountOf } from '../common/money'
import { weightedPackCost, costFromBatches, costInPack } from '../common/cost'
import { addUnits, ensureBatch, expiryFrom, lockProducts, syncProduct, uppOf } from '../common/stock'
import { openShiftFor } from '../shifts/till'
import { setSupplierCash } from '../shifts/totals'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { lockSupplier } from '../suppliers/suppliers.service'
import { forgetStamps, same, stamp } from '../common/stamps'
import { CreateArrivalDto, UpdateArrivalDto } from './dto'

type Tx = Prisma.TransactionClient

// ── Поставщик прихода и долг перед ним ──
// Приход в долг прибавляет к долгу поставщика неоплаченную часть. Поставщик — под
// замком: приходы и оплаты, пришедшие разом, меняют один и тот же долг по очереди.
// Неоплаченная часть не бывает больше самого прихода
async function supplierDebt(tx: Tx, supplierId: string | null | undefined, asked: Prisma.Decimal | number | undefined, total: Prisma.Decimal) {
  if (!supplierId) return { supplierId: null as string | null, name: null as string | null, debt: D(0) }
  const s = await lockSupplier(tx, supplierId)
  if (!s) throw new BadRequestException('Поставщик не найден')
  const debt = Prisma.Decimal.min(Prisma.Decimal.max(0, D(asked ?? 0)), total).toDecimalPlaces(2)
  return { supplierId: s.id, name: s.name, debt }
}

const addDebt = async (tx: Tx, supplierId: string | null, delta: Prisma.Decimal) => {
  if (supplierId && !delta.isZero()) await tx.supplier.update({ where: { id: supplierId }, data: { debt: { increment: delta } } })
}

@Injectable()
export class ArrivalsService {
  constructor(private prisma: PrismaService) {}

  // По умолчанию — недавние поставки. За давний период их спрашивают отдельно:
  // приходов десятки в месяц, но за несколько лет это уже заметный объём.
  findAll(q: PeriodQuery = {}) {
    return this.prisma.arrival.findMany({
      where: periodFilter(q, 180),
      // Кто принял — для таблицы «Закупки и оплаты» в разделе «Поставщики»
      include: { items: true, user: { select: { id: true, name: true } } },
      orderBy: { date: 'desc' },
      take: MAX_ROWS,
    })
  }

  // ── Один приход со всех сторон ──
  // Кроме самих строк отдаём то, чего в базе нет, но без чего правку не показать:
  // сколько от каждой строки ещё лежит на полке и сколько уже ушло покупателям.
  // Ниже проданного количество опускать нельзя — этих упаковок физически нет.
  // Штук в строке прихода: упаковки × штук в упаковке + штуки (граммы) сверх
  private unitsOf(it: { qty: number; pieces?: number | null }, upp: number) {
    return (it.qty || 0) * upp + Math.max(0, Math.trunc(it.pieces || 0))
  }

  async findOne(id: string) {
    const arrival = await this.prisma.arrival.findUnique({ where: { id }, include: { items: true } })
    if (!arrival) throw new BadRequestException('Приход не найден')

    const ids = [...new Set(arrival.items.map((i) => i.productId).filter(Boolean) as string[])]
    const products = await this.prisma.product.findMany({ where: { id: { in: ids } } })
    const byId = new Map(products.map((p) => [p.id, p]))
    const batches = await this.prisma.batch.findMany({ where: { arrivalId: id } })

    // Остаток считаем по товару, а не по строке: один товар может стоять
    // в приходе дважды (две партии с разными сроками), и партии тогда
    // к отдельной строке не привязать
    const leftByProduct = new Map<string, number>()
    // Срок годности хранит партия, а не строка прихода. Без него окно правки
    // показывало бы пустое поле, и владелец решил бы, что срока не было вовсе
    const expiryByProduct = new Map<string, Date | null>()
    for (const b of batches) {
      leftByProduct.set(b.productId, (leftByProduct.get(b.productId) || 0) + b.units)
      const было = expiryByProduct.get(b.productId)
      if (было === undefined || (b.expiryDate && было && b.expiryDate < было)) {
        expiryByProduct.set(b.productId, b.expiryDate)
      }
    }
    const broughtByProduct = new Map<string, number>()
    const linesByProduct = new Map<string, number>()
    for (const it of arrival.items) {
      if (!it.productId) continue
      // Упаковка — снимком строки (1.5.12): товару могли сменить её после прихода
      const upp = it.unitsPerPack || uppOf(byId.get(it.productId) || {})
      broughtByProduct.set(it.productId, (broughtByProduct.get(it.productId) || 0) + this.unitsOf(it, upp))
      linesByProduct.set(it.productId, (linesByProduct.get(it.productId) || 0) + 1)
    }

    return {
      ...arrival,
      items: arrival.items.map((it) => {
        const p = it.productId ? byId.get(it.productId) : null
        const upp = it.unitsPerPack || uppOf(p || {})
        const brought = it.productId ? broughtByProduct.get(it.productId) || 0 : 0
        const left = it.productId ? leftByProduct.get(it.productId) || 0 : 0
        const soldUnits = Math.max(0, brought - left)
        const exp = it.productId ? expiryByProduct.get(it.productId) : null
        return {
          ...it,
          unitsPerPack: upp,
          // Для поля <input type="date">: только дата, без времени
          expiryDate: exp ? exp.toISOString().slice(0, 10) : '',
          // Товар мог быть удалён из справочника — тогда править нечего
          exists: !!p,
          soldUnits,
          // Сколько упаковок этой строки уже не вернуть. Округляем ВВЕРХ:
          // продали 1 штуку из пачки — целую пачку уже не снять.
          //
          // Если один товар стоит в приходе двумя строками, проданное относится
          // к обеим сразу, и запрет на КАЖДУЮ строку был бы строже, чем надо:
          // хватит, чтобы сумма строк покрыла проданное. Такую пару считает
          // сервер при сохранении, а подсказку в строке не показываем.
          minQty: (linesByProduct.get(it.productId || '') || 0) > 1 ? 0 : Math.ceil(soldUnits / upp),
        }
      }),
    }
  }

  async create(dto: CreateArrivalDto, userId?: string) {
    const { supplier, items } = dto

    return this.prisma.$transaction(async (tx) => {
      const ids = [...new Set(items.map((i) => i.productId))]

      // Блокируем строки товаров (в едином порядке по id — без deadlock), чтобы
      // одновременные приходы одного товара не затирали себестоимость (read-modify-write).
      await lockProducts(tx, ids)

      const products = await tx.product.findMany({ where: { id: { in: ids } } })
      const byId = new Map(products.map((p) => [p.id, p]))
      for (const it of items) if (!byId.has(it.productId)) throw new BadRequestException('Товар не найден')

      // Упаковку поменяли прямо в приходе (1.5.12): карточка получает её раньше всего
      // остального — средняя закупочная и цены дальше считаются уже по новой упаковке
      const { moved: packMoved, scaled: packScaled } = await applyPackChanges(tx, items, byId)

      // Позиции прихода сохраняем как есть (для аудита) — каждая со своей упаковкой: так
      // окно считало qty и pieces (у прежнего окна весовой товар — килограммами, lineUpp)
      const arrivalItems = items.map((it) => {
        const p = byId.get(it.productId)!
        if (oldLineOnSack(it, p)) throw new BadRequestException(OLD_WINDOW_SACK(p.name))
        const upp = lineUpp(it, p)
        const pieces = Math.max(0, Math.trunc(it.pieces || 0))
        if (it.qty * upp + pieces <= 0) throw new BadRequestException(`Укажите количество: ${p.name}`)
        return { productId: p.id, name: p.name, qty: it.qty, pieces, unitsPerPack: upp, cost: D(it.cost), discount: discountOf(it.discount) }
      })

      // Срок годности партии не обязателен: система универсальная, у хлеба или
      // шампуня даты может не быть. Впишут срок — партия под контролем сроков,
      // оставят пустым — партия живёт без срока
      const expiryByIndex = items.map((it) => {
        const raw = (it as any).expiryDate
        return raw ? expiryFrom(raw) : null
      })

      // Агрегируем по товару: суммарное кол-во и суммарная стоимость (один товар может
      // встретиться в нескольких строках) — иначе средневзвешенная считалась бы неверно.
      const agg = new Map<string, { units: number; value: Prisma.Decimal }>()
      for (const it of arrivalItems) {
        const upp = it.unitsPerPack
        const units = this.unitsOf(it, upp)
        const a = agg.get(it.productId) || { units: 0, value: D(0) }
        a.units += units
        // Цена указана за упаковку строки (за мешок, за килограмм): граммы оплачиваются долей
        a.value = a.value.plus(it.cost.times(D(units).div(upp)))
        agg.set(it.productId, a)
      }

      // Пересчитываем СРЕДНЕВЗВЕШЕННУЮ себестоимость — по одному разу на товар.
      // Само количество добавляется партиями ниже (там же обновится остаток карточки).
      // Отметку времени получает только то, что правда поменялось: приход по прежней цене
      // закупочную цену не меняет и правку цены, сделанную на кассе без связи, не перекрывает
      const costMoved = new Set<string>()
      for (const [pid, a] of agg) {
        const p = byId.get(pid)!
        const weighted = weightedPackCost({
          stock: p.stock,
          looseUnits: p.looseUnits,
          unitsPerPack: p.unitsPerPack,
          cost: p.cost,
          addPacks: Number(D(a.units).div(uppOf(p))),
          addValue: a.value,
        }).toDecimalPlaces(2)
        if (!same(p.cost, weighted)) costMoved.add(pid)
        await tx.product.update({ where: { id: pid }, data: { cost: weighted } })
      }

      // Новая цена продажи из строк прихода: владелец назначил её наценкой на новый
      // закуп. Один товар может стоять в приходе дважды — решает последняя строка
      // Цена — за упаковку строки; товару она ставится за его упаковку (как и закупочная, 1.5.12)
      const newPrice = new Map<string, Prisma.Decimal>()
      items.forEach((it, n) => {
        if (it.price === undefined || it.price === null) return
        const upp = uppOf(byId.get(it.productId)!)
        newPrice.set(it.productId, costInPack(D(it.price).toDecimalPlaces(2), arrivalItems[n].unitsPerPack, upp).toDecimalPlaces(2))
      })
      const priceMoved = new Set<string>()
      for (const [pid, price] of newPrice) {
        if (D(byId.get(pid)!.price).equals(price)) continue
        await tx.product.update({ where: { id: pid }, data: { price } })
        priceMoved.add(pid)
      }
      // Своя цена штуки (у весового — килограмма) из строк прихода: прислана — ставим (или
      // убираем, если пусто); не прислана — остаётся прежней. Решает последняя строка товара
      const pieceMoved = await applyOwnPiece(tx, items, byId)
      // Приход меняет закупочную цену (и цену продажи, если её назначили): это правка
      // карточки, и касса без связи должна видеть, что она была (common/stamps.ts)
      for (const pid of agg.keys()) {
        await stamp(tx, 'Product', pid, [
          ...(costMoved.has(pid) ? ['cost'] : []),
          ...(priceMoved.has(pid) ? ['price'] : []),
          ...(pieceMoved.has(pid) ? ['piecePrice'] : []),
          ...(packMoved.has(pid) ? ['unitsPerPack'] : []),
          ...(packScaled.has(pid) ? ['cost', 'price'] : []),
        ])
      }

      let total = D(0)
      for (const it of arrivalItems) {
        total = total.plus(it.cost.times(D(this.unitsOf(it, it.unitsPerPack)).div(it.unitsPerPack)))
      }

      // Поставщик — после товаров, в том же порядке, что и у правки прихода
      const sup = await supplierDebt(tx, dto.supplierId, dto.debt, total)
      const arrival = await tx.arrival.create({
        data: {
          supplier: sup.name || supplier?.trim() || '—',
          supplierId: sup.supplierId,
          debt: sup.debt,
          payMethod: ['cash', 'own', 'card', 'debt'].includes(dto.payMethod || '') ? dto.payMethod! : '',
          userId: userId ?? null,
          total,
          items: { create: arrivalItems },
        },
        include: { items: true },
      })
      await addDebt(tx, sup.supplierId, sup.debt)

      // «Из кассы»: оплаченная часть прихода уходит из денежного ящика. Записываем
      // её оплатой поставщику «наличными из кассы» той же транзакцией — она видна
      // в журнале оплат, уменьшает ожидаемые наличные и попадает в Z-отчёт.
      // Долг поставщика она не трогает: это оплата самого прихода, а не долга
      const paidCash = D(dto.paidCash || 0).toDecimalPlaces(2)
      if (paidCash.gt(0)) {
        if (!sup.supplierId) throw new BadRequestException('Для оплаты из кассы выберите поставщика из справочника')
        if (paidCash.gt(total.minus(sup.debt).plus(D('0.01')))) {
          throw new BadRequestException('Из кассы оплачено больше, чем стоит приход без долга')
        }
        const shiftId = await openShiftFor(tx, dto.shiftId, 'Нет открытой смены — из кассы взять нечего.')
        await tx.supplierPayment.create({
          data: {
            clientId: arrival.id + ':pay',
            supplierId: sup.supplierId,
            amount: paidCash,
            note: 'Оплата прихода',
            fromCash: true,
            shiftId,
            userId: userId ?? null,
          },
        })
        await setSupplierCash(tx, shiftId)
      }

      // Каждая строка прихода — партия со своим сроком годности. Партия помнит цену за
      // упаковку ТОВАРА: у строки, посчитанной в другой упаковке, цена переводится
      for (let n = 0; n < arrivalItems.length; n++) {
        const it = arrivalItems[n]
        const p = byId.get(it.productId)!
        await addUnits(tx, it.productId, this.unitsOf(it, it.unitsPerPack), costInPack(it.cost, it.unitsPerPack, uppOf(p)), expiryByIndex[n], arrival.id)
      }

      return arrival
    }, TX)
  }

  // ── Правка прихода ──
  //
  // Приход — не запись в журнале, а уже случившееся движение: он положил на полку
  // партии, поднял остаток и сдвинул среднюю закупочную цену. Поэтому правка не
  // «меняет цифры в строке», а переделывает движение целиком.
  //
  // Работаем ПО ТОВАРАМ, а не по строкам: один товар может стоять в приходе дважды
  // (две партии с разными сроками), и партию к отдельной строке уже не привязать.
  //
  // Что нельзя: опустить количество ниже проданного. Этих упаковок физически нет
  // на полке, и «снять» их означало бы увести остаток в минус.
  async update(id: string, dto: UpdateArrivalDto) {
    return this.prisma.$transaction((tx) => updateArrivalIn(tx, id, dto), TX)
  }

  // ── Удаление прихода ──
  // Снимает с полки всё, что от него ещё осталось, и возвращает закупочную цену
  // к той, что следует из оставшихся партий. Проданное не трогаем: тех упаковок
  // уже нет, а чеки хранят свою себестоимость снимком и задним числом не меняются.
  async remove(id: string) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await removeArrivalIn(tx, id))) throw new BadRequestException('Приход не найден')
      return { ok: true }
    }, TX)
  }
}

// Штук в строке прихода: упаковки × штук в упаковке + штуки (граммы) сверх
const unitsOfLine = (it: { qty: number; pieces?: number | null }, upp: number) => (it.qty || 0) * upp + Math.max(0, Math.trunc(it.pieces || 0))

type Card = Awaited<ReturnType<Tx['product']['findMany']>>[number]

// ── Упаковку товара поменяли прямо в приходе (1.5.12) ──
// Строка с packChanged приносит новую упаковку: мешок 50 кг вместо килограмма, пачку по 24
// вместо 20. Остаток при этом не меняется — партии хранят штуки (граммы), карточка лишь
// заново делит их на упаковки. Что значили прежние цены, говорит человек (packScale):
//   • были за прежнюю упаковку (185 за кг) — переводятся на новую: закупочная, цена продажи и
//     цена каждой партии × новая / прежняя упаковка (9250 за мешок) — на грамм всё как было;
//   • уже за новую (так записали — «190 за кг», а это цена мешка) — числа остаются.
// Решает последняя строка товара. byId получает свежие карточки. Общая часть для сайта и для
// прихода с кассы без связи (sync). Возвращает товары, у которых упаковка правда сменилась, и
// те, у которых цены переведены
export async function applyPackChanges(
  tx: Tx,
  items: { productId: string; unitsPerPack?: number | null; packChanged?: boolean; packScale?: boolean }[],
  byId: Map<string, Card>,
): Promise<{ moved: Set<string>; scaled: Set<string> }> {
  const want = new Map<string, { upp: number; scale: boolean }>()
  for (const it of items) if (it.packChanged && it.unitsPerPack) want.set(it.productId, { upp: it.unitsPerPack, scale: it.packScale === true })
  const moved = new Set<string>()
  const scaled = new Set<string>()
  for (const [pid, w] of want) {
    const p = byId.get(pid)
    if (!p) continue
    const was = uppOf(p)
    const upp = packFor(p.unit, w.upp)
    if (upp === was) continue
    // Товар, заведённый до партий, сначала ложится партией по прежней упаковке
    await ensureBatch(tx, p)
    const data: Prisma.ProductUncheckedUpdateInput = { unitsPerPack: upp }
    if (w.scale) {
      data.cost = costInPack(p.cost, was, upp)
      data.price = costInPack(p.price, was, upp)
      await tx.$executeRaw(Prisma.sql`UPDATE "Batch" SET "cost" = ROUND("cost" * ${upp}::numeric / ${was}::numeric, 2) WHERE "productId" = ${pid}`)
      scaled.add(pid)
    }
    await tx.product.update({ where: { id: pid }, data })
    await syncProduct(tx, pid)
    byId.set(pid, (await tx.product.findUnique({ where: { id: pid } }))!)
    moved.add(pid)
  }
  return { moved, scaled }
}

// ── Своя цена штуки (у весового — килограмма) из строк прихода ──
// Прислана — ставим (пусто — убираем), не прислана — прежняя. Своя цена бывает только у
// товара, упаковку которого вскрывают: убрали в приходе мешок — уходит и цена за 1 кг
// (common/piece.ts). Решает последняя строка товара. Возвращает товары, где цена сменилась
export async function applyOwnPiece(
  tx: Tx,
  items: { productId: string; piecePrice?: unknown }[],
  byId: Map<string, Card>,
): Promise<Set<string>> {
  const asked = new Map<string, Prisma.Decimal | null>()
  for (const it of items) if (it.piecePrice !== undefined) asked.set(it.productId, piecePriceIn(it.piecePrice))
  const moved = new Set<string>()
  for (const pid of new Set(items.map((i) => i.productId))) {
    const p = byId.get(pid)
    if (!p) continue
    let want = asked.has(pid) ? asked.get(pid)! : p.piecePrice
    if (want !== null && !opensPack(p)) want = null
    if (same(p.piecePrice, want)) continue
    await tx.product.update({ where: { id: pid }, data: { piecePrice: want } })
    byId.set(pid, { ...p, piecePrice: want })
    moved.add(pid)
  }
  return moved
}

// Упаковка, в которой окно прислало строку правки. Новое окно присылает её само; прежнее
// считало весовой товар килограммами, остальные — по нынешней карточке (common/piece, lineUpp)
const editUpp = (l: { unitsPerPack?: number | null }, p: { unit?: string | null; unitsPerPack?: number | null } | undefined) =>
  l.unitsPerPack ? l.unitsPerPack : isDrob(p?.unit) ? KG : uppOf(p || {})

// ── Правка прихода ──
// Общая часть для сайта и для правки, сделанной на кассе без связи (sync). Подробности
// правила — у метода update выше
// at — когда правили (у кассы без связи — момент на кассе): по нему решается, чья правка
// новее, если приход правили и там, и тут (common/stamps.ts)
export async function updateArrivalIn(tx: Tx, id: string, dto: UpdateArrivalDto, at: Date = new Date()) {
  const arrival = await tx.arrival.findUnique({ where: { id }, include: { items: true } })
  if (!arrival) throw new BadRequestException('Приход не найден')

  const byLineId = new Map(arrival.items.map((i) => [i.id, i]))
  const lines = dto.items.filter((l) => byLineId.has(l.id))
  if (!lines.length) throw new BadRequestException('Строки прихода не найдены')
  if (!lines.some((l) => l.qty > 0 || (l.pieces || 0) > 0)) {
    throw new BadRequestException('В приходе не осталось ни одной позиции. Чтобы убрать его целиком, удалите приход.')
  }

  const ids = [...new Set(arrival.items.map((i) => i.productId).filter(Boolean) as string[])]
  // Тот же замок, что и при создании: одновременная продажа не должна
  // разъехаться с пересчётом остатка (read-modify-write)
  await lockProducts(tx, ids)
  const products = await tx.product.findMany({ where: { id: { in: ids } } })
  const byId = new Map(products.map((p) => [p.id, p]))
  const batches = await tx.batch.findMany({ where: { arrivalId: id } })

  // Срок годности партий этого прихода — до того, как мы их снимем.
  // Пустое поле в правке означает «оставить как было»: стереть срок случайно
  // нельзя, иначе весь контроль сроков в магазине молча провалился бы
  const прежнийСрок = new Map<string, Date | null>()
  for (const b of batches) {
    const было = прежнийСрок.get(b.productId)
    if (было === undefined || (b.expiryDate && было && b.expiryDate < было)) {
      прежнийСрок.set(b.productId, b.expiryDate)
    }
  }

  // Новое состояние каждой строки: не прислали — считаем, что убрали
  const wanted = new Map(lines.map((l) => [l.id, l]))
  // Товары, у которых закупочная цена правда поменялась: отметку времени получают только они
  // (иначе правка прихода на сайте перекрыла бы цену, поправленную на кассе без связи)
  const costMoved: string[] = []

  // Упаковка, в которой окно прислало каждую строку. Строку, записанную в одной упаковке,
  // окно показало и прислало в другой — цена и количество в ней значили бы не то. Такую
  // правку не принимаем. Прежнее окно упаковку строки не знает — пусть правят обновлённым;
  // новое прислало не ту, что записана (документ у него устарел) — пусть откроют заново
  const inUpp = new Map<string, number>()
  for (const l of lines) {
    const it = byLineId.get(l.id)!
    const p = it.productId ? byId.get(it.productId) : undefined
    const was = it.unitsPerPack || uppOf(p || {})
    const got = editUpp(l, p)
    if (got !== was) {
      throw new BadRequestException(
        l.unitsPerPack
          ? `«${it.name}»: строка прихода записана с другой упаковкой. Откройте приход заново и поправьте ещё раз.`
          : `«${it.name}»: упаковку товара сменили после этого прихода. Обновите программу (сайт — перезагрузите) и поправьте приход заново.`,
      )
    }
    inUpp.set(l.id, got)
  }

  for (const pid of ids) {
    const p = byId.get(pid)
    const upp = uppOf(p || {})
    const mine = arrival.items.filter((i) => i.productId === pid)

    // Было — по упаковке, с которой строку записали (1.5.12): товару могли сменить её позже
    const brought = mine.reduce((s, i) => s + unitsOfLine(i, i.unitsPerPack || upp), 0)
    const left = batches.filter((b) => b.productId === pid).reduce((s, b) => s + b.units, 0)
    const sold = Math.max(0, brought - left)

    const newLines = mine.map((i) => wanted.get(i.id)).filter(Boolean) as typeof lines
    const wantUnits = newLines.reduce((s, l) => s + unitsOfLine(l, inUpp.get(l.id)!), 0)

    if (wantUnits < sold) {
      const name = p?.name || mine[0]?.name || 'товар'
      // Дробному — в его единице: «350 шт» для него значило бы граммы
      const skolko = isDrob(p?.unit) ? `${sold / KG} ${String(p?.unit).trim()}` : `${sold} шт (${Math.ceil(sold / upp)} уп)`
      throw new BadRequestException(
        `«${name}»: из этого прихода уже продано ${skolko}. ` +
          'Меньше проданного поставить нельзя — этого товара на полке уже нет.',
      )
    }

    // Партии прихода снимаем целиком и раскладываем заново: так одним
    // действием меняются и количество, и цена, и срок годности
    await tx.batch.deleteMany({ where: { arrivalId: id, productId: pid } })

    // ── Обязательно ДО раскладки ──
    // Приход штук умеет чинить товары, заведённые до появления партий: увидев
    // карточку с остатком и ни одной партии, он считает остаток «начальным»
    // и заводит партию под него. Здесь это сработало бы во вред: партии мы
    // только что сняли, а в карточке ещё лежит прежний остаток — и он вернулся
    // бы отдельной партией, сложившись с новым количеством. Поэтому сначала
    // приводим карточку к пустым партиям и лишь потом раскладываем заново.
    await syncProduct(tx, pid)

    // На полку возвращаем всё новое количество за вычетом проданного.
    // Раскладываем по строкам подряд: если товар стоит одной строкой —
    // а так почти всегда — это просто «сколько осталось»
    let toPlace = wantUnits - sold
    for (const l of newLines) {
      if (toPlace <= 0) break
      const take = Math.min(unitsOfLine(l, inUpp.get(l.id)!), toPlace)
      if (take <= 0) continue
      const срок = l.expiryDate ? expiryFrom(l.expiryDate) : прежнийСрок.get(pid) ?? null
      // Партия — с ценой за упаковку товара, строка — в своей упаковке
      await addUnits(tx, pid, take, costInPack(l.cost, inUpp.get(l.id)!, upp), срок, id)
      toPlace -= take
    }

    // Остаток карточки и её цена — заново, по тому, что реально осталось.
    // Обратить средневзвешенную формулу нельзя, а посчитать по партиям можно
    await syncProduct(tx, pid)
    const nowBatches = await tx.batch.findMany({ where: { productId: pid } })
    // Как её хранит база — до дирама: иначе «10.3333…» не совпало бы с прежними 10.33
    const cost = costFromBatches(nowBatches, upp, p?.cost ?? 0).toDecimalPlaces(2)
    if (!same(p?.cost, cost)) costMoved.push(pid)
    await tx.product.update({ where: { id: pid }, data: { cost } })
  }

  // Сами строки: убранные удаляем, остальные переписываем
  for (const it of arrival.items) {
    const l = wanted.get(it.id)
    if (!l || l.qty * inUpp.get(l.id)! + (l.pieces || 0) <= 0) {
      await tx.arrivalItem.delete({ where: { id: it.id } })
      continue
    }
    await tx.arrivalItem.update({
      where: { id: it.id },
      data: { qty: l.qty, pieces: Math.max(0, Math.trunc(l.pieces || 0)), unitsPerPack: inUpp.get(l.id)!, cost: D(l.cost) },
    })
  }

  // Сумма — как при оформлении: цена за упаковку × сколько пришло, вместе со
  // штуками сверх целых упаковок (и граммами весового). Раньше здесь считались
  // только упаковки, и «2 уп + 5 шт» после правки стоили как 2 уп
  const total = lines.reduce((s, l) => {
    const upp = inUpp.get(l.id)!
    const units = unitsOfLine(l, upp)
    return units > 0 ? s.plus(D(l.cost).times(D(units).div(upp))) : s
  }, D(0)).toDecimalPlaces(2)

  // Долг поставщика переписывается вместе с приходом: прежняя неоплаченная часть
  // снимается с прежнего поставщика, новая ложится на нового (это может быть тот же)
  const nextSupplierId = dto.supplierId === undefined ? arrival.supplierId : dto.supplierId || null
  const nextAsked = dto.debt === undefined ? arrival.debt : dto.debt
  // Замки на поставщиков — в одном порядке, чтобы две правки не заперли друг друга
  for (const sid of [arrival.supplierId, nextSupplierId].filter((x, i, a): x is string => !!x && a.indexOf(x) === i).sort()) {
    if (!(await lockSupplier(tx, sid)) && sid === nextSupplierId) throw new BadRequestException('Поставщик не найден')
  }
  const sup = await supplierDebt(tx, nextSupplierId, nextAsked, total)
  await addDebt(tx, arrival.supplierId, D(arrival.debt).negated())
  await addDebt(tx, sup.supplierId, sup.debt)
  // Приход правили — и закупочная цена его товаров пересчитана
  await stamp(tx, 'Arrival', id, ['doc'], at)
  for (const pid of costMoved) await stamp(tx, 'Product', pid, ['cost'], at)

  return tx.arrival.update({
    where: { id },
    data: {
      supplier: sup.name || (dto.supplierId === '' ? dto.supplier?.trim() || '—' : dto.supplier?.trim() || arrival.supplier),
      supplierId: sup.supplierId,
      debt: sup.debt,
      total,
    },
    include: { items: true },
  })
}

// ── Удаление прихода ──
// Общая часть для сайта и для удаления на кассе без связи (sync). Прихода уже нет — false
export async function removeArrivalIn(tx: Tx, id: string, at: Date = new Date()): Promise<boolean> {
  const arrival = await tx.arrival.findUnique({ where: { id }, include: { items: true } })
  if (!arrival) return false

  const ids = [...new Set(arrival.items.map((i) => i.productId).filter(Boolean) as string[])]
  await lockProducts(tx, ids)
  const products = await tx.product.findMany({ where: { id: { in: ids } } })
  const byId = new Map(products.map((p) => [p.id, p]))

  for (const pid of ids) {
    const p = byId.get(pid)
    await tx.batch.deleteMany({ where: { arrivalId: id, productId: pid } })
    await syncProduct(tx, pid)
    const nowBatches = await tx.batch.findMany({ where: { productId: pid } })
    const cost = costFromBatches(nowBatches, uppOf(p || {}), p?.cost ?? 0).toDecimalPlaces(2)
    await tx.product.update({ where: { id: pid }, data: { cost } })
    // Отметка — только если цена правда поменялась
    if (!same(p?.cost, cost)) await stamp(tx, 'Product', pid, ['cost'], at)
  }

  // Неоплаченная часть удалённого прихода долгом больше не числится
  if (arrival.supplierId) {
    await lockSupplier(tx, arrival.supplierId)
    await addDebt(tx, arrival.supplierId, D(arrival.debt).negated())
  }
  await tx.arrival.delete({ where: { id } }) // строки уходят каскадом
  await forgetStamps(tx, 'Arrival', id)
  return true
}
