// ── Движение остатков через партии ──
//
// Перенос серверных правил (server/src/common/stock.ts и cost.ts) в локальную базу.
// Правило системы то же: остаток товара — это сумма его партий, партии хранят
// количество в ШТУКАХ, списание идёт с ближайшего срока годности (FEFO), а продажа
// берёт только ГОДНЫЕ партии — просрочку покупателю не отдаём.
//
// Отличие одно. Сервер просто меняет партии. Касса ещё и записывает каждое движение
// в журнал (stock_moves) — так, чтобы его можно было проиграть заново. Когда сервер
// пришлёт свежий остаток, сделанное здесь и ещё не дошедшее до него накладывается
// поверх: остаток считается по журналу движений, а не перезаписью количества.
import { bad, inTx, q } from './db.mjs'
import { D, fromCentsD, toCents } from './money.mjs'
import { expiryLimit } from './time.mjs'
import { uppOf } from './units.mjs'

// Порядок списания: сначала ближайший срок, бессрочные — в конце; при равном сроке
// раньше уходит партия, заведённая раньше
const FEFO = 'ORDER BY (expiryDate IS NULL), expiryDate, createdAt, id'

const liveBatches = (db, productId) => q(db, `SELECT * FROM batches WHERE productId = ? AND units > 0 ${FEFO}`).all(productId)

export const productById = (db, id) => q(db, 'SELECT * FROM products WHERE id = ?').get(id) || null

// Сколько штук товара лежит на полке и сколько из них просрочено
export function unitsOf(db, productId, now) {
  const r = q(
    db,
    `SELECT COALESCE(SUM(units), 0) AS units,
            COALESCE(SUM(CASE WHEN expiryDate IS NOT NULL AND expiryDate < ? THEN units ELSE 0 END), 0) AS expired
     FROM batches WHERE productId = ? AND units > 0`,
  ).get(expiryLimit(now), productId)
  return { units: r.units, expired: r.expired }
}

// То же по всем товарам сразу — для списка товаров
export function allUnits(db, now) {
  const rows = q(
    db,
    `SELECT productId,
            SUM(units) AS units,
            SUM(CASE WHEN expiryDate IS NOT NULL AND expiryDate < ? THEN units ELSE 0 END) AS expired
     FROM batches WHERE units > 0 GROUP BY productId`,
  ).all(expiryLimit(now))
  return new Map(rows.map((r) => [r.productId, r]))
}

// Ближайший срок годности в карточке товара — по тому, что реально лежит на полке.
// Сервер делает это после каждого движения (writeTotals).
function writeNearest(db, productId) {
  q(
    db,
    `UPDATE products SET expiryDate =
       (SELECT MIN(expiryDate) FROM batches WHERE productId = ? AND units > 0 AND expiryDate IS NOT NULL)
     WHERE id = ?`,
  ).run(productId, productId)
}

// ── Срок годности товара, который вернул покупатель ──
// То же правило, что на сервере (server/src/common/stock.ts, returnExpiry): самый
// ранний срок среди партий товара, годных в день покупки, — в том числе уже
// распроданных. Продажа берёт партию с ближайшим сроком, поэтому настоящий срок пачки
// не раньше этого: ошибиться можно только в осторожную сторону.
//
// Касса знает не все распроданные партии (сервер присылает те, где товар есть или
// кончился при ней), поэтому её ответ — предварительный. Приняв возврат, сервер ставит
// срок по своим партиям, и с ближайшим обменом его партия приходит сюда.
//
// soldAt — когда товар продали (возврат без чека — когда вернули).
// fallback — что взять, если ни одна партия не подошла: срок из карточки товара.
export function returnExpiry(db, productId, soldAt, fallback = null) {
  const row = q(db, 'SELECT MIN(expiryDate) AS d FROM batches WHERE productId = ? AND expiryDate IS NOT NULL AND expiryDate >= ?').get(
    productId,
    expiryLimit(soldAt),
  )
  return row?.d ?? fallback ?? null
}

// ── Списать штуки по FEFO ──
// Возвращает, из каких партий и сколько взято: срок партии уходит в документ.
//
// skipExpired — брать только годные партии (так работает продажа).
// tolerant — не отказывать, если товара не хватило: взять сколько есть, а недостачу
// записать. Нужно, когда журнал проигрывается поверх свежего остатка: продажа уже
// состоялась, товар отдан, и отменить её задним числом нельзя.
export function consume(db, product, units, { skipExpired = false, tolerant = false, now } = {}) {
  if (units <= 0) return { taken: [], short: 0 }
  const limit = expiryLimit(now)
  const live = liveBatches(db, product.id)
  const expiredOf = (b) => !!b.expiryDate && b.expiryDate < limit
  const usable = skipExpired ? live.filter((b) => !expiredOf(b)) : live
  const have = usable.reduce((s, b) => s + b.units, 0)

  if (have < units && !tolerant) {
    const name = product.name || 'товар'
    const expired = live.reduce((s, b) => s + (expiredOf(b) ? b.units : 0), 0)
    // Кассир должен понимать, что делать: «мало товара» и «товар просрочен» —
    // разные ситуации с разными действиями. Тексты — слово в слово как у сервера
    throw bad(
      skipExpired && expired > 0
        ? `«${name}»: годных ${have} шт, просрочено ${expired} шт. Просроченное продавать нельзя — уберите его с полки и спишите.`
        : `Недостаточно «${name}» на складе (есть ${have} шт)`,
    )
  }

  const taken = []
  let left = Math.min(units, have)
  for (const b of usable) {
    if (left <= 0) break
    const take = Math.min(left, b.units)
    q(db, 'UPDATE batches SET units = units - ? WHERE id = ?').run(take, b.id)
    taken.push({ batchId: b.id, units: take, costC: b.costC, expiryDate: b.expiryDate })
    left -= take
  }

  const short = Math.max(0, units - have)
  if (short > 0) q(db, 'UPDATE products SET oversold = oversold + ? WHERE id = ?').run(short, product.id)
  writeNearest(db, product.id)
  return { taken, short }
}

// ── Положить штуки на полку ──
// Новая партия со своим сроком. Одинаковые срок, цена и приход объединяются,
// чтобы не плодить десятки партий по одному товару.
export function addUnits(db, productId, units, costC, expiryDate, arrivalId, note, { id, createdAt }) {
  if (units <= 0) return null
  const exp = expiryDate ?? null
  const arr = arrivalId ?? null
  const same = q(db, 'SELECT id FROM batches WHERE productId = ? AND costC = ? AND expiryDate IS ? AND arrivalId IS ? LIMIT 1').get(
    productId,
    costC,
    exp,
    arr,
  )
  let batchId = same?.id
  if (batchId) {
    q(db, 'UPDATE batches SET units = units + ? WHERE id = ?').run(units, batchId)
  } else {
    batchId = id
    q(
      db,
      `INSERT INTO batches (id, productId, units, sUnits, costC, expiryDate, arrivalId, note, createdAt)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(batchId, productId, units, costC, exp, arr, note || '', createdAt)
  }
  writeNearest(db, productId)
  return batchId
}

// ── Средневзвешенная закупочная цена ──
// После прихода цена товара становится средней между тем, что лежит на складе,
// и тем, что привезли. Считается В ШТУКАХ: у делимых товаров часть остатка лежит
// во вскрытой упаковке, и по упаковкам она весила бы ноль.
// Возвращает точную цену УПАКОВКИ; округляют её там, где записывают.
export function weightedPackCost({ stock, looseUnits, unitsPerPack, cost, addPacks, addValue }) {
  const upp = Math.max(1, unitsPerPack || 1)
  const oldUnits = D(stock || 0).times(upp).plus(looseUnits || 0)
  const added = D(addPacks || 0).times(upp)
  const total = oldUnits.plus(added)
  // Ни старого остатка, ни прихода — менять нечего
  if (total.lte(0)) return D(cost)
  const oldValue = D(cost).dividedBy(upp).times(oldUnits)
  return oldValue.plus(D(addValue)).dividedBy(total).times(upp)
}

// ── Одно движение из журнала ──
// Через эту функцию проходит всё: и продажа в момент оплаты, и её повтор при
// проигрывании журнала. Одна дорога — значит остаток после «сделали» и после
// «проиграли заново» получается одним и тем же кодом.
export function applyMove(db, move, { tolerant = false, now } = {}) {
  const product = productById(db, move.productId)
  // Товар убрали из справочника, пока движение ждало отправки. Двигать нечего
  if (!product) return { taken: [], short: 0 }

  if (move.units < 0) {
    return consume(db, product, -move.units, { skipExpired: !!move.skipExpired, tolerant, now })
  }

  // Приход: сначала средняя цена — она считается от остатка ДО прихода
  if (move.wPacks !== null && move.wPacks !== undefined) {
    const upp = uppOf(product)
    const { units } = unitsOf(db, product.id, now)
    const cost = weightedPackCost({
      stock: Math.floor(units / upp),
      looseUnits: units % upp,
      unitsPerPack: upp,
      cost: fromCentsD(product.costC),
      addPacks: move.wPacks,
      addValue: D(move.wValue),
    })
    q(db, 'UPDATE products SET costC = ? WHERE id = ?').run(toCents(cost), product.id)
  }

  const batchId = addUnits(db, product.id, move.units, move.costC ?? product.costC, move.expiryDate, move.arrivalId, move.note, {
    // Номер партии выводится из номера движения: при проигрывании журнала она
    // получит тот же самый
    id: 'loc-' + move.seq,
    createdAt: move.createdAt,
  })
  return { taken: [], short: 0, batchId }
}

// ── Записать движение и сразу выполнить ──
// Запись и выполнение идут внутри одной транзакции вызывающей операции: если товара
// не хватило, отказ откатывает и строку журнала тоже.
export function move(db, m, { now }) {
  const createdAt = new Date(now).toISOString()
  const info = q(
    db,
    `INSERT INTO stock_moves (opId, productId, kind, units, skipExpired, costC, expiryDate, arrivalId, note, wPacks, wValue, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.opId,
    m.productId,
    m.kind,
    m.units,
    m.skipExpired ? 1 : 0,
    m.costC ?? null,
    m.expiryDate ?? null,
    m.arrivalId ?? null,
    m.note || '',
    m.wPacks ?? null,
    m.wValue ?? null,
    createdAt,
  )
  return applyMove(db, { ...m, seq: Number(info.lastInsertRowid), createdAt }, { tolerant: false, now })
}

// ── Проиграть журнал заново ──
// Основа — то, что сказал сервер: его партии, его закупочные цены. Поверх
// накладывается всё, что сделано на этой кассе и сервером ещё не принято, в том же
// порядке, в каком делалось. Отказов здесь нет: всё это уже случилось.
//
// Срок годности при проигрывании оценивается на момент самого движения, а не на
// сегодня: вчерашняя продажа брала партию, которая вчера была годной.
export function rebuildStock(db) {
  // Одной транзакцией: либо остаток пересчитан целиком, либо остался прежним.
  // Половина пересчёта — это полка, на которой товара то ли вдвое больше, то ли нет вовсе
  return inTx(db, () => {
    q(db, 'DELETE FROM batches WHERE sUnits IS NULL').run()
    q(db, 'UPDATE batches SET units = sUnits').run()
    q(db, 'UPDATE products SET costC = sCostC, expiryDate = sExpiry, oversold = 0').run()
    const moves = q(db, 'SELECT * FROM stock_moves WHERE synced = 0 ORDER BY seq').all()
    for (const m of moves) applyMove(db, m, { tolerant: true, now: Date.parse(m.createdAt) })
    return moves.length
  })
}
