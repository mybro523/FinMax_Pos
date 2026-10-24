// ── Поправки поверх данных сервера: справочники и правки документов ──
//
// Касса заводит и правит без интернета товары, поставщиков, категории, типы, статьи и
// сервисы перевода; правит и удаляет расходы, доходы, приходы, оплаты. Сервер о
// сделанном узнает позже — а свежие данные от него приходят и раньше (после обмена,
// который не дошёл до наших операций, или от соседней кассы). Поэтому сделанное
// хранится поправкой, а не просто правкой строки:
//
//   • строки справочников (row_edits): «завести» (put с row), «поменять поля» (put с set),
//     «убрать» (del), «переименовать во всех строках» (map). Данные сервера ложатся
//     основой, и поправки, которые сервер ещё не принял, проигрываются поверх заново —
//     так же, как журнал движений товара (stock.mjs);
//   • документы (tbl = 'doc:<вид>'): новое тело с пометкой «поправлен здесь» (edited)
//     или пометка «удалён здесь» (deleted). Такой документ данными сервера не заменяется
//     (snapshot.mjs), поэтому проигрывать его не нужно. Документ, заведённый здесь и ещё
//     не отправленный, после правки остаётся «ждущим» (pending): сервер получит его
//     заведение, а следом правку. «Поправлен» отличается от «ждущего» намеренно: суммы,
//     которые касса досчитывает за сервером (долг поставщику, расходы из кассы), берут
//     из «ждущих» документа целиком — а поправленный сервер уже знает, у него только
//     другая сумма (её разница — поправкой суммы, ниже);
//   • лист пересчёта (tbl = 'doc:inventory') — иначе: не тело целиком, а поправки по строкам
//     (action = 'lines'), которые лежат поверх копии сервера (sheet.mjs). Копия сервера
//     ложится основой всегда, а поправки, которых он ещё не видел, — поверх неё;
//   • суммы, которые сервер ведёт сам (adj_moves): долг поставщику, расходы и оплаты
//     поставщикам из ящика смены. Сумма = что сказал сервер + свои поправки.
//
// У каждой поправки есть «как было» (was): если сервер операцию отвергнет, строка и
// документ сразу возвращаются к прежнему виду — не дожидаясь, пока придут его данные.
import { q, setMeta } from './db.mjs'
import { putDoc } from './docs.mjs'
import { D, fromCents, toCents } from './money.mjs'
import { foldSheetEdit, SHEET_TBL } from './sheet.mjs'

// Какие столбцы можно трогать в каждой таблице. Поправка приходит и от соседней кассы
// по сети — писать в базу что попало нельзя
const COLS = {
  products: [
    'ord', 'name', 'barcode', 'category', 'type', 'priceC', 'minStock', 'unit', 'unitsPerPack', 'dosage', 'analogIds', 'image',
    'createdAt', 'sCostC', 'costC', 'sExpiry', 'expiryDate',
  ],
  categories: ['ord', 'name', 'noExpiry', 'createdAt'],
  product_types: ['name', 'analogs', 'createdAt'],
  pay_services: ['name', 'ord', 'createdAt'],
  expense_categories: ['name', 'createdAt'],
  income_categories: ['name', 'createdAt'],
  suppliers: ['name', 'phone', 'note', 'openingDebtC', 'sDebtC', 'debtArrivals', 'createdAt'],
  // Сотрудники и роли (1.4.16)
  staff: ['name', 'fullName', 'role', 'active', 'salaryC', 'bonusBp', 'salaryDay', 'createdAt'],
  team_accounts: ['login', 'role', 'roleId', 'roleName', 'active', 'userId', 'createdAt', 'ord'],
  team_roles: ['name', 'description', 'system', 'permissions', 'createdAt', 'ord'],
}
export const EDIT_TABLES = Object.keys(COLS)
// Виды документов, которые можно править и удалять поправкой
const DOC_KINDS = new Set(['expense', 'income', 'cashmove', 'supplierreturn', 'supplierpayment', 'arrival', 'inventory'])

// Суммы, которые ведёт сервер, и куда переходит поправка, когда он её принял
export const ADJ = { supplierDebt: 'supplierDebt', expenseCash: 'expenseCash', supplierCash: 'supplierCash' }

const parse = (s) => {
  if (s && typeof s === 'object') return s
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const iso = (now) => new Date(now).toISOString()
// В базу — только то, что SQLite умеет хранить: да/нет — числом, списки — текстом JSON
const dbValue = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v ?? null)

// ── Одна поправка → в базу ──
// Своя она или соседней кассы — неважно: лежит одинаково
export function applyRowEdit(db, e) {
  const data = parse(e.data) || {}
  if (typeof e.tbl === 'string' && e.tbl.startsWith('doc:')) return applyDocEdit(db, e.tbl.slice(4), e.rowId, e.action, data)
  const cols = COLS[e.tbl]
  if (!cols || typeof e.rowId !== 'string' || !e.rowId) return
  if (e.action === 'del') {
    q(db, `DELETE FROM ${e.tbl} WHERE id = ?`).run(e.rowId)
    // Товар убрали — его партии на полке больше не числятся
    if (e.tbl === 'products') q(db, 'DELETE FROM batches WHERE productId = ?').run(e.rowId)
    return
  }
  if (e.action === 'map') {
    if (!cols.includes(data.col) || data.from === undefined || data.to === undefined) return
    q(db, `UPDATE ${e.tbl} SET ${data.col} = ? WHERE ${data.col} = ?`).run(dbValue(data.to), dbValue(data.from))
    return
  }
  if (e.action !== 'put') return
  if (data.row && typeof data.row === 'object') {
    const keys = Object.keys(data.row).filter((k) => cols.includes(k))
    // Строка уже есть (сервер прислал её раньше, чем мы узнали, что он её принял) —
    // её не заменяем: серверная новее
    q(db, `INSERT OR IGNORE INTO ${e.tbl} (id${keys.map((k) => ', ' + k).join('')}) VALUES (?${keys.map(() => ', ?').join('')})`).run(
      e.rowId,
      ...keys.map((k) => dbValue(data.row[k])),
    )
  }
  if (data.set && typeof data.set === 'object') {
    const keys = Object.keys(data.set).filter((k) => cols.includes(k))
    if (keys.length) q(db, `UPDATE ${e.tbl} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => dbValue(data.set[k])), e.rowId)
  }
}

// Правка документа ложится только на документ, который здесь есть: из правки он не
// заводится (соседскую правку документа, которого здесь нет, applyPeerEdits не кладёт)
function applyDocEdit(db, kind, id, action, data) {
  if (!DOC_KINDS.has(kind) || typeof id !== 'string' || !id) return
  const cur = q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(kind, id)
  if (!cur) return
  // Заведение сервер отверг — документа у него не будет, и чужая правка его не воскрешает.
  // Состояние — выведенное, а не пометка в строке: удалённый здесь хранит «удалён»
  if (docState(db, kind, id) === 'rejected') return
  // Насчитанное в листе пересчёта лежит поверх основы (sheet.mjs) — тело не меняется,
  // меняется только состояние: «поправлен здесь» (или «ждущий», «от соседа», как было)
  if (action === 'lines') {
    if (kind === 'inventory') settleDoc(db, kind, id)
    return
  }
  if (action === 'put' && data.body && typeof data.body === 'object' && data.body.id === id) {
    // Документ удалили (здесь или на соседней кассе) — правка, пришедшая позже, его не
    // возвращает: сервер, получив удаление, правку уже не применит
    // Удаление, которое сервер уже принял, — не в счёт: если документ после него здесь, сервер
    // его оставил (позже его правили), и правки ложатся как обычно
    if (q(db, "SELECT 1 FROM row_edits WHERE tbl = ? AND rowId = ? AND action = 'del' AND synced = 0 LIMIT 1").get('doc:' + kind, id)) return
    // Заведён здесь и ещё не отправлен — остаётся «ждущим»; заведён соседней кассой и ещё не
    // дошёл до сервера — остаётся «от соседа»; иначе — «поправлен здесь» (docState)
    putDoc(db, kind, data.body, { sync: docState(db, kind, id), deviceId: data.deviceId ?? null })
  } else if (action === 'del') {
    // Документ остаётся в базе с пометкой «удалён здесь»: в журналы он не идёт, а если
    // сервер откажет — вернётся как был
    q(db, "UPDATE docs SET sync = 'deleted' WHERE kind = ? AND id = ?").run(kind, id)
  }
}

// ── Записать поправку и сразу выполнить ──
// Внутри транзакции операции: не бывает ни правки без поправки, ни поправки без правки
export function recordEdit(db, { opId, tbl, rowId, action, data, now }) {
  q(db, 'INSERT INTO row_edits (opId, tbl, rowId, action, data, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
    opId,
    tbl,
    rowId,
    action,
    JSON.stringify(data || {}),
    iso(now),
  )
  applyRowEdit(db, { tbl, rowId, action, data })
}

// Поправка документа: новое тело (put) или «удалён здесь» (del). Прежнее тело запоминается —
// по нему документ вернётся, если сервер откажет. Возвращает, в каком состоянии документ
// был: 'synced'/'edited' — сервер его знает (разницу сумм тогда надо досчитать поправкой),
// 'pending' или 'peer' — сервер его ещё не знает: сумма идёт из самого документа, а когда
// сервер его узнает, разница правки станет поправкой сама (docKnown)
export function recordDocEdit(db, { opId, kind, body, del = false, now }) {
  const row = q(db, 'SELECT body, sync, deviceId FROM docs WHERE kind = ? AND id = ?').get(kind, body.id)
  const was = row ? JSON.parse(row.body) : null
  const data = { was, deviceId: row?.deviceId ?? null, ...(del ? {} : { body }) }
  recordEdit(db, { opId, tbl: 'doc:' + kind, rowId: body.id, action: del ? 'del' : 'put', data, now })
  return row?.sync ?? null
}

// Знает ли сервер документ в нынешнем виде (а значит, и его суммы)
export const serverKnows = (sync) => sync === 'synced' || sync === 'edited'

// ── Проиграть поправки заново ──
// Свежие данные сервера легли в таблицы — накладываем поверх всё, что он ещё не принял,
// в том же порядке, в каком делалось
export function replayEdits(db, tbls) {
  const list = (tbls || []).filter((t) => COLS[t])
  if (!list.length) return 0
  const rows = q(db, `SELECT * FROM row_edits WHERE synced = 0 AND tbl IN (${list.map(() => '?').join(', ')}) ORDER BY seq`).all(...list)
  for (const e of rows) applyRowEdit(db, e)
  return rows.length
}

// Есть ли неотправленные поправки строки — например, товар заведён здесь и сервер его
// ещё не знает
export const pendingRowEdit = (db, tbl, rowId) => !!q(db, 'SELECT 1 FROM row_edits WHERE synced = 0 AND tbl = ? AND rowId = ? LIMIT 1').get(tbl, rowId)

// ── Поправки сумм ──
export function adjMove(db, { opId, target, rowId, deltaC, now }) {
  if (!deltaC || !rowId) return
  q(db, 'INSERT INTO adj_moves (opId, target, rowId, deltaC, createdAt) VALUES (?, ?, ?, ?, ?)').run(opId, target, rowId, Math.trunc(deltaC), iso(now))
}

// Сколько своих (и соседских) неотправленных поправок у суммы, в дирамах
export const adjSum = (db, target, rowId) =>
  q(db, 'SELECT COALESCE(SUM(deltaC), 0) AS c FROM adj_moves WHERE synced = 0 AND target = ? AND rowId = ?').get(target, rowId).c

export function adjByRow(db, target) {
  const rows = q(db, 'SELECT rowId, SUM(deltaC) AS c FROM adj_moves WHERE synced = 0 AND target = ? GROUP BY rowId').all(target)
  return new Map(rows.map((r) => [r.rowId, r.c]))
}

// ── Ждёт ли документ ещё чего-то в очереди ──
// Документ меняют несколько операций: завели, поправили, удалили. Пока хоть одна из них
// не принята, документ остаётся «ждущим» — иначе данные сервера заменили бы правку,
// которую он ещё не видел
export function docStillQueued(db, kind, id, exceptOpId) {
  return !!q(
    db,
    `SELECT 1 FROM outbox WHERE state = 'pending' AND id <> ?
       AND json_extract(payload, '$.ref.kind') = ? AND json_extract(payload, '$.ref.id') = ? LIMIT 1`,
  ).get(exceptOpId, kind, id)
}

// ── В каком состоянии документ должен быть сейчас ──
// Состояние выводится из того, что ждёт отправки, а не из пометки, запомненной при правке:
// к моменту ответа сервера она могла устареть (заведение уже принято, а правка отвергнута;
// документ завела соседняя касса и её операцию уже подтвердили). Порядок проверок важен:
//   • своё заведение сервер отверг — «отвергнутый»;
//   • удаление ждёт отправки — «удалён здесь» (даже если заведение ещё ждёт отправки и
//     какая бы правка ни легла после: в журналах и суммах удалённого нет);
//   • своё заведение ещё в очереди — «ждущий» (сумма идёт из самого документа);
//   • документ соседней кассы, которого сервер ещё не знает, — «от соседа»;
//   • есть неотправленные правки — «поправлен здесь»; иначе — обычный, как у сервера
const CREATED_BY = {
  expense: ['expense', '$.expense.id'],
  income: ['income', '$.income.id'],
  cashmove: ['cash.move', '$.move.id'],
  supplierreturn: ['supplier.return', '$.ret.id'],
  supplierpayment: ['supplier.pay', '$.payment.id'],
  arrival: ['arrival', '$.arrival.id'],
  inventory: ['inventory.create', '$.inventory.id'],
}
function creationIn(db, kind, id, states) {
  const by = CREATED_BY[kind]
  if (!by) return false
  return !!q(
    db,
    `SELECT 1 FROM outbox WHERE type = ? AND state IN (${states.map(() => '?').join(', ')}) AND json_extract(payload, '${by[1]}') = ? LIMIT 1`,
  ).get(by[0], ...states, id)
}
// Документ завела соседняя касса, и её операция лежит у нас поправкой (сервер её ещё не принял)
export const peerDocWaiting = (db, kind, id) =>
  !!q(db, "SELECT 1 FROM lan_docs d JOIN lan_log l ON l.id = d.opId WHERE d.kind = ? AND d.id = ? AND l.kind = 'op' AND l.state = 'applied' LIMIT 1").get(kind, id)

export function docState(db, kind, id) {
  if (creationIn(db, kind, id, ['rejected', 'dismissed'])) return 'rejected'
  // Удаление ждёт отправки — документ удалён, какая бы правка ни легла после
  if (q(db, "SELECT 1 FROM row_edits WHERE tbl = ? AND rowId = ? AND synced = 0 AND action = 'del' LIMIT 1").get('doc:' + kind, id)) return 'deleted'
  const last = q(db, 'SELECT action FROM row_edits WHERE tbl = ? AND rowId = ? AND synced = 0 ORDER BY seq DESC LIMIT 1').get('doc:' + kind, id)
  if (creationIn(db, kind, id, ['pending'])) return 'pending'
  if (peerDocWaiting(db, kind, id)) return 'peer'
  return last ? 'edited' : 'synced'
}

// ── Деньги из ящика смены, отданные с неотправленными приходами ──
// Оплату, записанную с приходом, сервер заведёт, приняв сам приход, — и не отменит, даже
// если приход потом удалят или поправят (здесь или на соседней кассе). Поэтому она числится
// за сменой, пока заведение прихода ждёт отправки, — по самой операции заведения, в каком бы
// виде ни был документ. В дирамах
export function unsentPaidCash(db, shiftId) {
  let c = 0
  for (const r of q(db, "SELECT payload FROM outbox WHERE type = 'arrival' AND state = 'pending' AND json_extract(payload, '$.arrival.shiftId') = ?").all(shiftId)) {
    c += toCents(parse(r.payload)?.arrival?.paidCash || 0)
  }
  return c
}
const settleDoc = (db, kind, id) => q(db, 'UPDATE docs SET sync = ? WHERE kind = ? AND id = ?').run(docState(db, kind, id), kind, id)

// ── Чем документ, которого сервер ещё не знает, входит в суммы сервера ──
// Такой документ касса досчитывает к суммам сама, целиком (suppliers.mjs, ops/expense.mjs).
// Деньги, взятые из ящика на приход, сюда не входят: оплату, записанную с приходом, его
// правка и удаление на сервере не трогают
const DOC_SUMS = {
  expense: (b) => (b?.fromCash && b.shiftId ? [[ADJ.expenseCash, b.shiftId, toCents(b.amount || 0)]] : []),
  arrival: (b) => (b?.supplierId && Number(b.debt) > 0 ? [[ADJ.supplierDebt, b.supplierId, toCents(b.debt)]] : []),
  supplierreturn: (b) => (b?.supplierId && b.refund === 'debt' && Number(b.total) > 0 ? [[ADJ.supplierDebt, b.supplierId, -toCents(b.total)]] : []),
}
export const EDITABLE_DOC_KINDS = DOC_KINDS

// ── Сервер узнал документ ──
// Заведение принято (своё — ackOp, соседское — подтверждено, lan.mjs). До этой минуты
// документ входил в суммы целиком, своим нынешним телом. Теперь сервер знает его таким,
// каким его заводили, а правки, сделанные после (свои и соседские), — ещё нет. Разница
// каждой правки становится поправкой суммы этой правки: примут — перейдёт в сумму сервера,
// отвергнут — уйдёт вместе с ней.
// fold — своё заведение: то, что сервер прибавил, сразу переходит в его сумму (до его
// следующего ответа она иначе «просела» бы). Соседское — нет: данные сервера, которые
// подтверждают операцию, приходят уже с ней
// created — каким документ получил сервер (тело из самой операции заведения). Без него — по
// первой ждущей правке («как было» до неё) или нынешнее тело
export function docKnown(db, kind, id, { fold = false, created: sent = null, now = Date.now() } = {}) {
  const row = q(db, 'SELECT body, sync FROM docs WHERE kind = ? AND id = ?').get(kind, id)
  const edits = q(db, 'SELECT * FROM row_edits WHERE tbl = ? AND rowId = ? AND synced = 0 ORDER BY seq').all('doc:' + kind, id)
  const created = sent && typeof sent === 'object' ? sent : edits.length ? (parse(edits[0].data) || {}).was : row ? JSON.parse(row.body) : null
  const sums = DOC_SUMS[kind]
  if (sums && created && typeof created === 'object') {
    if (fold) {
      for (const [target, rowId, c] of sums(created)) foldSum(db, target, rowId, c)
      // Деньги из ящика, отданные с приходом, — тоже к серверу: оплату он завёл вместе с приходом
      if (kind === 'arrival' && created.shiftId && Number(created.paidCash) > 0) foldSum(db, ADJ.supplierCash, created.shiftId, toCents(created.paidCash))
    }
    for (const e of edits) {
      // Правку сделали, когда сервер уже знал документ (на соседней кассе — её заведение там
      // уже приняли): своя поправка суммы у неё уже есть
      if (q(db, 'SELECT 1 FROM adj_moves WHERE opId = ? AND synced = 0 LIMIT 1').get(e.opId)) continue
      editSumAdj(db, kind, e.opId, e.action, parse(e.data) || {}, now)
    }
  }
  if (row && row.sync !== 'rejected') settleDoc(db, kind, id)
}

// Разница одной правки в суммах сервера — поправкой этой правки: стало минус было
function editSumAdj(db, kind, opId, action, d, now) {
  const sums = DOC_SUMS[kind]
  if (!sums) return
  const delta = new Map()
  const add = (list, sign) => {
    for (const [target, rowId, c] of list) delta.set(target + '|' + rowId, (delta.get(target + '|' + rowId) || 0) + sign * c)
  }
  add(sums(d.was), -1)
  if (action !== 'del') add(sums(d.body), 1)
  for (const [key, c] of delta) {
    const [target, rowId] = key.split('|')
    adjMove(db, { opId, target, rowId, deltaC: c, now })
  }
}

// ── Сервер принял операцию ──
// Её поправки больше не проигрываются: следующие данные сервера придут уже с ними.
// Поправки сумм своей операции переходят в то, что знает сервер (иначе до его ответа
// сумма «просела» бы). У операции соседней кассы (fold: false) — нет: данные сервера, по
// которым её подтвердили, сняты после приёма и уже содержат её.
// applied: false — сервер операцию принял, но ничего не сделал (запись уже удалили, чужая
// правка оказалась новее): тогда своя строка не верна, и касса просит всё заново
export function ackEdits(db, opId, { applied = true, fold = true } = {}) {
  const edits = q(db, 'SELECT * FROM row_edits WHERE opId = ? AND synced = 0 ORDER BY seq').all(opId)
  q(db, 'UPDATE row_edits SET synced = 1 WHERE opId = ?').run(opId)
  for (const e of edits) {
    if (!e.tbl.startsWith('doc:')) continue
    const kind = e.tbl.slice(4)
    // Своё насчитанное в листе сервер принял — оно в основу листа до его следующего ответа.
    // Соседское — нет: данные сервера, по которым его подтвердили, уже с ним
    if (e.tbl === SHEET_TBL && e.action === 'lines' && fold && applied) foldSheetEdit(db, e.rowId, parse(e.data) || {})
    if (e.action === 'del') q(db, "DELETE FROM docs WHERE kind = ? AND id = ? AND sync = 'deleted'").run(kind, e.rowId)
    else if (q(db, "SELECT 1 FROM docs WHERE kind = ? AND id = ? AND sync IN ('pending', 'peer', 'edited', 'synced')").get(kind, e.rowId)) settleDoc(db, kind, e.rowId)
  }
  // Сервер ничего не сделал — и в его суммах ничего не прибавилось
  if (fold && applied) for (const a of q(db, 'SELECT * FROM adj_moves WHERE opId = ? AND synced = 0').all(opId)) foldSum(db, a.target, a.rowId, a.deltaC)
  q(db, 'UPDATE adj_moves SET synced = 1 WHERE opId = ?').run(opId)
  if (!applied && edits.length) setMeta(db, 'needFull', '1')
  return edits.length
}

// Сумма, принятая сервером, — в то, что он знает. Долг, которого касса не знает (его
// получал кассир), не трогаем. У смены — только открытая и известная серверу: закрытая
// здесь и ждущая отправки уже посчитана со всем своим
function foldSum(db, target, rowId, deltaC) {
  if (!deltaC || !rowId) return
  if (target === ADJ.supplierDebt) {
    q(db, 'UPDATE suppliers SET sDebtC = sDebtC + ? WHERE id = ? AND sDebtC IS NOT NULL').run(deltaC, rowId)
    return
  }
  if (target === ADJ.expenseCash || target === ADJ.supplierCash) {
    const row = q(db, "SELECT body FROM docs WHERE kind = 'shift' AND id = ? AND sync = 'synced' AND closedAt IS NULL").get(rowId)
    if (!row) return
    const body = JSON.parse(row.body)
    body[target] = Math.max(0, fromCents(toCents(D(body[target] || 0).plus(D(deltaC).dividedBy(100)))))
    q(db, "UPDATE docs SET body = ? WHERE kind = 'shift' AND id = ?").run(JSON.stringify(body), rowId)
  }
}

// ── Сервер отверг операцию (или чужая так и не дошла до него) ──
// Снимаем её поправки и сразу возвращаем строки и документы к прежнему виду — с конца,
// чтобы несколько правок одной строки откатились правильно. Документ получает прежнее тело,
// только если после этой правки его не правили ещё раз (иначе он уже несёт ту, позднюю,
// правку), а состояние — заново, по очереди (docState). Данные сервера, которые придут
// следом (касса попросит всё заново), поправят остальное
export function undoEdits(db, opId) {
  const edits = q(db, 'SELECT * FROM row_edits WHERE opId = ? AND synced = 0 ORDER BY seq DESC').all(opId)
  const docs = new Map()
  for (const e of edits) {
    const data = parse(e.data) || {}
    if (e.tbl.startsWith('doc:')) {
      const kind = e.tbl.slice(4)
      // Лист пересчёта: поправка лежала поверх основы — без неё лист сразу такой, как был
      if (e.tbl === SHEET_TBL) {
        docs.set(kind + '|' + e.rowId, [kind, e.rowId])
        continue
      }
      const later = q(db, 'SELECT 1 FROM row_edits WHERE tbl = ? AND rowId = ? AND synced = 0 AND opId <> ? AND seq > ? LIMIT 1').get(e.tbl, e.rowId, opId, e.seq)
      if (!later) {
        if (data.was && data.was.id === e.rowId) putDoc(db, kind, data.was, { sync: 'synced', deviceId: data.deviceId ?? null })
        else q(db, "DELETE FROM docs WHERE kind = ? AND id = ? AND sync IN ('pending', 'peer', 'deleted', 'edited')").run(kind, e.rowId)
      }
      docs.set(kind + '|' + e.rowId, [kind, e.rowId])
      continue
    }
    const cols = COLS[e.tbl]
    if (!cols) continue
    if (e.action === 'put' && data.row) {
      q(db, `DELETE FROM ${e.tbl} WHERE id = ?`).run(e.rowId)
      if (e.tbl === 'products') q(db, 'DELETE FROM batches WHERE productId = ?').run(e.rowId)
    } else if (e.action === 'put' && data.was && typeof data.was === 'object') {
      applyRowEdit(db, { tbl: e.tbl, rowId: e.rowId, action: 'put', data: { set: data.was } })
    } else if (e.action === 'del' && data.wasRow && typeof data.wasRow === 'object') {
      applyRowEdit(db, { tbl: e.tbl, rowId: e.rowId, action: 'put', data: { row: data.wasRow } })
    } else if (e.action === 'map') {
      applyRowEdit(db, { tbl: e.tbl, rowId: e.rowId, action: 'map', data: { col: data.col, from: data.to, to: data.from } })
    }
  }
  q(db, 'DELETE FROM row_edits WHERE opId = ? AND synced = 0').run(opId)
  q(db, 'DELETE FROM adj_moves WHERE opId = ? AND synced = 0').run(opId)
  // Состояние — когда поправок этой операции уже нет
  for (const [kind, id] of docs.values()) {
    const cur = q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(kind, id)
    if (cur && cur.sync !== 'rejected') settleDoc(db, kind, id)
  }
  return edits.length
}

// ── Для обмена по местной сети ──
// Что сделала операция: поправки строк и сумм — в том виде, в каком их положит сосед
export function editsOf(db, opId) {
  const rows = q(db, 'SELECT tbl, rowId, action, data FROM row_edits WHERE opId = ? ORDER BY seq').all(opId).map((e) => ({ ...e, data: parse(e.data) || {} }))
  const adj = q(db, 'SELECT target, rowId, deltaC FROM adj_moves WHERE opId = ? ORDER BY seq').all(opId)
  return { rows, adj }
}

// Положить поправки соседней кассы: с номером её операции, как свои неотправленные.
//
// Поправку суммы у правки документа (расход из кассы, приход в долг, возврат в счёт долга)
// решает то, каким документ знает ЭТА касса, а не та, где правили: там заведение могли уже
// принять, а здесь его ещё ждут, — и наоборот. Знает сервер документ здесь — разница правки
// ложится поправкой; ещё не знает (свой неотправленный или соседский) — сумма идёт из тела
// документа, а когда сервер его узнает, разница станет поправкой сама (docKnown). Документа
// здесь нет вовсе — берётся поправка, которую посчитала касса, где правили
const ADJ_TARGETS = new Set(Object.values(ADJ))
const validRow = (e) =>
  !!e &&
  typeof e.tbl === 'string' &&
  typeof e.rowId === 'string' &&
  (['put', 'del', 'map'].includes(e.action) || (e.action === 'lines' && e.tbl === SHEET_TBL)) &&
  !!(COLS[e.tbl] || (e.tbl.startsWith('doc:') && DOC_KINDS.has(e.tbl.slice(4))))
const sumKind = (e) => (e.tbl.startsWith('doc:') && DOC_SUMS[e.tbl.slice(4)] ? e.tbl.slice(4) : null)

export function applyPeerEdits(db, opId, { rows = [], adj = [] } = {}, now) {
  const changed = new Set()
  let shipped = true
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!validRow(e)) continue
    // Правка документа, которого здесь нет (давний, за пределами журналов кассы; заведение
    // соседа, отвергнутое сервером; ещё не дошедшее через третью кассу): документ из неё не
    // заводится. Его поправка суммы — та, что посчитала касса, где правили (ниже)
    // Насчитанное в листе пересчёта — исключение: оно лежит поправкой поверх листа и ляжет,
    // когда лист придёт (с сервера или от соседа), — иначе пересчёт соседа терялся бы навсегда
    if (e.tbl.startsWith('doc:') && e.tbl !== SHEET_TBL && !q(db, 'SELECT 1 FROM docs WHERE kind = ? AND id = ?').get(e.tbl.slice(4), e.rowId)) continue
    // Документ уже удалили (здесь или другой правкой) — правка, пришедшая позже, не кладётся:
    // сервер, получив удаление, её не применит, а лишняя поправка путала бы состояние документа
    if (e.tbl.startsWith('doc:') && q(db, "SELECT 1 FROM row_edits WHERE tbl = ? AND rowId = ? AND action = 'del' AND synced = 0 LIMIT 1").get(e.tbl, e.rowId)) continue
    const kind = sumKind(e)
    const cur = kind ? q(db, 'SELECT sync FROM docs WHERE kind = ? AND id = ?').get(kind, e.rowId) : null
    q(db, 'INSERT INTO row_edits (opId, tbl, rowId, action, data, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      opId,
      e.tbl,
      e.rowId,
      e.action,
      JSON.stringify(e.data || {}),
      iso(now),
    )
    applyRowEdit(db, e)
    changed.add(e.tbl)
    if (kind && cur) {
      shipped = false
      if (cur.sync === 'synced' || cur.sync === 'edited') {
        editSumAdj(db, kind, opId, e.action, e.data || {}, now)
        changed.add(kind === 'expense' ? ADJ.expenseCash : ADJ.supplierDebt)
      }
    }
  }
  if (shipped) {
    for (const a of Array.isArray(adj) ? adj : []) {
      if (!a || !ADJ_TARGETS.has(a.target) || typeof a.rowId !== 'string' || !Number.isInteger(a.deltaC)) continue
      adjMove(db, { opId, target: a.target, rowId: a.rowId, deltaC: a.deltaC, now })
      changed.add(a.target)
    }
  }
  return changed
}

// ── Урезанная запись соседа пришла целиком ──
// Поправки уже лежат — без денег магазина. Их не снимают и не кладут заново (тогда они
// встали бы после правок, сделанных здесь позже, и перекрыли бы их), а дополняют на месте:
// у строк — полные данные, у поставщика — долг; чего в урезанной не было вовсе (документы с
// деньгами) — ложится как обычная поправка соседа. moneyCols — денежные столбцы поставщика
export function completePeerEdits(db, opId, { rows = [], adj = [] } = {}, now, moneyCols = []) {
  const have = q(db, 'SELECT seq, tbl, rowId, action FROM row_edits WHERE opId = ? AND synced = 0 ORDER BY seq').all(opId)
  const used = new Set()
  const changed = new Set()
  const fresh = []
  let decided = false
  for (const e of Array.isArray(rows) ? rows : []) {
    if (!validRow(e)) continue
    const match = have.find((h) => !used.has(h.seq) && h.tbl === e.tbl && h.rowId === e.rowId && h.action === e.action)
    if (!match) {
      fresh.push(e)
      continue
    }
    used.add(match.seq)
    q(db, 'UPDATE row_edits SET data = ? WHERE seq = ?').run(JSON.stringify(e.data || {}), match.seq)
    if (sumKind(e)) decided = true
    if (e.tbl === 'suppliers' && e.action === 'put') {
      const src = (e.data && (e.data.row || e.data.set)) || {}
      const money = Object.fromEntries(Object.entries(src).filter(([k]) => moneyCols.includes(k)))
      if (Object.keys(money).length) {
        applyRowEdit(db, { tbl: 'suppliers', rowId: e.rowId, action: 'put', data: { set: money } })
        changed.add('suppliers')
      }
    }
  }
  // Сумму правки, документ которой уже лежал здесь, решили, когда она легла (applyPeerEdits)
  for (const t of applyPeerEdits(db, opId, { rows: fresh, adj: decided ? [] : adj }, now)) changed.add(t)
  return changed
}
