// ── Склад (1.8.0): остатки по товарам и итоги ──
// Склад — отдельный запас: партии склада (skladBatches) приходят с сервера, у каждой —
// штуки, закупочная за упаковку товара и срок. Здесь они сводятся по товарам:
// сколько лежит (штук), на сколько по закупке (по ценам партий) и по цене продажи
// (как остаток магазина — целые упаковки по цене упаковки, вскрытая — по цене штуки).
// Расширения в путях — файл грузится и проверками без сборщика.
import { uppOf, stockValue, splitUnits } from './units.js'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const kop = (x) => Math.round(x * 100) / 100
const ts = (d) => (d ? new Date(d).getTime() : NaN)

// Стоимость указанного числа штук товара по цене продажи
export const skladValueOf = (p, units) => (p ? stockValue({ ...p, ...splitUnits(units, p) }) : 0)

// Строки склада по товарам: [{ productId, product, units, cost, value, expiry, batches }].
// Товара уже нет в справочнике — строки нет (партии удаляются вместе с товаром)
export function skladPoTovaram(batches, products) {
  const byId = products instanceof Map ? products : new Map((products || []).map((p) => [p.id, p]))
  const rows = new Map()
  for (const b of batches || []) {
    const units = Math.max(0, Math.trunc(num(b?.units)))
    if (!units) continue
    const p = byId.get(b.productId)
    if (!p) continue
    const r = rows.get(p.id) || { productId: p.id, product: p, units: 0, cost: 0, value: 0, expiry: null, batches: [] }
    r.units += units
    r.cost += (units * num(b.cost)) / uppOf(p)
    r.batches.push(b)
    const t = ts(b.expiryDate)
    if (Number.isFinite(t) && (r.expiry === null || t < ts(r.expiry))) r.expiry = b.expiryDate
    rows.set(p.id, r)
  }
  const list = [...rows.values()].map((r) => ({ ...r, cost: kop(r.cost), value: kop(skladValueOf(r.product, r.units)) }))
  list.sort((a, b) => String(a.product.name).localeCompare(String(b.product.name), 'ru'))
  return list
}

// Итоги склада: сколько товаров (наименований), штук, по закупке и по цене продажи
export function skladItogo(rows) {
  return {
    tovarov: rows.length,
    units: rows.reduce((s, r) => s + r.units, 0),
    cost: kop(rows.reduce((s, r) => s + r.cost, 0)),
    value: kop(rows.reduce((s, r) => s + r.value, 0)),
  }
}

// Штук товара на складе (для переноса и правки)
export function skladUnitsOf(batches, productId) {
  return (batches || []).reduce((s, b) => s + (b?.productId === productId ? Math.max(0, Math.trunc(num(b.units))) : 0), 0)
}
