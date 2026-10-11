// ── Отложенные штрихкоды ──
//
// Кассир отсканировал товар, которого нет в базе. Заводить карточку на кассе он не
// может — штрихкод откладывается, а товар потом оформит владелец. Без интернета это
// нужно так же, как с ним: покупатель с незнакомой коробкой приходит в любой день.
import { deferredByBarcode } from '../catalog.mjs'
import { bodyOf, checker } from '../check.mjs'
import { inTx, newId, q } from '../db.mjs'
import { enqueue } from '../docs.mjs'

const view = (r) => ({ id: r.id, barcode: r.barcode, createdAt: r.createdAt })

export function addDeferred(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  // Длину меряем без пробелов по краям — как сервер: «  12 » — это два знака, и
  // такой штрихкод он отверг бы уже после того, как касса его отложила
  const code = c.str(typeof dto.barcode === 'string' ? dto.barcode.trim() : dto.barcode, 'barcode', { min: 3 })
  c.done()

  return inTx(db, () => {
    // Повтор того же штрихкода ничего не меняет — отдаём уже отложенный
    const existing = deferredByBarcode(db, code)
    if (existing) return view(existing)

    const row = { id: newId(), barcode: code, createdAt: new Date(now).toISOString() }
    q(db, "INSERT INTO deferred (id, barcode, createdAt, sync) VALUES (?, ?, ?, 'pending')").run(row.id, row.barcode, row.createdAt)
    enqueue(db, { id: newId(), type: 'deferred.add', accountId: ctx.user.accountId, payload: { deferred: row }, now })
    return row
  })
}

export function removeDeferred(ctx, id) {
  const { db, now } = ctx
  return inTx(db, () => {
    const row = q(db, "SELECT * FROM deferred WHERE id = ? AND sync <> 'deleted'").get(id)
    // Нечего убирать — не ошибка: штрихкод могли убрать с другой кассы
    if (!row) return { ok: true }
    // Строка остаётся с пометкой «убран»: если её стереть, следующая сверка
    // с сервером вернула бы штрихкод в список
    q(db, "UPDATE deferred SET sync = 'deleted' WHERE id = ?").run(id)
    enqueue(db, {
      id: newId(),
      type: 'deferred.remove',
      accountId: ctx.user.accountId,
      payload: { id: row.id, barcode: row.barcode },
      now,
    })
    return { ok: true }
  })
}
