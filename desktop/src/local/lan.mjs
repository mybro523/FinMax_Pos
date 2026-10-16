// ── Обмен кассами по местной сети: журнал и операции соседей ──
//
// Две кассы одного магазина стоят в одной сети (кабель, роутер), а интернета нет.
// Каждая продаёт из своей локальной базы, и без этого модуля владелец на своём
// компьютере не видел бы продаж кассира, пока обе кассы не выйдут в интернет.
//
// Как это устроено. Всё, что касса делает без сервера, она и так записывает очередью
// операций (outbox) — с документами и движениями остатка и долга. Здесь к этому
// добавляется журнал обмена (lan_log): каждая своя операция попадает в него вместе с
// тем, что она сделала в базе (документы, движения, новый клиент, новая цена). Соседняя
// касса забирает журнал по сети (lan.mjs в корне программы) и кладёт чужую операцию
// к себе ровно так, как лежит своя неотправленная:
//   • документы — с пометкой sync = 'peer' (журналы и отчёты их показывают);
//   • движения остатка и долга — с номером операции и пометкой «сервер ещё не принял»:
//     остаток и долг складываются из данных сервера и этих поправок (snapshot.mjs).
//
// На сервер чужую операцию отправляет только её касса — она знает свою смену и свой
// ключ. Когда сервер её принял, поправку пора снимать: в его данных она уже есть.
// Узнаём это двумя путями, и оба — по данным самого обмена с сервером:
//   • сервер прислал документ этой операции — значит, принял, и его остатки уже с ней;
//   • касса-источник сообщила по сети «сервер принял». Тогда поправка снимается при
//     следующем обмене с сервером, начатом ПОСЛЕ этого известия: его данные сняты
//     позже приёма и точно её содержат.
// Сервер отверг операцию — её касса сообщит и это: документы и движения убираются.
// Операция, которая за две недели так и не дошла до сервера, снимается тоже.
//
// Кассир видит не всё: расходы, доходы и списания сервер отдаёт только тем, у кого
// есть права (pullScope на сервере). Соседу без таких прав журнал уходит урезанным:
// расходы и доходы не уходят вовсе, у списания — только движения остатка, без
// документа с суммами. Остатки при этом сходятся на обеих кассах.
import { getMeta, inTx, q, setMeta } from './db.mjs'
import { KINDS, putDoc } from './docs.mjs'
import { docsOf, touchedBy } from './outbox.mjs'
import { applyMove, rebuildStock } from './stock.mjs'
import { DOC_KEYS, recountDebts } from './snapshot.mjs'
import { hasPerm } from './accounts.mjs'

// Сколько дней чужая операция может ждать сервера. Касса без связи работает не
// больше недели (срок подписки без проверки), две недели — с запасом
export const LAN_KEEP_DAYS = 14
// Сколько дней журнал хранит то, что уже не нужно соседям
const LOG_KEEP_DAYS = 21
const DAY_MS = 86400000

// Виды документов, которые видит не каждый
export const WIDE_KINDS = new Set(['writeoff', 'expense', 'income', 'supplierpayment'])
// Операции, которые соседу без прав не уходят вовсе: в них ничего, кроме денег магазина
const WIDE_ONLY_TYPES = new Set(['expense', 'income'])
// С какими правами касса получает такие данные — те же, что у сервера (pullScope)
export const WIDE_PERMS = ['suppliers.view', 'writeoffs.view', 'expenses.view', 'incomes.view', 'reports.view', 'dashboard.view']

const KIND_KEY = Object.fromEntries(Object.entries(DOC_KEYS).map(([key, kind]) => [kind, key]))

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// ── Вошедшие на этом компьютере: есть ли среди них кто-то с правами на деньги ──
// По этому соседи решают, отдавать ли сюда расходы, доходы и списания. За кассой мог
// работать и владелец: тогда здесь лежат и его данные — как и с сервера
export function lanWideHere(core, pharmacyCode) {
  if (!core || !pharmacyCode) return false
  return q(core, 'SELECT role, permissions FROM accounts WHERE pharmacyCode = ?')
    .all(pharmacyCode)
    .some((acc) => hasPerm(acc, ...WIDE_PERMS))
}

// ── Своя операция → в журнал ──
// Что операция сделала в этой базе: документы в их нынешнем виде, движения остатка и
// долга, новый клиент, отложенный штрихкод, новая цена продажи
function effectsOf(db, op) {
  const docs = []
  for (const [kind, id] of docsOf(op)) {
    if (!id) continue
    const row = q(db, 'SELECT deviceId, body FROM docs WHERE kind = ? AND id = ?').get(kind, id)
    if (row) docs.push({ kind, deviceId: row.deviceId ?? null, body: JSON.parse(row.body) })
  }
  const moves = q(
    db,
    'SELECT productId, kind, units, skipExpired, costC, expiryDate, arrivalId, note, wPacks, wValue, createdAt FROM stock_moves WHERE opId = ? ORDER BY seq',
  ).all(op.id)
  const debts = q(db, 'SELECT customerId, deltaC, kind, createdAt FROM debt_moves WHERE opId = ? ORDER BY seq').all(op.id)
  const out = { docs, moves, debts }
  const p = op.payload || {}
  if (op.type === 'customer.create' && p.customer?.id) {
    const c = q(db, 'SELECT id, name, phone, createdAt FROM customers WHERE id = ?').get(p.customer.id)
    if (c) out.customer = c
  }
  if (op.type === 'deferred.add' && p.deferred?.id) {
    out.deferred = { id: p.deferred.id, barcode: String(p.deferred.barcode ?? ''), createdAt: p.deferred.createdAt || op.createdAt }
  }
  if (op.type === 'deferred.remove' && p.id) out.deferredRemove = p.id
  if (op.type === 'arrival') {
    // Новая цена продажи из прихода — какой она стала в карточке после него
    const prices = []
    for (const it of p.arrival?.items || []) {
      if (!it || it.price === undefined || it.price === null) continue
      const row = q(db, 'SELECT priceC FROM products WHERE id = ?').get(it.productId)
      if (row) prices.push([it.productId, row.priceC])
    }
    if (prices.length) out.prices = prices
  }
  return out
}

function logOwn(db, op, deviceId) {
  if (q(db, 'SELECT 1 FROM lan_log WHERE id = ?').get(op.id)) return
  const effects = effectsOf(db, op)
  const wide = WIDE_ONLY_TYPES.has(op.type) || op.type === 'writeoff' || effects.docs.some((d) => WIDE_KINDS.has(d.kind))
  q(
    db,
    `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES (?, 'op', ?, NULL, ?, ?, ?, ?, ?, 0, 'own')`,
  ).run(op.id, deviceId, op.type, op.accountId ?? null, op.createdAt, JSON.stringify({ effects }), wide ? 1 : 0)
}

// ── Догнать очередь ──
// Каждая новая операция очереди (с прошлого раза) — в журнал. Зовётся сразу после
// записи операции и после обмена с сервером. Попадают только ещё не отправленные:
// принятое сервером соседи получат от сервера сами. Здесь же — судьба своих операций,
// которую уже знает очередь (сервер принял или отверг), для соседей
export function lanCatchUp(db, { deviceId, now }) {
  let logged = 0
  inTx(db, () => {
    const last = Number(getMeta(db, 'lanOutboxSeq') || 0)
    const rows = q(db, 'SELECT * FROM outbox WHERE seq > ? ORDER BY seq').all(last)
    for (const r of rows) {
      if (r.state !== 'pending') continue
      logOwn(db, { ...r, payload: parse(r.payload) || {} }, deviceId)
      logged++
    }
    if (rows.length) setMeta(db, 'lanOutboxSeq', String(rows[rows.length - 1].seq))
    const fates = q(
      db,
      `SELECT l.id, o.state, o.error FROM lan_log l JOIN outbox o ON o.id = l.id
       WHERE l.kind = 'op' AND l.state = 'own' AND l.fate IS NULL AND o.state IN ('done', 'rejected', 'dismissed')`,
    ).all()
    for (const f of fates) lanFate(db, f.id, f.state === 'done' ? 'ok' : 'rejected', f.error, { deviceId, now })
  })
  return logged
}

// ── Сервер сказал о своей операции ──
// Запоминаем и кладём в журнал отметку: соседи по ней снимут свою поправку (принял)
// или уберут операцию совсем (отверг)
export function lanFate(db, opId, status, error, { deviceId, now }) {
  const own = q(db, "SELECT fate FROM lan_log WHERE id = ? AND kind = 'op' AND state = 'own'").get(opId)
  if (!own || own.fate) return false
  q(db, 'UPDATE lan_log SET fate = ? WHERE id = ?').run(status, opId)
  q(
    db,
    `INSERT OR IGNORE INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state)
     VALUES (?, 'fate', ?, ?, '', NULL, ?, ?, 0, 0, 'own')`,
  ).run('fate:' + opId, deviceId, opId, new Date(now).toISOString(), JSON.stringify({ status, error: String(error || '').slice(0, 300) }))
  return true
}

// ── Что отдать соседу ──
// Записи журнала после отметки since, по порядку. Соседу без прав на деньги — урезанные
// (см. в начале файла). upTo — докуда журнал пройден, включая пропущенные записи:
// сосед подтвердит его, и в следующий раз они не пойдут снова
const toWire = (r) => ({
  seq: r.seq,
  id: r.id,
  kind: r.kind,
  origin: r.origin,
  opId: r.opId,
  type: r.type,
  accountId: r.accountId,
  createdAt: r.createdAt,
  body: r.body,
  wide: r.wide ? 1 : 0,
  redacted: r.redacted ? 1 : 0,
})

export function redact(e) {
  if (e.kind !== 'op' || !e.wide) return e
  if (WIDE_ONLY_TYPES.has(e.type)) return null
  const b = parse(e.body)
  const fx = b?.effects
  if (!fx) return null
  const docs = (fx.docs || []).filter((d) => !WIDE_KINDS.has(d.kind))
  const rest = { ...fx, docs }
  if (!docs.length && !(fx.moves || []).length && !(fx.debts || []).length) return null
  return { ...e, body: JSON.stringify({ effects: rest }), redacted: 1, wide: 0 }
}

export function lanEntriesSince(db, since, { wide = false, limit = 200, maxBytes = 1_500_000 } = {}) {
  const rows = q(db, 'SELECT * FROM lan_log WHERE seq > ? ORDER BY seq LIMIT ?').all(Number(since) || 0, limit + 1)
  const entries = []
  let upTo = Number(since) || 0
  let bytes = 0
  let more = rows.length > limit
  for (const r of rows.slice(0, limit)) {
    const e = wide ? toWire(r) : redact(toWire(r))
    if (e) {
      const size = e.body.length + 200
      if (entries.length && bytes + size > maxBytes) {
        more = true
        break
      }
      bytes += size
      entries.push(e)
    }
    upTo = r.seq
  }
  return { entries, upTo, more }
}

export const lanTopSeq = (db) => q(db, 'SELECT COALESCE(MAX(seq), 0) AS n FROM lan_log').get().n

// ── Чужая операция → в базу ──
const ID = /^[A-Za-z0-9_:.-]{1,100}$/
function validEntry(e) {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.id === 'string' &&
    ID.test(e.id) &&
    (e.kind === 'op' || e.kind === 'fate') &&
    typeof e.origin === 'string' &&
    e.origin.length <= 100 &&
    typeof e.body === 'string' &&
    e.body.length <= 2_000_000 &&
    typeof e.createdAt === 'string' &&
    e.createdAt.length <= 40
  )
}

// Документы чужой операции. Свой неотправленный документ с тем же номером не трогаем
// (такого не бывает, но портить своё нельзя); серверный — тоже: значит, операция уже
// у сервера. Смена — единственный документ, который меняют две операции (открытие и
// закрытие): её закрытие заменяет копию, в которой смена ещё открыта
function shiftCloses(row, d) {
  if (d.kind !== 'shift' || !d.body?.closedAt || !row || row.sync === 'pending') return false
  return row.sync === 'peer' || !row.closedAt
}
function addDocs(db, opId, docs, changed) {
  for (const d of docs || []) {
    const id = d?.body?.id
    if (typeof id !== 'string' || !ID.test(id) || !KINDS.includes(d.kind)) continue
    const row = q(db, 'SELECT sync, closedAt FROM docs WHERE kind = ? AND id = ?').get(d.kind, id)
    if (row && !shiftCloses(row, d)) continue
    putDoc(db, d.kind, d.body, { sync: 'peer', deviceId: typeof d.deviceId === 'string' ? d.deviceId : null })
    q(db, 'INSERT OR REPLACE INTO lan_docs (kind, id, opId) VALUES (?, ?, ?)').run(d.kind, id, opId)
    if (KIND_KEY[d.kind]) changed.add(KIND_KEY[d.kind])
  }
}

function applyEffects(db, opId, type, fx, changed) {
  // Документ этой операции уже пришёл от сервера — значит, сервер её принял, и в его
  // остатках она есть. Накладывать её второй раз нельзя
  for (const d of fx.docs || []) {
    if (d?.kind === 'shift') continue
    const row = q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(d?.kind, d?.body?.id)
    if (row && row.sync === 'synced') return 'confirmed'
  }
  addDocs(db, opId, fx.docs, changed)

  // Движения остатка — так же, как свои: в журнал с номером операции и сразу на полку.
  // Отказов нет: товар уже продан на соседней кассе (tolerant)
  const insertMove = q(
    db,
    `INSERT INTO stock_moves (opId, productId, kind, units, skipExpired, costC, expiryDate, arrivalId, note, wPacks, wValue, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const m of fx.moves || []) {
    if (!m || typeof m.productId !== 'string' || !Number.isInteger(m.units)) continue
    const createdAt = typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString()
    const info = insertMove.run(
      opId, m.productId, String(m.kind || 'peer'), m.units, m.skipExpired ? 1 : 0, m.costC ?? null, m.expiryDate ?? null,
      m.arrivalId ?? null, String(m.note || ''), m.wPacks ?? null, m.wValue ?? null, createdAt,
    )
    applyMove(db, { ...m, seq: Number(info.lastInsertRowid), createdAt }, { tolerant: true, now: Date.parse(createdAt) || Date.now() })
    changed.add('products')
  }

  // Новый клиент соседа: local = 2 — «заведён на другой кассе, сервер ещё не знает»
  if (fx.customer && typeof fx.customer.id === 'string') {
    q(db, 'INSERT OR IGNORE INTO customers (id, name, phone, sDebtC, debtC, createdAt, local) VALUES (?, ?, ?, 0, 0, ?, 2)').run(
      fx.customer.id,
      String(fx.customer.name ?? ''),
      String(fx.customer.phone ?? ''),
      String(fx.customer.createdAt || new Date().toISOString()),
    )
    changed.add('customers')
  }
  const insertDebt = q(db, 'INSERT INTO debt_moves (opId, customerId, deltaC, kind, createdAt) VALUES (?, ?, ?, ?, ?)')
  for (const d of fx.debts || []) {
    if (!d || typeof d.customerId !== 'string' || !Number.isInteger(d.deltaC)) continue
    insertDebt.run(opId, d.customerId, d.deltaC, String(d.kind || 'peer'), String(d.createdAt || new Date().toISOString()))
  }
  if ((fx.debts || []).length || fx.customer) {
    recountDebts(db)
    changed.add('customers')
  }

  if (fx.deferred && typeof fx.deferred.id === 'string') {
    q(db, "INSERT OR IGNORE INTO deferred (id, barcode, createdAt, sync) VALUES (?, ?, ?, 'peer')").run(
      fx.deferred.id,
      String(fx.deferred.barcode ?? ''),
      String(fx.deferred.createdAt || new Date().toISOString()),
    )
    changed.add('deferred')
  }
  if (typeof fx.deferredRemove === 'string') {
    q(db, "UPDATE deferred SET sync = 'deleted' WHERE id = ? AND sync IN ('synced', 'peer')").run(fx.deferredRemove)
    changed.add('deferred')
  }
  for (const pr of fx.prices || []) {
    if (Array.isArray(pr) && typeof pr[0] === 'string' && Number.isInteger(pr[1])) {
      q(db, 'UPDATE products SET priceC = ? WHERE id = ?').run(pr[1], pr[0])
      changed.add('products')
    }
  }
  for (const k of touchedBy({ type })) changed.add(k)
  return 'applied'
}

// ── Сервер принял чужую операцию: поправку снимаем ──
// Её движения больше не «наши неотправленные» — они в данных сервера. Документы
// становятся обычными серверными (сервер пришлёт свою копию — она их заменит)
function confirmOp(db, opId) {
  const row = q(db, "SELECT body FROM lan_log WHERE id = ? AND kind = 'op' AND state = 'applied'").get(opId)
  if (!row) return false
  q(db, 'UPDATE stock_moves SET synced = 1 WHERE opId = ?').run(opId)
  q(db, 'UPDATE debt_moves SET synced = 1 WHERE opId = ?').run(opId)
  for (const d of q(db, 'SELECT kind, id FROM lan_docs WHERE opId = ?').all(opId)) {
    q(db, "UPDATE docs SET sync = 'synced' WHERE kind = ? AND id = ? AND sync = 'peer'").run(d.kind, d.id)
  }
  q(db, 'DELETE FROM lan_docs WHERE opId = ?').run(opId)
  const fx = parse(row.body)?.effects || {}
  if (fx.customer?.id) q(db, 'UPDATE customers SET local = 0 WHERE id = ? AND local = 2').run(fx.customer.id)
  if (fx.deferred?.id) q(db, "UPDATE deferred SET sync = 'synced' WHERE id = ? AND sync = 'peer'").run(fx.deferred.id)
  if (typeof fx.deferredRemove === 'string') q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'deleted'").run(fx.deferredRemove)
  q(db, "UPDATE lan_log SET state = 'confirmed' WHERE id = ?").run(opId)
  return true
}

// ── Сервер отверг чужую операцию (или она так и не дошла) — убираем её совсем ──
function undoOp(db, opId, state) {
  const row = q(db, "SELECT type, body FROM lan_log WHERE id = ? AND kind = 'op' AND state = 'applied'").get(opId)
  if (!row) return null
  for (const d of q(db, 'SELECT kind, id FROM lan_docs WHERE opId = ?').all(opId)) {
    q(db, "DELETE FROM docs WHERE kind = ? AND id = ? AND sync = 'peer'").run(d.kind, d.id)
  }
  q(db, 'DELETE FROM lan_docs WHERE opId = ?').run(opId)
  q(db, 'DELETE FROM stock_moves WHERE opId = ? AND synced = 0').run(opId)
  q(db, 'DELETE FROM debt_moves WHERE opId = ? AND synced = 0').run(opId)
  const fx = parse(row.body)?.effects || {}
  if (fx.customer?.id) q(db, 'DELETE FROM customers WHERE id = ? AND local = 2').run(fx.customer.id)
  if (fx.deferred?.id) q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'peer'").run(fx.deferred.id)
  if (typeof fx.deferredRemove === 'string') q(db, "UPDATE deferred SET sync = 'synced' WHERE id = ? AND sync = 'deleted'").run(fx.deferredRemove)
  q(db, 'UPDATE lan_log SET state = ? WHERE id = ?').run(state, opId)
  return row.type
}

// Остаток и долг — заново от данных сервера и всех поправок, что остались
function rebuild(db) {
  rebuildStock(db)
  recountDebts(db)
}

// ── Записи от соседа ──
// gen — номер последнего начатого обмена с сервером (lanGen): с ним запоминается
// известие «сервер принял» (см. в начале файла). Возвращает, какие разделы окна
// устарели, и нужно ли поскорее обменяться с сервером (пришло известие о приёме)
export function lanReceive(db, entries, { now, gen }) {
  const changed = new Set()
  let kickSync = false
  if (!Array.isArray(entries) || !entries.length) return { changed: [], kickSync }
  inTx(db, () => {
    let needRebuild = false
    for (const e of entries) {
      if (!validEntry(e)) continue
      if (e.kind === 'op') {
        // Своя операция вернулась от соседа — у нас она и так есть
        if (q(db, 'SELECT 1 FROM outbox WHERE id = ?').get(e.id)) continue
        const fx = parse(e.body)?.effects
        if (!fx || typeof fx !== 'object') continue
        const known = q(db, 'SELECT redacted, state FROM lan_log WHERE id = ?').get(e.id)
        if (known) {
          // Лежала урезанной, а теперь пришла целиком: докладываем недостающие документы
          if (known.redacted && !e.redacted) {
            q(db, 'UPDATE lan_log SET body = ?, redacted = 0, wide = ? WHERE id = ?').run(e.body, e.wide ? 1 : 0, e.id)
            if (known.state === 'applied') addDocs(db, e.id, fx.docs, changed)
          }
          continue
        }
        q(
          db,
          `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state, receivedAt)
           VALUES (?, 'op', ?, NULL, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
        ).run(
          e.id, e.origin, String(e.type || '').slice(0, 40), typeof e.accountId === 'string' ? e.accountId : null, e.createdAt, e.body,
          e.wide ? 1 : 0, e.redacted ? 1 : 0, new Date(now).toISOString(),
        )
        const state = applyEffects(db, e.id, String(e.type || ''), fx, changed)
        if (state === 'confirmed') {
          q(db, "UPDATE lan_log SET state = 'confirmed' WHERE id = ?").run(e.id)
          continue
        }
        // Известие о судьбе могло прийти раньше самой операции (через третью кассу)
        const fate = q(db, "SELECT body FROM lan_log WHERE id = ? AND kind = 'fate'").get('fate:' + e.id)
        if (fate) {
          const r = fateTo(db, e.id, parse(fate.body), gen, changed)
          if (r === 'rejected') needRebuild = true
          if (r === 'ok') kickSync = true
        }
      } else {
        if (typeof e.opId !== 'string' || !ID.test(e.opId)) continue
        if (!q(db, 'SELECT 1 FROM lan_log WHERE id = ?').get(e.id)) {
          q(
            db,
            `INSERT INTO lan_log (id, kind, origin, opId, type, accountId, createdAt, body, wide, redacted, state, receivedAt)
             VALUES (?, 'fate', ?, ?, '', NULL, ?, ?, 0, 0, 'relay', ?)`,
          ).run(e.id, e.origin, e.opId, e.createdAt, e.body, new Date(now).toISOString())
        }
        const r = fateTo(db, e.opId, parse(e.body), gen, changed)
        if (r === 'rejected') needRebuild = true
        if (r === 'ok') kickSync = true
      }
    }
    if (needRebuild) rebuild(db)
  })
  return { changed: [...changed], kickSync }
}

// Что сказал сервер о чужой операции, которая лежит у нас поправкой
function fateTo(db, opId, fate, gen, changed) {
  if (!fate || typeof fate !== 'object') return null
  const op = q(db, "SELECT type FROM lan_log WHERE id = ? AND kind = 'op' AND state = 'applied'").get(opId)
  if (!op) return null
  if (fate.status === 'ok') {
    q(db, 'UPDATE lan_log SET fate = ?, fateGen = COALESCE(fateGen, ?) WHERE id = ?').run('ok', Number(gen) || 0, opId)
    return 'ok'
  }
  if (fate.status === 'rejected') {
    const type = undoOp(db, opId, 'rejected')
    for (const k of touchedBy({ type })) changed.add(k)
    changed.add('products')
    changed.add('customers')
    return 'rejected'
  }
  return null
}

// ── Номер обмена с сервером ──
// Растёт с началом каждого обмена: по нему видно, начат ли обмен после известия
// «сервер принял» (см. в начале файла)
export function lanNextGen(db) {
  const n = Number(getMeta(db, 'lanGen') || 0) + 1
  setMeta(db, 'lanGen', String(n))
  return n
}
export const lanGen = (db) => Number(getMeta(db, 'lanGen') || 0)

// ── Перед тем как лягут данные сервера ──
// Снимаем поправки чужих операций, которые в этих данных уже есть, и убираем те, что
// так и не дошли до сервера. Остаток и долг пересчитает сам приём данных (needRebuild)
export function lanBeforePull(db, data, { startedGen, now }) {
  let any = false
  const d = data && typeof data === 'object' ? data : {}
  for (const [key, kind] of Object.entries(DOC_KEYS)) {
    // Смену меняют две операции — по её документу не понять, какая из них принята
    if (kind === 'shift') continue
    const ups = d[key]?.upsert
    if (!Array.isArray(ups) || !ups.length) continue
    for (const doc of ups) {
      if (typeof doc?.id !== 'string') continue
      const m = q(db, 'SELECT opId FROM lan_docs WHERE kind = ? AND id = ?').get(kind, doc.id)
      if (m && confirmOp(db, m.opId)) any = true
    }
  }
  for (const r of q(db, "SELECT id FROM lan_log WHERE kind = 'op' AND state = 'applied' AND fate = 'ok' AND fateGen < ?").all(Number(startedGen) || 0)) {
    if (confirmOp(db, r.id)) any = true
  }
  if (expireOld(db, now)) any = true
  if (any) setMeta(db, 'needRebuild', '1')
  return any
}

function expireOld(db, now) {
  const before = new Date(now - LAN_KEEP_DAYS * DAY_MS).toISOString()
  let any = false
  for (const r of q(db, "SELECT id FROM lan_log WHERE kind = 'op' AND state = 'applied' AND receivedAt < ?").all(before)) {
    if (undoOp(db, r.id, 'expired')) any = true
  }
  return any
}

// ── Уборка журнала ──
// Раз в сутки: старое и уже ненужное соседям уходит; чужое, что так и не дошло до
// сервера за две недели, снимается (и без связи — остаток должен прийти в порядок)
export function lanPrune(db, now) {
  const last = Number(getMeta(db, 'lanPrunedAt') || 0)
  if (now - last < DAY_MS) return false
  let rebuilt = false
  inTx(db, () => {
    if (expireOld(db, now)) {
      rebuild(db)
      rebuilt = true
    }
    const before = new Date(now - LOG_KEEP_DAYS * DAY_MS).toISOString()
    q(db, "DELETE FROM lan_log WHERE createdAt < ? AND state <> 'applied'").run(before)
    setMeta(db, 'lanPrunedAt', String(now))
  })
  return rebuilt
}

// ── Ждёт ли своя операция соседа ──
// Возврат по чеку соседней кассы, продажа в долг её новому клиенту, погашение его долга:
// пока сосед не отправил свой чек или клиента, сервер их не знает и операцию отверг бы.
// Такая операция ждёт в очереди (sync.mjs) — до приёма чужой или до её отказа
export function waitsForPeer(db, op) {
  const p = op?.payload || {}
  const peerSale = (id) => typeof id === 'string' && !!q(db, "SELECT 1 FROM docs WHERE kind = 'sale' AND id = ? AND sync = 'peer'").get(id)
  const peerCustomer = (id) => typeof id === 'string' && !!q(db, 'SELECT 1 FROM customers WHERE id = ? AND local = 2').get(id)
  switch (op?.type) {
    case 'sale':
      return peerCustomer(p.sale?.customerId)
    case 'return':
      return peerSale(p.ret?.saleId) || peerCustomer(p.ret?.customerId)
    case 'debt.pay':
      return peerCustomer(p.payment?.customerId)
    default:
      return false
  }
}

// ── Соседние кассы ──
export const lanPeers = (db) => q(db, 'SELECT * FROM lan_peers ORDER BY name, deviceId').all()
export const lanPeer = (db, deviceId) => q(db, 'SELECT * FROM lan_peers WHERE deviceId = ?').get(deviceId) || null

// Сосед откликнулся: где он и как называется. Адрес — откуда пришёл, порт — тот,
// что он слушает (из его сообщения)
export function lanPeerSeen(db, { deviceId, name, address, port, wide, ok, now }) {
  if (typeof deviceId !== 'string' || !ID.test(deviceId)) return
  const at = new Date(now).toISOString()
  q(
    db,
    `INSERT INTO lan_peers (deviceId, name, address, port, wide, seenAt, okAt) VALUES (?, ?, ?, ?, COALESCE(?, 0), ?, ?)
     ON CONFLICT(deviceId) DO UPDATE SET
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE lan_peers.name END,
       address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE lan_peers.address END,
       port = CASE WHEN excluded.port > 0 THEN excluded.port ELSE lan_peers.port END,
       wide = CASE WHEN ? IS NULL THEN lan_peers.wide ELSE excluded.wide END,
       seenAt = excluded.seenAt,
       okAt = COALESCE(excluded.okAt, lan_peers.okAt)`,
  ).run(
    deviceId,
    String(name || '').slice(0, 60),
    String(address || '').slice(0, 100),
    Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    wide === undefined || wide === null ? null : wide ? 1 : 0,
    at,
    ok ? at : null,
    wide === undefined || wide === null ? null : 1,
  )
}

// Докуда журналы друг друга уже переданы: sentUpTo — что сосед подтвердил из нашего
// (его слово — главное: базу соседа могли начать заново, тогда он скажет меньше),
// gotUpTo — докуда у нас его журнал
export function lanPeerProgress(db, deviceId, { sentUpTo, gotUpTo }) {
  const peer = lanPeer(db, deviceId)
  if (!peer) return
  const sent = Number.isInteger(sentUpTo) && sentUpTo >= 0 ? sentUpTo : peer.sentUpTo
  const got = Number.isInteger(gotUpTo) && gotUpTo >= 0 ? gotUpTo : peer.gotUpTo
  q(db, 'UPDATE lan_peers SET sentUpTo = ?, gotUpTo = ? WHERE deviceId = ?').run(sent, got, deviceId)
}

// За этим компьютером начал работать тот, кому видны деньги магазина, а журналы соседей
// до сих пор приходили урезанными. Просим их целиком заново: отметка «докуда получили»
// у всех соседей сбрасывается, и полные записи заменят урезанные
export function lanAskFull(db) {
  q(db, 'UPDATE lan_peers SET gotUpTo = 0').run()
}

export const lanManual = (db) => q(db, 'SELECT address FROM lan_manual ORDER BY createdAt').all().map((r) => r.address)
export function lanAddManual(db, address, now) {
  q(db, 'INSERT OR IGNORE INTO lan_manual (address, createdAt) VALUES (?, ?)').run(address, new Date(now).toISOString())
}
export const lanRemoveManual = (db, address) => q(db, 'DELETE FROM lan_manual WHERE address = ?').run(address).changes > 0
export const lanForgetPeer = (db, deviceId) => q(db, 'DELETE FROM lan_peers WHERE deviceId = ?').run(deviceId).changes > 0

// Сколько чужих операций лежит поправкой — для экрана: «от соседей, сервер ещё не видел»
export const lanAppliedCount = (db) => q(db, "SELECT COUNT(*) AS n FROM lan_log WHERE kind = 'op' AND state = 'applied'").get().n
