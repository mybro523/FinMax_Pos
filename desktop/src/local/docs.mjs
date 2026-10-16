// ── Документы: чеки, возвраты, приходы, списания, погашения долга, смены, расходы ──
//
// Все лежат в одной таблице, каждый — в том виде, в каком его отдаёт сервер.
// Рядом с документом вынесено только то, по чему его ищут: дата, смена, чек,
// ключ повтора. Остальное читается из самого документа.
import { q } from './db.mjs'

export const KINDS = ['sale', 'return', 'arrival', 'writeoff', 'payment', 'shift', 'expense', 'cashmove', 'supplierpayment', 'income']

// За какой срок касса держит журналы у себя. Столько же по умолчанию отдаёт сервер
// (server/src/*/…service.ts) и столько же держит в памяти окно (client/src/db/store.js).
// Смены сервер отдаёт все — у них срока нет.
export const WINDOW_DAYS = { sale: 60, return: 180, arrival: 180, writeoff: 180, payment: 180, expense: 180, cashmove: 180, supplierpayment: 180, income: 180 }

// Какое поле документа считается его датой
const dateOf = (kind, body) => (kind === 'payment' ? body.createdAt : kind === 'shift' ? body.openedAt : body.date)

export function putDoc(db, kind, body, { sync = 'synced', deviceId = null } = {}) {
  q(
    db,
    `INSERT OR REPLACE INTO docs (kind, id, date, shiftId, saleId, clientId, deviceId, closedAt, body, sync)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    kind,
    body.id,
    dateOf(kind, body),
    kind === 'shift' ? null : body.shiftId ?? null,
    kind === 'return' ? body.saleId ?? null : null,
    // Ключ повтора есть у чека, возврата, расхода, дохода и движения наличных
    kind === 'sale' || kind === 'return' || kind === 'expense' || kind === 'cashmove' || kind === 'income' ? body.clientId ?? null : null,
    deviceId ?? body.deviceId ?? null,
    kind === 'shift' ? body.closedAt ?? null : null,
    JSON.stringify(body),
    sync,
  )
  return body
}

const parse = (row) => (row ? { ...row, body: JSON.parse(row.body) } : null)

export const getDoc = (db, kind, id) => parse(q(db, 'SELECT * FROM docs WHERE kind = ? AND id = ?').get(kind, id))

export const docByClientId = (db, kind, clientId) =>
  parse(q(db, 'SELECT * FROM docs WHERE kind = ? AND clientId = ?').get(kind, clientId))

// Список как у сервера: новые сверху. Тела склеиваются в один текст и разбираются
// одним заходом — на тысячах чеков это заметно быстрее, чем разбирать каждый.
function bodies(rows) {
  return rows.length ? JSON.parse('[' + rows.map((r) => r.body).join(',') + ']') : []
}

// Отвергнутое сервером в журналы и итоги не входит: оно снято с учёта (товар и долг
// вернулись к тому, что знает сервер) и остаётся на виду у владельца в списке «не
// принято сервером». Покажи журнал отвергнутый возврат — окно решило бы, что товар
// уже вернули; покажи отвергнутую смену — что она открыта
export function listDocs(db, kind, { from = null, to = null } = {}) {
  const rows = q(
    db,
    `SELECT body FROM docs
     WHERE kind = ? AND sync <> 'rejected' AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)
     ORDER BY date DESC, id DESC`,
  ).all(kind, from, from, to, to)
  return bodies(rows)
}

export const docsOfShift = (db, kind, shiftId) =>
  bodies(q(db, "SELECT body FROM docs WHERE kind = ? AND shiftId = ? AND sync <> 'rejected'").all(kind, shiftId))

// Возвраты по чеку — чтобы не вернуть больше купленного. Отвергнутый сервером возврат
// не в счёт: его нет нигде, кроме списка «не принято», и товар по нему не вернулся
export const returnsOfSale = (db, saleId) =>
  bodies(q(db, "SELECT body FROM docs WHERE kind = 'return' AND saleId = ? AND sync <> 'rejected'").all(saleId))

// ── Смены ──
// Открытая смена — у каждой кассы своя. Чужую открытую смену касса не показывает:
// иначе экран решил бы, что смена открыта здесь, и стал бы привязывать к ней чеки.
// Смена, открытие которой сервер отверг, открытой не считается: иначе касса вечно
// отвечала бы «смена уже открыта» и привязывала чеки к смене, которой на сервере нет.
export const myOpenShift = (db, deviceId) =>
  parse(
    q(
      db,
      "SELECT * FROM docs WHERE kind = 'shift' AND closedAt IS NULL AND deviceId = ? AND sync <> 'rejected' ORDER BY date DESC LIMIT 1",
    ).get(deviceId),
  )

export const listShifts = (db, deviceId) =>
  bodies(
    q(
      db,
      `SELECT body FROM docs
       WHERE kind = 'shift' AND sync <> 'rejected' AND (closedAt IS NOT NULL OR deviceId = ?)
       ORDER BY date DESC, id DESC`,
    ).all(deviceId),
  )

// Сколько документов сделано здесь и ещё не принято сервером
export const pendingDocs = (db) => q(db, "SELECT COUNT(*) AS n FROM docs WHERE sync = 'pending'").get().n

// ── Очередь на отправку ──
// Строка очереди пишется в той же транзакции, что и сама операция: не бывает ни
// продажи без строки в очереди, ни строки без продажи.
export function enqueue(db, { id, type, accountId, payload, now }) {
  q(db, 'INSERT INTO outbox (id, type, accountId, payload, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    type,
    accountId ?? null,
    JSON.stringify(payload),
    new Date(now).toISOString(),
  )
}

export const outboxPending = (db) => q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n
