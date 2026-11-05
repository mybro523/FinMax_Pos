// ── Магазин без интернета: кассы по сети (версия 1.7.0) ──
//
// Сервера у магазина нет. Его роль берёт главный компьютер — тот, где владелец ввёл код
// активации и завёл магазин. Кассы подключаются к нему по сети и обмениваются только с ним
// (звезда): так у всех один порядок приёма операций и одна основа остатков.
//
// Главный:
//   • свою операцию принимает сразу (standalone.mjs, acceptAll) — как в 1.6.0;
//   • операцию кассы — как только она пришла по сети (lan.mjs кладёт её поправкой): здесь она
//     становится принятой (то, что сервер заводит сам, — оплата прихода из кассы, списание
//     недостачи по пересчёту — заводится тоже), и основа остатков и долгов догоняет её (foldBase);
//   • после каждого приёма пишет в журнал обмена ОСНОВУ (запись kind 'base'): какие операции
//     приняты (по порядку) и чем после них стали основа затронутых товаров (с партиями),
//     покупателей и поставщиков, плюс документы, заведённые «сервером», и тела смен с суммами.
//
// Касса:
//   • свою операцию держит поправкой (как неотправленную), пока основа от главного не назовёт её;
//   • чужую (главного или другой кассы — главный пересылает их всем) кладёт поправкой (lan.mjs);
//   • получив основу: названные в ней операции подтверждает (свою — как принятую сервером,
//     outbox.ackOp; чужую — lan.mjs, confirmOp), основу затронутых строк берёт у главного и
//     пересобирает остаток и долги поверх своих ещё не принятых операций.
// Основа приходит в том же потоке, что и операции, и после них: подтверждать есть что.
//
// Подключение кассы: главный отдаёт ей свою базу целиком (shopSnapshot) — без своих служебных
// журналов и ключей; касса кладёт её у себя (regInstallDb) и дальше получает журнал главного с
// той записи, на которой база снята.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { getMeta, inTx, q, setMeta } from './db.mjs'
import { putDoc } from './docs.mjs'
import { ackOp, docsOf, rejectOp, touchedBy } from './outbox.mjs'
import { ackEdits, ADJ, docKnown, EDIT_COLS, EDITABLE_DOC_KINDS, replayEdits } from './edits.mjs'
import { confirmOp, undoPeerOp, WIDE_KINDS } from './lan.mjs'
import { rebuildStock } from './stock.mjs'
import { DOC_KEYS, recountDebts, reorderCategories, reorderProducts } from './snapshot.mjs'
import { foldBase, serverExtras } from './standalone.mjs'
import { SHEET_TBL } from './sheet.mjs'

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const iso = (now) => new Date(now).toISOString()
// Вид документа → раздел окна
const KIND_KEY = Object.fromEntries(Object.entries(DOC_KEYS).map(([key, kind]) => [kind, key]))

// Номер последней основы: у главного — выданной, у кассы — положенной
export const soloAcc = (db) => Number(getMeta(db, 'soloAcc') || 0)

// ── Принятое главным ──
// Номера операций, которые главный уже принял (свои и касс), — на 400 дней: касса, подключаясь
// заново, несёт всё, что у неё есть (и ждущее любой давности), и принятое второй раз не ложится
export function markSeen(db, ids, now) {
  const put = q(db, 'INSERT OR IGNORE INTO solo_seen (id, at) VALUES (?, ?)')
  const at = iso(now)
  for (const id of ids) if (typeof id === 'string' && id) put.run(id, at)
}
export const seenHas = (db, id) => !!q(db, 'SELECT 1 FROM solo_seen WHERE id = ?').get(id)
export function pruneSeen(db, now, days = 400) {
  q(db, 'DELETE FROM solo_seen WHERE at < ?').run(iso(now - days * 86400000))
}

// ── Кассы главного компьютера ──
// [{ deviceId, name, host, pairedAt }] — по порядку подключения: по коду активации работают первые
export function soloPairedList(db) {
  try {
    const v = JSON.parse(getMeta(db, 'soloPaired') || '[]')
    return Array.isArray(v) ? v.filter((r) => r && typeof r.deviceId === 'string' && r.deviceId) : []
  } catch {
    return []
  }
}
export const setSoloPaired = (db, list) => setMeta(db, 'soloPaired', JSON.stringify(list))
// Имя новой кассы: «Касса 2», «Касса 3»… (главный — первая касса магазина)
export function nextRegisterName(list) {
  const used = new Set(list.map((r) => r.name))
  for (let n = 2; ; n++) if (!used.has('Касса ' + n)) return 'Касса ' + n
}

// ── Пароль сотрудника по сети ──
// Отпечаток пароля (scrypt) уходит главному и кассам зашифрованным ключом магазина: в журнале
// обмена и в копиях базы его не прочитать без ключа, а ключ хранится зашифрованным средствами Windows
const pwKey = (lanKey) => Buffer.from(hkdfSync('sha256', Buffer.from(String(lanKey), 'base64url'), Buffer.from('finmax-solo'), Buffer.from('pw-v1'), 32))
export function pwToLan(lanKey, verifier) {
  if (!lanKey || typeof verifier !== 'string' || !verifier) return null
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', pwKey(lanKey), iv)
  const data = Buffer.concat([c.update(verifier, 'utf8'), c.final()])
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url')
}
export function pwFromLan(lanKey, blob) {
  if (!lanKey || typeof blob !== 'string' || !blob.startsWith('v1.')) return null
  try {
    const buf = Buffer.from(blob.slice(3), 'base64url')
    if (buf.length < 29) return null
    const d = createDecipheriv('aes-256-gcm', pwKey(lanKey), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

// ── Расхождения (главный) ──
// Касса продала без главного то, чего на складе уже не было (продали на другой кассе): операция
// принята как есть — товар отдан, а владелец видит расхождение. Список — в базе главного
const DISC_KEEP = 500
export function soloDiscrepancies(db) {
  try {
    const v = JSON.parse(getMeta(db, 'soloDisc') || '[]')
    return Array.isArray(v) ? v.filter((d) => d && typeof d.id === 'string') : []
  } catch {
    return []
  }
}
export function addDiscrepancies(db, list) {
  if (!list.length) return
  setMeta(db, 'soloDisc', JSON.stringify([...soloDiscrepancies(db), ...list].slice(-DISC_KEEP)))
}
export function resolveDiscrepancy(db, id) {
  const all = soloDiscrepancies(db)
  const next = all.filter((d) => d.id !== id)
  if (next.length === all.length) return false
  setMeta(db, 'soloDisc', JSON.stringify(next))
  return true
}
// Вид расхождения — по операции, которая увела остаток в минус (слова — в окне, lib/discrepancy.js)
export const shortKind = (type) => (type === 'writeoff' ? 'writeoff' : type === 'supplier.return' || type === 'supplierreturn' ? 'supreturn' : 'sale')

// ── Главный: операции касс → в принятые ──
// Все чужие операции, лежащие поправкой (пришли по сети), по порядку прихода. Каждая — своей
// точкой отката: операцию, которую принять не вышло (повреждена, от другой версии программы),
// главный снимает, а остальные принимает — одна плохая операция не останавливает приём со всех
// касс. Не принятые касса отменит у себя (основа называет их в rejected), владелец увидит их на
// панели. Ответ — принятые операции, документы, которые завёл «сервер», пароли сотрудников,
// заданные на кассах (pw), что ушло в минус (short: продано больше, чем было на складе) и что не
// принято (rejected)
export function mainAcceptPeers(db, { now }) {
  const ops = []
  const extras = []
  const pw = []
  const short = []
  const rejected = []
  inTx(db, () => {
    const rows = q(db, "SELECT * FROM lan_log WHERE kind = 'op' AND state = 'applied' ORDER BY seq").all()
    if (!rows.length) return
    // Долг поставщика, заведённого на кассе тем, кому деньги магазина не видны, «сервер» всё равно
    // ведёт: без основы его поправки долга просто не легли бы (как acceptAll, standalone.mjs)
    q(db, 'UPDATE suppliers SET openingDebtC = COALESCE(openingDebtC, 0), sDebtC = COALESCE(sDebtC, openingDebtC, 0), debtArrivals = COALESCE(debtArrivals, 0)').run()
    const taker = new Map()
    for (const r of rows) {
      const fx = parse(r.body)?.effects || {}
      const made = []
      try {
        inTx(db, () => {
          serverExtras(db, peerAsOp(r, fx), now, made)
          acceptPeer(db, r, fx)
        })
      } catch (e) {
        rejected.push({ id: r.id, type: r.type, origin: r.origin, accountId: r.accountId ?? null, createdAt: r.createdAt, error: String(e?.message || e).slice(0, 200) })
        continue
      }
      extras.push(...made)
      ops.push({
        id: r.id,
        type: r.type,
        accountId: r.accountId ?? null,
        origin: r.origin,
        createdAt: r.createdAt,
        docs: (fx.docs || []).filter((d) => d && typeof d.kind === 'string' && d.body && typeof d.body === 'object'),
        // Что главный поправил в операции при приёме (gateway withTrim): расхождения, строки для касс
        trim: parse(r.body)?.trim || null,
      })
      for (const e of fx.edits?.rows || []) {
        if (e?.tbl === 'team_accounts' && typeof e.rowId === 'string' && typeof e.data?.pwLan === 'string') pw.push({ id: e.rowId, pwLan: e.data.pwLan, accountId: r.accountId ?? null })
      }
      for (const m of fx.moves || []) {
        if (m && typeof m.productId === 'string' && Number(m.units) < 0) taker.set(m.productId, r)
      }
    }
    // Не принятые — назад: их поправки снимаются, остаток и долги — заново без них
    if (rejected.length) {
      for (const x of rejected) undoPeerOp(db, x.id, 'rejected')
      rebuildStock(db)
      recountDebts(db)
    }
    // Остаток в минусе — от операций касс, легших поправкой (свои операции главного в минус не уводят)
    for (const p of q(db, 'SELECT id, name, oversold FROM products WHERE oversold > 0').all()) {
      const r = taker.get(p.id)
      if (r) short.push({ productId: p.id, name: p.name || '', units: p.oversold, opId: r.id, type: r.type, origin: r.origin, accountId: r.accountId ?? null, createdAt: r.createdAt })
    }
    foldBase(db)
  })
  return { ops, extras, pw, short, rejected }
}

// Чужая операция глазами «сервера»: то, что ему нужно для своих записей, — из её документов
function peerAsOp(r, fx) {
  const payload = {}
  if (r.type === 'arrival') {
    const doc = (fx.docs || []).find((d) => d?.kind === 'arrival')
    if (doc?.body) payload.arrival = doc.body
  }
  if (r.type === 'inventory.apply') {
    const sheet = (fx.edits?.rows || []).find((e) => e?.tbl === SHEET_TBL)
    if (sheet && typeof sheet.rowId === 'string') {
      payload.id = sheet.rowId
      payload.at = r.createdAt
    }
  }
  return { id: r.id, type: r.type, accountId: r.accountId, payload }
}

// Как своя принятая операция (outbox.ackOp): документы — в известные «серверу», их суммы и
// поправки — в основу (её свернёт foldBase)
function acceptPeer(db, r, fx) {
  const docs = q(db, 'SELECT kind, id FROM lan_docs WHERE opId = ?').all(r.id)
  q(db, 'DELETE FROM lan_docs WHERE opId = ?').run(r.id)
  for (const d of docs) {
    if (EDITABLE_DOC_KINDS.has(d.kind)) {
      const created = (fx.docs || []).find((x) => x?.kind === d.kind && x?.body?.id === d.id)?.body || null
      docKnown(db, d.kind, d.id, { fold: true, created })
    }
    q(db, "UPDATE docs SET sync = 'synced' WHERE kind = ? AND id = ? AND sync = 'peer'").run(d.kind, d.id)
  }
  if (fx.customer?.id) q(db, 'UPDATE customers SET local = 0 WHERE id = ? AND local = 2').run(fx.customer.id)
  if (fx.deferred?.id) q(db, "UPDATE deferred SET sync = 'synced' WHERE id = ? AND sync = 'peer'").run(fx.deferred.id)
  if (typeof fx.deferredRemove === 'string') q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'deleted'").run(fx.deferredRemove)
  ackEdits(db, r.id, { fold: true })
  q(db, "UPDATE lan_log SET state = 'confirmed' WHERE id = ?").run(r.id)
}

// Документы своей операции главного (для основы): какие она завела, из очереди
export function ownOpDocs(db, op) {
  const out = []
  for (const [kind, id] of docsOf(op)) {
    if (!id) continue
    const row = q(db, 'SELECT body FROM docs WHERE kind = ? AND id = ?').get(kind, id)
    if (row) out.push({ kind, body: parse(row.body) })
  }
  return out
}

// ── Главный: основа после приёма → в журнал ──
// ops — [{ id, docs: [{ kind, body }] }] по порядку приёма; extras — документы «сервера»;
// logins — учётные записи сотрудников для касс (их пароли — local/solonet: см. gateway)
// gone — что главный убрал сам, не операцией (удалённые покупатели); lic — новый код активации;
// logo — логотип магазина ({ logo, at }: его ставят на главном, «Настройки» → «Чек и печать»);
// rejected — операции касс, которые главный не принял ([{ id, error }]); rows — строки
// справочников и документы, которые правили эти операции, целиком: правки одной строки на главном
// и на кассе сходятся у всех одинаково (касса кладёт строку главного и проигрывает поверх свои
// неотправленные правки). Партии — только непустые: основа не растёт с историей магазина.
// Затронуто много товаров (пересчёт всего склада) — основа идёт несколькими записями по BASE_CHUNK
// товаров: большая запись застряла бы в сети. Операции названы в последней из них
const BASE_ROW_TABLES = ['products', 'categories', 'product_types', 'pay_services', 'expense_categories', 'income_categories', 'suppliers']
const BASE_CHUNK = 800
// Сколько строк справочников целиком — в одной основе: с фото товаров они тяжёлые. Сверх того
// правки ложатся у касс как есть (поправками из операций)
const BASE_ROWS_BYTES = 2_000_000
const ROW_KEY = {
  products: 'products', categories: 'categories', product_types: 'productTypes', pay_services: 'payServices',
  expense_categories: 'expenseCategories', income_categories: 'incomeCategories', suppliers: 'suppliers',
}
// touch — строки и документы, которые касса должна взять у главного целиком, хоть их и не правили
// принятые операции: их правила операция кассы, которую главный не принял (касса откатит её к
// прежнему виду, а нынешний — главного)
export function mainLogBase(db, { ops = [], extras = [], logins = [], gone = null, lic = null, logo = null, rejected = [], rows: withRows = false, touch = [], deviceId, now }) {
  const goneCustomers = Array.isArray(gone?.customers) ? gone.customers.filter((x) => typeof x === 'string') : []
  const withLogo = !!logo && typeof logo === 'object' && typeof logo.logo === 'string'
  const rejectedList = (Array.isArray(rejected) ? rejected : []).filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, error: String(x.error || '').slice(0, 200) }))
  if (!ops.length && !extras.length && !logins.length && !goneCustomers.length && !lic && !withLogo && !rejectedList.length) return null
  return inTx(db, () => {
    const ids = ops.map((o) => o.id)
    const products = new Set()
    const customers = new Set()
    const suppliers = new Set()
    const shifts = new Set()
    const edited = new Map()
    const editedDocs = new Map()
    for (const t of Array.isArray(touch) ? touch : []) {
      if (typeof t?.tbl !== 'string' || typeof t.rowId !== 'string' || !t.rowId) continue
      if (BASE_ROW_TABLES.includes(t.tbl)) {
        if (!edited.has(t.tbl)) edited.set(t.tbl, new Set())
        edited.get(t.tbl).add(t.rowId)
        if (t.tbl === 'products') products.add(t.rowId)
        if (t.tbl === 'suppliers') suppliers.add(t.rowId)
      } else if (t.tbl.startsWith('doc:') && t.tbl !== SHEET_TBL) {
        const kind = t.tbl.slice(4)
        if (!editedDocs.has(kind)) editedDocs.set(kind, new Set())
        editedDocs.get(kind).add(t.rowId)
      }
    }
    if (ids.length) {
      const list = ids.map(() => '?').join(', ')
      for (const r of q(db, `SELECT DISTINCT productId FROM stock_moves WHERE opId IN (${list})`).all(...ids)) products.add(r.productId)
      for (const r of q(db, `SELECT DISTINCT customerId FROM debt_moves WHERE opId IN (${list})`).all(...ids)) customers.add(r.customerId)
      for (const r of q(db, `SELECT target, rowId FROM adj_moves WHERE opId IN (${list})`).all(...ids)) {
        if (r.target === ADJ.supplierDebt) suppliers.add(r.rowId)
        else shifts.add(r.rowId)
      }
      for (const r of q(db, `SELECT DISTINCT tbl, rowId FROM row_edits WHERE opId IN (${list})`).all(...ids)) {
        if (r.tbl === 'products') products.add(r.rowId)
        else if (r.tbl === 'suppliers') suppliers.add(r.rowId)
        else if (r.tbl === 'customers') customers.add(r.rowId)
        if (!withRows || typeof r.rowId !== 'string') continue
        if (BASE_ROW_TABLES.includes(r.tbl)) {
          if (!edited.has(r.tbl)) edited.set(r.tbl, new Set())
          edited.get(r.tbl).add(r.rowId)
        } else if (typeof r.tbl === 'string' && r.tbl.startsWith('doc:') && r.tbl !== SHEET_TBL) {
          const kind = r.tbl.slice(4)
          if (!editedDocs.has(kind)) editedDocs.set(kind, new Set())
          editedDocs.get(kind).add(r.rowId)
        }
      }
    }
    // Суммы документов уходят в основу без своих поправок (edits.mjs, docKnown): поставщик и
    // смена документа тоже затронуты
    for (const d of [...ops.flatMap((o) => o.docs || []), ...extras]) {
      const b = d.body || {}
      if (typeof b.supplierId === 'string') suppliers.add(b.supplierId)
      if (typeof b.shiftId === 'string') shifts.add(b.shiftId)
      if (typeof b.customerId === 'string') customers.add(b.customerId)
    }
    const rowsOf = (sql, values) => {
      const v = [...values].filter((x) => typeof x === 'string')
      return v.length ? q(db, sql.replace('?*', v.map(() => '?').join(', '))).all(...v) : []
    }
    // Строки справочников целиком
    const rowsOut = {}
    const drop = {}
    let rowBytes = 0
    for (const [tbl, set] of edited) {
      const cols = ['id', ...EDIT_COLS[tbl]]
      for (const id of set) {
        const row = q(db, `SELECT ${cols.join(', ')} FROM ${tbl} WHERE id = ?`).get(id)
        if (!row) {
          ;(drop[tbl] ||= []).push(id)
          continue
        }
        const size = JSON.stringify(row).length
        if (rowBytes + size > BASE_ROWS_BYTES) continue
        rowBytes += size
        ;(rowsOut[tbl] ||= []).push(row)
      }
    }
    const docsOut = [
      ...extras.map((d) => ({ kind: d.kind, body: d.body, deviceId: null })),
      ...rowsOf("SELECT body, deviceId FROM docs WHERE kind = 'shift' AND id IN (?*)", shifts).map((r) => ({ kind: 'shift', body: parse(r.body), deviceId: r.deviceId ?? null })),
    ]
    const goneDocs = []
    for (const [kind, set] of editedDocs) {
      for (const id of set) {
        const d = q(db, 'SELECT body, deviceId, sync FROM docs WHERE kind = ? AND id = ?').get(kind, id)
        if (!d || d.sync === 'deleted' || d.sync === 'rejected') goneDocs.push({ kind, id })
        else docsOut.push({ kind, body: parse(d.body), deviceId: d.deviceId ?? null })
      }
    }
    const prodIds = [...products].filter((x) => typeof x === 'string')
    const parts = []
    for (let i = 0; i < prodIds.length; i += BASE_CHUNK) parts.push(prodIds.slice(i, i + BASE_CHUNK))
    if (!parts.length) parts.push([])
    const insert = q(
      db,
      `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
       VALUES (?, 'base', ?, NULL, '', NULL, ?, ?, ?, 0, 'own')`,
    )
    let acc = soloAcc(db)
    parts.forEach((part, n) => {
      acc += 1
      const last = n === parts.length - 1
      const stock = {
        products: rowsOf('SELECT id, sCostC, sExpiry FROM products WHERE id IN (?*)', part),
        batches: rowsOf('SELECT id, productId, sUnits, costC, expiryDate, arrivalId, note, createdAt FROM batches WHERE productId IN (?*) AND sUnits > 0', part),
      }
      const body = !last
        ? { acc, ops: [], ...stock }
        : {
            acc,
            ops: ids,
            ...stock,
            customers: rowsOf('SELECT id, sDebtC FROM customers WHERE id IN (?*)', customers),
            suppliers: rowsOf('SELECT id, sDebtC, debtArrivals, openingDebtC FROM suppliers WHERE id IN (?*)', suppliers),
            docs: docsOut,
            logins,
            ...(rejectedList.length ? { rejected: rejectedList } : {}),
            ...(Object.keys(rowsOut).length ? { rows: rowsOut } : {}),
            ...(Object.keys(drop).length ? { drop } : {}),
            ...(goneCustomers.length || goneDocs.length ? { gone: { customers: goneCustomers, docs: goneDocs } } : {}),
            ...(typeof lic === 'string' && lic ? { lic } : {}),
            ...(withLogo ? { logo: { logo: logo.logo, at: typeof logo.at === 'string' ? logo.at : null } } : {}),
          }
      const wide = (body.suppliers || []).length > 0 || (body.docs || []).some((d) => WIDE_KINDS.has(d.kind)) ? 1 : 0
      insert.run('base:' + acc, deviceId, iso(now), JSON.stringify(body), wide)
    })
    setMeta(db, 'soloAcc', String(acc))
    return acc
  })
}

// ── Касса: основа от главного ──
// Ответ — какие разделы окна устарели. onLogins — что сделать с учётными записями (их кладёт в
// общую базу программы gateway: пароли перешифровываются ключом этого компьютера) — после записи
// в базу магазина; onLic — с новым кодом активации главного; onLogo — с логотипом магазина
// ({ logo, at }). Основа, которая не легла, — ошибка: обмен её не пропустит и пришлёт снова
export function regApplyBase(db, entry, { onLogins = null, onLic = null, onLogo = null } = {}) {
  const b = parse(entry?.body)
  if (!b || !Number.isInteger(b.acc)) return []
  const changed = new Set()
  let logins = null
  inTx(db, () => {
    // Эта основа (или более поздняя) уже лежит: запись пришла второй раз
    if (b.acc <= soloAcc(db)) return
    for (const id of Array.isArray(b.ops) ? b.ops : []) {
      if (typeof id !== 'string') continue
      const own = q(db, "SELECT * FROM outbox WHERE id = ? AND state = 'pending'").get(id)
      if (own) {
        const op = { ...own, payload: parse(own.payload) || {} }
        ackOp(db, op, { status: 'ok' })
        for (const k of touchedBy(op)) changed.add(k)
        continue
      }
      if (confirmOp(db, id)) changed.add('products')
    }
    // Не принятое главным: своё — в «не принято» (его поправки снимаются), чужое — убирается
    for (const x of Array.isArray(b.rejected) ? b.rejected : []) {
      if (typeof x?.id !== 'string') continue
      const own = q(db, "SELECT * FROM outbox WHERE id = ? AND state = 'pending'").get(x.id)
      if (own) {
        const op = { ...own, payload: parse(own.payload) || {} }
        rejectOp(db, op, String(x.error || '').slice(0, 200) || 'Главный компьютер не принял операцию')
        for (const k of touchedBy(op)) changed.add(k)
      } else if (undoPeerOp(db, x.id, 'rejected')) {
        changed.add('products')
        changed.add('customers')
      }
    }
    const upProduct = q(db, 'UPDATE products SET sCostC = ?, sExpiry = ? WHERE id = ?')
    for (const p of Array.isArray(b.products) ? b.products : []) {
      if (typeof p?.id === 'string' && Number.isInteger(p.sCostC)) upProduct.run(p.sCostC, p.sExpiry ?? null, p.id)
    }
    const pids = new Set((Array.isArray(b.products) ? b.products : []).map((p) => p?.id).filter((x) => typeof x === 'string'))
    for (const pid of pids) q(db, 'DELETE FROM batches WHERE productId = ?').run(pid)
    const putBatch = q(db, 'INSERT OR REPLACE INTO batches (id, productId, units, sUnits, costC, expiryDate, arrivalId, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const x of Array.isArray(b.batches) ? b.batches : []) {
      if (typeof x?.id !== 'string' || !pids.has(x.productId) || !Number.isInteger(x.sUnits)) continue
      putBatch.run(x.id, x.productId, x.sUnits, x.sUnits, Number(x.costC) || 0, x.expiryDate ?? null, x.arrivalId ?? null, String(x.note ?? ''), String(x.createdAt || ''))
    }
    if (pids.size) changed.add('products')
    // Строки справочников, которые правили принятые операции, — как у главного; свои
    // неотправленные правки (и чужие, ещё не названные) — поверх них заново
    const rowTbls = new Set()
    const rows = b.rows && typeof b.rows === 'object' ? b.rows : {}
    for (const tbl of BASE_ROW_TABLES) {
      const list = Array.isArray(rows[tbl]) ? rows[tbl] : []
      const cols = EDIT_COLS[tbl]
      for (const row of list) {
        if (typeof row?.id !== 'string' || !row.id) continue
        const keys = cols.filter((k) => Object.prototype.hasOwnProperty.call(row, k))
        if (!keys.length) continue
        q(
          db,
          `INSERT INTO ${tbl} (id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
           ON CONFLICT(id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`,
        ).run(row.id, ...keys.map((k) => row[k] ?? null))
        rowTbls.add(tbl)
      }
    }
    const drop = b.drop && typeof b.drop === 'object' ? b.drop : {}
    for (const tbl of BASE_ROW_TABLES) {
      for (const id of Array.isArray(drop[tbl]) ? drop[tbl] : []) {
        if (typeof id !== 'string') continue
        // Своя неотправленная правка этой строки — её судьбу решит главный, когда получит
        const mine = q(db, "SELECT 1 FROM row_edits e JOIN outbox o ON o.id = e.opId WHERE e.tbl = ? AND e.rowId = ? AND o.state = 'pending' LIMIT 1").get(tbl, id)
        if (mine) continue
        q(db, `DELETE FROM ${tbl} WHERE id = ?`).run(id)
        if (tbl === 'products') q(db, 'DELETE FROM batches WHERE productId = ?').run(id)
        rowTbls.add(tbl)
      }
    }
    if (rowTbls.size) {
      replayEdits(db, [...rowTbls])
      if (rowTbls.has('products')) reorderProducts(db)
      if (rowTbls.has('categories')) reorderCategories(db)
      for (const t of rowTbls) changed.add(ROW_KEY[t] || t)
    }
    // Покупателя удалили на главном: он сам, история его долга и погашения уходят (как
    // standalone.mjs, deleteCustomer)
    for (const id of Array.isArray(b.gone?.customers) ? b.gone.customers : []) {
      if (typeof id !== 'string') continue
      q(db, 'DELETE FROM customers WHERE id = ?').run(id)
      q(db, 'DELETE FROM debt_moves WHERE customerId = ?').run(id)
      q(db, "DELETE FROM docs WHERE kind = 'payment' AND json_extract(body, '$.customerId') = ?").run(id)
      changed.add('customers')
      changed.add('payments')
    }
    // Документ удалили (правкой кассы, принятой главным): у главного его больше нет
    for (const d of Array.isArray(b.gone?.docs) ? b.gone.docs : []) {
      if (typeof d?.kind !== 'string' || typeof d.id !== 'string') continue
      const here = q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(d.kind, d.id)
      if (!here || !['synced', 'peer', 'deleted'].includes(here.sync)) continue
      q(db, 'DELETE FROM docs WHERE kind = ? AND id = ?').run(d.kind, d.id)
      changed.add(KIND_KEY[d.kind] || d.kind)
    }
    const upCustomer = q(db, 'UPDATE customers SET sDebtC = ?, local = 0 WHERE id = ?')
    for (const c of Array.isArray(b.customers) ? b.customers : []) {
      if (typeof c?.id === 'string' && Number.isInteger(c.sDebtC)) upCustomer.run(c.sDebtC, c.id)
    }
    if ((b.customers || []).length) changed.add('customers')
    const upSupplier = q(db, 'UPDATE suppliers SET sDebtC = ?, debtArrivals = ?, openingDebtC = ? WHERE id = ?')
    for (const s of Array.isArray(b.suppliers) ? b.suppliers : []) {
      if (typeof s?.id === 'string') upSupplier.run(s.sDebtC ?? null, Number(s.debtArrivals) || 0, s.openingDebtC ?? null, s.id)
    }
    if ((b.suppliers || []).length) changed.add('suppliers')
    for (const d of Array.isArray(b.docs) ? b.docs : []) {
      const id = d?.body?.id
      if (typeof id !== 'string' || typeof d.kind !== 'string') continue
      // Свой документ, который здесь ещё правят (или ждёт отправки), не трогаем: его версию
      // главный пришлёт, когда примет правку
      const here = q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(d.kind, id)
      if (here && !['synced', 'peer'].includes(here.sync)) continue
      putDoc(db, d.kind, d.body, { sync: 'synced', deviceId: typeof d.deviceId === 'string' ? d.deviceId : null })
      changed.add(KIND_KEY[d.kind] || d.kind)
    }
    if (Array.isArray(b.logins) && b.logins.length && onLogins) {
      logins = b.logins
      changed.add('users')
    }
    if (typeof b.lic === 'string' && b.lic && onLic) onLic(b.lic)
    if (b.logo && typeof b.logo.logo === 'string' && onLogo) {
      onLogo({ logo: b.logo.logo, at: typeof b.logo.at === 'string' ? b.logo.at : null })
      changed.add('shop')
    }
    setMeta(db, 'soloAcc', String(b.acc))
    rebuildStock(db)
    recountDebts(db)
  })
  // Учётные записи — в общую базу программы, когда основа уже легла
  if (logins) onLogins(logins)
  return [...changed]
}

// ── Подключение кассы ──
// Главный: база магазина для новой кассы — снимок в памяти, без своих служебных журналов
// (очередь своих операций, журнал обмена, соседи), без ключа сети (он зашифрован средствами Windows
// главного — касса получает его отдельно) и без зашифрованных там же отпечатков паролей
export function shopSnapshot(db) {
  const buf = db.serialize()
  // База в режиме WAL: снимок открывается в памяти только как обычный файл
  buf[18] = 1
  buf[19] = 1
  const copy = new Database(buf)
  try {
    copy.exec('DELETE FROM outbox; DELETE FROM lan_log; DELETE FROM lan_docs; DELETE FROM lan_peers; DELETE FROM lan_manual;')
    const drop = copy.prepare('DELETE FROM meta WHERE key = ?')
    for (const key of ['lanKey', 'lanRegKey', 'soloPaired', 'soloDisc', 'restored', 'deviceName', 'needFull', 'lanWide', 'lanDevices', 'soloMain', 'batchTag', 'soloRestoredFrom', 'soloEpochSeq', 'soloEpochBlind', 'soloFormerMain', 'lanPrunedTop']) drop.run(key)
    copy
      .prepare("UPDATE row_edits SET data = json_remove(data, '$.pw') WHERE tbl = 'team_accounts' AND json_valid(data) AND json_extract(data, '$.pw') IS NOT NULL")
      .run()
    copy.exec('VACUUM')
    return copy.serialize()
  } finally {
    copy.close()
  }
}

// Касса: база главного легла файлом — служебное этой кассы начинается заново. Главный — её
// единственный сосед: его журнал она получит с той записи, на которой база снята (topSeq).
// soloMain — пометка в самой базе «это касса такого-то главного»: база говорит о себе сама, и
// оборвись подключение на полпути, программа при следующем запуске знает, чья это база.
// regKeySealed — ключ обмена этой кассы с главным (свой у каждой кассы: отключённая касса больше
// не говорит с главным); lanKeySealed — ключ магазина (пароли сотрудников в основе)
export function regInstallDb(db, { main, address, port, topSeq, lanKeySealed, regKeySealed = null, name, soloMain = null, now }) {
  inTx(db, () => {
    for (const t of ['outbox', 'lan_log', 'lan_docs', 'lan_peers', 'lan_manual']) q(db, `DELETE FROM ${t}`).run()
    // Свои операции кассы пойдут с номерами после снимка: журнал обмена подхватит их с этого места
    const seq = q(db, "SELECT seq FROM sqlite_sequence WHERE name = 'outbox'").get()?.seq || 0
    setMeta(db, 'lanOutboxSeq', String(seq))
    setMeta(db, 'lanKey', lanKeySealed)
    if (regKeySealed) setMeta(db, 'lanRegKey', regKeySealed)
    setMeta(db, 'deviceName', String(name || '').slice(0, 60))
    // Номера своих партий — со своей пометкой (stock.mjs, localBatchId)
    setMeta(db, 'batchTag', randomBytes(4).toString('hex'))
    if (soloMain) setMeta(db, 'soloMain', JSON.stringify(soloMain))
    for (const key of ['soloPaired', 'soloDisc', 'restored', 'needFull', 'soloRestoredFrom']) q(db, 'DELETE FROM meta WHERE key = ?').run(key)
    const at = new Date(now).toISOString()
    q(db, 'INSERT INTO lan_peers (deviceId, name, address, port, sentUpTo, gotUpTo, wide, seenAt, okAt) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?)').run(
      main.deviceId,
      String(main.name || '').slice(0, 60),
      String(address || '').slice(0, 100),
      Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
      Number.isInteger(topSeq) && topSeq >= 0 ? topSeq : 0,
      at,
      at,
    )
  })
}

// Пометка «это касса» в самой базе магазина (regInstallDb) — или null
export function dbSoloMain(db) {
  try {
    const v = JSON.parse(getMeta(db, 'soloMain') || 'null')
    return v && typeof v.deviceId === 'string' && v.deviceId ? v : null
  } catch {
    return null
  }
}

// Касса подключается заново: всё, что у неё есть из журнала, — главному. Свои операции (и
// принятые, и ждущие) и чужие, пришедшие от главного: если он загрузил копию базы или его
// компьютер заменили, недостающее он возьмёт отсюда — и ничего, что успели продать, не пропадёт.
// Главный сам отбрасывает то, что у него уже есть (gateway, pairServe). Свои операции, ещё не
// записанные в журнал, туда сначала записывает вызывающий (lanCatchUp)
// Неотправленное (своё ждущее, чужое не названное в основе) — всё, какой бы давности оно ни было;
// принятое — за последние days дней (главный мог его потерять с загруженной копией)
export function regRecoveryEntries(db, { now, days = 30 } = {}) {
  const from = new Date(now - days * 86400000).toISOString()
  return q(
    db,
    `SELECT l.* FROM lan_log l WHERE l.kind = 'op'
       AND (
         (l.state = 'own' AND EXISTS (SELECT 1 FROM outbox o WHERE o.id = l.id AND o.state = 'pending'))
         OR l.state = 'applied'
         OR (l.state IN ('own', 'confirmed') AND l.createdAt >= ?)
       )
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id = l.id AND o.state IN ('rejected', 'dismissed'))
     ORDER BY l.seq`,
  )
    .all(from)
    .map((r) => ({
      seq: r.seq, id: r.id, kind: r.kind, origin: r.origin, opId: r.opId, type: r.type, accountId: r.accountId,
      createdAt: r.createdAt, body: r.body, wide: r.wide ? 1 : 0, redacted: 0,
    }))
}
