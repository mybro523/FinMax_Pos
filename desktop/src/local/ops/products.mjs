// ── Товары: завести, поправить, удалить — и без связи ──
//
// Перенос серверной карточки товара (server/src/products/products.service.ts). Карточка
// ложится поправкой поверх данных сервера (edits.mjs), остаток — движением товара
// (stock.mjs), и всё уходит на сервер, когда появится связь.
//
// Что решает сервер, когда операция до него дойдёт:
//   • правку решает время: если то же поле поправили и на сайте, остаётся последняя по
//     времени правка, а владелец видит столкновение в «Расхождениях»;
//   • товар, чей штрихкод за это время заняли, сервер заведёт с внутренним кодом —
//     вместе со всеми чеками по нему; владелец объединит карточки;
//   • остаток, вписанный в карточку, — это пересчёт одного товара на момент правки.
// Поэтому касса присылает не только «что стало», но и «что было у неё» и «когда».
import { bodyOf, checker, expiryOk, MAX_MONEY, MAX_UPP, unitsOk } from '../check.mjs'
import { ApiError, bad, inTx, newId, notFound } from '../db.mjs'
import { enqueue } from '../docs.mjs'
import { productByBarcode, productView1 } from '../catalog.mjs'
import { recordEdit } from '../edits.mjs'
import { fromCents, toCents } from '../money.mjs'
import { move, productById, unitsOf } from '../stock.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'
import { reorderProducts } from '../snapshot.mjs'

// Тексты отказов — слово в слово как у сервера
export const BARCODE_TAKEN = 'Товар с таким штрихкодом уже существует'
const IMAGE = /^$|^data:image\/(jpeg|png|webp);base64,/

// Поле карточки: как его называет сервер → столбец локальной базы и перевод значения
const FIELDS = {
  name: { col: 'name' },
  barcode: { col: 'barcode' },
  category: { col: 'category' },
  type: { col: 'type' },
  price: { col: 'priceC', toDb: (v) => toCents(v), fromRow: (r) => fromCents(r.priceC) },
  // Закупочная цена — основа для пересчёта средней цены: что «знает сервер» (sCostC)
  cost: { col: 'sCostC', also: 'costC', toDb: (v) => toCents(v), fromRow: (r) => fromCents(r.costC) },
  minStock: { col: 'minStock' },
  unit: { col: 'unit' },
  unitsPerPack: { col: 'unitsPerPack' },
  dosage: { col: 'dosage' },
  analogIds: { col: 'analogIds', toDb: (v) => JSON.stringify(v), fromRow: (r) => analogsOf(r.analogIds) },
  image: { col: 'image', fromRow: (r) => r.image || '' },
}
function analogsOf(text) {
  try {
    const a = JSON.parse(text || '[]')
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}
const valueOf = (row, f) => (FIELDS[f].fromRow ? FIELDS[f].fromRow(row) : row[FIELDS[f].col] ?? '')
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// Поля из запроса окна — с теми же пределами, что у сервера (products/dto.ts)
function readFields(raw) {
  const dto = bodyOf(raw)
  const c = checker()
  const out = {}
  const opt = { optional: true }
  const take = (k, v) => {
    if (v !== undefined) out[k] = v
  }
  take('name', c.str(dto.name, 'name', opt))
  take('barcode', c.str(dto.barcode, 'barcode', opt))
  take('category', c.str(dto.category, 'category', opt))
  take('type', c.str(dto.type, 'type', opt))
  take('cost', c.num(dto.cost, 'cost', { ...opt, max: MAX_MONEY }))
  take('price', c.num(dto.price, 'price', { ...opt, max: MAX_MONEY }))
  take('minStock', c.int(dto.minStock, 'minStock', opt))
  take('unit', c.str(dto.unit, 'unit', opt))
  take('unitsPerPack', c.int(dto.unitsPerPack, 'unitsPerPack', { ...opt, min: 1, max: MAX_UPP }))
  take('dosage', c.str(dto.dosage, 'dosage', opt))
  take('image', c.str(dto.image, 'image', opt))
  const stock = c.int(dto.stock, 'stock', opt)
  const looseUnits = c.int(dto.looseUnits, 'looseUnits', opt)
  const expiry = c.str(dto.expiryDate, 'expiryDate', opt)
  if (dto.analogIds !== undefined) {
    if (!Array.isArray(dto.analogIds) || dto.analogIds.some((x) => typeof x !== 'string')) c.str(1, 'analogIds')
    else out.analogIds = dto.analogIds.slice(0, 500)
  }
  c.done()
  if (out.name !== undefined) out.name = out.name.trim()
  if (out.barcode !== undefined) out.barcode = out.barcode.trim()
  if (out.category !== undefined) out.category = out.category.trim()
  if (out.type !== undefined) {
    out.type = out.type.trim()
    if (out.type.length > 40) throw bad('Тип: не длиннее 40 символов')
  }
  if (out.unit !== undefined) out.unit = out.unit.trim() || 'уп'
  if (out.image !== undefined && (out.image.length > 200_000 || !IMAGE.test(out.image))) throw bad('Фото: не тот вид')
  if (out.name !== undefined && !out.name) throw bad('Укажите название товара')
  if (out.barcode !== undefined && !out.barcode) throw bad('Укажите штрихкод')
  if (out.name && out.name.length > 300) throw bad('Название: не длиннее 300 символов')
  if (out.barcode && out.barcode.length > 200) throw bad('Штрихкод: не длиннее 200 символов')
  // Срок годности: пусто — без срока; не прислан — не трогали
  let expiryDate
  if (dto.expiryDate !== undefined) {
    expiryDate = expiry ? isoOrNull(expiry) : null
    if (expiry && !expiryDate) throw bad('Срок годности: неверная дата')
    expiryOk(expiryDate)
  }
  return { fields: out, stock, looseUnits, expiryDate }
}

// ── Завести товар ──
export function createProduct(ctx, raw) {
  const { db, now } = ctx
  const { fields: f, stock = 0, looseUnits = 0, expiryDate = null } = readFields(raw)
  if (!f.name) throw bad('Укажите название товара')
  if (!f.barcode) throw bad('Укажите штрихкод')
  const upp = f.unitsPerPack ?? 1
  const units = stock * upp + looseUnits
  unitsOk(units)

  return inTx(db, () => {
    if (productByBarcode(db, f.barcode)) throw new ApiError(409, BARCODE_TAKEN)
    const id = newId()
    const opId = newId()
    const at = new Date(now).toISOString()
    const costC = toCents(f.cost ?? 0)
    const row = {
      ord: 0,
      name: f.name,
      barcode: f.barcode,
      // Как у сервера: не прислали — «Прочее», прислали пусто — пусто
      category: f.category ?? 'Прочее',
      type: f.type ?? '',
      priceC: toCents(f.price ?? 0),
      minStock: f.minStock ?? 5,
      unit: f.unit ?? 'уп',
      unitsPerPack: upp,
      dosage: f.dosage ?? '',
      analogIds: JSON.stringify(f.analogIds ?? []),
      image: f.image ?? '',
      createdAt: at,
      sCostC: costC,
      costC,
      sExpiry: null,
      expiryDate: null,
    }
    recordEdit(db, { opId, tbl: 'products', rowId: id, action: 'put', data: { row }, now })
    reorderProducts(db)
    // Начальный остаток — партией, как у сервера: продажа берёт товар именно из партий
    if (units > 0) move(db, { opId, productId: id, kind: 'card', units, costC, expiryDate, note: 'Начальный остаток' }, { now })
    enqueue(db, {
      id: opId,
      type: 'product.create',
      accountId: ctx.user.accountId,
      payload: {
        product: {
          id,
          name: row.name,
          barcode: row.barcode,
          category: row.category,
          type: row.type,
          cost: f.cost ?? 0,
          price: f.price ?? 0,
          minStock: row.minStock,
          unit: row.unit,
          unitsPerPack: upp,
          dosage: row.dosage,
          analogIds: f.analogIds ?? [],
          image: row.image,
          stock,
          looseUnits,
          expiryDate,
          createdAt: at,
        },
      },
      now,
    })
    return productView1(db, productById(db, id), now)
  })
}

// ── Поправить карточку ──
// Окно присылает форму целиком; на сервер уходит только то, что действительно поменяли,
// вместе с тем, что было в этих полях у кассы
export function updateProduct(ctx, id, raw) {
  const { db, now } = ctx
  const { fields: f, stock, looseUnits, expiryDate } = readFields(raw)

  return inTx(db, () => {
    const row = productById(db, id)
    if (!row) throw notFound('Товар не найден')
    const view = productView1(db, row, now)
    const set = {}
    const base = {}
    for (const k of Object.keys(f)) {
      if (!FIELDS[k]) continue
      const was = valueOf(row, k)
      if (same(was, f[k])) continue
      set[k] = f[k]
      base[k] = was
    }
    if (set.barcode) {
      const other = productByBarcode(db, set.barcode)
      if (other && other.id !== id) throw new ApiError(409, BARCODE_TAKEN)
    }

    // Остаток: вписали число руками — или поменяли штук в упаковке, а упаковок столько же
    // (так считает и сервер: упаковки × новые штуки в упаковке + вскрытые)
    const oldUpp = uppOf(row)
    const newUpp = set.unitsPerPack ?? oldUpp
    const { units: haveUnits } = unitsOf(db, id, now)
    // Вписали другое число руками. Окно присылает форму целиком, поэтому «поле есть в
    // форме» ещё не значит «пересчитали»: при одной лишь смене упаковки число в форме прежнее.
    // Сервер по этому решает, ставить ли остаток, если упаковку оставили чужую (edits.ts)
    const explicit = (stock !== undefined && stock !== view.stock) || (looseUnits !== undefined && looseUnits !== view.looseUnits)
    let target = null
    if (explicit || newUpp !== oldUpp) {
      const packs = stock ?? view.stock
      const loose = looseUnits ?? view.looseUnits
      const t = packs * newUpp + loose
      unitsOk(t)
      if (t !== haveUnits) target = t
    }
    // Срок годности: прислали другой день, чем у товара сейчас
    const expiryChanged = expiryDate !== undefined && String(expiryDate || '').slice(0, 10) !== String(view.expiryDate || '').slice(0, 10)

    if (!Object.keys(set).length && target === null && !expiryChanged) return view

    const opId = newId()
    const at = new Date(now).toISOString()
    if (Object.keys(set).length) {
      const dbSet = {}
      const dbWas = {}
      for (const [k, v] of Object.entries(set)) {
        const spec = FIELDS[k]
        dbSet[spec.col] = spec.toDb ? spec.toDb(v) : v
        dbWas[spec.col] = row[spec.col]
        if (spec.also) {
          dbSet[spec.also] = dbSet[spec.col]
          dbWas[spec.also] = row[spec.also]
        }
      }
      recordEdit(db, { opId, tbl: 'products', rowId: id, action: 'put', data: { set: dbSet, was: dbWas }, now })
      if ('name' in set) reorderProducts(db)
    }
    // Остаток — разницей, движением товара: поверх свежих данных сервера оно проиграется
    // заново, как продажа. Сервер получит само число — это пересчёт на момент правки
    if (target !== null) move(db, { opId, productId: id, kind: 'count', units: target - haveUnits, costC: row.costC, expiryDate: row.expiryDate ?? null, note: 'Правка остатка в карточке' }, { now })
    // Закупочная цена, вписанная руками, — тоже движением: при пересчёте полки оно ляжет после
    // приходов, сделанных раньше правки (их средняя цена её не перекроет), и до сделанных позже
    if ('cost' in set) move(db, { opId, productId: id, kind: 'cost', units: 0, costC: toCents(set.cost) }, { now })
    if (expiryChanged) move(db, { opId, productId: id, kind: 'expiry', units: 0, expiryDate }, { now })

    enqueue(db, {
      id: opId,
      type: 'product.update',
      accountId: ctx.user.accountId,
      payload: {
        id,
        at,
        set,
        base,
        stock: target === null ? null : { units: target, explicit },
        ...(expiryChanged ? { expiryDate } : {}),
      },
      now,
    })
    return productView1(db, productById(db, id), now)
  })
}

// ── Удалить товар ──
export function deleteProduct(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const row = productById(db, id)
    if (!row) throw notFound('Товар не найден')
    const opId = newId()
    const { id: _id, ...wasRow } = row
    recordEdit(db, { opId, tbl: 'products', rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type: 'product.delete', accountId: ctx.user.accountId, payload: { id, at: new Date(now).toISOString() }, now })
    return { ok: true }
  })
}
