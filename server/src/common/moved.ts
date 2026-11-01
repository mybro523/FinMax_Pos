import { Prisma } from '@prisma/client'
import { uppOf } from './stock'

type Tx = Prisma.TransactionClient

// ── То же для многих товаров разом — для листа пересчёта ──
// По запросу на вид документа, а не на товар: в листе тысячи строк. Момент сравнивается
// всемирным временем — так даты лежат в таблицах (см. common/stamps.ts)
export async function unitsMovedAfterMany(tx: Tx, products: { id: string; unitsPerPack: number | null }[], at: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const upp = new Map(products.map((p) => [p.id, uppOf(p)]))
  const add = (id: string, d: number) => out.set(id, (out.get(id) || 0) + d)
  const t = Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
  const ids = products.map((p) => p.id)
  for (let n = 0; n < ids.length; n += 500) {
    const part = Prisma.join(ids.slice(n, n + 500))
    const sales = await tx.$queryRaw<{ id: string; u: bigint }[]>(Prisma.sql`
      SELECT si."productId" AS id, SUM(si."qty" * GREATEST(1, si."unitsPerPack") + si."pieces")::bigint AS u
      FROM "SaleItem" si JOIN "Sale" s ON s."id" = si."saleId"
      WHERE si."productId" IN (${part}) AND s."date" > ${t} GROUP BY si."productId"`)
    for (const r of sales) add(r.id, -Number(r.u))
    const rets = await tx.$queryRaw<{ id: string; u: bigint }[]>(Prisma.sql`
      SELECT ri."productId" AS id, SUM(ri."units")::bigint AS u
      FROM "SaleReturnItem" ri JOIN "SaleReturn" r ON r."id" = ri."returnId"
      WHERE ri."productId" IN (${part}) AND ri."restock" = true AND r."date" > ${t} GROUP BY ri."productId"`)
    for (const r of rets) add(r.id, Number(r.u))
    // Строки прихода и возврата поставщику — по своей упаковке (1.5.12): товару могли сменить
    // её позже (килограмм → мешок), и «100 кг» прежнего прихода — всё те же 100 кг. У строки без
    // снимка (удалённый товар) — по нынешней карточке
    const arrs = await tx.$queryRaw<{ id: string; q: bigint; u: bigint; p: bigint }[]>(Prisma.sql`
      SELECT ai."productId" AS id,
        SUM(CASE WHEN ai."unitsPerPack" IS NULL THEN ai."qty" ELSE 0 END)::bigint AS q,
        SUM(CASE WHEN ai."unitsPerPack" IS NULL THEN 0 ELSE ai."qty"::bigint * ai."unitsPerPack" END)::bigint AS u,
        SUM(ai."pieces")::bigint AS p
      FROM "ArrivalItem" ai JOIN "Arrival" a ON a."id" = ai."arrivalId"
      WHERE ai."productId" IN (${part}) AND a."date" > ${t} GROUP BY ai."productId"`)
    for (const r of arrs) add(r.id, Number(r.q) * (upp.get(r.id) || 1) + Number(r.u) + Number(r.p))
    const wos = await tx.$queryRaw<{ id: string; u: bigint }[]>(Prisma.sql`
      SELECT wi."productId" AS id, SUM(wi."units")::bigint AS u
      FROM "WriteOffItem" wi JOIN "WriteOff" w ON w."id" = wi."writeOffId"
      WHERE wi."productId" IN (${part}) AND w."source" = 'manual' AND w."date" > ${t} GROUP BY wi."productId"`)
    for (const r of wos) add(r.id, -Number(r.u))
    const srs = await tx.$queryRaw<{ id: string; q: bigint; u: bigint; p: bigint }[]>(Prisma.sql`
      SELECT sri."productId" AS id,
        SUM(CASE WHEN sri."unitsPerPack" IS NULL THEN sri."qty" ELSE 0 END)::bigint AS q,
        SUM(CASE WHEN sri."unitsPerPack" IS NULL THEN 0 ELSE sri."qty"::bigint * sri."unitsPerPack" END)::bigint AS u,
        SUM(sri."pieces")::bigint AS p
      FROM "SupplierReturnItem" sri JOIN "SupplierReturn" sr ON sr."id" = sri."returnId"
      WHERE sri."productId" IN (${part}) AND sr."date" > ${t} GROUP BY sri."productId"`)
    for (const r of srs) add(r.id, -(Number(r.q) * (upp.get(r.id) || 1) + Number(r.u) + Number(r.p)))
  }
  return out
}
