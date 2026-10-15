// ── Свежие данные с сервера → в локальную базу ──
//
// Сервер — источник правды для всего, что он уже знает. Но на кассе есть и то, чего
// он ещё не знает: чеки, пробитые без связи, приход, принятый минуту назад. Поэтому
// данные сервера не «перезаписывают» базу, а становятся новой основой, поверх
// которой накладывается сделанное здесь:
//   • остатки — партии сервера, затем журнал своих движений проигрывается заново;
//   • долги — долг по словам сервера плюс свои неотправленные изменения;
//   • документы — серверные заменяют прежние, свои неотправленные остаются;
//   • отложенные штрихкоды — список сервера, плюс добавленные здесь, минус убранные.
//
// Сервер отвечает двумя способами. Полный ответ (первый обмен) — «вот всё, что у меня
// есть»: раздел заменяется целиком. Частичный — «вот что изменилось с прошлого раза»:
// записи дописываются, меняются и удаляются по одной.
import { getMeta, inTx, q, setMeta } from './db.mjs'
import { KINDS, putDoc, WINDOW_DAYS } from './docs.mjs'
import { toCents } from './money.mjs'
import { rebuildStock } from './stock.mjs'
import { DAY_MS, expiryLimit, isoOrNull } from './time.mjs'
import { packsToUnits, uppOf, wholeNonNeg } from './units.mjs'

// Раздел ответа сервера → вид документа в локальной базе
export const DOC_KEYS = {
  sales: 'sale', returns: 'return', arrivals: 'arrival', writeoffs: 'writeoff', payments: 'payment', shifts: 'shift', expenses: 'expense',
  cashMoves: 'cashmove', supplierPayments: 'supplierpayment',
}

const rows = (v) => (Array.isArray(v) ? v : [])
// Раздел ответа: что записать и что убрать
const part = (v) => ({ upsert: rows(v?.upsert), remove: rows(v?.remove) })
const touched = (p) => p.upsert.length > 0 || p.remove.length > 0

// Алфавитный порядок для списков. Сервер сортирует по правилам своей базы, а касса
// получает товары по одному, по мере изменений, — и расставляет их сама
const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

// ── Партии из карточки товара ──
// У товаров, заведённых до появления партий (и у показательных магазинов), остаток лежит
// только в карточке: сервер заводит партию при первом же движении. До тех пор касса
// знает о товаре три числа — сколько штук всего, сколько из них просрочено и ближайший
// срок — и выводит из них две условные партии. Этого хватает для главного: не продать
// просрочку и не дать продать больше, чем лежит на полке.
export function batchesFromCard(p, now) {
  const upp = uppOf(p)
  const total = wholeNonNeg(packsToUnits(p.stock, p.looseUnits, upp))
  if (total <= 0) return []
  const expired = Math.min(total, wholeNonNeg(p.expiredUnits))
  const nearest = isoOrNull(p.expiryDate)
  const limit = expiryLimit(now)
  const base = { productId: p.id, costC: toCents(p.cost), arrivalId: null, note: '', createdAt: isoOrNull(p.createdAt) || new Date(now).toISOString() }
  const out = []
  if (expired > 0) {
    // Ближайший срок у товара с просрочкой — это и есть срок просроченной партии.
    // Если сервер его не прислал, ставим вчерашний день: партия обязана считаться негодной
    const date = nearest && nearest < limit ? nearest : new Date(Date.parse(limit) - DAY_MS).toISOString()
    out.push({ ...base, id: 'card-e:' + p.id, units: expired, expiryDate: date })
  }
  if (total > expired) {
    // Срок годной части известен, только когда просрочки нет: иначе ближайший срок
    // относится к просроченной партии, а про годную сервер ничего не сказал
    const date = expired > 0 ? (nearest && nearest >= limit ? nearest : null) : nearest
    out.push({ ...base, id: 'card-g:' + p.id, units: total - expired, expiryDate: date })
  }
  return out
}

function applyProducts(db, products, batches, full, now) {
  const insertBatch = q(
    db,
    `INSERT OR REPLACE INTO batches (id, productId, units, sUnits, costC, expiryDate, arrivalId, note, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const addBatch = (b) => {
    const units = wholeNonNeg(b.units)
    insertBatch.run(b.id, b.productId, units, units, b.costC, b.expiryDate ?? null, b.arrivalId ?? null, b.note || '', b.createdAt)
  }

  if (full) {
    q(db, 'DELETE FROM products').run()
    q(db, 'DELETE FROM batches').run()
  }

  // Карточки. Закупочная цена и срок «с учётом сделанного здесь» пока ставятся
  // серверными — журнал своих движений поправит их при пересчёте ниже
  const upsertProduct = q(
    db,
    `INSERT INTO products
       (id, ord, name, barcode, category, priceC, minStock, unit, unitsPerPack, dosage, image, analogIds, createdAt, sCostC, costC, sExpiry, expiryDate)
     VALUES (@id, @ord, @name, @barcode, @category, @priceC, @minStock, @unit, @upp, @dosage, @image, @analogIds, @createdAt, @costC, @costC, @expiry, @expiry)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, barcode = excluded.barcode, category = excluded.category, priceC = excluded.priceC,
       minStock = excluded.minStock, unit = excluded.unit, unitsPerPack = excluded.unitsPerPack, dosage = excluded.dosage,
       image = excluded.image,
       analogIds = excluded.analogIds, createdAt = excluded.createdAt, sCostC = excluded.sCostC, costC = excluded.costC,
       sExpiry = excluded.sExpiry, expiryDate = excluded.expiryDate`,
  )
  const nameOf = q(db, 'SELECT name FROM products WHERE id = ?')
  let reorder = full
  products.upsert.forEach((p, n) => {
    const name = String(p.name ?? '')
    if (!reorder && nameOf.get(p.id)?.name !== name) reorder = true
    upsertProduct.run({
      id: p.id,
      ord: n,
      name,
      barcode: String(p.barcode ?? ''),
      category: String(p.category ?? 'Прочее'),
      priceC: toCents(p.price),
      minStock: wholeNonNeg(p.minStock),
      unit: String(p.unit ?? 'уп'),
      upp: uppOf(p),
      dosage: String(p.dosage ?? ''),
      image: String(p.image ?? ''),
      analogIds: JSON.stringify(Array.isArray(p.analogIds) ? p.analogIds : []),
      createdAt: isoOrNull(p.createdAt) || new Date(now).toISOString(),
      costC: toCents(p.cost),
      expiry: isoOrNull(p.expiryDate),
    })
  })
  for (const id of products.remove) {
    q(db, 'DELETE FROM products WHERE id = ?').run(id)
    q(db, 'DELETE FROM batches WHERE productId = ?').run(id)
  }

  for (const b of batches.upsert) {
    addBatch({
      id: b.id,
      productId: b.productId,
      units: b.units,
      costC: toCents(b.cost),
      expiryDate: isoOrNull(b.expiryDate),
      arrivalId: b.arrivalId ?? null,
      note: b.note || '',
      createdAt: isoOrNull(b.createdAt) || new Date(now).toISOString(),
    })
  }
  for (const id of batches.remove) q(db, 'DELETE FROM batches WHERE id = ?').run(id)

  // У кого настоящих партий нет — партии из карточки; у кого появились — карточные убрать.
  // Настоящая — та, что пришла с сервера (у неё есть серверное количество). Партия,
  // заведённая здесь неотправленным приходом, не в счёт: приняв её за серверную, касса
  // выбросила бы остаток из карточки, и товара на полке стало бы меньше, чем есть
  const hasReal = q(db, "SELECT 1 FROM batches WHERE productId = ? AND id NOT LIKE 'card-%' AND sUnits IS NOT NULL LIMIT 1")
  const dropCard = q(db, "DELETE FROM batches WHERE productId = ? AND id LIKE 'card-%'")
  for (const p of products.upsert) {
    dropCard.run(p.id)
    if (!hasReal.get(p.id)) batchesFromCard(p, now).forEach(addBatch)
  }
  for (const b of batches.upsert) dropCard.run(b.productId)

  if (reorder) {
    const all = q(db, 'SELECT id, name FROM products').all().sort((a, b) => byName.compare(a.name, b.name))
    const setOrd = q(db, 'UPDATE products SET ord = ? WHERE id = ?')
    all.forEach((p, n) => setOrd.run(n, p.id))
  }
}

function applyCategories(db, categories, full) {
  if (full) q(db, 'DELETE FROM categories').run()
  const insert = q(db, 'INSERT OR REPLACE INTO categories (id, ord, name, noExpiry, createdAt) VALUES (?, 0, ?, ?, ?)')
  for (const c of categories.upsert) insert.run(c.id, String(c.name ?? ''), c.noExpiry ? 1 : 0, isoOrNull(c.createdAt) || '')
  for (const id of categories.remove) q(db, 'DELETE FROM categories WHERE id = ?').run(id)
  const all = q(db, 'SELECT id, name FROM categories').all().sort((a, b) => byName.compare(a.name, b.name))
  const setOrd = q(db, 'UPDATE categories SET ord = ? WHERE id = ?')
  all.forEach((c, n) => setOrd.run(n, c.id))
}

// Статьи расходов. Меняют их только через сервер, поэтому своих неотправленных
// здесь не бывает: список сервера и есть весь список
function applyExpenseCategories(db, cats, full) {
  if (full) q(db, 'DELETE FROM expense_categories').run()
  const insert = q(db, 'INSERT OR REPLACE INTO expense_categories (id, name, createdAt) VALUES (?, ?, ?)')
  for (const c of cats.upsert) {
    if (c && typeof c.id === 'string') insert.run(c.id, String(c.name ?? ''), isoOrNull(c.createdAt) || '')
  }
  for (const id of cats.remove) q(db, 'DELETE FROM expense_categories WHERE id = ?').run(id)
}

// Поставщики. Кассиру сервер отдаёт их без долга — тогда долг, известный с прошлого
// обмена владельца, не трогаем: иначе владелец, вернувшись, увидел бы нули
function applySuppliers(db, sup, full) {
  if (full) q(db, 'DELETE FROM suppliers').run()
  const insert = q(
    db,
    `INSERT INTO suppliers (id, name, phone, note, openingDebtC, sDebtC, debtArrivals, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, phone = excluded.phone, note = excluded.note,
       openingDebtC = COALESCE(excluded.openingDebtC, suppliers.openingDebtC),
       sDebtC = COALESCE(excluded.sDebtC, suppliers.sDebtC),
       debtArrivals = COALESCE(excluded.debtArrivals, suppliers.debtArrivals), createdAt = excluded.createdAt`,
  )
  for (const s of sup.upsert) {
    if (!s || typeof s.id !== 'string') continue
    const known = s.debt !== undefined && s.debt !== null
    insert.run(s.id, String(s.name ?? ''), String(s.phone ?? ''), String(s.note ?? ''), known ? toCents(s.openingDebt || 0) : null, known ? toCents(s.debt) : null, Number.isInteger(s.debtArrivals) ? s.debtArrivals : null, isoOrNull(s.createdAt) || '')
  }
  for (const id of sup.remove) q(db, 'DELETE FROM suppliers WHERE id = ?').run(id)
}

// Сервисы перевода — список сервера целиком, своих неотправленных не бывает
function applyPayServices(db, list, full) {
  if (full) q(db, 'DELETE FROM pay_services').run()
  const insert = q(db, 'INSERT OR REPLACE INTO pay_services (id, name, ord, createdAt) VALUES (?, ?, ?, ?)')
  for (const s of list.upsert) {
    if (s && typeof s.id === 'string') insert.run(s.id, String(s.name ?? ''), Number(s.ord) || 0, isoOrNull(s.createdAt) || '')
  }
  for (const id of list.remove) q(db, 'DELETE FROM pay_services WHERE id = ?').run(id)
}

// Долг = что сказал сервер + свои неотправленные изменения. В минус не уходит
export function recountDebts(db) {
  q(
    db,
    `UPDATE customers SET debtC = MAX(0, sDebtC + COALESCE(
       (SELECT SUM(deltaC) FROM debt_moves WHERE debt_moves.customerId = customers.id AND synced = 0), 0))`,
  ).run()
}

function applyCustomers(db, customers, full) {
  // Клиенты, заведённые здесь и ещё не дошедшие до сервера, остаются
  if (full) q(db, 'DELETE FROM customers WHERE local = 0').run()
  const insert = q(
    db,
    'INSERT OR REPLACE INTO customers (id, name, phone, sDebtC, debtC, createdAt, local) VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
  for (const c of customers.upsert) {
    const debtC = toCents(c.debt)
    insert.run(c.id, String(c.name ?? ''), String(c.phone ?? ''), debtC, debtC, isoOrNull(c.createdAt) || '')
  }
  for (const id of customers.remove) q(db, 'DELETE FROM customers WHERE id = ? AND local = 0').run(id)
  recountDebts(db)
}

function applyDeferred(db, deferred, full) {
  if (full) q(db, "DELETE FROM deferred WHERE sync = 'synced'").run()
  const removed = new Set(q(db, "SELECT id FROM deferred WHERE sync = 'deleted'").all().map((r) => r.id))
  const insert = q(db, "INSERT OR REPLACE INTO deferred (id, barcode, createdAt, sync) VALUES (?, ?, ?, 'synced')")
  for (const d of deferred.upsert) {
    // Убран здесь, сервер об этом ещё не знает — в список не возвращаем
    if (removed.has(d.id)) continue
    insert.run(d.id, String(d.barcode ?? ''), isoOrNull(d.createdAt) || '')
  }
  for (const id of deferred.remove) q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'synced'").run(id)
}

function applyDocs(db, kind, docs, full) {
  if (full) q(db, "DELETE FROM docs WHERE kind = ? AND sync = 'synced'").run(kind)
  // Свой документ, который сервер ещё не подтвердил, серверной копией не заменяем:
  // вместе с ним в журнале лежат его движения, и заменить одно без другого —
  // значит посчитать товар дважды
  // (Отвергнутый — не в счёт: если сервер прислал документ с таким номером, значит,
  // он у сервера есть, и пометка «отвергнут» устарела.)
  const mine = new Set(q(db, "SELECT id FROM docs WHERE kind = ? AND sync = 'pending'").all(kind).map((r) => r.id))
  for (const d of docs.upsert) {
    if (!d || typeof d.id !== 'string' || mine.has(d.id)) continue
    putDoc(db, kind, d, { sync: 'synced' })
  }
  const drop = q(db, "DELETE FROM docs WHERE kind = ? AND id = ? AND sync = 'synced'")
  for (const id of docs.remove) drop.run(kind, id)
}

// Сколько дней хранить то, что сервер уже принял: операции в очереди и движения
// в журнале. Работе они больше не нужны — остаток и долг приходят от сервера уже с
// ними. Держим полтора месяца на случай разбирательства: «что касса отправляла».
export const SENT_KEEP_DAYS = 45

// Журналы не растут вечно: касса держит их столько же, сколько по умолчанию отдаёт
// сервер. Более давние чеки окно всё равно спрашивает у сервера.
function pruneOld(db, now) {
  const last = Number(getMeta(db, 'docsPrunedAt') || 0)
  if (now - last < DAY_MS) return
  for (const [kind, days] of Object.entries(WINDOW_DAYS)) {
    // День запаса: чек у самой границы срока не должен мигать туда-сюда
    q(db, "DELETE FROM docs WHERE kind = ? AND sync = 'synced' AND date < ?").run(kind, new Date(now - (days + 1) * DAY_MS).toISOString())
  }
  // Принятое сервером. Не принятое (ждёт отправки, отвергнуто) не трогаем никогда:
  // это единственная запись о сделанном
  const before = new Date(now - SENT_KEEP_DAYS * DAY_MS).toISOString()
  q(db, "DELETE FROM outbox WHERE state = 'done' AND createdAt < ?").run(before)
  q(db, 'DELETE FROM stock_moves WHERE synced = 1 AND createdAt < ?').run(before)
  q(db, 'DELETE FROM debt_moves WHERE synced = 1 AND createdAt < ?').run(before)
  setMeta(db, 'docsPrunedAt', String(now))
}

// ── Применить ответ сервера ──
// res: { full, cursor, data: { раздел: { upsert, remove } } }. Возвращает названия
// разделов, которые обновились, — по ним окно перечитает свои списки.
export function applyPull(db, res, { now }) {
  const full = !!res.full
  const data = res.data || {}
  const changed = []
  inTx(db, () => {
    if (data.categories) {
      const p = part(data.categories)
      if (full || touched(p)) {
        applyCategories(db, p, full)
        changed.push('categories')
      }
    }

    // Товары и партии — вместе: остаток товара складывается из его партий
    const products = part(data.products)
    const batches = part(data.batches)
    const stockTouched = (full && !!data.products) || touched(products) || touched(batches)
    if (stockTouched) applyProducts(db, products, batches, full && !!data.products, now)
    // Основа новая (или сервер отверг какую-то операцию) — накладываем поверх всё,
    // что сделано здесь и ещё не принято
    if (stockTouched || getMeta(db, 'needRebuild') === '1') {
      rebuildStock(db)
      recountDebts(db)
      setMeta(db, 'needRebuild', '0')
      changed.push('products')
    }

    if (data.customers) {
      const p = part(data.customers)
      if (full || touched(p)) {
        applyCustomers(db, p, full)
        changed.push('customers')
      }
    }
    if (data.deferred) {
      const p = part(data.deferred)
      if (full || touched(p)) {
        applyDeferred(db, p, full)
        changed.push('deferred')
      }
    }
    for (const [key, kind] of Object.entries(DOC_KEYS)) {
      if (!data[key]) continue
      const p = part(data[key])
      if (!full && !touched(p)) continue
      applyDocs(db, kind, p, full)
      changed.push(key)
    }
    if (data.suppliers) {
      const p = part(data.suppliers)
      if (full || touched(p)) {
        applySuppliers(db, p, full)
        changed.push('suppliers')
      }
    }
    if (data.payServices) {
      const p = part(data.payServices)
      if (full || touched(p)) {
        applyPayServices(db, p, full)
        changed.push('payServices')
      }
    }
    // Статьи расходов сервер отдаёт только владельцу — как и сами расходы
    if (data.expenseCategories) {
      const p = part(data.expenseCategories)
      if (full || touched(p)) {
        applyExpenseCategories(db, p, full)
        changed.push('expenseCategories')
      }
    }

    if (typeof res.cursor === 'string' && res.cursor) {
      setMeta(db, 'cursor', res.cursor)
      // Журнал списаний (а с ним расходы и их статьи) сервер отдаёт только владельцу.
      // Пока за кассой кассир, общая отметка идёт вперёд, а эти разделы стоят на месте —
      // докуда они верны, помним отдельно. С этой отметки владелец и доберёт пропущенное
      if (data.writeoffs) setMeta(db, 'wcursor', res.cursor)
    }
    if (full) {
      // Полный ответ без списаний (за кассой кассир): лежавшие здесь списания
      // устарели целиком — владельцу при входе понадобится свой полный ответ
      if (!data.writeoffs) setMeta(db, 'wcursor', '')
      if (data.products && data.sales) setMeta(db, 'loaded', '1')
    }
    setMeta(db, 'syncedAt', new Date(now).toISOString())
    pruneOld(db, now)
  })
  return [...new Set(changed)]
}

// То же для готовых списков: «вот раздел целиком». Чего не передали — то не трогается.
export function applySnapshot(db, snap, { now }) {
  const data = {}
  for (const [key, value] of Object.entries(snap)) data[key] = { upsert: rows(value), remove: [] }
  return applyPull(db, { full: true, data }, { now })
}

// ── Кто этот сотрудник в базе магазина ──
// Вход знает учётную запись сервиса, а чеки и смены подписаны сотрудником магазина —
// это разные номера. Обычно второй номер сообщает сам сервер при обмене; это запасной
// путь — он виден в любом документе, который человек уже оформил.
export function tenantUserOf(db, login) {
  const kinds = KINDS.filter((k) => k !== 'arrival' && k !== 'payment')
  const row = q(
    db,
    `SELECT json_extract(body, '$.user.id') AS id FROM docs
     WHERE sync = 'synced' AND kind IN (${kinds.map(() => '?').join(', ')}) AND json_extract(body, '$.user.name') = ?
     LIMIT 1`,
  ).get(...kinds, login)
  return typeof row?.id === 'string' && row.id ? row.id : null
}
