// ── Справочники настроек — и без связи ──
//
// Категории и типы товаров, сервисы перевода, статьи расходов и доходов. Перенос серверных
// правил (categories, producttypes, payservices, expenses, incomes): те же проверки, те же
// тексты отказов. Сделанное ложится поправкой поверх данных сервера (edits.mjs) и уходит
// на сервер, когда появится связь.
//
// Переименование категории или типа переносит товары — как у сервера: иначе они выпали бы
// из фильтров и пересчёта. Перенос тоже поправкой (map): свежие данные сервера, пришедшие
// раньше, чем он узнает о переименовании, не вернут товарам старое название.
import { bodyOf, checker } from '../check.mjs'
import { bad, inTx, newId, notFound, q } from '../db.mjs'
import { enqueue } from '../docs.mjs'
import { recordEdit } from '../edits.mjs'
import { categoriesList, productTypesList } from '../catalog.mjs'
import { reorderCategories } from '../snapshot.mjs'

// Тексты — слово в слово как у сервера
export const CATEGORY_EXISTS = 'Такая категория уже есть'
export const CATEGORY_NAME_TAKEN = 'Категория с таким названием уже есть'
export const categoryInUse = (name, used) => `В категории «${name}» ${used} товар(ов) — сначала перенесите их в другую категорию`
export const TYPE_EXISTS = 'Такой тип товара уже есть'
export const typeInUse = (name, used) => `Тип «${name}» стоит у ${used} товар(ов) — сначала смените им тип`
export const PAY_SERVICE_EXISTS = 'Такой сервис уже есть'
export const EXPENSE_CATEGORY_EXISTS = 'Такая статья расходов уже есть'
export const INCOME_CATEGORY_EXISTS = 'Такая статья доходов уже есть'

const at = (now) => new Date(now).toISOString()

// Название из запроса: текст, не пустой, не длиннее max — как у сервера
function nameOf(dto, max, emptyText) {
  const c = checker()
  const name = c.str(dto.name, 'name')
  c.done()
  const v = name.trim()
  if (!v) throw bad(emptyText)
  if (v.length > max) throw bad(`Название: не длиннее ${max} символов`)
  return v
}

// ════════════════════════ Категории ════════════════════════

export function createCategory(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const name = nameOf(dto, 40, 'Укажите название категории')
  const noExpiry = dto.noExpiry === true
  return inTx(db, () => {
    if (q(db, 'SELECT 1 FROM categories WHERE name = ?').get(name)) throw bad(CATEGORY_EXISTS)
    const id = newId()
    const opId = newId()
    const createdAt = at(now)
    recordEdit(db, { opId, tbl: 'categories', rowId: id, action: 'put', data: { row: { ord: 0, name, noExpiry: noExpiry ? 1 : 0, createdAt } }, now })
    reorderCategories(db)
    enqueue(db, { id: opId, type: 'category.create', accountId: ctx.user.accountId, payload: { category: { id, name, noExpiry, createdAt } }, now })
    return { id, name, noExpiry, createdAt }
  })
}

export function updateCategory(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  return inTx(db, () => {
    const cat = q(db, 'SELECT * FROM categories WHERE id = ?').get(id)
    if (!cat) throw notFound('Категория не найдена')
    const name = dto.name === undefined ? cat.name : nameOf(dto, 40, 'Укажите название категории')
    const noExpiry = dto.noExpiry === undefined ? !!cat.noExpiry : dto.noExpiry === true
    const set = {}
    const base = {}
    if (name !== cat.name) {
      if (q(db, 'SELECT 1 FROM categories WHERE name = ? AND id <> ?').get(name, id)) throw bad(CATEGORY_NAME_TAKEN)
      set.name = name
      base.name = cat.name
    }
    if (noExpiry !== !!cat.noExpiry) {
      set.noExpiry = noExpiry
      base.noExpiry = !!cat.noExpiry
    }
    if (!Object.keys(set).length) return view(cat)
    const opId = newId()
    // В поправку — только то, что поменяли: иначе, пока операция ждёт отправки, прежнее
    // значение нетронутого поля перекрывало бы при каждом обмене новое с сайта
    recordEdit(db, {
      opId, tbl: 'categories', rowId: id, action: 'put',
      data: {
        set: { ...('name' in set ? { name } : {}), ...('noExpiry' in set ? { noExpiry: noExpiry ? 1 : 0 } : {}) },
        was: { ...('name' in set ? { name: cat.name } : {}), ...('noExpiry' in set ? { noExpiry: cat.noExpiry } : {}) },
      },
      now,
    })
    // Товары переезжают вместе с названием
    if (set.name) recordEdit(db, { opId, tbl: 'products', rowId: '*', action: 'map', data: { col: 'category', from: cat.name, to: name }, now })
    reorderCategories(db)
    enqueue(db, { id: opId, type: 'category.update', accountId: ctx.user.accountId, payload: { id, at: at(now), set, base }, now })
    return categoriesList(db).find((c) => c.id === id)
  })
}

export function deleteCategory(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const cat = q(db, 'SELECT * FROM categories WHERE id = ?').get(id)
    if (!cat) throw notFound('Категория не найдена')
    const used = q(db, 'SELECT COUNT(*) AS n FROM products WHERE category = ?').get(cat.name).n
    if (used > 0) throw bad(categoryInUse(cat.name, used))
    const opId = newId()
    const { id: _id, ...wasRow } = cat
    recordEdit(db, { opId, tbl: 'categories', rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type: 'category.delete', accountId: ctx.user.accountId, payload: { id, at: at(now) }, now })
    return { ok: true }
  })
}

const view = (c) => ({ id: c.id, name: c.name, noExpiry: !!c.noExpiry, createdAt: c.createdAt })

// ════════════════════════ Типы товаров ════════════════════════

export function createProductType(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const name = nameOf(dto, 40, 'Укажите название типа товара')
  const analogs = dto.analogs === true
  return inTx(db, () => {
    if (q(db, 'SELECT 1 FROM product_types WHERE name = ?').get(name)) throw bad(TYPE_EXISTS)
    const id = newId()
    const opId = newId()
    const createdAt = at(now)
    recordEdit(db, { opId, tbl: 'product_types', rowId: id, action: 'put', data: { row: { name, analogs: analogs ? 1 : 0, createdAt } }, now })
    enqueue(db, { id: opId, type: 'productType.create', accountId: ctx.user.accountId, payload: { type: { id, name, analogs, createdAt } }, now })
    return { id, name, analogs, createdAt }
  })
}

export function updateProductType(ctx, id, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  return inTx(db, () => {
    const t = q(db, 'SELECT * FROM product_types WHERE id = ?').get(id)
    if (!t) throw notFound('Тип товара не найден')
    const name = dto.name === undefined ? t.name : nameOf(dto, 40, 'Укажите название типа товара')
    const analogs = dto.analogs === undefined ? !!t.analogs : dto.analogs === true
    const set = {}
    const base = {}
    if (name !== t.name) {
      if (q(db, 'SELECT 1 FROM product_types WHERE name = ? AND id <> ?').get(name, id)) throw bad(TYPE_EXISTS)
      set.name = name
      base.name = t.name
    }
    if (analogs !== !!t.analogs) {
      set.analogs = analogs
      base.analogs = !!t.analogs
    }
    if (!Object.keys(set).length) return { id: t.id, name: t.name, analogs: !!t.analogs, createdAt: t.createdAt }
    const opId = newId()
    recordEdit(db, {
      opId, tbl: 'product_types', rowId: id, action: 'put',
      data: {
        set: { ...('name' in set ? { name } : {}), ...('analogs' in set ? { analogs: analogs ? 1 : 0 } : {}) },
        was: { ...('name' in set ? { name: t.name } : {}), ...('analogs' in set ? { analogs: t.analogs } : {}) },
      },
      now,
    })
    if (set.name) recordEdit(db, { opId, tbl: 'products', rowId: '*', action: 'map', data: { col: 'type', from: t.name, to: name }, now })
    enqueue(db, { id: opId, type: 'productType.update', accountId: ctx.user.accountId, payload: { id, at: at(now), set, base }, now })
    return productTypesList(db).find((x) => x.id === id)
  })
}

export function deleteProductType(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const t = q(db, 'SELECT * FROM product_types WHERE id = ?').get(id)
    if (!t) throw notFound('Тип товара не найден')
    const used = q(db, 'SELECT COUNT(*) AS n FROM products WHERE type = ?').get(t.name).n
    if (used > 0) throw bad(typeInUse(t.name, used))
    const opId = newId()
    const { id: _id, ...wasRow } = t
    recordEdit(db, { opId, tbl: 'product_types', rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type: 'productType.delete', accountId: ctx.user.accountId, payload: { id, at: at(now) }, now })
    return { ok: true }
  })
}

// ════════════════════════ Сервисы перевода и статьи ════════════════════════
// Только завести и убрать — как на сайте

export function createPayService(ctx, raw) {
  const { db, now } = ctx
  const name = nameOf(bodyOf(raw), 40, 'Укажите название сервиса')
  return inTx(db, () => {
    if (q(db, 'SELECT 1 FROM pay_services WHERE name = ?').get(name)) throw bad(PAY_SERVICE_EXISTS)
    const id = newId()
    const opId = newId()
    const createdAt = at(now)
    const ord = (q(db, 'SELECT COALESCE(MAX(ord), 0) AS m FROM pay_services').get().m || 0) + 1
    recordEdit(db, { opId, tbl: 'pay_services', rowId: id, action: 'put', data: { row: { name, ord, createdAt } }, now })
    enqueue(db, { id: opId, type: 'payService.create', accountId: ctx.user.accountId, payload: { service: { id, name, createdAt } }, now })
    return { id, name, ord, createdAt }
  })
}

export function deletePayService(ctx, id) {
  return removeNamed(ctx, id, 'pay_services', 'payService.delete', 'Сервис не найден')
}

const NAMED = {
  expense: { tbl: 'expense_categories', type: 'expenseCategory', exists: EXPENSE_CATEGORY_EXISTS, empty: 'Укажите название статьи', gone: 'Статья расходов не найдена' },
  income: { tbl: 'income_categories', type: 'incomeCategory', exists: INCOME_CATEGORY_EXISTS, empty: 'Укажите название статьи', gone: 'Статья доходов не найдена' },
}

// Статья расходов или доходов
export function createArticle(ctx, which, raw) {
  const { db, now } = ctx
  const spec = NAMED[which]
  const name = nameOf(bodyOf(raw), 60, spec.empty)
  return inTx(db, () => {
    if (q(db, `SELECT 1 FROM ${spec.tbl} WHERE name = ?`).get(name)) throw bad(spec.exists)
    const id = newId()
    const opId = newId()
    const createdAt = at(now)
    recordEdit(db, { opId, tbl: spec.tbl, rowId: id, action: 'put', data: { row: { name, createdAt } }, now })
    enqueue(db, { id: opId, type: spec.type + '.create', accountId: ctx.user.accountId, payload: { category: { id, name, createdAt } }, now })
    return { id, name, createdAt }
  })
}

// Статью убрать можно, даже если по ней есть записи: они хранят её название
export function deleteArticle(ctx, which, id) {
  const spec = NAMED[which]
  return removeNamed(ctx, id, spec.tbl, spec.type + '.delete', spec.gone)
}

function removeNamed(ctx, id, tbl, type, gone) {
  const { db, now } = ctx
  return inTx(db, () => {
    const row = q(db, `SELECT * FROM ${tbl} WHERE id = ?`).get(id)
    if (!row) throw notFound(gone)
    const opId = newId()
    const { id: _id, ...wasRow } = row
    recordEdit(db, { opId, tbl, rowId: id, action: 'del', data: { wasRow }, now })
    enqueue(db, { id: opId, type, accountId: ctx.user.accountId, payload: { id, at: at(now) }, now })
    return { ok: true }
  })
}
