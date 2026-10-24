import { Prisma } from '@prisma/client'
import { D } from '../common/money'
import { setUnits, syncProduct, totalUnits, uppOf, lockProducts } from '../common/stock'
import { firstCountAfter, lockInventories, markCounted } from '../common/counted'
import { freeInternalBarcode } from '../common/barcode'
import { conflictNote, EditOutcome, forgetStamps, lastEditOf, resolveEdit, stamp, StampTable, stampsOf, stampsOfRows } from '../common/stamps'
import { setExpenseCash, setSupplierCash } from '../shifts/totals'
import { lockShift, SHIFT_CLOSED } from '../shifts/till'
import { hasPerm } from '../auth/permissions'
import { createProductIn, setCardExpiry } from '../products/products.service'
import { categoryInUse } from '../categories/categories.service'
import { typeInUse } from '../producttypes/product-types.service'
import { lockSupplier, removePaymentIn, SUPPLIER_HAS_DEBT, SUPPLIER_HAS_PAYMENTS } from '../suppliers/suppliers.service'
import { removeSupplierReturnIn } from '../supplier-returns/supplier-returns.service'
import { removeCashMoveIn } from '../shifts/cash.service'
import { removeArrivalIn, updateArrivalIn } from '../arrivals/arrivals.service'
import { applyInventoryIn, createInventoryIn, removeInventoryIn, saveCountsIn } from '../inventory/inventory.service'
import {
  Reject,
  parseArrivalUpdate,
  parseCategoryCreate,
  parseCategoryUpdate,
  parseExpenseUpdate,
  parseIncomeUpdate,
  parseInventoryApply,
  parseInventoryCount,
  parseInventoryCreate,
  parseNamed,
  parseProductCreate,
  parseProductUpdate,
  parseRemove,
  parseSupplierCreate,
  parseSupplierPay,
  parseSupplierUpdate,
  parseTypeCreate,
  parseTypeUpdate,
} from './payload'

// ── Справочники и правки документов, сделанные на кассе без связи ──
//
// Касса заводит и правит без интернета товары, поставщиков, категории, типы, статьи и
// сервисы перевода; правит и удаляет расходы, доходы, приходы, возвраты поставщику,
// оплаты и внесения. Сюда приходит сделанное — и ложится по правилам, которые выбрал
// владелец:
//   • правку карточки решает время: если то же поле правили и на сайте, остаётся
//     последняя по времени правка, а владелец видит столкновение в «Расхождениях»
//     (common/stamps.ts). Удаление — тоже: запись, которую правили позже удаления, остаётся;
//   • товар, чей штрихкод за это время заняли, принимается с внутренним кодом (вместе со
//     всеми его чеками), а владелец видит дубль и объединяет карточки;
//   • поставщик с тем же названием, заведённый на сайте, — тот же поставщик: касса
//     получает псевдоним, и её приходы и оплаты ложатся на него;
//   • то, чего нельзя сделать и на сайте (удалить категорию с товарами, поставщика с
//     долгом, оплату в закрытой смене), отвергается тем же текстом, что на сайте.
//
// Ответ — номер записи, которой коснулась операция. null — операция принята, но ничего
// не изменила (запись уже удалили, чужая правка новее): касса заберёт всё заново.

type Tx = Prisma.TransactionClient

export interface EditCtx {
  deviceId: string
  tenantUserId: string | null
  actor?: { role: string; permissions: string[]; tenantUserId: string | null }
  flagged: boolean
  extra: Set<string>
  // Псевдонимы: товар, объединённый с другим, и поставщик, заведённый дважды
  aliases?: Map<string, string>
}

export interface EditFlag {
  kind: string
  productId?: string | null
  name: string
  units: number
  checkPrice?: Prisma.Decimal
  basePrice?: Prisma.Decimal
  note?: string
}

// Что нужно отсюда от службы обмена: записать расхождение и найти свою смену под замком
export interface EditKit {
  flag(tx: Tx, ctx: EditCtx, doc: { id: string; date: Date }, data: EditFlag): Promise<void>
  shiftRef(tx: Tx, shiftId: string | null, ctx: EditCtx): Promise<string | null>
  recountClosed(tx: Tx, shiftId: string | null): Promise<void>
}

export const EDIT_TYPES = new Set([
  'product.create', 'product.update', 'product.delete',
  'category.create', 'category.update', 'category.delete',
  'productType.create', 'productType.update', 'productType.delete',
  'payService.create', 'payService.delete',
  'expenseCategory.create', 'expenseCategory.delete',
  'incomeCategory.create', 'incomeCategory.delete',
  'supplier.create', 'supplier.update', 'supplier.delete', 'supplier.pay', 'supplierPayment.delete',
  'supplierReturn.delete', 'expense.update', 'expense.delete', 'income.update', 'income.delete',
  'cashMove.delete', 'arrival.update', 'arrival.delete',
])

// ── Псевдонимы ──
// alias:product:<номер> — лишняя карточка, объединённая с основной (products.service, merge);
// alias:supplier:<номер>, alias:category:<номер>, alias:productType:<номер> — запись, которую
// касса завела без связи, а на сайте такая же (по названию) уже была
export const ALIAS = 'alias:'
type AliasKind = 'product' | 'supplier' | 'category' | 'productType'
export async function loadAliases(tx: Tx | { syncMeta: any }): Promise<Map<string, string>> {
  const rows: { key: string; value: string }[] = await (tx as any).syncMeta.findMany({ where: { key: { startsWith: ALIAS } } })
  return new Map(rows.map((r) => [r.key.slice(ALIAS.length), r.value]))
}
export function aliasOf(aliases: Map<string, string> | undefined, kind: AliasKind, id: string): string {
  let cur = id
  // Цепочка не длиннее нескольких шагов; предел — страховка от кольца
  for (let i = 0; i < 8 && aliases?.has(kind + ':' + cur); i++) cur = aliases.get(kind + ':' + cur)!
  return cur
}
// Касса называет запись своим номером, а её уже слили с другой. Удалять с кассы такую
// запись нечего: лишней больше нет, а ту, с которой её слили, удаление кассы не касается
const merged = (ctx: EditCtx, kind: AliasKind, id: string) => aliasOf(ctx.aliases, kind, id) !== id
async function setAlias(tx: Tx, ctx: EditCtx, kind: AliasKind, from: string, to: string) {
  await tx.syncMeta.upsert({ where: { key: ALIAS + kind + ':' + from }, update: { value: to }, create: { key: ALIAS + kind + ':' + from, value: to } })
  ctx.aliases?.set(kind + ':' + from, to)
}

// В операциях прежних видов (чек, возврат, приход, списание, возврат поставщику) товар и
// поставщик названы номером. Если запись с тех пор объединили — номер ведёт к основной
export function rewriteAliases(payload: any, aliases: Map<string, string>): any {
  if (!aliases.size) return payload
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const out: any = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'productId' && typeof x === 'string') out[k] = aliasOf(aliases, 'product', x)
      else if (k === 'supplierId' && typeof x === 'string' && x) out[k] = aliasOf(aliases, 'supplier', x)
      else out[k] = walk(x)
    }
    return out
  }
  return walk(payload)
}

// Столкнулись правки — владелец должен это увидеть, чья бы ни победила
async function conflict(tx: Tx, ctx: EditCtx, kit: EditKit, tbl: StampTable, row: { id: string; name: string; productId?: string | null }, at: Date, set: any, current: any, out: EditOutcome, extra: Record<string, any> = {}) {
  if (!out.overrode.length && !out.kept.length && !Object.keys(extra).length) return
  await kit.flag(tx, ctx, { id: row.id, date: at }, { kind: 'edit', productId: row.productId ?? null, name: row.name, units: 0, note: conflictNote(tbl, set, current, out, extra) })
}

// Запись, которую правили позже удаления с кассы, остаётся — у правки время новее
async function keptAfterDelete(tx: Tx, ctx: EditCtx, kit: EditKit, tbl: StampTable, row: { id: string; name: string; productId?: string | null }, at: Date): Promise<boolean> {
  const last = await lastEditOf(tx, tbl, row.id)
  if (!last || last.getTime() <= at.getTime()) return false
  await kit.flag(tx, ctx, { id: row.id, date: at }, { kind: 'edit', productId: row.productId ?? null, name: row.name, units: 0, note: JSON.stringify({ tbl, deleteKept: true, editedAt: last.toISOString() }) })
  return true
}

const pick = (set: Record<string, any>, fields: string[]) => Object.fromEntries(fields.map((f) => [f, set[f]]))

// Осталась хоть одна чужая правка (она новее) — у кассы запись не такая, как у сервера:
// ответ «ничего не сделано» (null), и касса заберёт её заново, не доверяя своим числам
const keptAny = (out: EditOutcome, other = false) => other || out.kept.length > 0

export async function applyEdit(tx: Tx, type: string, payload: any, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  switch (type) {
    case 'product.create':
      return productCreate(tx, parseProductCreate(payload), ctx, kit)
    case 'product.update':
      return productUpdate(tx, parseProductUpdate(payload), ctx, kit)
    case 'product.delete':
      return productDelete(tx, parseRemove(payload, 'товар'), ctx, kit)
    case 'category.create':
      return categoryCreate(tx, parseCategoryCreate(payload), ctx)
    case 'category.update':
      return categoryUpdate(tx, parseCategoryUpdate(payload), ctx, kit)
    case 'category.delete':
      return categoryDelete(tx, parseRemove(payload, 'категория'), ctx, kit)
    case 'productType.create':
      return typeCreate(tx, parseTypeCreate(payload), ctx)
    case 'productType.update':
      return typeUpdate(tx, parseTypeUpdate(payload), ctx, kit)
    case 'productType.delete':
      return typeDelete(tx, parseRemove(payload, 'тип товара'), ctx, kit)
    case 'payService.create':
      return payServiceCreate(tx, parseNamed(payload, 'service', 'сервис перевода', 40))
    case 'payService.delete':
      return removeById(tx.payService, parseRemove(payload, 'сервис перевода').id)
    case 'expenseCategory.create':
      return namedCreate(tx.expenseCategory, parseNamed(payload, 'category', 'статья расходов', 60))
    case 'expenseCategory.delete':
      return removeById(tx.expenseCategory, parseRemove(payload, 'статья расходов').id)
    case 'incomeCategory.create':
      return namedCreate(tx.incomeCategory, parseNamed(payload, 'category', 'статья доходов', 60))
    case 'incomeCategory.delete':
      return removeById(tx.incomeCategory, parseRemove(payload, 'статья доходов').id)
    case 'supplier.create':
      return supplierCreate(tx, parseSupplierCreate(payload), ctx, kit)
    case 'supplier.update':
      return supplierUpdate(tx, parseSupplierUpdate(payload), ctx, kit)
    case 'supplier.delete':
      return supplierDelete(tx, parseRemove(payload, 'поставщик'), ctx, kit)
    case 'supplier.pay':
      return supplierPay(tx, parseSupplierPay(payload), ctx, kit)
    case 'supplierPayment.delete':
      return (await removePaymentIn(tx, parseRemove(payload, 'оплата поставщику').id)) ? payload.id : null
    case 'supplierReturn.delete':
      return (await removeSupplierReturnIn(tx, parseRemove(payload, 'возврат поставщику').id)) ? payload.id : null
    case 'expense.update':
      return expenseUpdate(tx, parseExpenseUpdate(payload), ctx, kit)
    case 'expense.delete':
      return expenseDelete(tx, parseRemove(payload, 'расход'), ctx, kit)
    case 'income.update':
      return incomeUpdate(tx, parseIncomeUpdate(payload), ctx, kit)
    case 'income.delete':
      return incomeDelete(tx, parseRemove(payload, 'доход'), ctx, kit)
    case 'cashMove.delete':
      return (await removeCashMoveIn(tx, parseRemove(payload, 'операция с наличными').id)) ? payload.id : null
    case 'arrival.update':
      return arrivalUpdate(tx, parseArrivalUpdate(payload), ctx, kit)
    case 'arrival.delete':
      return arrivalDelete(tx, parseRemove(payload, 'приход'), ctx, kit)
    case 'inventory.create':
      return inventoryCreate(tx, parseInventoryCreate(payload), ctx)
    case 'inventory.count':
      return inventoryCount(tx, parseInventoryCount(payload))
    case 'inventory.apply':
      return inventoryApply(tx, parseInventoryApply(payload), ctx, kit)
    case 'inventory.delete':
      return inventoryDelete(tx, parseRemove(payload, 'лист пересчёта'), ctx, kit)
    default:
      throw new Reject('Неизвестная операция')
  }
}

// ════════════════════════ Товар ════════════════════════

async function productCreate(tx: Tx, p: ReturnType<typeof parseProductCreate>, ctx: EditCtx, kit: EditKit): Promise<string> {
  if (await tx.product.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  // Штрихкод за это время заняли на сайте или другой кассе. Товар всё равно принимаем —
  // по нему уже могли продавать, — но с внутренним кодом; владелец объединит карточки
  const clash = await tx.product.findUnique({ where: { barcode: p.barcode }, select: { id: true, name: true } })
  const barcode = clash ? await freeInternalBarcode(tx) : p.barcode
  await createProductIn(tx, {
    id: p.id,
    name: p.name,
    barcode,
    category: p.category,
    type: p.type,
    cost: D(p.cost).toDecimalPlaces(2),
    price: D(p.price).toDecimalPlaces(2),
    minStock: p.minStock,
    unit: p.unit,
    unitsPerPack: p.unitsPerPack,
    dosage: p.dosage,
    analogIds: analogsVia(ctx, p.analogIds, p.id),
    image: p.image,
    stock: p.stock,
    looseUnits: p.looseUnits,
    expiryDate: p.expiryDate,
    createdAt: p.createdAt,
  })
  // Цена товара действует с той минуты, когда его завели на кассе: по ней там и продавали
  await backdatePrice(tx, p.id, p.createdAt)
  if (clash) {
    await kit.flag(tx, ctx, { id: p.id, date: p.createdAt }, {
      kind: 'barcode',
      productId: p.id,
      name: p.name,
      units: 0,
      note: JSON.stringify({ barcode: p.barcode, internal: barcode, other: { id: clash.id, name: clash.name } }),
    })
  }
  return p.id
}

async function productUpdate(tx: Tx, p: ReturnType<typeof parseProductUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const pid = aliasOf(ctx.aliases, 'product', p.id)
  await lockProducts(tx, [pid])
  const product = await tx.product.findUnique({ where: { id: pid } })
  if (!product) {
    // Товар удалили, пока касса была без связи: править нечего
    await kit.flag(tx, ctx, { id: p.id, date: p.at }, { kind: 'edit', productId: null, name: String(p.set.name ?? p.base.name ?? '—'), units: 0, note: JSON.stringify({ tbl: 'Product', gone: true }) })
    return null
  }
  // Аналоги — через псевдонимы, и прежние у кассы тоже: иначе слитая карточка в её списке
  // выглядела бы правкой, которой не было
  if ('analogIds' in p.set) {
    p.set.analogIds = analogsVia(ctx, p.set.analogIds, pid)
    if ('analogIds' in p.base) p.base.analogIds = analogsVia(ctx, p.base.analogIds, pid)
  }
  const out = resolveEdit(p.set, p.base, product as any, await stampsOf(tx, 'Product', pid), p.at)
  // Штрихкод, который за это время занял другой товар, не ставим: у этого остаётся прежний
  let taken: { id: string; name: string } | null = null
  if (out.apply.includes('barcode')) {
    const other = await tx.product.findUnique({ where: { barcode: String(p.set.barcode) }, select: { id: true, name: true } })
    if (other && other.id !== pid) {
      taken = other
      out.apply = out.apply.filter((f) => f !== 'barcode')
      out.overrode = out.overrode.filter((f) => f !== 'barcode')
    }
  }
  if (out.apply.length) {
    const data: any = pick(p.set, out.apply)
    if ('cost' in data) data.cost = D(data.cost).toDecimalPlaces(2)
    if ('price' in data) data.price = D(data.price).toDecimalPlaces(2)
    const repack = 'unitsPerPack' in data
    // Остаток живёт партиями в штуках, карточка лишь показывает его упаковками. У товара,
    // заведённого до партий, остаток лежит только в карточке — сначала он ложится партией
    // по прежней упаковке: иначе новые «штук в упаковке» пересчитали бы его
    if (repack) await ensureBatch(tx, product)
    await tx.product.update({ where: { id: pid }, data })
    // Упаковки и вскрытая — заново по партиям: до этого карточка показывала бы прежние
    // упаковки уже по новому числу штук
    if (repack) await syncProduct(tx, pid)
    // Новая цена действует с момента правки на кассе, а не с минуты, когда правка дошла:
    // чеки этой кассы между правкой и отправкой пробиты уже по ней (сверка цен в sync)
    if ('price' in data || repack) await backdatePrice(tx, pid, p.at)
    await stamp(tx, 'Product', pid, out.apply, p.at)
  }
  await conflict(tx, ctx, kit, 'Product', { id: pid, name: product.name, productId: pid }, p.at, p.set, product, out)
  if (taken) {
    await kit.flag(tx, ctx, { id: pid, date: p.at }, {
      kind: 'barcode',
      productId: pid,
      name: product.name,
      units: 0,
      note: JSON.stringify({ barcode: p.set.barcode, kept: product.barcode, other: taken, edit: true }),
    })
  }

  const now = await tx.product.findUnique({ where: { id: pid } })
  if (p.stock && now && pid !== p.id) {
    // Касса пересчитала лишнюю карточку, а её уже объединили с основной: на основной лежит
    // остаток обеих, и число кассы не про неё. Владелец увидит это и пересчитает сам
    await kit.flag(tx, ctx, { id: pid, date: p.at }, { kind: 'edit', productId: pid, name: now.name, units: 0, note: JSON.stringify({ tbl: 'Product', merged: true, stock: p.stock.units }) })
  } else if (p.stock && now && (p.stock.explicit || !('unitsPerPack' in p.set) || uppOf(now) === p.set.unitsPerPack)) {
    // Остаток, вписанный в карточку, — это пересчёт одного товара на момент правки. Если он
    // вышел из новой упаковки, а упаковку оставили чужую (её правка новее) — он не про эту карточку.
    // Документы после момента правки, уже записанные, легли по прежней упаковке — по ней их и считаем
    await countAt(tx, ctx, kit, pid, p.stock.units, p.at, uppOf(product))
  }
  // Срок с лишней карточки — тоже не про основную: на ней партии обеих
  if (p.expiryTouched && pid === p.id) await setCardExpiry(tx, pid, p.expiryDate)
  return keptAny(out, !!taken) ? null : pid
}

// Товар, заведённый до партий, держит остаток только в карточке — кладём его партией
async function ensureBatch(tx: Tx, product: { id: string; cost: Prisma.Decimal; expiryDate: Date | null; stock: number; looseUnits: number | null; unitsPerPack: number | null }) {
  if (await tx.batch.count({ where: { productId: product.id } })) return
  const units = totalUnits(product)
  if (units > 0) await tx.batch.create({ data: { productId: product.id, units, cost: product.cost, expiryDate: product.expiryDate, note: 'Начальный остаток' } })
}

// Сколько штук товара на полке — по партиям, как считает пересчёт (setUnits). У товара без
// партий — по карточке
async function unitsNow(tx: Tx, product: { id: string; stock: number; looseUnits: number | null; unitsPerPack: number | null }) {
  const batches = await tx.batch.findMany({ where: { productId: product.id }, select: { units: true } })
  return batches.length ? batches.reduce((s, b) => s + Math.max(0, b.units), 0) : totalUnits(product)
}

// ── С какого момента действует цена, поставленная на кассе ──
// Историю цен пишет сама база (триггер на Product) — моментом записи. Для товара и правки с
// кассы это минута, когда операция дошла, а не когда её сделали, а чеки этой кассы между
// тем и другим пробиты уже по новой цене (сверка цен в sync). Поэтому в историю ложится ещё
// одна строка — та же цена с момента на кассе (всемирным временем, как в common/stamps.ts).
// Строку базы не трогаем: она последняя по времени и говорит, какая цена действует сейчас;
// перенесённая назад, она встала бы перед более поздними строками, и «действующей» по истории
// оказалась бы прежняя цена. Копируется только строка, записанная этой же транзакцией (её
// момент — now() транзакции), и только если момент на кассе раньше
async function backdatePrice(tx: Tx, productId: string, at: Date) {
  const iso = at.toISOString()
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack", "at")
    SELECT "productId", "price", "unitsPerPack", (${iso}::timestamptz AT TIME ZONE 'UTC')::timestamp(3) FROM "PriceLog"
    WHERE "seq" = (SELECT MAX("seq") FROM "PriceLog" WHERE "productId" = ${productId})
      AND "at" = (now() AT TIME ZONE 'UTC')::timestamp(3)
      AND "at" > (${iso}::timestamptz AT TIME ZONE 'UTC')`)
}

// Аналоги, названные кассой: карточку, которую с тех пор объединили с другой, заменяет та,
// другая; повторы и ссылка на саму себя убираются
const analogsVia = (ctx: EditCtx, list: any, self: string) =>
  Array.isArray(list) ? [...new Set(list.map((x: any) => aliasOf(ctx.aliases, 'product', String(x))))].filter((x) => x !== self) : list

// ── Остаток, вписанный в карточку на кассе, — пересчёт на момент at ──
// Сосчитали N штук в момент at. Всё, что случилось до этого момента, в этом числе уже
// есть — даже если дойдёт до сервера позже (такие операции остаток уже не двигают,
// common/counted.ts). Всё, что случилось после, — прибавляется к N. Если после at
// остаток уже пересчитывали (инвентаризация, правка на сайте), то то число новее
// uppBefore — сколько штук было в упаковке у документов, уже записанных после at (приход и
// возврат поставщику хранят упаковки): правка карточки могла их число сменить
export async function countAt(tx: Tx, ctx: EditCtx, kit: EditKit, pid: string, units: number, at: Date, uppBefore?: number) {
  const product = await tx.product.findUnique({ where: { id: pid } })
  if (!product) return
  // Сколько было — по партиям: карточка могла ещё не успеть за ними (сменили упаковку)
  const was = await unitsNow(tx, product)
  const later = await firstCountAfter(tx, [pid], at)
  if (later.has(pid)) {
    await kit.flag(tx, ctx, { id: pid, date: at }, { kind: 'counted', productId: pid, name: product.name, units: Math.abs(units - was) })
    return
  }
  const target = Math.max(0, units + (await unitsMovedAfter(tx, { id: pid, unitsPerPack: uppBefore ?? product.unitsPerPack }, at)))
  if (target !== was) await setUnits(tx, pid, target, product.name)
  await markCounted(tx, [{ productId: pid }], at)
  if (target !== was) await tx.stockEdit.create({ data: { productId: pid, fromUnits: was, toUnits: target, userId: ctx.tenantUserId, date: at } })
}

// На сколько штук сдвинули остаток товара документы, сделанные позже at: чеки, возвраты в
// продажу, приходы, списания руками, возвраты поставщику
export async function unitsMovedAfter(tx: Tx, product: { id: string; unitsPerPack: number | null }, at: Date): Promise<number> {
  const upp = uppOf(product)
  const later = { gt: at }
  const [sales, rets, arrs, wos, srs] = await Promise.all([
    tx.saleItem.findMany({ where: { productId: product.id, sale: { date: later } }, select: { qty: true, pieces: true, unitsPerPack: true } }),
    tx.saleReturnItem.findMany({ where: { productId: product.id, restock: true, ret: { date: later } }, select: { units: true } }),
    tx.arrivalItem.findMany({ where: { productId: product.id, arrival: { date: later } }, select: { qty: true, pieces: true } }),
    tx.writeOffItem.findMany({ where: { productId: product.id, writeOff: { date: later, source: 'manual' } }, select: { units: true } }),
    tx.supplierReturnItem.findMany({ where: { productId: product.id, ret: { date: later } }, select: { qty: true, pieces: true } }),
  ])
  let d = 0
  for (const s of sales) d -= s.qty * Math.max(1, s.unitsPerPack || 1) + (s.pieces || 0)
  for (const r of rets) d += r.units
  for (const a of arrs) d += a.qty * upp + (a.pieces || 0)
  for (const w of wos) d -= w.units
  for (const r of srs) d -= r.qty * upp + (r.pieces || 0)
  return d
}

async function productDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  if (merged(ctx, 'product', p.id)) return null
  const pid = p.id
  const product = await tx.product.findUnique({ where: { id: pid }, select: { id: true, name: true } })
  if (!product) return null
  if (await keptAfterDelete(tx, ctx, kit, 'Product', { id: pid, name: product.name, productId: pid }, p.at)) return null
  await tx.product.delete({ where: { id: pid } })
  await forgetStamps(tx, 'Product', pid)
  return pid
}

// ════════════════════════ Категория и тип товара ════════════════════════

async function categoryCreate(tx: Tx, p: ReturnType<typeof parseCategoryCreate>, ctx: EditCtx): Promise<string> {
  if (await tx.category.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  // Такую же завели на сайте — это она и есть: товар хранит категорию названием. Правки
  // и удаление с кассы, названные её номером, лягут на эту (псевдоним)
  const same = await tx.category.findUnique({ where: { name: p.name }, select: { id: true } })
  if (same) {
    await setAlias(tx, ctx, 'category', p.id, same.id)
    return same.id
  }
  await tx.category.create({ data: { id: p.id, name: p.name, noExpiry: p.noExpiry, createdAt: p.createdAt } })
  return p.id
}

async function categoryUpdate(tx: Tx, p: ReturnType<typeof parseCategoryUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const cat = await tx.category.findUnique({ where: { id: aliasOf(ctx.aliases, 'category', p.id) } })
  if (!cat) return null
  const out = resolveEdit(p.set, p.base, cat, await stampsOf(tx, 'Category', cat.id), p.at)
  const extra: Record<string, any> = {}
  if (out.apply.includes('name') && (await tx.category.findFirst({ where: { name: p.set.name, NOT: { id: cat.id } }, select: { id: true } }))) {
    out.apply = out.apply.filter((f) => f !== 'name')
    out.overrode = out.overrode.filter((f) => f !== 'name')
    extra.nameTaken = p.set.name
  }
  if (out.apply.length) {
    await tx.category.update({ where: { id: cat.id }, data: pick(p.set, out.apply) })
    // Переименование переносит товары — иначе они выпали бы из фильтров и пересчёта
    if (out.apply.includes('name')) await tx.product.updateMany({ where: { category: cat.name }, data: { category: p.set.name } })
    await stamp(tx, 'Category', cat.id, out.apply, p.at)
  }
  await conflict(tx, ctx, kit, 'Category', { id: cat.id, name: cat.name }, p.at, p.set, cat, out, extra)
  return keptAny(out, !!extra.nameTaken) ? null : cat.id
}

async function categoryDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  if (merged(ctx, 'category', p.id)) return null
  const cat = await tx.category.findUnique({ where: { id: p.id } })
  if (!cat) return null
  const used = await tx.product.count({ where: { category: cat.name } })
  if (used > 0) throw new Reject(categoryInUse(cat.name, used))
  if (await keptAfterDelete(tx, ctx, kit, 'Category', { id: cat.id, name: cat.name }, p.at)) return null
  await tx.category.delete({ where: { id: cat.id } })
  await forgetStamps(tx, 'Category', cat.id)
  return cat.id
}

async function typeCreate(tx: Tx, p: ReturnType<typeof parseTypeCreate>, ctx: EditCtx): Promise<string> {
  if (await tx.productType.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  const same = await tx.productType.findUnique({ where: { name: p.name }, select: { id: true } })
  if (same) {
    await setAlias(tx, ctx, 'productType', p.id, same.id)
    return same.id
  }
  await tx.productType.create({ data: { id: p.id, name: p.name, analogs: p.analogs, createdAt: p.createdAt } })
  return p.id
}

async function typeUpdate(tx: Tx, p: ReturnType<typeof parseTypeUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const t = await tx.productType.findUnique({ where: { id: aliasOf(ctx.aliases, 'productType', p.id) } })
  if (!t) return null
  const out = resolveEdit(p.set, p.base, t, await stampsOf(tx, 'ProductType', t.id), p.at)
  const extra: Record<string, any> = {}
  if (out.apply.includes('name') && (await tx.productType.findFirst({ where: { name: p.set.name, NOT: { id: t.id } }, select: { id: true } }))) {
    out.apply = out.apply.filter((f) => f !== 'name')
    out.overrode = out.overrode.filter((f) => f !== 'name')
    extra.nameTaken = p.set.name
  }
  if (out.apply.length) {
    await tx.productType.update({ where: { id: t.id }, data: pick(p.set, out.apply) })
    if (out.apply.includes('name')) await tx.product.updateMany({ where: { type: t.name }, data: { type: p.set.name } })
    await stamp(tx, 'ProductType', t.id, out.apply, p.at)
  }
  await conflict(tx, ctx, kit, 'ProductType', { id: t.id, name: t.name }, p.at, p.set, t, out, extra)
  return keptAny(out, !!extra.nameTaken) ? null : t.id
}

async function typeDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  if (merged(ctx, 'productType', p.id)) return null
  const t = await tx.productType.findUnique({ where: { id: p.id } })
  if (!t) return null
  const used = await tx.product.count({ where: { type: t.name } })
  if (used > 0) throw new Reject(typeInUse(t.name, used))
  if (await keptAfterDelete(tx, ctx, kit, 'ProductType', { id: t.id, name: t.name }, p.at)) return null
  await tx.productType.delete({ where: { id: t.id } })
  await forgetStamps(tx, 'ProductType', t.id)
  return t.id
}

// ════════════════════════ Сервисы перевода, статьи ════════════════════════

async function payServiceCreate(tx: Tx, p: ReturnType<typeof parseNamed>): Promise<string> {
  if (await tx.payService.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  const same = await tx.payService.findUnique({ where: { name: p.name }, select: { id: true } })
  if (same) return same.id
  const last = await tx.payService.aggregate({ _max: { ord: true } })
  await tx.payService.create({ data: { id: p.id, name: p.name, ord: (last._max.ord ?? 0) + 1, createdAt: p.createdAt } })
  return p.id
}

// Статья расходов или доходов: та же по названию — это она и есть
async function namedCreate(model: any, p: ReturnType<typeof parseNamed>): Promise<string> {
  if (await model.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  const same = await model.findUnique({ where: { name: p.name }, select: { id: true } })
  if (same) return same.id
  await model.create({ data: { id: p.id, name: p.name, createdAt: p.createdAt } })
  return p.id
}

async function removeById(model: any, id: string): Promise<string | null> {
  const r = await model.deleteMany({ where: { id } })
  return r.count ? id : null
}

// ════════════════════════ Поставщики ════════════════════════

async function supplierCreate(tx: Tx, p: ReturnType<typeof parseSupplierCreate>, ctx: EditCtx, kit: EditKit): Promise<string> {
  if (await tx.supplier.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  // Долг на начало — как на сайте: только у того, кому видны долги
  const opening = hasPerm(ctx.actor, 'suppliers.view') ? D(p.openingDebt).toDecimalPlaces(2) : D(0)
  // Такого же завели на сайте — это он и есть. Приходы и оплаты кассы с её номером
  // поставщика ложатся на него (псевдоним)
  const same = await tx.supplier.findUnique({ where: { name: p.name }, select: { id: true, name: true } })
  if (same) {
    await setAlias(tx, ctx, 'supplier', p.id, same.id)
    // Долг на начало, вписанный на кассе, к нему не прибавляем: на сайте его могли вписать
    // тоже, и долг задвоился бы. Владелец увидит сумму и решит сам
    if (opening.gt(0)) {
      await kit.flag(tx, ctx, { id: same.id, date: p.createdAt }, {
        kind: 'edit',
        name: same.name,
        units: 0,
        note: JSON.stringify({ tbl: 'Supplier', sameName: true, openingDebt: Number(opening) }),
      })
    }
    return same.id
  }
  await tx.supplier.create({ data: { id: p.id, name: p.name, phone: p.phone, note: p.note, openingDebt: opening, debt: opening, createdAt: p.createdAt } })
  return p.id
}

async function supplierUpdate(tx: Tx, p: ReturnType<typeof parseSupplierUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const sid = aliasOf(ctx.aliases, 'supplier', p.id)
  const s = await tx.supplier.findUnique({ where: { id: sid } })
  if (!s) return null
  const out = resolveEdit(p.set, p.base, s, await stampsOf(tx, 'Supplier', sid), p.at)
  const extra: Record<string, any> = {}
  if (out.apply.includes('name') && (await tx.supplier.findFirst({ where: { name: p.set.name, NOT: { id: sid } }, select: { id: true } }))) {
    out.apply = out.apply.filter((f) => f !== 'name')
    out.overrode = out.overrode.filter((f) => f !== 'name')
    extra.nameTaken = p.set.name
  }
  if (out.apply.length) {
    await tx.supplier.update({ where: { id: sid }, data: pick(p.set, out.apply) })
    await stamp(tx, 'Supplier', sid, out.apply, p.at)
  }
  await conflict(tx, ctx, kit, 'Supplier', { id: sid, name: s.name }, p.at, p.set, s, out, extra)
  return keptAny(out, !!extra.nameTaken) ? null : sid
}

async function supplierDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  if (merged(ctx, 'supplier', p.id)) return null
  const sid = p.id
  const s = await tx.supplier.findUnique({ where: { id: sid }, include: { _count: { select: { payments: true } } } })
  if (!s) return null
  if (!D(s.debt).isZero()) throw new Reject(SUPPLIER_HAS_DEBT)
  if (s._count.payments > 0) throw new Reject(SUPPLIER_HAS_PAYMENTS)
  if (await keptAfterDelete(tx, ctx, kit, 'Supplier', { id: sid, name: s.name }, p.at)) return null
  await tx.supplier.delete({ where: { id: sid } })
  await forgetStamps(tx, 'Supplier', sid)
  return sid
}

// ── Оплата поставщику ──
// Деньги уже отданы — отказать задним числом нельзя. Если долг за это время успели
// погасить (на сайте, другой кассой), долг уходит в минус — поставщик должен магазину,
// — а владелец видит это в «Расхождениях»
async function supplierPay(tx: Tx, p: ReturnType<typeof parseSupplierPay>, ctx: EditCtx, kit: EditKit): Promise<string> {
  if (await tx.supplierPayment.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  // Смена — первой (её замок берут и закрытие, и расход), поставщик — следом
  const shiftId = p.fromCash ? await kit.shiftRef(tx, p.shiftId, ctx) : null
  const s = await lockSupplier(tx, aliasOf(ctx.aliases, 'supplier', p.supplierId))
  if (!s) throw new Reject('Поставщик не найден')
  const amount = D(p.amount).toDecimalPlaces(2)
  if (amount.gt(s.debt)) {
    await kit.flag(tx, ctx, { id: p.id, date: p.date }, { kind: 'supdebt', name: s.name, units: 0, checkPrice: amount, basePrice: s.debt.toDecimalPlaces(2) })
  }
  await tx.supplierPayment.create({
    data: { id: p.id, supplierId: s.id, amount, note: p.note, fromCash: p.fromCash, shiftId, userId: ctx.tenantUserId, date: p.date, createdAt: p.date },
  })
  await tx.supplier.update({ where: { id: s.id }, data: { debt: { decrement: amount } } })
  if (shiftId) {
    await setSupplierCash(tx, shiftId)
    // Смену могли закрыть с сайта раньше, чем оплата дошла, — итоги пересчитываются с ней
    await kit.recountClosed(tx, shiftId)
  }
  return p.id
}

// ════════════════════════ Расходы и доходы ════════════════════════

async function expenseUpdate(tx: Tx, p: ReturnType<typeof parseExpenseUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const e = await tx.expense.findUnique({ where: { id: p.id } })
  if (!e) return null
  if (e.fromCash && e.shiftId) {
    const shift = await lockShift(tx, e.shiftId)
    if (shift?.closedAt) throw new Reject(SHIFT_CLOSED)
  }
  const set = { ...p.set }
  // Дата расхода из кассы — это время в смене, её не переносят
  if (e.fromCash) delete set.date
  const out = resolveEdit(set, p.base, e, await stampsOf(tx, 'Expense', e.id), p.at)
  if (out.apply.length) {
    const data: any = pick(set, out.apply)
    if ('amount' in data) data.amount = D(data.amount).toDecimalPlaces(2)
    if ('employeeId' in data) {
      const u = data.employeeId ? await tx.user.findUnique({ where: { id: data.employeeId }, select: { id: true, name: true, fullName: true } }) : null
      data.employeeId = u?.id ?? null
      data.employeeName = u ? (u.fullName || '').trim() || u.name : ''
      // Сотрудника сняли — месяц и дни бонуса уходят вместе с ним
      if (!u) Object.assign(data, { salaryMonth: '', bonusFrom: '', bonusTo: '' })
    }
    // Дни бонуса — парой и по порядку; иначе это не период
    const from = 'bonusFrom' in data ? data.bonusFrom : e.bonusFrom
    const to = 'bonusTo' in data ? data.bonusTo : e.bonusTo
    if (('bonusFrom' in data || 'bonusTo' in data) && (!from || !to || from > to)) Object.assign(data, { bonusFrom: '', bonusTo: '' })
    await tx.expense.update({ where: { id: e.id }, data })
    await stamp(tx, 'Expense', e.id, out.apply, p.at)
    if (e.fromCash && e.shiftId) await setExpenseCash(tx, e.shiftId)
  }
  await conflict(tx, ctx, kit, 'Expense', { id: e.id, name: e.category }, p.at, set, e, out)
  return keptAny(out) ? null : e.id
}

async function expenseDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const e = await tx.expense.findUnique({ where: { id: p.id } })
  if (!e) return null
  if (e.fromCash && e.shiftId) {
    const shift = await lockShift(tx, e.shiftId)
    if (shift?.closedAt) throw new Reject(SHIFT_CLOSED)
  }
  if (await keptAfterDelete(tx, ctx, kit, 'Expense', { id: e.id, name: e.category }, p.at)) return null
  await tx.expense.delete({ where: { id: e.id } })
  await forgetStamps(tx, 'Expense', e.id)
  if (e.fromCash && e.shiftId) await setExpenseCash(tx, e.shiftId)
  return e.id
}

async function incomeUpdate(tx: Tx, p: ReturnType<typeof parseIncomeUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const x = await tx.income.findUnique({ where: { id: p.id } })
  if (!x) return null
  const out = resolveEdit(p.set, p.base, x, await stampsOf(tx, 'Income', x.id), p.at)
  if (out.apply.length) {
    const data: any = pick(p.set, out.apply)
    if ('amount' in data) data.amount = D(data.amount).toDecimalPlaces(2)
    await tx.income.update({ where: { id: x.id }, data })
    await stamp(tx, 'Income', x.id, out.apply, p.at)
  }
  await conflict(tx, ctx, kit, 'Income', { id: x.id, name: x.category }, p.at, p.set, x, out)
  return keptAny(out) ? null : x.id
}

async function incomeDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const x = await tx.income.findUnique({ where: { id: p.id } })
  if (!x) return null
  if (await keptAfterDelete(tx, ctx, kit, 'Income', { id: x.id, name: x.category }, p.at)) return null
  await tx.income.delete({ where: { id: x.id } })
  await forgetStamps(tx, 'Income', x.id)
  return x.id
}

// ════════════════════════ Приход ════════════════════════

async function arrivalUpdate(tx: Tx, p: ReturnType<typeof parseArrivalUpdate>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const a = await tx.arrival.findUnique({ where: { id: p.id }, select: { id: true, supplier: true } })
  if (!a) return null
  // Приход правили и на сайте, и позже кассы — остаётся та правка
  const last = await lastEditOf(tx, 'Arrival', a.id)
  if (last && last.getTime() > p.at.getTime()) {
    await kit.flag(tx, ctx, { id: a.id, date: p.at }, { kind: 'edit', name: a.supplier || '—', units: 0, note: JSON.stringify({ tbl: 'Arrival', kept: true, editedAt: last.toISOString() }) })
    return null
  }
  const supplierId = p.supplierId === undefined || p.supplierId === '' ? p.supplierId : aliasOf(ctx.aliases, 'supplier', p.supplierId)
  await updateArrivalIn(tx, a.id, { supplier: p.supplier, supplierId, debt: p.debt, items: p.items } as any, p.at)
  return a.id
}

async function arrivalDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const a = await tx.arrival.findUnique({ where: { id: p.id }, select: { id: true, supplier: true } })
  if (!a) return null
  const last = await lastEditOf(tx, 'Arrival', a.id)
  if (last && last.getTime() > p.at.getTime()) {
    await kit.flag(tx, ctx, { id: a.id, date: p.at }, { kind: 'edit', name: a.supplier || '—', units: 0, note: JSON.stringify({ tbl: 'Arrival', deleteKept: true, editedAt: last.toISOString() }) })
    return null
  }
  return (await removeArrivalIn(tx, a.id, p.at)) ? a.id : null
}

// ════════════════════════ Инвентаризация (версия 1.4.15) ════════════════════════
// Лист, заведённый на кассе, — с её номерами листа и строк. Повтор — тот же лист
async function inventoryCreate(tx: Tx, p: ReturnType<typeof parseInventoryCreate>, ctx: EditCtx): Promise<string> {
  if (await tx.inventory.findUnique({ where: { id: p.id }, select: { id: true } })) return p.id
  await createInventoryIn(tx, { ...p, userId: ctx.tenantUserId })
  return p.id
}

// Насчитанное на кассе: строку, которую позже посчитали в другом месте, не перекрывает.
// Лист применили или удалили, пока касса считала, — отказ теми же словами, что на сайте
// Не легла хоть одна строка — ответ «принято, но не так» (null): касса заберёт лист заново
// и покажет более поздний пересчёт, а не оставит у себя своё число
async function inventoryCount(tx: Tx, p: ReturnType<typeof parseInventoryCount>): Promise<string | null> {
  const skipped = await saveCountsIn(tx, p.id, p.items, p.at)
  return skipped ? null : p.id
}

// Применение на кассе — пересчёт на момент at (inventory.service, applyInventoryIn). Товар,
// который позже пересчитали ещё раз, остаётся как есть — владелец видит это в «Расхождениях»
async function inventoryApply(tx: Tx, p: ReturnType<typeof parseInventoryApply>, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  const report = { skipped: 0 }
  await applyInventoryIn(tx, p.id, {
    at: p.at,
    userId: ctx.tenantUserId,
    counts: p.items,
    report,
    onCounted: (product, line) =>
      kit.flag(tx, ctx, { id: p.id, date: p.at }, { kind: 'counted', productId: product.id, name: product.name, units: Math.abs(line.actualUnits - line.units) }),
  })
  return report.skipped ? null : p.id
}

// Удаление незаконченного листа: если его считали позже удаления с кассы — лист остаётся
async function inventoryDelete(tx: Tx, p: { id: string; at: Date }, ctx: EditCtx, kit: EditKit): Promise<string | null> {
  // Сначала замок листа, потом чтение: пересчёт той же секунды не проскочит между проверкой
  // «когда считали» и удалением
  await lockInventories(tx, [p.id])
  const inv = await tx.inventory.findUnique({ where: { id: p.id }, select: { id: true, scope: true, items: { select: { id: true } } } })
  if (!inv) return null
  const stamps = await stampsOfRows(tx, 'InventoryItem', inv.items.map((i) => i.id), 'actual')
  const last = [...stamps.values()].reduce<Date | null>((m, d) => (!m || d > m ? d : m), null)
  if (last && last.getTime() > p.at.getTime()) {
    await kit.flag(tx, ctx, { id: p.id, date: p.at }, { kind: 'edit', name: inv.scope === 'all' ? 'Пересчёт' : inv.scope, units: 0, note: JSON.stringify({ tbl: 'Inventory', deleteKept: true, editedAt: last.toISOString() }) })
    return null
  }
  return (await removeInventoryIn(tx, p.id)) ? p.id : null
}
