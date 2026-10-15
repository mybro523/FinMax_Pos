import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { D } from './money'
import { isExpired, startOfTodayTj, storableDate } from './time'

// ── Движение остатков через партии ──
// Правило системы: сумма остатков всех партий товара всегда равна его остатку
// (упаковки × штук в упаковке + штуки во вскрытой). Партии хранят количество
// в ШТУКАХ — так не возникает путаницы при делении упаковок.
//
// Списание идёт по правилу FEFO: первой уходит партия с ближайшим сроком годности.
// Благодаря этому кассир ничего не выбирает, а просрочка не залёживается.
//
// У FEFO есть обратная сторона: просроченная партия — как раз та, у которой срок
// ближе всех, и продаже она доставалась ПЕРВОЙ. Магазин молча отдавал покупателю
// просрочку, пока раздел «Срок годности» честно показывал её владельцу.
// Поэтому продажа теперь берёт ближайшую ГОДНУЮ партию (skipExpired), а списание
// и пересчёт остатков — любую: убрать просрочку со склада надо именно ими.
//
// ВАЖНО про скорость: всё это выполняется внутри денежной транзакции, а у неё есть
// ограничение по времени. Поэтому здесь намеренно минимум обращений к базе:
// товар и его партии читаются ОДИН раз, дальше идут только записи.

type Tx = Prisma.TransactionClient

export const uppOf = (p: { unitsPerPack?: number | null }) => Math.max(1, p?.unitsPerPack || 1)
export const totalUnits = (p: { stock?: number; looseUnits?: number | null; unitsPerPack?: number | null }) =>
  (p.stock || 0) * uppOf(p) + (p.looseUnits || 0)

// ── Замок на товары ──
// Функции ниже читают партии, считают в памяти и записывают готовые числа. Если две
// операции с одним товаром пойдут одновременно, вторая запишет своё поверх первой —
// и одно из движений пропадёт. Поэтому всё, что двигает остаток, первым делом берёт
// замок на карточки своих товаров: вторая операция ждёт, пока закончит первая.
// Порядок по номеру единый для всех: иначе две операции с пересекающимися товарами
// заперли бы друг друга.
//
// Замок — «меняю числа в карточке» (FOR NO KEY UPDATE), а не «удаляю карточку»
// (FOR UPDATE). Разница в том, кого он заставляет ждать: тех, кто двигает этот же
// остаток, — да; тех, кто только ссылается на товар (новый лист пересчёта, строка
// документа), — нет. С полным замком применение пересчёта всего склада останавливало
// бы и их, а с листом пересчёта, который в эту минуту создают, могло и запереть друг друга.
export async function lockProducts(tx: Tx, ids: (string | null | undefined)[]) {
  const sorted = [...new Set(ids.filter((x): x is string => !!x))].sort()
  // Пересчёт всего склада — это тысячи товаров, а у базы есть предел на число
  // подставляемых значений. Пачки идут по возрастанию, так что порядок сохраняется
  for (let at = 0; at < sorted.length; at += 1000) {
    const part = sorted.slice(at, at + 1000)
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Product" WHERE id IN (${Prisma.join(part)}) ORDER BY id FOR NO KEY UPDATE`)
  }
}

// ── Срок годности из запроса сайта ──
// Год длиннее четырёх цифр база не хранит (см. storableDate): отказываем здесь и
// понятными словами. Не дату вовсе («2026-13-45») функция не трогает — с ней, как и
// раньше, разбирается тот, кто вызвал
export function expiryFrom(raw: string | Date): Date {
  const d = new Date(raw)
  if (Number.isFinite(d.getTime()) && !storableDate(d.getTime())) throw new BadRequestException('Срок годности: проверьте год')
  return d
}

// ── Срок годности товара, который вернул покупатель ──
// Из какой партии продана пачка, при продаже не записывается, а срок ей нужен: товар
// без срока выпадает из контроля сроков и продавался бы сколько угодно.
//
// Раньше возвращённое получало срок ближайшей партии из тех, что лежат на складе. Склад
// пуст — срока не было вовсе. А когда партию, из которой пачку продали, уже распродали,
// пачка получала срок следующей — то есть ПОЗЖЕ настоящего.
//
// Теперь — самый ранний срок среди партий товара, которые были годны в день покупки,
// в том числе уже распроданных. Продажа берёт партию с ближайшим сроком, поэтому
// настоящий срок пачки не раньше этого: ошибиться можно только в осторожную сторону.
// Точный срок кассир может вписать сам, с упаковки (enteredExpiry), — тогда берётся он.
//
// soldAt — когда товар продали (возврат без чека — когда вернули).
// fallback — что взять, если ни одна партия не подошла: срок из карточки товара.
export function returnExpiry(batches: { expiryDate: Date | null }[], soldAt: Date, fallback: Date | null = null): Date | null {
  const from = startOfTodayTj(soldAt).getTime()
  let best: number | null = null
  for (const b of batches) {
    if (!b.expiryDate) continue
    const t = b.expiryDate.getTime()
    if (t >= from && (best === null || t < best)) best = t
  }
  return best === null ? fallback : new Date(best)
}

// Срок, который кассир вписал с упаковки возвращаемого товара. Пусто — null: срок
// поставит правило. Товар с истёкшим сроком в продажу не возвращают — его списывают.
// Текст отказа тот же у программы для Windows (desktop/src/local/check.mjs)
export const RETURN_EXPIRED = 'Срок на упаковке уже истёк — такой товар в продажу не возвращают. Выберите «Списать».'
export function enteredExpiry(raw: string | null | undefined, restock: boolean): Date | null {
  if (raw === null || raw === undefined || raw === '') return null
  const d = expiryFrom(raw)
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Срок годности: неверная дата')
  if (restock && isExpired(d)) throw new BadRequestException(RETURN_EXPIRED)
  return d
}

// ── Сколько стоит недостача товара ──
// rows — строки списания одного товара: цена упаковки и штуки. Сначала складываем
// «цена упаковки × штук» и только потом делим на число штук в упаковке — так результат
// не зависит от порядка строк и точен до дирама. Этой формулой недостачу оценивает и
// применение пересчёта, и её поправка, когда касса присылает операцию, сделанную до
// пересчёта (sync.service.ts): считай они по-разному, сумма списания расходилась бы
// с его строками на дирам на каждой «половинке».
export function shortageWorth(rows: { cost: Prisma.Decimal | number; units: number }[], unitsPerPack: number) {
  return rows
    .reduce((s, r) => s.plus(D(r.cost as any).times(r.units)), D(0))
    .dividedBy(Math.max(1, unitsPerPack))
    .toDecimalPlaces(2)
}

// Порядок списания: сначала ближайший срок, бессрочные — в конце
const byFefo = (a: { expiryDate: Date | null; createdAt: Date }, b: { expiryDate: Date | null; createdAt: Date }) => {
  const ax = a.expiryDate ? a.expiryDate.getTime() : Number.MAX_SAFE_INTEGER
  const bx = b.expiryDate ? b.expiryDate.getTime() : Number.MAX_SAFE_INTEGER
  return ax !== bx ? ax - bx : a.createdAt.getTime() - b.createdAt.getTime()
}

// Читаем товар и его партии одним заходом. У товаров, заведённых до появления
// партий, остаток лежит только в карточке — тогда создаём начальную партию.
async function load(tx: Tx, productId: string) {
  const product = await tx.product.findUnique({ where: { id: productId }, include: { batches: true } })
  if (!product) throw new BadRequestException('Товар не найден')
  let batches = product.batches
  if (batches.length === 0) {
    const need = totalUnits(product)
    if (need > 0) {
      const b = await tx.batch.create({
        data: { productId, units: need, cost: product.cost, expiryDate: product.expiryDate, note: 'Начальный остаток' },
      })
      batches = [b]
    }
  }
  return { product, batches }
}

// Приводим карточку товара к партиям: упаковки, штуки во вскрытой и ближайший срок.
// Значения передаются готовыми, чтобы не перечитывать партии из базы.
async function writeTotals(tx: Tx, product: { id: string; unitsPerPack: number | null }, batches: { units: number; expiryDate: Date | null }[]) {
  const upp = uppOf(product)
  const live = batches.filter((b) => b.units > 0)
  const units = live.reduce((s, b) => s + b.units, 0)
  const dates = live.map((b) => b.expiryDate).filter(Boolean) as Date[]
  const nearest = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null
  // Сколько штук уже просрочено. Касса вычитает это из остатка и показывает
  // кассиру, сколько товара реально можно продать, — иначе он набрал бы полный
  // остаток, а сервер отказал бы уже на оплате.
  const expired = live.reduce((s, b) => s + (isExpired(b.expiryDate) ? b.units : 0), 0)
  await tx.product.update({
    where: { id: product.id },
    data: { stock: Math.floor(units / upp), looseUnits: units % upp, expiryDate: nearest, expiredUnits: expired },
  })
}

// Пересчёт карточки по партиям — для мест, где партии меняли напрямую
// (например, ручная правка остатка в карточке товара). Два запроса вместо трёх.
export async function syncProduct(tx: Tx, productId: string) {
  const product = await tx.product.findUnique({ where: { id: productId }, include: { batches: true } })
  if (!product) return
  await writeTotals(tx, product, product.batches)
}

// Списание нужного числа штук по FEFO. Возвращает, из каких партий и сколько взято —
// это нужно, чтобы записать себестоимость и срок в документ (продажа, списание).
//
// skipExpired=true — брать только годные партии. Так работает продажа.
// По умолчанию берутся любые: списанию и пересчёту остатков нужно добраться
// именно до просроченного товара.
export async function consumeUnits(
  tx: Tx,
  productId: string,
  units: number,
  productName = 'товар',
  opts: { skipExpired?: boolean } = {},
) {
  return (await takeUnits(tx, productId, units, productName, { ...opts, tolerant: false })).taken
}

// ── То же, но без отказа ──
// Для операций, которые УЖЕ случились: касса продала без интернета, товар отдан,
// деньги взяты. Отказать задним числом нельзя. Берём сколько есть, а чего не
// хватило — возвращаем числом: его записывают как «продано больше, чем было».
//
// atDate — на какой момент оценивать срок годности. Продажа, пришедшая с кассы
// через три дня, брала партию, которая в тот день была годной.
export async function consumeUnitsTolerant(
  tx: Tx,
  productId: string,
  units: number,
  opts: { skipExpired?: boolean; atDate?: Date } = {},
) {
  return takeUnits(tx, productId, units, 'товар', { ...opts, tolerant: true })
}

type Taken = { batchId: string; units: number; cost: Prisma.Decimal; expiryDate: Date | null }

async function takeUnits(
  tx: Tx,
  productId: string,
  units: number,
  productName: string,
  opts: { skipExpired?: boolean; tolerant: boolean; atDate?: Date },
): Promise<{ taken: Taken[]; short: number }> {
  if (units <= 0) return { taken: [], short: 0 }
  const { product, batches } = await load(tx, productId)
  const live = batches.filter((b) => b.units > 0)
  const usable = (opts.skipExpired ? live.filter((b) => !isExpired(b.expiryDate, opts.atDate)) : live).sort(byFefo)
  const have = usable.reduce((s, b) => s + b.units, 0)
  if (have < units && !opts.tolerant) {
    const name = product.name || productName
    const expired = live.reduce((s, b) => s + (isExpired(b.expiryDate) ? b.units : 0), 0)
    // Кассир должен понимать, что делать: «мало товара» и «товар просрочен» —
    // это разные ситуации с разными действиями
    throw new BadRequestException(
      opts.skipExpired && expired > 0
        ? `«${name}»: годных ${have} шт, просрочено ${expired} шт. Просроченное продавать нельзя — уберите его с полки и спишите.`
        : `Недостаточно «${name}» на складе (есть ${have} шт)`,
    )
  }

  const taken: Taken[] = []
  let left = Math.min(units, have)
  for (const b of usable) {
    if (left <= 0) break
    const take = Math.min(left, b.units)
    b.units -= take // держим актуальное состояние в памяти — не перечитываем базу
    await tx.batch.update({ where: { id: b.id }, data: { units: b.units } })
    taken.push({ batchId: b.id, units: take, cost: b.cost, expiryDate: b.expiryDate })
    left -= take
  }
  await writeTotals(tx, product, batches)
  return { taken, short: Math.max(0, units - have) }
}

// Приход штук: новая партия со своим сроком. Одинаковые срок+цена объединяем,
// чтобы не плодить десятки партий по одному и тому же товару.
export async function addUnits(
  tx: Tx,
  productId: string,
  units: number,
  cost: Prisma.Decimal | number,
  expiryDate?: Date | null,
  arrivalId?: string | null,
  note = '',
) {
  if (units <= 0) return null
  const { product, batches } = await load(tx, productId)
  const exp = expiryDate ?? null
  const price = D(cost as any)
  const expKey = exp ? exp.getTime() : null
  const same = batches.find(
    (b) => (b.expiryDate ? b.expiryDate.getTime() : null) === expKey && D(b.cost).equals(price) && (b.arrivalId ?? null) === (arrivalId ?? null),
  )

  let batch
  if (same) {
    same.units += units
    batch = await tx.batch.update({ where: { id: same.id }, data: { units: same.units } })
  } else {
    batch = await tx.batch.create({
      data: { productId, units, cost: price, expiryDate: exp, arrivalId: arrivalId ?? null, note },
    })
    batches.push(batch)
  }
  await writeTotals(tx, product, batches)
  return batch
}

// Привести остаток товара к точному числу штук (инвентаризация).
// Излишек кладём в партию с самым дальним сроком, недостачу списываем по FEFO.
export async function setUnits(tx: Tx, productId: string, targetUnits: number, productName = 'товар') {
  const { product, batches } = await load(tx, productId)
  const usable = batches.filter((b) => b.units > 0).sort(byFefo)
  const have = usable.reduce((s, b) => s + b.units, 0)
  const diff = targetUnits - have
  if (diff === 0) return { diff: 0, taken: [] as any[] }

  if (diff < 0) {
    const taken = await consumeUnits(tx, productId, -diff, product.name || productName)
    return { diff, taken }
  }

  const last = usable[usable.length - 1]
  if (last) {
    last.units += diff
    await tx.batch.update({ where: { id: last.id }, data: { units: last.units } })
  } else {
    const created = await tx.batch.create({
      data: { productId, units: diff, cost: product.cost, expiryDate: product.expiryDate, note: 'Излишек по инвентаризации' },
    })
    batches.push(created)
  }
  await writeTotals(tx, product, batches)
  return { diff, taken: [] as any[] }
}
