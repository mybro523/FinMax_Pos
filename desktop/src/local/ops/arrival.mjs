// ── Приход товара ──
//
// Перенос серверного прихода (server/src/arrivals/arrivals.service.ts, только
// оформление: правка и удаление прихода остаются за сервером). Каждая строка —
// партия со своим сроком годности; закупочная цена товара после прихода становится
// средневзвешенной между тем, что лежало, и тем, что привезли.
import { bodyOf, checker, expiryOk, MAX_MONEY, MAX_UPP, sumOk, unitsOk } from '../check.mjs'
import { bad, inTx, newId } from '../db.mjs'
import { enqueue, putDoc } from '../docs.mjs'
import { recordEdit } from '../edits.mjs'
import { D, fromCents, toCents } from '../money.mjs'
import { costCInPack, lineUpp, opensPack, packFor, pieceCentsIn } from '../piece.mjs'
import { myOpenShift } from '../docs.mjs'
import { move, productById } from '../stock.mjs'
import { supplierRow } from '../suppliers.mjs'
import { isoOrNull } from '../time.mjs'
import { uppOf } from '../units.mjs'

export function createArrival(ctx, raw) {
  const { db, now } = ctx
  const dto = bodyOf(raw)
  const c = checker()
  const supplier = c.str(dto.supplier, 'supplier', { optional: true })
  // Поставщик из справочника и неоплаченная часть — долг перед ним
  const supplierId = c.str(dto.supplierId, 'supplierId', { optional: true })
  const debtAsked = c.num(dto.debt, 'debt', { optional: true, max: MAX_MONEY })
  // Чем заплатили и сколько из этого — деньгами из ящика кассы
  const payMethod = c.oneOf(dto.payMethod ?? '', 'payMethod', ['', 'cash', 'own', 'card', 'debt'])
  const paidCashAsked = c.num(dto.paidCash, 'paidCash', { optional: true, max: MAX_MONEY })
  const items = c.list(dto.items, 'items').map((it, n) => ({
    productId: c.str(it?.productId, `items.${n}.productId`),
    // Целые упаковки (у весового товара без мешка — килограммы); ноль допустим при pieces > 0
    qty: c.int(it?.qty, `items.${n}.qty`, { min: 0 }),
    // Штуки (граммы) сверх целых упаковок
    pieces: it?.pieces === undefined || it?.pieces === null ? 0 : c.int(it.pieces, `items.${n}.pieces`, { min: 0, max: MAX_UPP }),
    // Закупочная цена — уже со скидкой поставщика; сама скидка, % — для истории
    cost: c.num(it?.cost, `items.${n}.cost`),
    discount: it?.discount === undefined || it?.discount === null ? 0 : c.num(it.discount, `items.${n}.discount`, { max: 100 }),
    expiryDate: c.str(it?.expiryDate, `items.${n}.expiryDate`, { optional: true }),
    // Новая цена продажи, назначенная наценкой в приходе. Нет — цена прежняя
    price: it?.price === undefined || it?.price === null ? null : c.num(it.price, `items.${n}.price`, { max: MAX_MONEY }),
    // Своя цена штуки (1.5.11; у весового — за 1 кг, 1.5.12): нет поля — не трогать; пусто —
    // убрать; число — поставить
    piecePrice: it?.piecePrice === undefined ? undefined : it.piecePrice === null || it.piecePrice === '' ? null : c.num(it.piecePrice, `items.${n}.piecePrice`, { max: MAX_MONEY }),
    // Сколько штук (граммов) в упаковке строки — так окно считало qty и pieces (1.5.12)
    unitsPerPack: it?.unitsPerPack === undefined || it?.unitsPerPack === null ? undefined : c.int(it.unitsPerPack, `items.${n}.unitsPerPack`, { min: 1, max: MAX_UPP }),
    // Упаковку товара поменяли прямо в приходе: карточка получит unitsPerPack строки
    packChanged: it?.packChanged === true,
    // Прежние цены были за прежнюю упаковку (185 за кг) — перевести на новую (как у сервера)
    packScale: it?.packScale === true,
  }))
  c.done()

  return inTx(db, () => {
    const byId = new Map()
    for (const it of items) {
      if (!byId.has(it.productId)) byId.set(it.productId, productById(db, it.productId))
      if (!byId.get(it.productId)) throw bad('Товар не найден')
    }
    const opId = newId()

    // ── Упаковку поменяли прямо в приходе (1.5.12) ──
    // Как у сервера (applyPackChanges): карточка получает её раньше всего остального —
    // средняя закупочная считается уже по новой упаковке. Остаток не меняется: он в штуках
    // (граммах), карточка лишь заново делит его на упаковки. Цены за упаковку — те же
    // числа. Правкой карточки под номером этой операции: свежие данные сервера её не
    // затрут, пока он не примет приход, а отказ сервера вернёт прежнюю упаковку
    // Прежние цены были за прежнюю упаковку (packScale) — переводятся на новую: закупочная и цена
    // продажи × новая / прежняя упаковка. Цены партий переведёт сервер (здесь средняя закупочная
    // считается от карточки)
    const packWant = new Map()
    for (const it of items) if (it.packChanged && it.unitsPerPack) packWant.set(it.productId, { upp: it.unitsPerPack, scale: it.packScale })
    const packMoved = new Set()
    const packScaled = new Map()
    for (const [pid, w] of packWant) {
      const p = byId.get(pid)
      const was = uppOf(p)
      const upp = packFor(p.unit, w.upp)
      if (upp === was) continue
      const set = { unitsPerPack: upp }
      const before = { unitsPerPack: p.unitsPerPack }
      if (w.scale) {
        const k = (c) => (c === null || c === undefined ? c : Math.round((c * upp) / was))
        Object.assign(set, { priceC: k(p.priceC), costC: k(p.costC), sCostC: k(p.sCostC) })
        Object.assign(before, { priceC: p.priceC, costC: p.costC, sCostC: p.sCostC })
        packScaled.set(pid, upp / was)
      }
      recordEdit(db, { opId, tbl: 'products', rowId: pid, action: 'put', data: { set, was: before }, now })
      byId.set(pid, productById(db, pid))
      packMoved.add(pid)
    }

    const lines = items.map((it) => {
      const p = byId.get(it.productId)
      // Упаковка строки — как её считало окно (у прежнего весовой товар — килограммами)
      const upp = lineUpp(it, p)
      const units = it.qty * upp + it.pieces
      if (units <= 0) throw bad(`Укажите количество: ${p.name}`)
      // Тот же отказ и теми же словами, что у сервера: позже его прислал бы он —
      // когда товар уже стоит на полке
      unitsOk(units, 'В приходе слишком большое количество')
      // Скидка — до сотых процента, как её хранит сервер
      const discount = Math.round((it.discount || 0) * 100) / 100
      return { productId: p.id, name: p.name, qty: it.qty, pieces: it.pieces, upp, units, cost: D(it.cost), discount }
    })

    // Срок годности партии не обязателен: впишут — партия под контролем сроков,
    // оставят пустым — партия без срока (хлеб, шампунь и прочее без даты)
    const expiry = items.map((it) => {
      if (!it.expiryDate) return null
      const iso = isoOrNull(it.expiryDate)
      if (!iso) throw bad('Некорректные данные запроса')
      expiryOk(iso)
      return iso
    })

    // Один товар может стоять в приходе несколькими строками. Среднюю цену считаем
    // по товару целиком: сколько штук пришло и на какую сумму
    const agg = new Map()
    let total = D(0)
    for (const l of lines) {
      // Цена — за упаковку строки (за мешок, за килограмм): граммы оплачиваются долей
      const dolya = D(l.units).div(l.upp)
      const a = agg.get(l.productId) || { units: 0, value: D(0) }
      a.units += l.units
      a.value = a.value.plus(l.cost.times(dolya))
      agg.set(l.productId, a)
      total = total.plus(l.cost.times(dolya))
    }
    sumOk(total)

    // Поставщика знает справочник, присланный сервером. Нового без связи не завести —
    // его заводит сервер; приход в долг тогда ждёт интернета
    let sup = null
    if (supplierId) {
      sup = supplierRow(db, supplierId)
      if (!sup) throw bad('Поставщик не найден')
    }
    const asked = D(debtAsked || 0)
    const debtD = !sup ? D(0) : asked.gt(total) ? total : asked
    const debt = fromCents(toCents(debtD))

    // «Из кассы»: деньги уходят из ящика ОТКРЫТОЙ смены этой кассы. Пока приход
    // не отправлен, закрытие смены само добавит эту сумму к «оплачено поставщикам»
    // (см. ops/shift.mjs); сервер при приёме запишет ту же оплату поставщику
    const paidCash = fromCents(toCents(D(paidCashAsked || 0)))
    let paidShiftId = null
    if (paidCash > 0) {
      if (!sup) throw bad('Для оплаты из кассы выберите поставщика из справочника')
      if (D(paidCash).gt(total.minus(debtD).plus(D('0.01')))) throw bad('Из кассы оплачено больше, чем стоит приход без долга')
      const shift = myOpenShift(db, ctx.deviceId)
      if (!shift) throw bad('Нет открытой смены — из кассы взять нечего.')
      paidShiftId = shift.id
    }

    const arrivalId = newId()
    const weighed = new Set()

    lines.forEach((l, n) => {
      const p = byId.get(l.productId)
      // Пересчёт средней цены — один раз на товар, перед первой его партией:
      // цена считается от остатка ДО прихода
      const first = !weighed.has(l.productId)
      weighed.add(l.productId)
      const a = agg.get(l.productId)
      move(
        db,
        {
          opId,
          productId: l.productId,
          kind: 'arrival',
          units: l.units,
          // Партия помнит цену за упаковку ТОВАРА: строка, посчитанная в другой упаковке
          // (прежнее окно — килограммами при мешке), переводится
          costC: costCInPack(toCents(l.cost), l.upp, uppOf(p)),
          expiryDate: expiry[n],
          arrivalId,
          // Дробные «упаковки» (12,35 кг) — это нормально: средняя цена считается в штуках
          wPacks: first ? Number(D(a.units).div(uppOf(p))) : null,
          wValue: first ? a.value.toString() : null,
        },
        { now },
      )
    })

    const body = {
      id: arrivalId,
      date: new Date(now).toISOString(),
      supplier: sup?.name || supplier || '—',
      supplierId: sup?.id ?? null,
      debt,
      payMethod,
      paidCash,
      shiftId: paidShiftId,
      userId: ctx.user.id,
      user: { id: ctx.user.id, name: ctx.user.name },
      total: fromCents(toCents(total)),
      items: lines.map((l) => ({
        id: newId(),
        arrivalId,
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        pieces: l.pieces,
        // Упаковка строки — снимком, как у сервера (1.5.12)
        unitsPerPack: l.upp,
        cost: fromCents(toCents(l.cost)),
        discount: l.discount,
      })),
    }
    // Новая цена продажи и своя цена штуки (у весового — килограмма) — сразу в карточке:
    // касса продаёт по ним, не дожидаясь связи. Один товар может стоять в приходе дважды —
    // решает последняя строка. Своя цена бывает только у товара, упаковку которого
    // вскрывают: убрали мешок — уходит и цена за 1 кг (как у сервера, applyOwnPiece)
    const newPrice = new Map()
    items.forEach((it) => { if (it.price !== null && it.price !== undefined) newPrice.set(it.productId, toCents(D(it.price))) })
    const newPiece = new Map()
    items.forEach((it) => { if (it.piecePrice !== undefined) newPiece.set(it.productId, pieceCentsIn(it.piecePrice)) })
    for (const pid of agg.keys()) {
      const p = byId.get(pid)
      const set = {}
      const was = {}
      if (newPrice.has(pid) && newPrice.get(pid) !== p.priceC) {
        set.priceC = newPrice.get(pid)
        was.priceC = p.priceC
      }
      let piece = newPiece.has(pid) ? newPiece.get(pid) : p.pieceC ?? null
      if (piece !== null && !opensPack(p)) piece = null
      if (piece !== (p.pieceC ?? null)) {
        set.pieceC = piece
        was.pieceC = p.pieceC ?? null
      }
      if (Object.keys(set).length) recordEdit(db, { opId, tbl: 'products', rowId: pid, action: 'put', data: { set, was }, now })
    }

    putDoc(db, 'arrival', body, { sync: 'pending', deviceId: ctx.deviceId })
    enqueue(db, {
      id: opId,
      type: 'arrival',
      accountId: ctx.user.accountId,
      payload: {
        // Закупочную цену в документе храним до дирама, а сумма прихода посчитана по
        // цене, как её ввели: 33,333 × 3 = 100.00, а не 99.99. Сервер пересчитывает
        // сумму сам и сверяет с нашей — поэтому цену он получает неокруглённой
        arrival: {
          ...body,
          items: body.items.map((it, n) => ({
            ...it,
            cost: lines[n].cost.toNumber(),
            ...(items[n].price !== null && items[n].price !== undefined ? { price: items[n].price } : {}),
            ...(items[n].piecePrice !== undefined ? { piecePrice: items[n].piecePrice } : {}),
            ...(items[n].packChanged && packMoved.has(items[n].productId) ? { packChanged: true, ...(packScaled.has(items[n].productId) ? { packScale: true } : {}) } : {}),
          })),
        },
        // Срок годности в самом документе не хранится — он у партии. Серверу его
        // надо передать отдельно, построчно
        expiry,
        deviceId: ctx.deviceId,
      },
      now,
    })
    return body
  })
}
