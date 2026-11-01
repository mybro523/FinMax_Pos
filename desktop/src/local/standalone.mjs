// ── Магазин без интернета (версия 1.6.0) ──
//
// Обычно касса работает поверх сервера: всё сделанное здесь лежит поправкой, пока сервер его не
// примет, а основу (остатки, долги, суммы смены) присылает он. У магазина без интернета сервера
// нет вовсе: база на компьютере владельца — и есть правда. Поэтому программа сама делает то, что
// сделал бы сервер:
//   • заводит магазин — роли, категории, статьи, сервисы, типы, как сервер при заведении;
//   • принимает каждую операцию сразу после записи (acceptAll): поправка становится основой —
//     остатки, долги и суммы смены переходят в «известное серверу», и пересборка остатка даёт то
//     же самое;
//   • делает то, что сервер делает сам при приёме: оплату прихода из кассы записывает оплатой
//     поставщику, недостачу по пересчёту — списанием;
//   • объединяет одинаковые товары и удаляет покупателя — эти действия раньше умел только сервер.
// Журналы не обрезаются: документы хранятся все (возврат по любому чеку, отчёт за любой период).
import { getMeta, inTx, newId, notFound, bad, q, setMeta } from './db.mjs'
import { CASHIER_DEFAULT } from './accounts.mjs'
import { getDoc, putDoc } from './docs.mjs'
import { ackOp, pendingOps } from './outbox.mjs'
import { D, fromCents, fromCentsD, toCents } from './money.mjs'
import { reorderCategories, reorderProducts } from './snapshot.mjs'
import { costFromBatches } from './stock.mjs'
import { uppOf } from './units.mjs'

// Код магазина без интернета. Файл базы — pharmacy-local.db; на компьютере такой магазин один
export const STANDALONE_CODE = 'local'
export const isStandaloneDb = (db) => getMeta(db, 'standalone') === '1'

// ── Права и роли — как на сервере (server/src/auth/permissions.ts) ──
// Список сверяет проверка (test/local-standalone.test.mjs): разойдётся — она упадёт
export const ALL_PERMISSIONS = [
  'pos.sell', 'pos.discount', 'pos.debt', 'pos.defer', 'returns.view', 'returns.create', 'discounts.view', 'products.view',
  'products.create', 'products.edit', 'products.delete', 'products.history', 'products.labels', 'arrivals.view', 'arrivals.create',
  'arrivals.edit', 'arrivals.debt', 'arrivals.return', 'expiry.view', 'writeoffs.view', 'writeoffs.create', 'inventory.view',
  'inventory.count', 'inventory.apply', 'deferred.view', 'deferred.manage', 'orders.view', 'dashboard.view', 'shift.view',
  'shift.open', 'shift.cash', 'shift.others', 'shift.closeAny', 'debts.view', 'debts.pay', 'customers.create', 'customers.delete',
  'suppliers.view', 'suppliers.edit', 'suppliers.pay', 'suppliers.delete', 'expenses.view', 'expenses.create', 'expenses.edit',
  'incomes.view', 'incomes.create', 'incomes.edit', 'reports.view', 'reports.export', 'settings.categories',
  'settings.expenseCategories', 'settings.incomeCategories', 'settings.payServices', 'settings.print', 'settings.devices',
  'settings.backup', 'profile.password',
]
export const SYSTEM_CASHIER = { name: 'Кассир', description: 'Приём оплаты и кассовые операции' }
export const OWNER_ROLE = { name: 'Владелец', description: 'Все права. Роль нельзя изменить или удалить' }
export const ROLE_PRESETS = [
  {
    name: 'Заведующий',
    description: 'Склад, финансы и настройки магазина, кроме резервной копии и устройств',
    permissions: ALL_PERMISSIONS.filter((k) => k !== 'settings.backup' && k !== 'settings.devices'),
  },
  {
    name: 'Наблюдатель',
    description: 'Только просмотр: панель, журналы и отчёты без права что-либо менять',
    permissions: ALL_PERMISSIONS.filter((k) => k.endsWith('.view') || k === 'shift.others' || k === 'profile.password'),
  },
]

// ── Стартовые справочники — как у нового магазина на сервере ──
// (categories.service STARTING и строки, которые заводят миграции схемы магазина)
export const SEED = {
  categories: [
    { name: 'Продукты' }, { name: 'Напитки' }, { name: 'Бытовая химия' }, { name: 'Косметика' },
    { name: 'Хозтовары', noExpiry: true }, { name: 'Канцтовары', noExpiry: true }, { name: 'Прочее', noExpiry: true },
  ],
  expenseCategories: [
    ['expcat-arenda', 'Аренда'], ['expcat-zarplata', 'Зарплата'], ['expcat-kommunalnye', 'Коммунальные услуги'],
    ['expcat-nalogi', 'Налоги'], ['expcat-transport', 'Транспорт'], ['expcat-reklama', 'Реклама'],
    ['expcat-hoz', 'Хозяйственные нужды'], ['expcat-drugoe', 'Другое'], ['opu_magazin', 'Расход магазина'],
  ],
  incomeCategories: [['inccat-arenda', 'Аренда'], ['inccat-uslugi', 'Услуги'], ['inccat-bonus', 'Бонус от поставщика'], ['inccat-prochie', 'Прочие доходы']],
  payServices: [['paysvc-alif', 'Alif', 1], ['paysvc-dc', 'DC', 2], ['paysvc-eskhata', 'Эсхата', 3], ['paysvc-humo', 'Humo', 4], ['paysvc-amonat', 'Амонат', 5]],
  productTypes: [
    ['pt_med', 'Медицинский', 1], ['pt_produkty', 'Продукты', 0], ['pt_himiya', 'Бытовая химия', 0], ['pt_kosmetika', 'Косметика', 0],
    ['pt_hoz', 'Хозтовары', 0], ['pt_elektronika', 'Электроника', 0], ['pt_prochee', 'Прочее', 0],
  ],
}

const iso = (now) => new Date(now).toISOString()

// ── Завести магазин ──
// База магазина пустая (только что создана). Владелец — учётная запись (ownerId) и сотрудник
// магазина (ownerUserId), как у сервера: учётной записью входят, сотрудником подписаны документы
export function setupShopDb(db, { shopName, ownerId, ownerUserId, login, now }) {
  return inTx(db, () => {
    const at = iso(now)
    if (q(db, 'SELECT 1 FROM team_accounts LIMIT 1').get()) throw bad('Магазин на этом компьютере уже заведён')
    SEED.categories.forEach((c, n) => q(db, 'INSERT OR IGNORE INTO categories (id, ord, name, noExpiry, createdAt) VALUES (?, ?, ?, ?, ?)').run(newId(), n, c.name, c.noExpiry ? 1 : 0, at))
    reorderCategories(db)
    for (const [id, name] of SEED.expenseCategories) q(db, 'INSERT OR IGNORE INTO expense_categories (id, name, createdAt) VALUES (?, ?, ?)').run(id, name, at)
    for (const [id, name] of SEED.incomeCategories) q(db, 'INSERT OR IGNORE INTO income_categories (id, name, createdAt) VALUES (?, ?, ?)').run(id, name, at)
    for (const [id, name, ord] of SEED.payServices) q(db, 'INSERT OR IGNORE INTO pay_services (id, name, ord, createdAt) VALUES (?, ?, ?, ?)').run(id, name, ord, at)
    for (const [id, name, analogs] of SEED.productTypes) q(db, 'INSERT OR IGNORE INTO product_types (id, name, analogs, createdAt) VALUES (?, ?, ?, ?)').run(id, name, analogs, at)
    // Роли — как их отдаёт сервер (sync/team.ts): «Владелец» первой строкой, системная роль
    // кассира и две заготовки (roles.service, ensure)
    const role = q(db, 'INSERT INTO team_roles (id, name, description, system, permissions, createdAt, ord) VALUES (?, ?, ?, ?, ?, ?, ?)')
    role.run('owner', OWNER_ROLE.name, OWNER_ROLE.description, 'owner', JSON.stringify(ALL_PERMISSIONS), at, 0)
    role.run(newId(), SYSTEM_CASHIER.name, SYSTEM_CASHIER.description, 'cashier', JSON.stringify(CASHIER_DEFAULT), at, 0)
    ROLE_PRESETS.forEach((p, n) => role.run(newId(), p.name, p.description, null, JSON.stringify(p.permissions), at, n + 1))
    // Владелец
    q(db, 'INSERT INTO team_accounts (id, login, role, roleId, roleName, active, userId, createdAt, ord) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, 0)').run(ownerId, login, 'founder', 'Владелец', ownerUserId, at)
    q(db, 'INSERT INTO staff (id, name, fullName, role, active, salaryC, bonusBp, salaryDay, createdAt) VALUES (?, ?, ?, ?, 1, 0, 0, 1, ?)').run(ownerUserId, login, '', 'founder', at)
    setMeta(db, 'standalone', '1')
    setMeta(db, 'shopName', String(shopName))
    // Всё «загружено»: отвечать есть чем с первой минуты
    for (const key of ['loaded', 'teamLoaded', 'staffLoaded']) setMeta(db, key, '1')
    setMeta(db, 'teamAt', at)
    setMeta(db, 'syncedAt', at)
    setMeta(db, 'tenantUser:' + login, ownerUserId)
  })
}

// ── Принять операции вместо сервера ──
// Всё, что ждёт отправки, — принято: поправки становятся основой. Вызывается сразу после
// каждой записи. Возвращает принятые операции
export function acceptAll(db, { now }) {
  const done = []
  inTx(db, () => {
    // Долг поставщика, заведённого кассиром (ему деньги магазина не видны), сервер всё равно
    // знает: без основы поправки долга этого поставщика просто не легли бы
    q(db, 'UPDATE suppliers SET openingDebtC = COALESCE(openingDebtC, 0), sDebtC = COALESCE(sDebtC, openingDebtC, 0), debtArrivals = COALESCE(debtArrivals, 0)').run()
    for (;;) {
      const ops = pendingOps(db, 500)
      if (!ops.length) break
      for (const op of ops) {
        serverExtras(db, op, now)
        ackOp(db, op, { status: 'ok' })
        done.push(op)
      }
    }
    if (done.length) foldBase(db)
  })
  return done
}

// Остаток, закупочная цена, срок и долг — «как знает сервер»: свои движения уже приняты.
// Пересборка остатка (stock.mjs) после этого даёт ровно то, что сейчас на полке
export function foldBase(db) {
  q(db, 'UPDATE batches SET sUnits = units').run()
  q(db, 'UPDATE products SET sCostC = costC, sExpiry = expiryDate, oversold = 0').run()
  q(db, 'UPDATE customers SET sDebtC = debtC, local = 0').run()
  q(db, 'UPDATE stock_moves SET synced = 1 WHERE synced = 0').run()
  q(db, 'UPDATE debt_moves SET synced = 1 WHERE synced = 0').run()
  // Сколько долговых приходов у поставщика — сервер считает по своим приходам
  q(
    db,
    `UPDATE suppliers SET debtArrivals = (
       SELECT COUNT(*) FROM docs WHERE kind = 'arrival' AND sync NOT IN ('rejected', 'deleted')
         AND json_extract(body, '$.supplierId') = suppliers.id AND CAST(json_extract(body, '$.debt') AS REAL) > 0)`,
  ).run()
  setMeta(db, 'needRebuild', '0')
}

// ── Что сервер делает сам при приёме операции ──
function serverExtras(db, op, now) {
  const p = op.payload || {}
  // Приход, оплаченный из ящика кассы: сервер записывает оплату поставщику (sync.service,
  // applyArrival). В смене эти деньги уже учтены (edits.mjs, docKnown) — здесь только запись
  if (op.type === 'arrival') {
    const a = p.arrival || {}
    if (Number(a.paidCash) > 0 && a.supplierId && !q(db, "SELECT 1 FROM docs WHERE kind = 'supplierpayment' AND clientId = ?").get(op.id + ':pay')) {
      const sup = q(db, 'SELECT id, name FROM suppliers WHERE id = ?').get(a.supplierId)
      const date = a.date || iso(now)
      putDoc(
        db,
        'supplierpayment',
        {
          id: newId(),
          clientId: op.id + ':pay',
          supplierId: a.supplierId,
          amount: fromCents(toCents(D(a.paidCash))),
          date,
          note: 'Оплата прихода',
          fromCash: true,
          shiftId: a.shiftId ?? null,
          userId: a.userId ?? a.user?.id ?? null,
          createdAt: date,
          user: a.user ?? null,
          supplier: { id: a.supplierId, name: sup?.name || a.supplier || '' },
        },
        { sync: 'synced' },
      )
    }
  }
  // Пересчёт применён: недостача — списанием с причиной «недостача» (inventory.service,
  // applyInventoryIn). Сколько не хватило — по движениям пересчёта этой операции
  if (op.type === 'inventory.apply') {
    const short = q(db, "SELECT * FROM stock_moves WHERE opId = ? AND kind = 'count' AND units < 0 ORDER BY seq").all(op.id)
    if (!short.length) return
    const sheet = getDoc(db, 'inventory', p.id)?.body
    const user = op.accountId ? q(db, 'SELECT userId, login FROM team_accounts WHERE id = ?').get(op.accountId) : null
    const id = newId()
    let total = D(0)
    const items = []
    for (const m of short) {
      const prod = q(db, 'SELECT * FROM products WHERE id = ?').get(m.productId)
      if (!prod) continue
      const costC = Number.isInteger(m.costC) ? m.costC : prod.costC
      const units = -m.units
      total = total.plus(fromCentsD(costC).dividedBy(uppOf(prod)).times(units))
      items.push({ id: newId(), writeOffId: id, productId: prod.id, name: prod.name, units, cost: fromCents(costC), expiryDate: m.expiryDate ?? null })
    }
    if (!items.length) return
    const date = typeof p.at === 'string' ? p.at : iso(now)
    putDoc(
      db,
      'writeoff',
      {
        id,
        date,
        userId: user?.userId ?? sheet?.userId ?? null,
        reason: 'lost',
        note: 'Недостача по итогам пересчёта',
        totalCost: fromCents(toCents(total)),
        source: 'inventory',
        items,
        user: user ? { id: user.userId, name: user.login } : sheet?.user ?? null,
      },
      { sync: 'synced' },
    )
  }
}

// ── Объединить одинаковые товары (как products.service, merge) ──
// Лишняя карточка уходит, её партии и строки документов переходят к основной
export const MERGE_TEXT = {
  same: 'Выберите две разные карточки',
  notFound: 'Товар не найден',
  upp: (a, b) => `Штук в упаковке у карточек разное (${a} и ${b}) — сначала поправьте карточку`,
}
const DOC_ITEM_KINDS = ['sale', 'return', 'arrival', 'writeoff', 'supplierreturn', 'inventory']
export function mergeProducts(db, fromId, intoId, { now }) {
  if (!fromId || !intoId || fromId === intoId) throw bad(MERGE_TEXT.same)
  return inTx(db, () => {
    const from = q(db, 'SELECT * FROM products WHERE id = ?').get(fromId)
    const into = q(db, 'SELECT * FROM products WHERE id = ?').get(intoId)
    if (!from || !into) throw notFound(MERGE_TEXT.notFound)
    if (uppOf(from) !== uppOf(into)) throw bad(MERGE_TEXT.upp(uppOf(from), uppOf(into)))
    q(db, 'UPDATE batches SET productId = ? WHERE productId = ?').run(intoId, fromId)
    q(db, 'UPDATE stock_moves SET productId = ? WHERE productId = ?').run(intoId, fromId)
    // Строки документов — номер товара в теле документа
    const like = '%' + fromId + '%'
    for (const kind of DOC_ITEM_KINDS) {
      for (const row of q(db, 'SELECT id, body FROM docs WHERE kind = ? AND body LIKE ?').all(kind, like)) {
        const body = JSON.parse(row.body)
        let touched = false
        for (const it of Array.isArray(body.items) ? body.items : []) {
          if (it && it.productId === fromId) {
            it.productId = intoId
            touched = true
          }
        }
        if (touched) q(db, 'UPDATE docs SET body = ? WHERE kind = ? AND id = ?').run(JSON.stringify(body), kind, row.id)
      }
    }
    // Аналоги: кто ссылался на лишнюю — ссылается на основную; аналоги лишней — к основной
    const parseIds = (s) => {
      try {
        const v = JSON.parse(s || '[]')
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
      } catch {
        return []
      }
    }
    for (const r of q(db, 'SELECT id, analogIds FROM products WHERE analogIds LIKE ?').all(like)) {
      if (r.id === intoId || r.id === fromId) continue
      const next = [...new Set(parseIds(r.analogIds).map((x) => (x === fromId ? intoId : x)))].filter((x) => x !== r.id)
      q(db, 'UPDATE products SET analogIds = ? WHERE id = ?').run(JSON.stringify(next), r.id)
    }
    const own = [...new Set([...parseIds(into.analogIds), ...parseIds(from.analogIds)])].filter((x) => x !== intoId && x !== fromId)
    q(db, 'UPDATE products SET analogIds = ? WHERE id = ?').run(JSON.stringify(own), intoId)
    q(db, 'DELETE FROM products WHERE id = ?').run(fromId)
    // Закупочная цена основной — по партиям обеих; ближайший срок — по полке
    costFromBatches(db, q(db, 'SELECT * FROM products WHERE id = ?').get(intoId))
    q(db, 'UPDATE products SET expiryDate = (SELECT MIN(expiryDate) FROM batches WHERE productId = ? AND units > 0 AND expiryDate IS NOT NULL) WHERE id = ?').run(intoId, intoId)
    foldBase(db)
    reorderProducts(db)
    setMeta(db, 'mergedAt', iso(now))
    return q(db, 'SELECT * FROM products WHERE id = ?').get(intoId)
  })
}

// ── Удалить покупателя (как customers.service, remove) ──
// Уходят он сам и история погашений его долга; чеки остаются (имя в них записано снимком)
export function deleteCustomer(db, id) {
  return inTx(db, () => {
    if (!q(db, 'SELECT 1 FROM customers WHERE id = ?').get(id)) throw notFound('Клиент не найден')
    q(db, 'DELETE FROM customers WHERE id = ?').run(id)
    q(db, 'DELETE FROM debt_moves WHERE customerId = ?').run(id)
    q(db, "DELETE FROM docs WHERE kind = 'payment' AND json_extract(body, '$.customerId') = ?").run(id)
    return { ok: true }
  })
}

// ── Уборка: принятое давно больше не нужно ──
// Документы не трогаем никогда — их и смотрят. Уходят только служебные журналы приёма
const KEEP_DAYS = 45
export function pruneAccepted(db, now) {
  const last = Number(getMeta(db, 'acceptPrunedAt') || 0)
  if (now - last < 86400000) return
  const before = iso(now - KEEP_DAYS * 86400000)
  q(db, "DELETE FROM outbox WHERE state = 'done' AND createdAt < ?").run(before)
  // Правки остатка (kind 'count': остаток в карточке, пересчёт) — не служебная запись: из них
  // история товара берёт строки «правка» (history.mjs), а других следов у них нет. Их немного
  q(db, "DELETE FROM stock_moves WHERE synced = 1 AND createdAt < ? AND kind <> 'count'").run(before)
  q(db, 'DELETE FROM debt_moves WHERE synced = 1 AND createdAt < ?').run(before)
  q(db, 'DELETE FROM row_edits WHERE synced = 1 AND createdAt < ?').run(before)
  q(db, 'DELETE FROM adj_moves WHERE synced = 1 AND createdAt < ?').run(before)
  setMeta(db, 'acceptPrunedAt', String(now))
}
