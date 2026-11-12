import { Prisma } from '@prisma/client'
import { createProductIn } from '../products/products.service'
import { isDrob, KG } from '../common/piece'
import { TX_LONG } from '../common/tx'

// ── Товары из Excel (12.11.2026) ──
// Владелец сервиса заводит магазин клиента (или дозагружает уже заведённый) сразу со списком
// товаров из его Excel. Файл разбирает панель (client/src/lib/importTovarov.js): находит
// колонки, даёт код товарам без штрихкода, убирает повторы. Сюда приходит готовый список —
// но он пришёл по сети, поэтому всё проверяется ещё раз: длины, числа, повторы.
//
// Товары со штрихкодом, который в магазине уже есть, не трогаются (дозагрузка не правит
// карточки). Всё — одной транзакцией: либо загрузилось всё, либо ничего.

export const MAX_IMPORT = 50_000

export type ImportRow = {
  barcode?: unknown
  name?: unknown
  price?: unknown
  cost?: unknown
  stock?: unknown
  category?: unknown
  unit?: unknown
  // Штрихкода в файле не было — код дала панель. Повторная загрузка того же файла дала бы
  // такому товару новый код и задвоила бы его, поэтому он сверяется по названию
  own?: unknown
}

export type CleanRow = {
  barcode: string
  name: string
  price: number
  cost: number
  stock: number
  category: string
  unit: string
  own: boolean
}

const str = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
const money = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.min(1e9, Math.round(n * 100) / 100) : 0
}

// Проверить и выровнять строки: без названия или штрихкода — мимо, повтор штрихкода — первая
// строка. Возвращает годные строки и сколько отброшено
export function cleanImport(items: unknown): { rows: CleanRow[]; dropped: number } {
  const list = Array.isArray(items) ? items.slice(0, MAX_IMPORT) : []
  const seen = new Set<string>()
  const rows: CleanRow[] = []
  let dropped = 0
  for (const it of list as ImportRow[]) {
    const barcode = str(it?.barcode, 64)
    const name = str(it?.name, 200)
    if (!barcode || !name || seen.has(barcode)) {
      dropped++
      continue
    }
    seen.add(barcode)
    const stock = Math.max(0, Math.min(10_000_000, Math.trunc(Number(it?.stock) || 0)))
    rows.push({
      barcode,
      name,
      price: money(it?.price),
      cost: money(it?.cost),
      stock,
      category: str(it?.category, 60) || 'Прочее',
      unit: str(it?.unit, 12) || 'уп',
      own: it?.own === true,
    })
  }
  return { rows, dropped }
}

// Завести товары в схеме магазина (вызывать внутри runInTenant). created — заведено,
// existed — такой штрихкод (а у товара без штрихкода в файле — такое название) в магазине
// уже был, dropped — строки, не прошедшие проверку
export async function importProducts(prisma: any, items: unknown) {
  const { rows, dropped } = cleanImport(items)
  if (!rows.length) return { created: 0, existed: 0, dropped }
  const cur = (await prisma.product.findMany({ select: { barcode: true, name: true } })) as { barcode: string; name: string }[]
  const have = new Set<string>(cur.map((p) => p.barcode))
  const key = (n: string) => n.replace(/\s+/g, ' ').trim().toLowerCase()
  const names = new Set<string>(cur.map((p) => key(p.name)))
  const fresh = rows.filter((r) => {
    if (have.has(r.barcode)) return false
    if (r.own) {
      if (names.has(key(r.name))) return false
      names.add(key(r.name))
    }
    return true
  })
  const existed = rows.length - fresh.length

  const data = (r: CleanRow): Prisma.ProductUncheckedCreateInput => ({
    barcode: r.barcode,
    name: r.name,
    price: r.price,
    cost: r.cost,
    stock: r.stock,
    category: r.category,
    unit: r.unit,
    // Дробный товар (кг, л, м, м²) — в упаковке 1000 тысячных, как у заведённого в карточке
    unitsPerPack: isDrob(r.unit) ? KG : 1,
  })

  // Одиннадцать тысяч товаров — запас времени как у инвентаризации (TX_LONG)
  await prisma.$transaction(
    async (tx: any) => {
      // Без остатка — пачками: одиннадцать тысяч товаров за секунды
      const plain = fresh.filter((r) => r.stock === 0)
      for (let i = 0; i < plain.length; i += 1000) {
        await tx.product.createMany({ data: plain.slice(i, i + 1000).map(data), skipDuplicates: true })
      }
      // С остатком — как в карточке: остаток ложится партией (createProductIn)
      for (const r of fresh.filter((x) => x.stock > 0)) await createProductIn(tx, data(r))
      // Штрихкоды, отложенные кассой «нет такого товара», теперь заведены
      const codes = fresh.map((r) => r.barcode)
      for (let i = 0; i < codes.length; i += 5000) {
        await tx.deferredBarcode.deleteMany({ where: { barcode: { in: codes.slice(i, i + 5000) } } })
      }
    },
    TX_LONG
  )
  return { created: fresh.length, existed, dropped }
}
