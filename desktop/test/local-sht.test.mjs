// ── Единица «шт» по умолчанию (17.11.2026) ──
//
// Владелец: товары по умолчанию — в штуках, а не в упаковках. Обновление программы переводит
// уже заведённые «уп» с одной штукой в упаковке в «шт» (шаг схемы в local/schema.mjs, как и
// миграция сервера 20261117_sht_po_umolchaniyu); настоящие упаковки и товары на вес не трогает.
// Новый товар без единицы — «шт», упаковка из нескольких штук — «уп».
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/local/db.mjs'
import { PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { createProduct } from '../src/local/ops/products.mjs'
import { ctx, pharmacy, rows } from '../test-support/pharmacy.mjs'

const insert = (db, id, unit, upp) =>
  db
    .prepare("INSERT INTO products (id, name, barcode, unit, unitsPerPack, createdAt) VALUES (?, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z')")
    .run(id, 'Товар ' + id, 'code-' + id, unit, upp)

test('обновление программы: «уп» по одной штуке — «шт», настоящие упаковки и весовые — как были', () => {
  const file = join(fs.mkdtempSync(join(os.tmpdir(), 'apteka-sht-')), 'p.db')
  // База прежней версии: все шаги схемы, кроме нового
  let db = openDb(file, PHARMACY_SCHEMA.slice(0, -1))
  insert(db, 'a', 'уп', 1) // «1 уп» из одной штуки — станет «шт»
  insert(db, 'b', '', 1) // единица не заполнена (показывалась «уп») — тоже «шт»
  insert(db, 'c', 'уп', 20) // пачка по 20 — остаётся упаковкой
  insert(db, 'd', 'кг', 1000) // на вес — своя единица
  insert(db, 'e', 'рулон', 1) // своя единица владельца — не трогаем
  insert(db, 'f', 'шт', 1)
  db.close()

  db = openDb(file, PHARMACY_SCHEMA)
  const units = Object.fromEntries(rows(db, 'SELECT id, unit, unitsPerPack FROM products ORDER BY id').map((r) => [r.id, `${r.unit}/${r.unitsPerPack}`]))
  assert.deepEqual(units, { a: 'шт/1', b: 'шт/1', c: 'уп/20', d: 'кг/1000', e: 'рулон/1', f: 'шт/1' })
  db.close()
  // Повторный запуск шаг не повторяет и ничего не меняет
  db = openDb(file, PHARMACY_SCHEMA)
  assert.equal(rows(db, "SELECT count(*) AS n FROM products WHERE unit = 'шт'")[0].n, 3)
  db.close()
})

test('новый товар без единицы — «шт», упаковка из нескольких штук — «уп»', () => {
  const db = pharmacy()
  const one = createProduct(ctx(db), { name: 'Губка', barcode: '4600000000101', price: 5, cost: 3 })
  const pack = createProduct(ctx(db), { name: 'Салфетки', barcode: '4600000000102', price: 20, cost: 12, unitsPerPack: 10 })
  const unit = (id) => rows(db, 'SELECT unit FROM products WHERE id = ?', id)[0].unit
  assert.equal(unit(one.id), 'шт')
  assert.equal(unit(pack.id), 'уп')
})
