import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { D } from '../common/money'
import { TX } from '../common/tx'
import { periodFilter, PeriodQuery, MAX_ROWS } from '../common/period'
import { weightedPackCost } from '../common/cost'
import { isDrob, KG } from '../common/piece'
import { addUnits, byFefo, expiryFrom, lockProducts, uppOf } from '../common/stock'
import { same, stamp } from '../common/stamps'
import { SkladEditDto, SkladToShopDto } from './dto'

// ── Склад (1.8.0) ──
// Свой склад магазина — отдельный запас товара: то, что не помещается в зал. Магазин
// (Product.stock, Batch) его не видит — продажи, сроки, списания и пересчёт работают
// как прежде. На склад товар попадает приходом «Куда: Склад» (arrivals.service,
// place 'sklad'), в магазин — переносом. Перенос кладёт товар в магазин обычной
// партией — с ценой и сроком складской партии — и сдвигает среднюю закупочную, как
// приход. Каждое движение склада — документ SkladMove: перенос (toShop) или правка
// остатка (edit).
//
// Функции «…In(tx, …)» — общая часть для сайта и для операций с кассы без связи (sync).

type Tx = Prisma.TransactionClient
export const SKLAD_WITH_USER = { user: { select: { id: true, name: true } } } as const

export type SkladRow = { id: string; units: number; cost: Prisma.Decimal | number | string; expiryDate: Date | null; createdAt: Date }

// Из каких партий склада брать: сначала ближайший срок, бессрочные — последними, при
// равных — старые раньше (как у магазина, common/stock byFefo)
export function planTake<T extends SkladRow>(rows: T[], units: number): { parts: { row: T; units: number }[]; have: number } {
  const live = rows.filter((r) => r.units > 0).sort(byFefo)
  const have = live.reduce((s, r) => s + r.units, 0)
  const parts: { row: T; units: number }[] = []
  let left = Math.min(Math.max(0, units), have)
  for (const r of live) {
    if (left <= 0) break
    const take = Math.min(left, r.units)
    parts.push({ row: r, units: take })
    left -= take
  }
  return { parts, have }
}

// Остаток словами — для отказа: «3 уп + 2 шт», «1,5 кг», «7 шт»
export function unitsText(units: number, p: { unit?: string | null; unitsPerPack?: number | null }): string {
  if (isDrob(p.unit)) return `${String(Math.round((units / KG) * 1000) / 1000).replace('.', ',')} кг`
  const upp = uppOf(p)
  if (upp <= 1) return `${units} шт`
  const packs = Math.floor(units / upp)
  const rest = units % upp
  return rest ? `${packs} уп + ${rest} шт` : `${packs} уп`
}

type Chunk = { units: number; cost: Prisma.Decimal; expiryDate: Date | null }

// Снять штуки со склада по партиям. Партия, ставшая пустой, удаляется. tolerant — для
// операций, которые уже случились (касса без связи перенесла товар руками): берём сколько
// есть, нехватку возвращаем числом
async function takeFromSklad(tx: Tx, p: { id: string; name: string; unit?: string | null; unitsPerPack?: number | null }, units: number, tolerant = false) {
  const rows = await tx.skladBatch.findMany({ where: { productId: p.id } })
  const { parts, have } = planTake(rows, units)
  if (have < units && !tolerant) throw new BadRequestException(`На складе не хватает: ${p.name} (есть ${unitsText(have, p)})`)
  const taken: Chunk[] = []
  for (const { row, units: take } of parts) {
    const left = row.units - take
    if (left > 0) await tx.skladBatch.update({ where: { id: row.id }, data: { units: left } })
    else await tx.skladBatch.delete({ where: { id: row.id } })
    taken.push({ units: take, cost: D(row.cost), expiryDate: row.expiryDate })
  }
  return { taken, short: Math.max(0, units - have) }
}

const lineOf = (p: { id: string; name: string }, c: Chunk, sign = 1) => ({
  productId: p.id,
  name: p.name,
  units: sign * c.units,
  cost: Number(D(c.cost).toDecimalPlaces(2)),
  expiryDate: c.expiryDate ? c.expiryDate.toISOString() : null,
})

// Повтор: тот же документ уже записан (clientId с кассы или с сайта, id с кассы)
async function already(tx: Tx, id?: string | null, clientId?: string | null) {
  if (clientId) {
    const m = await tx.skladMove.findUnique({ where: { clientId }, include: SKLAD_WITH_USER })
    if (m) return m
  }
  if (id) {
    const m = await tx.skladMove.findUnique({ where: { id }, include: SKLAD_WITH_USER })
    if (m) return m
  }
  return null
}

export type ToShopInput = {
  id?: string | null
  clientId?: string | null
  date?: Date
  note?: string
  items: { productId: string; units: number }[]
}

// ── Перенос со склада в магазин ──
// tolerant — операция с кассы без связи: товар уже перенесли руками. Не хватило на складе
// (сосед успел перенести) — в магазин всё равно ложится перенесённое, недостающее — по
// нынешней закупочной товара
export async function skladToShopIn(tx: Tx, input: ToShopInput, userId: string | null, opts: { tolerant?: boolean; at?: Date } = {}) {
  const dup = await already(tx, input.id, input.clientId)
  if (dup) return dup
  // По товару — сумма строк (один товар мог встретиться дважды), порядок — как прислали
  const want = new Map<string, number>()
  for (const it of input.items || []) {
    const units = Math.trunc(Number(it.units) || 0)
    if (!it.productId || units <= 0) throw new BadRequestException('Укажите, сколько перенести')
    want.set(it.productId, (want.get(it.productId) || 0) + units)
  }
  if (!want.size) throw new BadRequestException('Нечего переносить')
  const ids = [...want.keys()]
  await lockProducts(tx, ids)
  const products = await tx.product.findMany({ where: { id: { in: ids } } })
  const byId = new Map(products.map((p) => [p.id, p]))
  for (const pid of ids) if (!byId.has(pid)) throw new BadRequestException('Товар не найден')

  const at = opts.at ?? input.date ?? new Date()
  const lines: ReturnType<typeof lineOf>[] = []
  let total = D(0)
  for (const [pid, units] of want) {
    const p = byId.get(pid)!
    const { taken, short } = await takeFromSklad(tx, p, units, opts.tolerant)
    const chunks = short > 0 ? [...taken, { units: short, cost: D(p.cost), expiryDate: null }] : taken
    const upp = uppOf(p)
    const addValue = chunks.reduce((s, c) => s.plus(D(c.cost).times(c.units).div(upp)), D(0))
    // Средняя закупочная — как у прихода: от остатка магазина ДО переноса
    const weighted = weightedPackCost({
      stock: p.stock,
      looseUnits: p.looseUnits,
      unitsPerPack: p.unitsPerPack,
      cost: p.cost,
      addPacks: Number(D(units).div(upp)),
      addValue,
    }).toDecimalPlaces(2)
    if (!same(p.cost, weighted)) {
      await tx.product.update({ where: { id: pid }, data: { cost: weighted } })
      await stamp(tx, 'Product', pid, ['cost'], at)
    }
    // В магазин — обычной партией со сроком и ценой складской (остаток карточки пересчитает addUnits)
    for (const c of chunks) await addUnits(tx, pid, c.units, c.cost, c.expiryDate, null, 'Со склада')
    lines.push(...chunks.map((c) => lineOf(p, c)))
    total = total.plus(addValue)
  }
  return tx.skladMove.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      clientId: input.clientId ?? null,
      kind: 'toShop',
      date: input.date ?? new Date(),
      userId: userId ?? null,
      note: (input.note || '').trim().slice(0, 500),
      items: lines as unknown as Prisma.InputJsonValue,
      total: total.toDecimalPlaces(2),
    },
    include: SKLAD_WITH_USER,
  })
}

export type EditInput = {
  id?: string | null
  clientId?: string | null
  date?: Date
  note?: string
  productId: string
  units: number
  cost?: number | null
  expiryDate?: string | Date | null
}

// ── Правка остатка склада ──
// Поставить остаток товара на складе = units штук. Больше нынешнего — новая партия на
// разницу (цена за упаковку: присланная или нынешняя закупочная товара; срок — присланный),
// меньше — снимается по тем же правилам, что перенос. quiet — касса без связи: остаток
// уже такой — документа не будет (null), а не отказ
export async function skladEditIn(tx: Tx, input: EditInput, userId: string | null, opts: { quiet?: boolean } = {}) {
  const dup = await already(tx, input.id, input.clientId)
  if (dup) return dup
  const target = Math.trunc(Number(input.units))
  if (!Number.isFinite(target) || target < 0) throw new BadRequestException('Остаток склада: неверное число')
  await lockProducts(tx, [input.productId])
  const p = await tx.product.findUnique({ where: { id: input.productId } })
  if (!p) throw new BadRequestException('Товар не найден')
  const rows = await tx.skladBatch.findMany({ where: { productId: p.id } })
  const current = rows.reduce((s, r) => s + Math.max(0, r.units), 0)
  const diff = target - current
  if (diff === 0) {
    if (opts.quiet) return null
    throw new BadRequestException('Остаток не изменился')
  }
  const upp = uppOf(p)
  const lines: ReturnType<typeof lineOf>[] = []
  if (diff > 0) {
    const cost = input.cost !== undefined && input.cost !== null ? D(input.cost).toDecimalPlaces(2) : D(p.cost)
    const raw = input.expiryDate
    const exp = raw ? (raw instanceof Date ? raw : expiryFrom(raw)) : null
    await tx.skladBatch.create({ data: { productId: p.id, units: diff, cost, expiryDate: exp } })
    lines.push(lineOf(p, { units: diff, cost, expiryDate: exp }))
  } else {
    const { taken } = await takeFromSklad(tx, p, -diff)
    lines.push(...taken.map((c) => lineOf(p, c, -1)))
  }
  const total = lines.reduce((s, l) => s.plus(D(l.cost).times(Math.abs(l.units)).div(upp)), D(0))
  return tx.skladMove.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      clientId: input.clientId ?? null,
      kind: 'edit',
      date: input.date ?? new Date(),
      userId: userId ?? null,
      note: (input.note || '').trim().slice(0, 500),
      items: lines as unknown as Prisma.InputJsonValue,
      total: total.toDecimalPlaces(2),
    },
    include: SKLAD_WITH_USER,
  })
}

// Приход на склад: каждая строка — своя партия склада (arrivals.service, sync)
export async function addToSklad(tx: Tx, productId: string, units: number, cost: Prisma.Decimal, expiryDate: Date | null, arrivalId: string) {
  if (units <= 0) return
  await tx.skladBatch.create({ data: { productId, units, cost: D(cost).toDecimalPlaces(2), expiryDate, arrivalId } })
}

// Повтор того же запроса разом: второй упирается в уникальный clientId — отдаём первый
async function orExisting<T>(prisma: PrismaService, clientId: string | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e: any) {
    if (clientId && e?.code === 'P2002') {
      const existing = await prisma.skladMove.findUnique({ where: { clientId }, include: SKLAD_WITH_USER })
      if (existing) return existing as unknown as T
    }
    throw e
  }
}

@Injectable()
export class SkladService {
  constructor(private prisma: PrismaService) {}

  // Все партии склада (пустые удаляются сразу, но на всякий случай — только с остатком)
  findAll() {
    return this.prisma.skladBatch.findMany({ where: { units: { gt: 0 } }, orderBy: [{ productId: 'asc' }, { createdAt: 'asc' }] })
  }

  moves(q: PeriodQuery = {}) {
    return this.prisma.skladMove.findMany({ where: periodFilter(q, 180), include: SKLAD_WITH_USER, orderBy: { date: 'desc' }, take: MAX_ROWS })
  }

  toShop(dto: SkladToShopDto, userId?: string | null) {
    const run = (tx: Tx) => skladToShopIn(tx, { clientId: dto.clientId, note: dto.note, items: dto.items }, userId ?? null)
    return orExisting(this.prisma, dto.clientId, () => this.prisma.$transaction(run, TX))
  }

  edit(dto: SkladEditDto, userId?: string | null) {
    const input = { clientId: dto.clientId, note: dto.note, productId: dto.productId, units: dto.units, cost: dto.cost, expiryDate: dto.expiryDate }
    // Сайт: остаток уже такой — отказ «Остаток не изменился» (null бывает только у кассы)
    const run = (tx: Tx) => skladEditIn(tx, input, userId ?? null) as Promise<NonNullable<Awaited<ReturnType<typeof skladEditIn>>>>
    return orExisting(this.prisma, dto.clientId, () => this.prisma.$transaction(run, TX))
  }
}
