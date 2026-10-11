// ── Справочники: товары, категории, клиенты, отложенные штрихкоды ──
//
// Всё отдаётся в том виде, в каком это отдаёт сервер: интерфейс не знает и не должен
// знать, откуда пришёл ответ.
import { q } from './db.mjs'
import { fromCents } from './money.mjs'
import { allUnits, unitsOf } from './stock.mjs'
import { splitUnits, uppOf } from './units.mjs'

function analogs(text) {
  try {
    const a = JSON.parse(text || '[]')
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

// Карточка товара. Упаковки, штуки во вскрытой и просрочка не хранятся — они
// выводятся из партий в момент ответа. Поэтому просрочка здесь всегда сегодняшняя:
// партия, у которой срок вышел ночью, утром уже считается негодной, даже если
// компьютер неделю не видел сервера.
function productView(row, u) {
  const units = u?.units || 0
  const { stock, looseUnits } = splitUnits(units, uppOf(row))
  return {
    id: row.id,
    name: row.name,
    barcode: row.barcode,
    category: row.category,
    cost: fromCents(row.costC),
    price: fromCents(row.priceC),
    stock,
    minStock: row.minStock,
    unit: row.unit,
    unitsPerPack: row.unitsPerPack,
    looseUnits,
    dosage: row.dosage,
    expiryDate: row.expiryDate,
    expiredUnits: Math.min(units, u?.expired || 0),
    analogIds: analogs(row.analogIds),
    createdAt: row.createdAt,
  }
}

export function productsList(db, now) {
  const units = allUnits(db, now)
  return q(db, 'SELECT * FROM products ORDER BY ord, name').all().map((r) => productView(r, units.get(r.id)))
}

export function productView1(db, row, now) {
  return productView(row, unitsOf(db, row.id, now))
}

export const productByBarcode = (db, barcode) => q(db, 'SELECT * FROM products WHERE barcode = ?').get(barcode) || null

export const categoriesList = (db) =>
  q(db, 'SELECT id, name, noExpiry, createdAt FROM categories ORDER BY ord, name')
    .all()
    .map((c) => ({ id: c.id, name: c.name, noExpiry: !!c.noExpiry, createdAt: c.createdAt }))

// Названия категорий, где срок годности при приёмке не спрашивают (бинты, приборы)
export const noExpiryCategories = (db) => new Set(q(db, 'SELECT name FROM categories WHERE noExpiry = 1').all().map((c) => c.name))

// ── Клиенты ──
export const customerRow = (db, id) => q(db, 'SELECT * FROM customers WHERE id = ?').get(id) || null

export const customerView = (c) => ({ id: c.id, name: c.name, phone: c.phone, debt: fromCents(c.debtC), createdAt: c.createdAt })

export const customersList = (db) => q(db, 'SELECT * FROM customers ORDER BY createdAt DESC, id DESC').all().map(customerView)

// Изменить долг и записать это в журнал. Итог хранится готовым, но при свежих данных
// с сервера пересчитывается заново: долг по словам сервера плюс всё, что сделано
// здесь и ещё не принято (см. snapshot.mjs).
export function debtMove(db, { opId, customerId, deltaC, kind }, now) {
  if (!deltaC) return
  q(db, 'INSERT INTO debt_moves (opId, customerId, deltaC, kind, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    opId,
    customerId,
    deltaC,
    kind,
    new Date(now).toISOString(),
  )
  q(db, 'UPDATE customers SET debtC = MAX(0, debtC + ?) WHERE id = ?').run(deltaC, customerId)
}

// ── Отложенные штрихкоды ──
// Один штрихкод показывается один раз, даже если его отложили и здесь, и на другой
// кассе: первой идёт запись, которую уже знает сервер.
export function deferredList(db) {
  const rows = q(db, "SELECT * FROM deferred WHERE sync <> 'deleted' ORDER BY createdAt DESC, id DESC").all()
  const known = new Set(rows.filter((r) => r.sync === 'synced').map((r) => r.barcode))
  return rows
    .filter((r) => r.sync === 'synced' || !known.has(r.barcode))
    .map((r) => ({ id: r.id, barcode: r.barcode, createdAt: r.createdAt }))
}

export const deferredByBarcode = (db, barcode) =>
  q(db, "SELECT * FROM deferred WHERE barcode = ? AND sync <> 'deleted' ORDER BY (sync = 'synced') DESC LIMIT 1").get(barcode) || null
