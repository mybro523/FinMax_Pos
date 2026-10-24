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
import { docState } from './edits.mjs'
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

  // ── Движения правок, сделанных без связи (версия 1.4.14) ──
  // Срок годности из карточки: у единственной партии на полке
  if (move.kind === 'expiry') return setSingleExpiry(db, product, move.expiryDate ?? null)
  // Закупочная цена, вписанная в карточку руками
  if (move.kind === 'cost') {
    if (Number.isInteger(move.costC)) q(db, 'UPDATE products SET costC = ? WHERE id = ?').run(move.costC, product.id)
    return { taken: [], short: 0 }
  }
  // Удаление прихода: снять всё, что от него осталось на полке, — и закупочную цену заново
  // по оставшимся партиям (как сервер: arrivals.service, costFromBatches)
  if (move.kind === 'arrival-undo') return undoArrival(db, product, move.arrivalId)
  // Правка прихода — как у сервера, по партиям этой кассы на момент, когда движение ложится
  if (move.kind === 'arrival-edit') return editArrival(db, product, move)
  // Остаток, вписанный в карточку, больше прежнего: излишек — в партию с самым дальним
  // сроком, как у сервера (setUnits). Партий нет — новая
  if (move.kind === 'count' && move.units > 0) {
    const last = q(db, `SELECT id FROM batches WHERE productId = ? AND units > 0 ${FEFO_LAST}`).get(product.id)
    if (last) {
      q(db, 'UPDATE batches SET units = units + ? WHERE id = ?').run(move.units, last.id)
      writeNearest(db, product.id)
      return { taken: [], short: 0, batchId: last.id }
    }
  }

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

// ── Правка прихода ──
// Как сервер (updateArrivalIn): всё, что от прихода осталось на полке, снимается, а новое
// количество раскладывается по строкам прихода за вычетом проданного — первые строки
// целиком, последним достаётся остаток. Сколько продано, считается здесь и сейчас: «было в
// приходе» (spec.b) минус то, что от него лежит на полке этой кассы. Поэтому правка,
// сделанная на соседней кассе, не возвращает на полку то, что здесь из того же прихода
// уже продали. move.units — сколько штук стало в приходе; spec.l — строки: штуки, цена
// упаковки, срок
function editArrival(db, product, move) {
  let spec = null
  try {
    spec = JSON.parse(move.note)
  } catch {
    spec = null
  }
  if (!move.arrivalId || !spec || !Array.isArray(spec.l)) return { taken: [], short: 0 }
  // Прихода здесь нет, его заведение сервер отверг или его удалили — править нечего: иначе
  // «проданным» посчиталось бы всё, что в нём было, и на полку легла бы разница из ничего.
  // Удалённый приход и так кончается нулём на полке (его остаток снимает удаление), в каком
  // бы порядке ни легли правка и удаление. Состояние — по очереди, а не только по пометке
  const doc = q(db, "SELECT sync FROM docs WHERE kind = 'arrival' AND id = ?").get(move.arrivalId)
  if (!doc || doc.sync === 'rejected' || doc.sync === 'deleted') return { taken: [], short: 0 }
  const st = docState(db, 'arrival', move.arrivalId)
  if (st === 'rejected' || st === 'deleted') return { taken: [], short: 0 }
  const batches = q(db, 'SELECT * FROM batches WHERE productId = ? AND arrivalId = ? AND units > 0').all(product.id, move.arrivalId)
  const left = batches.reduce((s, b) => s + b.units, 0)
  const sold = Math.max(0, (Number(spec.b) || 0) - left)
  const taken = []
  for (const b of batches) {
    q(db, 'UPDATE batches SET units = 0 WHERE id = ?').run(b.id)
    taken.push({ batchId: b.id, units: b.units, costC: b.costC, expiryDate: b.expiryDate })
  }
  let toPlace = Math.max(0, Math.trunc(Number(move.units) || 0) - sold)
  spec.l.forEach((line, n) => {
    if (toPlace <= 0 || !Array.isArray(line)) return
    const take = Math.min(Math.max(0, Math.trunc(Number(line[0]) || 0)), toPlace)
    if (take <= 0) return
    // Номер партии выводится из номера движения и строки: при проигрывании журнала — тот же
    addUnits(db, product.id, take, Number.isInteger(line[1]) ? line[1] : product.costC, line[2] ?? null, move.arrivalId, 'приход изменён', {
      id: `loc-${move.seq}-${n}`,
      createdAt: move.createdAt,
    })
    toPlace -= take
  })
  writeNearest(db, product.id)
  costFromBatches(db, product)
  return { taken, short: 0 }
}

// Самая дальняя партия: обратный порядок списания (бессрочные — последними)
const FEFO_LAST = 'ORDER BY (expiryDate IS NULL) DESC, expiryDate DESC, createdAt DESC, id DESC'

function setSingleExpiry(db, product, expiryDate) {
  const live = q(db, 'SELECT id FROM batches WHERE productId = ? AND units > 0').all(product.id)
  if (live.length === 1) {
    q(db, 'UPDATE batches SET expiryDate = ? WHERE id = ?').run(expiryDate, live[0].id)
    writeNearest(db, product.id)
  }
  return { taken: [], short: 0 }
}

function undoArrival(db, product, arrivalId) {
  if (!arrivalId) return { taken: [], short: 0 }
  const taken = []
  for (const b of q(db, 'SELECT * FROM batches WHERE productId = ? AND arrivalId = ? AND units > 0').all(product.id, arrivalId)) {
    q(db, 'UPDATE batches SET units = 0 WHERE id = ?').run(b.id)
    taken.push({ batchId: b.id, units: b.units, costC: b.costC, expiryDate: b.expiryDate })
  }
  writeNearest(db, product.id)
  costFromBatches(db, product)
  return { taken, short: 0 }
}

// ── Закупочная цена по тому, что лежит на полке ──
// Как у сервера (server/src/common/cost.ts, costFromBatches): в штуках, по ценам партий.
// Полка пуста — цена остаётся прежней
export function costFromBatches(db, product) {
  const upp = uppOf(product)
  let units = D(0)
  let value = D(0)
  for (const b of q(db, 'SELECT units, costC FROM batches WHERE productId = ? AND units > 0').all(product.id)) {
    units = units.plus(b.units)
    value = value.plus(fromCentsD(b.costC).dividedBy(upp).times(b.units))
  }
  if (units.lte(0)) return
  q(db, 'UPDATE products SET costC = ? WHERE id = ?').run(toCents(value.dividedBy(units).times(upp)), product.id)
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
