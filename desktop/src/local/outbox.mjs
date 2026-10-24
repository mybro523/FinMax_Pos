// ── Очередь на отправку: что делать с ответом сервера ──
//
// Каждая операция кассы лежит в очереди со своим номером, пока сервер не скажет,
// что принял её. Здесь — три события в жизни операции:
//   • отправили (ещё не знаем, дошла ли) — запоминаем сам факт попытки;
//   • сервер принял — всё, что касса держала «поверх» серверных данных, гасится:
//     дальше остаток, долг и сам документ придут уже от сервера, с этой операцией внутри;
//   • сервер отверг — сделанное снимается с учёта и остаётся на виду как отвергнутое.
import { q, setMeta } from './db.mjs'
import { ackEdits, ADJ, adjSum, docKnown, docStillQueued, EDITABLE_DOC_KINDS, undoEdits, unsentPaidCash } from './edits.mjs'
import { D, fromCents, fromCentsD, toCents } from './money.mjs'

// ── Справочники и правки документов, сделанные без связи (версия 1.4.14) ──
// Справочники: строка ложится поправкой (edits.mjs)
export const REF_OPS = new Set([
  'product.create', 'product.update', 'product.delete',
  'category.create', 'category.update', 'category.delete',
  'productType.create', 'productType.update', 'productType.delete',
  'payService.create', 'payService.delete',
  'expenseCategory.create', 'expenseCategory.delete',
  'incomeCategory.create', 'incomeCategory.delete',
  'supplier.create', 'supplier.update', 'supplier.delete',
])
// Правки и удаления документов: документ назван в операции (ref)
export const DOC_EDIT_OPS = new Set([
  'supplierPayment.delete', 'supplierReturn.delete', 'expense.update', 'expense.delete', 'income.update', 'income.delete',
  'cashMove.delete', 'arrival.update', 'arrival.delete',
])
// Какую запись завела операция «завести» — по ней видно, не принял ли сервер её как уже
// существующую (такую же завели на сайте): тогда своя строка не нужна
function createdIdOf(op) {
  const p = op.payload || {}
  switch (op.type) {
    case 'product.create':
      return p.product?.id
    case 'category.create':
      return p.category?.id
    case 'productType.create':
      return p.type?.id
    case 'payService.create':
      return p.service?.id
    case 'expenseCategory.create':
    case 'incomeCategory.create':
      return p.category?.id
    case 'supplier.create':
      return p.supplier?.id
    default:
      return null
  }
}

// Что ждёт отправки, по порядку. Порядок — это порядок, в котором всё происходило:
// возврат не может уйти раньше своего чека.
export function pendingOps(db, limit = 50) {
  return q(db, "SELECT * FROM outbox WHERE state = 'pending' ORDER BY seq LIMIT ?")
    .all(limit)
    .map((o) => ({ ...o, payload: JSON.parse(o.payload) }))
}

export const pendingCount = (db) => q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n
export const rejectedCount = (db) => q(db, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'rejected'").get().n

// Были ли операции, которые уже отправляли, но ответа не получили. Пока такие есть,
// спрашивать у сервера свежие данные нельзя: он мог их принять, и тогда они
// посчитались бы дважды — в его остатке и в нашем журнале.
export const hasUnconfirmed = (db) => !!q(db, "SELECT 1 FROM outbox WHERE state = 'pending' AND attempts > 0 LIMIT 1").get()

// Операции, которые хоть раз уходили на сервер и всё ещё ждут: принял ли он их,
// касса не знает (ответ мог потеряться). О них она спрашивает при каждом обмене —
// и сервер отвечает из того же состояния базы, из которого отдаёт данные.
// Отметка «уходила» (nextTryAt) не снимается никогда: сброс счётчика попыток после
// отказа во входе не должен стереть память о более ранней отправке без ответа
export function sentOps(db, limit = 100) {
  return q(db, "SELECT * FROM outbox WHERE state = 'pending' AND nextTryAt IS NOT NULL ORDER BY seq LIMIT ?")
    .all(limit)
    .map((o) => ({ ...o, payload: JSON.parse(o.payload) }))
}

export function markAttempt(db, ops, now) {
  const at = new Date(now).toISOString()
  const st = q(db, 'UPDATE outbox SET attempts = attempts + 1, nextTryAt = ? WHERE id = ?')
  db.transaction(() => ops.forEach((o) => st.run(at, o.id)))()
}

// Сервер ответил по этим операциям определённо (принял, отверг или не смог записать
// и откатил). Неизвестности больше нет — счётчик попыток «без ответа» снимается
export function clearAttempts(db, ops) {
  const st = q(db, "UPDATE outbox SET attempts = 0 WHERE id = ? AND state = 'pending'")
  db.transaction(() => ops.forEach((o) => st.run(o.id)))()
}

// Какие документы создала операция: [вид, номер]. Нужно и обмену кассами по местной
// сети (lan.mjs): он передаёт соседям документы операции вместе с ней
export function docsOf(op) {
  const p = op.payload || {}
  switch (op.type) {
    case 'sale':
      return [['sale', p.sale?.id]]
    case 'return':
      return [['return', p.ret?.id], ...(p.writeOff ? [['writeoff', p.writeOff.id]] : [])]
    case 'writeoff':
      return [['writeoff', p.writeOff?.id]]
    case 'arrival':
      return [['arrival', p.arrival?.id]]
    case 'shift.open':
    case 'shift.close':
      return [['shift', p.shift?.id]]
    case 'debt.pay':
      return [['payment', p.payment?.id]]
    case 'expense':
      return [['expense', p.expense?.id]]
    case 'income':
      return [['income', p.income?.id]]
    case 'cash.move':
      return [['cashmove', p.move?.id]]
    case 'supplier.return':
      return [['supplierreturn', p.ret?.id]]
    case 'supplier.pay':
      return [['supplierpayment', p.payment?.id]]
    default:
      // Правка или удаление документа: он назван в самой операции
      return DOC_EDIT_OPS.has(op.type) && p.ref?.kind && p.ref?.id ? [[p.ref.kind, p.ref.id]] : []
  }
}

// ── Документ, заведённый здесь, принят сервером ──
// Расход из кассы, приход в долг, возврат поставщику «в счёт долга»: суммы, которые
// сервер ведёт сам (расходы из кассы в смене, долг поставщику), он, приняв документ, уже
// поменял. Касса до сих пор досчитывала документ к ним сама — как «своё неотправленное»
// (ops/expense.mjs, suppliers.mjs). С этой минуты прибавка переходит в сумму, известную от
// сервера: иначе до его следующего ответа (а связь может оборваться сразу после отправки)
// документ не числился бы нигде. Свежая копия с сервера потом заменит сумму своей — такой же.
// Если документ успели поправить или удалить, а правка ещё ждёт, — сервер знает его в
// прежнем виде, и разница правки становится её поправкой суммы (edits.mjs, docKnown).
//
// Смена — только открытая и известная серверу: закрытая здесь и ждущая отправки уже
// посчитана со всем своим; закрытую на сервере он пересчитает сам. Долг, которого касса не
// знает (его получал кассир), не трогаем

// Каким документ получил сервер — тело из самой операции заведения: правки, сделанные
// после, могли уже поменять и отменить его здесь
function sentBody(op, kind) {
  const p = op.payload || {}
  if (kind === 'expense') return p.expense ?? null
  if (kind === 'arrival') return p.arrival ?? null
  if (kind === 'supplierreturn') return p.ret ?? null
  return null
}

// Ждёт ли этот документ ещё чего-то в очереди. Смену меняют две операции: открытие и
// закрытие; остальные документы — заведение и следом правка или удаление (edits.mjs)
function stillQueued(db, kind, id, exceptOpId) {
  if (kind !== 'shift') return docStillQueued(db, kind, id, exceptOpId)
  return !!q(
    db,
    `SELECT 1 FROM outbox WHERE state = 'pending' AND id <> ? AND type IN ('shift.open', 'shift.close')
       AND json_extract(payload, '$.shift.id') = ? LIMIT 1`,
  ).get(exceptOpId, id)
}

// ── Сервер принял операцию ──
// fate — что он о ней сказал. docId: null значит «принял, но документа не завёл»:
// списывать оказалось нечего, штрихкод уже стал товаром
export function ackOp(db, op, fate = null) {
  const noDoc = !!fate && fate.docId === null
  db.transaction(() => {
    // Повторное «принято» (ответ пришёл и на отправку, и на вопрос о судьбе) ничего не меняет:
    // суммы документа уже перешли к серверу при первом
    const first = q(db, 'SELECT state FROM outbox WHERE id = ?').get(op.id)?.state !== 'done'
    // Поправки справочников и правки документов. Сервер принял операцию, но ничего не
    // сделал (запись уже удалили, чужая правка новее) или принял заведение как уже
    // существующую запись — тогда своя строка не верна, и касса заберёт всё заново.
    // Отметка 'noop' в строке очереди уходит и соседним кассам (lan.mjs): их копия правки
    // тоже не верна
    const made = createdIdOf(op)
    const merged = !!made && !!fate?.docId && fate.docId !== made
    const applied = !(noDoc && (REF_OPS.has(op.type) || DOC_EDIT_OPS.has(op.type))) && !merged
    q(db, "UPDATE outbox SET state = 'done', error = ? WHERE id = ?").run(applied ? null : 'noop', op.id)
    // Движения остатка и долга больше не «наши неотправленные»: сервер учёл их у себя,
    // и его следующий ответ придёт уже с ними
    q(db, 'UPDATE stock_moves SET synced = 1 WHERE opId = ?').run(op.id)
    q(db, 'UPDATE debt_moves SET synced = 1 WHERE opId = ?').run(op.id)
    ackEdits(db, op.id, { applied })
    if (!DOC_EDIT_OPS.has(op.type) && first) {
      for (const [kind, id] of docsOf(op)) {
        if (!id) continue
        // Документ, который можно править: суммы и состояние — см. выше
        if (EDITABLE_DOC_KINDS.has(kind)) docKnown(db, kind, id, { fold: true, created: sentBody(op, kind) })
        else if (!stillQueued(db, kind, id, op.id)) {
          q(db, "UPDATE docs SET sync = 'synced' WHERE kind = ? AND id = ? AND sync = 'pending'").run(kind, id)
        }
      }
    }
    const p = op.payload || {}
    if (op.type === 'customer.create' && p.customer?.id) q(db, 'UPDATE customers SET local = 0 WHERE id = ?').run(p.customer.id)
    if (op.type === 'deferred.add' && p.deferred?.id) {
      // Сервер штрихкод не завёл (товар с ним уже есть) — у кассы ему тоже не место
      if (noDoc) q(db, 'DELETE FROM deferred WHERE id = ?').run(p.deferred.id)
      else q(db, "UPDATE deferred SET sync = 'synced' WHERE id = ? AND sync = 'pending'").run(p.deferred.id)
    }
    // Убранный штрихкод сервер тоже убрал — отметка «убран здесь» больше не нужна
    if (op.type === 'deferred.remove' && p.id) q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'deleted'").run(p.id)
    // Списание сервер принял, но документа не завёл: остаток пересчитали раньше, чем
    // оно дошло, или списывать было уже нечего. В журнале кассы ему оставаться незачем
    if (op.type === 'writeoff' && noDoc && p.writeOff?.id) q(db, "DELETE FROM docs WHERE kind = 'writeoff' AND id = ?").run(p.writeOff.id)
    // Остаток и долг пересчитаются при ближайшем обмене — от того, что знает сервер.
    // Обычно его ответ и так приносит товар с этой операцией внутри. Но сервер мог
    // принять операцию, не тронув остаток (его пересчитали раньше, чем она дошла):
    // тогда товар в ответе не придёт, и без пересчёта поправка кассы так и осталась
    // бы наложенной — остаток на кассе разошёлся бы с сервером
    setMeta(db, 'needRebuild', '1')
  })()
}

// Отказы в закрытии смены, после которых открывать её здесь заново нельзя: такой
// смены для этой кассы у сервера нет. Тексты — слово в слово как у сервера
// (server/src/sync/sync.service.ts, applyShiftClose); меняются только вместе с ним.
// Незнакомый текст считается обычным отказом: смена у сервера есть и открыта
export const SHIFT_GONE = ['Смена не найдена', 'Эта смена открыта на другой кассе']

// ── Сервер отверг операцию ──
// Повторять её бессмысленно. Движения снимаются с учёта (остаток и долг вернутся к
// тому, что знает сервер), а документ остаётся с пометкой — владелец должен его увидеть.
export function rejectOp(db, op, error) {
  db.transaction(() => {
    q(db, "UPDATE outbox SET state = 'rejected', error = ? WHERE id = ?").run(String(error || '').slice(0, 500), op.id)
    q(db, 'DELETE FROM stock_moves WHERE opId = ? AND synced = 0').run(op.id)
    q(db, 'DELETE FROM debt_moves WHERE opId = ? AND synced = 0').run(op.id)
    // Поправки справочников и документов — назад, к тому, что было (edits.mjs)
    undoEdits(db, op.id)
    for (const [kind, id] of docsOf(op)) {
      // Правка документа не принята — документ уже вернулся к прежнему виду (выше),
      // а сам он у сервера есть: «отвергнутым» его не помечаем
      if (DOC_EDIT_OPS.has(op.type)) continue
      if (!id) continue
      // Закрытие смены сервер не принял — значит, для него смена по-прежнему открыта.
      // Открытой она сразу становится и здесь. Пометь мы её отвергнутой, смены на кассе
      // не стало бы вовсе: до полной загрузки (а связь может тут же пропасть) кассир
      // открыл бы вторую, сервер отверг бы и её, а чеки остались бы без смены.
      //
      // Другое дело — сервер ответил, что такой смены у него для этой кассы нет (его
      // базу вернули из старой копии; базу кассы перенесли с другого компьютера).
      // Открытая здесь заново, она собирала бы чеки, которые сервер запишет без смены,
      // а новое её закрытие он отверг бы опять. Такая смена остаётся отвергнутой:
      // кассир откроет новую, и её сервер примет
      if (op.type === 'shift.close' && !SHIFT_GONE.includes(String(error || ''))) reopenShift(db, id)
      else q(db, "UPDATE docs SET sync = 'rejected' WHERE kind = ? AND id = ? AND sync = 'pending'").run(kind, id)
    }
    const p = op.payload || {}
    if (op.type === 'deferred.add' && p.deferred?.id) q(db, "DELETE FROM deferred WHERE id = ? AND sync = 'pending'").run(p.deferred.id)
    // Клиента сервер не завёл — у кассы его тоже нет. Иначе он остался бы навсегда:
    // ни продать ему в долг (сервер отвергнет), ни удалить («ещё не отправлен»)
    if (op.type === 'customer.create' && p.customer?.id) q(db, 'DELETE FROM customers WHERE id = ? AND local = 1').run(p.customer.id)
    // Убрать не вышло — штрихкод возвращается в список
    if (op.type === 'deferred.remove' && p.id) q(db, "UPDATE deferred SET sync = 'synced' WHERE id = ? AND sync = 'deleted'").run(p.id)
    // Остаток пересчитается при ближайшем обмене — см. snapshot.mjs
    setMeta(db, 'needRebuild', '1')
    // И сам обмен будет полным. Отказ значит, что касса и сервер разошлись в том, что
    // считают правдой: у кассы «смена открыта», а сервер её не знает; у кассы клиент,
    // которого у сервера нет. Гадать, что именно поправить у себя, незачем — надёжнее
    // забрать у сервера всё, как он это видит. Отказы редки, а полная загрузка лечит
    // любой из них разом
    setMeta(db, 'needFull', '1')
  })()
}

// Смена снова открыта: итоги закрытия стираются — их посчитают заново, когда смену
// закроют ещё раз. Сервер о смене знает (её открытие он принял), поэтому она «принята»
const OPEN_TOTALS = {
  closedAt: null,
  countedCash: null,
  totalSales: 0,
  salesCash: 0,
  salesCard: 0,
  salesDebt: 0,
  debtPaid: 0,
  refundCash: 0,
  refundTotal: 0,
  refundCost: 0,
  profit: 0,
  discount: 0,
  count: 0,
  expectedCash: 0,
  difference: 0,
}
function reopenShift(db, id) {
  const row = q(db, "SELECT body FROM docs WHERE kind = 'shift' AND id = ? AND sync = 'pending'").get(id)
  if (!row) return
  const body = { ...JSON.parse(row.body), ...OPEN_TOTALS }
  // Расходы из кассы и оплаты поставщикам из ящика — не итог закрытия, а суммы, которые
  // копятся всю смену, и они остаются. Но при закрытии в них вошло и то, что сервер ещё не
  // принял: свои неотправленные расходы и приходы, оплаченные из кассы, поправки правок и
  // оплат. У открытой смены всё это прибавляется отдельно (ops/expense.mjs, ops/shift.mjs) —
  // вычитаем, чтобы не посчитать дважды
  let unsent = D(0)
  for (const r of q(db, "SELECT body FROM docs WHERE kind = 'expense' AND shiftId = ? AND sync = 'pending'").all(id)) {
    const e = JSON.parse(r.body)
    if (e.fromCash) unsent = unsent.plus(e.amount || 0)
  }
  body.expenseCash = Math.max(0, fromCents(toCents(D(body.expenseCash || 0).minus(unsent).minus(fromCentsD(adjSum(db, ADJ.expenseCash, id))))))
  body.supplierCash = Math.max(0, fromCents(toCents(D(body.supplierCash || 0).minus(fromCentsD(unsentPaidCash(db, id))).minus(fromCentsD(adjSum(db, ADJ.supplierCash, id))))))
  q(db, "UPDATE docs SET body = ?, closedAt = NULL, sync = 'synced' WHERE kind = 'shift' AND id = ?").run(JSON.stringify(body), id)
}

// Отвергнутые операции — для владельца: что именно сервер не принял и почему
export function rejectedOps(db, limit = 100) {
  return q(db, "SELECT id, type, accountId, createdAt, error, payload FROM outbox WHERE state = 'rejected' ORDER BY seq DESC LIMIT ?")
    .all(limit)
    .map((o) => ({ ...o, payload: JSON.parse(o.payload) }))
}

// Владелец разобрался с отвергнутой операцией. Строка остаётся в базе (это запись
// о том, что было), но из списка «не принято сервером» уходит
export function dismissRejected(db, id) {
  return q(db, "UPDATE outbox SET state = 'dismissed' WHERE id = ? AND state = 'rejected'").run(id).changes === 1
}

// ── Что это была за операция ──
// Для списка «не принято сервером». Отвергнутая операция снята с учёта и в журналах
// кассы её больше нет — этот список остаётся единственным местом, где владелец видит,
// что именно было сделано. Поэтому здесь не только сумма и название, но и содержимое
// целиком (detail): по нему операцию можно разобрать и, если надо, оформить заново.
// Слова подбирает окно — на выбранном языке; отсюда уходят только данные.
// Документ длиннее пятисот позиций касса не оформляет (check.mjs) — столько и показываем
const MAX_DETAIL_LINES = 500

// find(вид, номер) — документ из локальной базы: по нему возврат называет свой чек
export function describeOp(op, find = () => null) {
  const p = op.payload || {}
  const names = (items) => (Array.isArray(items) ? items.map((i) => i?.name).filter(Boolean).slice(0, 3).join(', ') : '')
  const lines = (items, pick) => (Array.isArray(items) ? items.slice(0, MAX_DETAIL_LINES).map((i, n) => pick(i || {}, n)) : [])
  switch (op.type) {
    case 'sale': {
      const s = p.sale || {}
      return {
        sum: s.total ?? null,
        title: names(s.items),
        detail: {
          payment: s.payment || '',
          customer: s.customer?.name || '',
          lines: lines(s.items, (i) => ({ name: i.name, qty: i.qty, pieces: i.pieces, unitsPerPack: i.unitsPerPack, price: i.price, discount: i.discount })),
        },
      }
    }
    case 'return': {
      const r = p.ret || {}
      // По какому чеку возврат: без этого его не оформить заново
      const sale = r.saleId ? find('sale', r.saleId) : null
      return {
        sum: r.total ?? null,
        title: names(r.items),
        detail: {
          refund: r.refund || '',
          note: r.note || '',
          sale: sale ? { date: sale.date, total: sale.total } : null,
          lines: lines(r.items, (i) => ({ name: i.name, units: i.units, amount: i.amount, restock: i.restock !== false })),
        },
      }
    }
    case 'arrival': {
      const a = p.arrival || {}
      // Срок годности в документе не хранится — он идёт рядом, построчно
      const expiry = Array.isArray(p.expiry) ? p.expiry : []
      return {
        sum: a.total ?? null,
        title: a.supplier && a.supplier !== '—' ? a.supplier : names(a.items),
        detail: { supplier: a.supplier || '', lines: lines(a.items, (i, n) => ({ name: i.name, qty: i.qty, cost: i.cost, expiry: expiry[n] || null })) },
      }
    }
    case 'writeoff': {
      const w = p.writeOff || {}
      return {
        sum: w.totalCost ?? null,
        title: names(w.items),
        detail: { reason: w.reason || '', note: w.note || '', lines: lines(w.items, (i) => ({ name: i.name, units: i.units })) },
      }
    }
    case 'debt.pay':
      return { sum: p.payment?.amount ?? null, title: p.payment?.customer?.name || '', detail: { customer: p.payment?.customer?.name || '' } }
    case 'expense': {
      const e = p.expense || {}
      return {
        sum: e.amount ?? null,
        title: e.category || '',
        detail: { category: e.category || '', note: e.note || '', date: e.date || '', fromCash: e.fromCash === true },
      }
    }
    case 'cash.move': {
      const m = p.move || {}
      return { sum: m.amount ?? null, title: '', detail: { kind: m.kind || '', note: m.note || '' } }
    }
    case 'income': {
      const e = p.income || {}
      return { sum: e.amount ?? null, title: e.category || '', detail: { category: e.category || '', note: e.note || '', date: e.date || '' } }
    }
    case 'supplier.return': {
      const r = p.ret || {}
      return {
        sum: r.total ?? null,
        title: r.supplier && r.supplier !== '—' ? r.supplier : names(r.items),
        detail: {
          supplier: r.supplier || '',
          refund: r.refund || '',
          note: r.note || '',
          lines: lines(r.items, (i) => ({ name: i.name, qty: i.qty, pieces: i.pieces || 0, price: i.price })),
        },
      }
    }
    case 'customer.create':
      return { sum: null, title: p.customer?.name || '', detail: { phone: p.customer?.phone || '', debt: p.customer?.debt || 0 } }
    case 'shift.open':
      return { sum: null, title: '', detail: { openingCash: p.shift?.openingCash ?? 0 } }
    case 'shift.close': {
      const s = p.shift || {}
      return {
        sum: s.totalSales ?? null,
        title: '',
        detail: { openingCash: s.openingCash ?? 0, countedCash: s.countedCash ?? 0, expectedCash: s.expectedCash ?? 0, difference: s.difference ?? 0, count: s.count ?? 0 },
      }
    }
    case 'deferred.add':
      return { sum: null, title: p.deferred?.barcode || '', detail: {} }
    case 'deferred.remove':
      return { sum: null, title: p.barcode || '', detail: {} }
    // ── Справочники и правки документов (версия 1.4.14) ──
    case 'product.create': {
      const x = p.product || {}
      return { sum: null, title: x.name || '', detail: { barcode: x.barcode || '', price: x.price ?? null, stock: x.stock ?? 0 } }
    }
    case 'product.update':
    case 'category.update':
    case 'productType.update':
    case 'supplier.update': {
      const old = p.base || {}
      const name = (find(KIND_OF[op.type], p.id) || {}).name || old.name || p.set?.name || ''
      return { sum: null, title: name, detail: { fields: Object.keys(p.set || {}), set: p.set || {}, base: old, stock: p.stock?.units ?? null } }
    }
    case 'product.delete':
    case 'category.delete':
    case 'productType.delete':
    case 'payService.delete':
    case 'expenseCategory.delete':
    case 'incomeCategory.delete':
    case 'supplier.delete':
      return { sum: null, title: (find(KIND_OF[op.type], p.id) || {}).name || '', detail: {} }
    case 'category.create':
    case 'expenseCategory.create':
    case 'incomeCategory.create':
      return { sum: null, title: p.category?.name || '', detail: {} }
    case 'productType.create':
      return { sum: null, title: p.type?.name || '', detail: {} }
    case 'payService.create':
      return { sum: null, title: p.service?.name || '', detail: {} }
    case 'supplier.create':
      return { sum: null, title: p.supplier?.name || '', detail: { phone: p.supplier?.phone || '', openingDebt: p.supplier?.openingDebt || 0 } }
    case 'supplier.pay': {
      const x = p.payment || {}
      return { sum: x.amount ?? null, title: (find('supplier', x.supplierId) || {}).name || '', detail: { note: x.note || '', fromCash: x.fromCash === true } }
    }
    case 'supplierPayment.delete':
    case 'supplierReturn.delete':
    case 'expense.update':
    case 'expense.delete':
    case 'income.update':
    case 'income.delete':
    case 'cashMove.delete':
    case 'arrival.update':
    case 'arrival.delete': {
      // Сам документ — каким он был: по нему владелец поймёт, о чём речь
      const d = find(p.ref?.kind, p.ref?.id) || {}
      const sum = d.amount ?? d.total ?? null
      const title = d.category || (d.supplier && d.supplier !== '—' ? d.supplier : '') || d.supplier?.name || d.note || ''
      return { sum, title: typeof title === 'string' ? title : '', detail: { date: d.date || '', fields: Object.keys(p.set || {}), set: p.set || {} } }
    }
    default:
      return { sum: null, title: '', detail: {} }
  }
}

// По какому виду искать запись, названную в операции (для названия в списке «не принято»)
const KIND_OF = {
  'product.update': 'product', 'product.delete': 'product',
  'category.update': 'category', 'category.delete': 'category',
  'productType.update': 'productType', 'productType.delete': 'productType',
  'payService.delete': 'payService', 'expenseCategory.delete': 'expenseCategory', 'incomeCategory.delete': 'incomeCategory',
  'supplier.update': 'supplier', 'supplier.delete': 'supplier',
}

// Какие разделы на экране устарели после того, как с операцией что-то случилось
// (сервер её отверг или принял без документа)
const TOUCHES = {
  sale: ['sales', 'products', 'customers', 'shifts'],
  return: ['returns', 'products', 'sales', 'customers', 'writeoffs', 'shifts'],
  writeoff: ['writeoffs', 'products'],
  // Приход в долг меняет и долг поставщика
  arrival: ['arrivals', 'products', 'suppliers'],
  'shift.open': ['shifts'],
  'shift.close': ['shifts'],
  'debt.pay': ['customers', 'payments', 'shifts'],
  'customer.create': ['customers'],
  'deferred.add': ['deferred'],
  'deferred.remove': ['deferred'],
  // Расход из кассы меняет и наличные, которые ждут в смене
  expense: ['expenses', 'shifts'],
  'cash.move': ['cashMoves', 'shifts'],
  income: ['incomes'],
  // Возврат поставщику: склад, долг поставщика, деньги «в кассу» — в смене
  'supplier.return': ['supplierReturns', 'products', 'suppliers', 'shifts'],
  // ── Справочники и правки документов (версия 1.4.14) ──
  'product.create': ['products', 'deferred'],
  'product.update': ['products'],
  'product.delete': ['products'],
  'category.create': ['categories'],
  'category.update': ['categories', 'products'],
  'category.delete': ['categories'],
  'productType.create': ['productTypes'],
  'productType.update': ['productTypes', 'products'],
  'productType.delete': ['productTypes'],
  'payService.create': ['payServices'],
  'payService.delete': ['payServices'],
  'expenseCategory.create': ['expenseCategories'],
  'expenseCategory.delete': ['expenseCategories'],
  'incomeCategory.create': ['incomeCategories'],
  'incomeCategory.delete': ['incomeCategories'],
  'supplier.create': ['suppliers'],
  'supplier.update': ['suppliers'],
  'supplier.delete': ['suppliers'],
  'supplier.pay': ['suppliers', 'supplierPayments', 'shifts'],
  'supplierPayment.delete': ['suppliers', 'supplierPayments', 'shifts'],
  'supplierReturn.delete': ['supplierReturns', 'products', 'suppliers', 'shifts'],
  'expense.update': ['expenses', 'shifts'],
  'expense.delete': ['expenses', 'shifts'],
  'income.update': ['incomes'],
  'income.delete': ['incomes'],
  'cashMove.delete': ['cashMoves', 'shifts'],
  'arrival.update': ['arrivals', 'products', 'suppliers'],
  'arrival.delete': ['arrivals', 'products', 'suppliers'],
}
export const touchedBy = (op) => TOUCHES[op?.type] || []
