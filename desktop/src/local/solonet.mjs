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
import { ackOp, docsOf, touchedBy } from './outbox.mjs'
import { ackEdits, ADJ, docKnown, EDITABLE_DOC_KINDS } from './edits.mjs'
import { confirmOp, WIDE_KINDS } from './lan.mjs'
import { rebuildStock } from './stock.mjs'
import { DOC_KEYS, recountDebts } from './snapshot.mjs'
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
// Все чужие операции, лежащие поправкой (пришли по сети), по порядку прихода. Ответ — принятые
// операции, документы, которые завёл «сервер», пароли сотрудников, заданные на кассах (pw), и что
// ушло в минус (short: продано больше, чем было на складе)
export function mainAcceptPeers(db, { now }) {
  const ops = []
  const extras = []
  const pw = []
  const short = []
  inTx(db, () => {
    const rows = q(db, "SELECT * FROM lan_log WHERE kind = 'op' AND state = 'applied' ORDER BY seq").all()
    if (!rows.length) return
    // Остаток в минусе — от операций касс, легших поправкой (свои операции главного в минус не уводят)
    const over = new Map(q(db, 'SELECT id, name, oversold FROM products WHERE oversold > 0').all().map((p) => [p.id, p]))
    const taker = new Map()
    for (const r of rows) {
      const fx = parse(r.body)?.effects || {}
      serverExtras(db, peerAsOp(r, fx), now, extras)
      acceptPeer(db, r, fx)
      ops.push({ id: r.id, type: r.type, docs: (fx.docs || []).filter((d) => d && typeof d.kind === 'string' && d.body && typeof d.body === 'object') })
      for (const e of fx.edits?.rows || []) {
        if (e?.tbl === 'team_accounts' && typeof e.rowId === 'string' && typeof e.data?.pwLan === 'string') pw.push({ id: e.rowId, pwLan: e.data.pwLan })
      }
      for (const m of fx.moves || []) {
        if (m && typeof m.productId === 'string' && Number(m.units) < 0 && over.has(m.productId)) taker.set(m.productId, r)
      }
    }
    for (const [pid, p] of over) {
      const r = taker.get(pid)
      if (r) short.push({ productId: pid, name: p.name || '', units: p.oversold, opId: r.id, type: r.type, origin: r.origin, accountId: r.accountId ?? null, createdAt: r.createdAt })
    }
    foldBase(db)
  })
  return { ops, extras, pw, short }
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
// logo — логотип магазина ({ logo, at }: его ставят на главном, «Настройки» → «Чек и печать»)
export function mainLogBase(db, { ops = [], extras = [], logins = [], gone = null, lic = null, logo = null, deviceId, now }) {
  const goneCustomers = Array.isArray(gone?.customers) ? gone.customers.filter((x) => typeof x === 'string') : []
  const withLogo = !!logo && typeof logo === 'object' && typeof logo.logo === 'string'
  if (!ops.length && !extras.length && !logins.length && !goneCustomers.length && !lic && !withLogo) return null
  return inTx(db, () => {
    const acc = soloAcc(db) + 1
    setMeta(db, 'soloAcc', String(acc))
    const ids = ops.map((o) => o.id)
    const products = new Set()
    const customers = new Set()
    const suppliers = new Set()
    const shifts = new Set()
    if (ids.length) {
      const list = ids.map(() => '?').join(', ')
      for (const r of q(db, `SELECT DISTINCT productId FROM stock_moves WHERE opId IN (${list})`).all(...ids)) products.add(r.productId)
      for (const r of q(db, `SELECT DISTINCT customerId FROM debt_moves WHERE opId IN (${list})`).all(...ids)) customers.add(r.customerId)
      for (const r of q(db, `SELECT target, rowId FROM adj_moves WHERE opId IN (${list})`).all(...ids)) {
        if (r.target === ADJ.supplierDebt) suppliers.add(r.rowId)
        else shifts.add(r.rowId)
      }
      for (const r of q(db, `SELECT tbl, rowId FROM row_edits WHERE opId IN (${list})`).all(...ids)) {
        if (r.tbl === 'products') products.add(r.rowId)
        else if (r.tbl === 'suppliers') suppliers.add(r.rowId)
        else if (r.tbl === 'customers') customers.add(r.rowId)
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
    const rowsOf = (sql, set) => {
      if (!set.size) return []
      const v = [...set].filter((x) => typeof x === 'string')
      return v.length ? q(db, sql.replace('?*', v.map(() => '?').join(', '))).all(...v) : []
    }
    const body = {
      acc,
      ops: ids,
      products: rowsOf('SELECT id, sCostC, sExpiry FROM products WHERE id IN (?*)', products),
      batches: rowsOf('SELECT id, productId, sUnits, costC, expiryDate, arrivalId, note, createdAt FROM batches WHERE productId IN (?*)', products),
      customers: rowsOf('SELECT id, sDebtC FROM customers WHERE id IN (?*)', customers),
      suppliers: rowsOf('SELECT id, sDebtC, debtArrivals, openingDebtC FROM suppliers WHERE id IN (?*)', suppliers),
      docs: [
        ...extras.map((d) => ({ kind: d.kind, body: d.body, deviceId: null })),
        ...rowsOf("SELECT body, deviceId FROM docs WHERE kind = 'shift' AND id IN (?*)", shifts).map((r) => ({ kind: 'shift', body: parse(r.body), deviceId: r.deviceId ?? null })),
      ],
      logins,
      ...(goneCustomers.length ? { gone: { customers: goneCustomers } } : {}),
      ...(typeof lic === 'string' && lic ? { lic } : {}),
      ...(withLogo ? { logo: { logo: logo.logo, at: typeof logo.at === 'string' ? logo.at : null } } : {}),
    }
    const wide = body.suppliers.length > 0 || body.docs.some((d) => WIDE_KINDS.has(d.kind)) ? 1 : 0
    q(
      db,
      `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
       VALUES (?, 'base', ?, NULL, '', NULL, ?, ?, ?, 0, 'own')`,
    ).run('base:' + acc, deviceId, iso(now), JSON.stringify(body), wide)
    return acc
  })
}

// ── Касса: основа от главного ──
// Ответ — какие разделы окна устарели. onLogins — что сделать с учётными записями (их кладёт в
// общую базу программы gateway: пароли перешифровываются ключом этого компьютера); onLic — с новым
// кодом активации главного; onLogo — с логотипом магазина ({ logo, at })
export function regApplyBase(db, entry, { onLogins = null, onLic = null, onLogo = null } = {}) {
  const b = parse(entry?.body)
  if (!b || !Number.isInteger(b.acc)) return []
  const changed = new Set()
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
      onLogins(b.logins)
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
    for (const key of ['lanKey', 'soloPaired', 'soloDisc', 'restored', 'deviceName', 'needFull', 'lanWide', 'lanDevices']) drop.run(key)
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
// единственный сосед: его журнал она получит с той записи, на которой снята база (topSeq)
export function regInstallDb(db, { main, address, port, topSeq, lanKeySealed, name, now }) {
  inTx(db, () => {
    for (const t of ['outbox', 'lan_log', 'lan_docs', 'lan_peers', 'lan_manual']) q(db, `DELETE FROM ${t}`).run()
    // Свои операции кассы пойдут с номерами после снимка: журнал обмена подхватит их с этого места
    const seq = q(db, "SELECT seq FROM sqlite_sequence WHERE name = 'outbox'").get()?.seq || 0
    setMeta(db, 'lanOutboxSeq', String(seq))
    setMeta(db, 'lanKey', lanKeySealed)
    setMeta(db, 'deviceName', String(name || '').slice(0, 60))
    for (const key of ['soloPaired', 'soloDisc', 'restored', 'needFull']) q(db, 'DELETE FROM meta WHERE key = ?').run(key)
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

// Касса подключается заново: свои операции, которые главный ещё не принял, — с собой
export function regPendingEntries(db) {
  return q(
    db,
    `SELECT l.* FROM lan_log l JOIN outbox o ON o.id = l.id
     WHERE l.kind = 'op' AND l.state = 'own' AND o.state = 'pending' ORDER BY l.seq`,
  )
    .all()
    .map((r) => ({
      seq: r.seq, id: r.id, kind: r.kind, origin: r.origin, opId: r.opId, type: r.type, accountId: r.accountId,
      createdAt: r.createdAt, body: r.body, wide: r.wide ? 1 : 0, redacted: 0,
    }))
}
