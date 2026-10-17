// ── Операции магазина поверх API: продажа, приход, долги ──
// Оптимистично применяем изменения в кэше сразу (мгновенный отклик), запрос уходит
// следом. Продажа НЕ ждёт сервер: чек печатается по локальной записи, покупатель не
// стоит у кассы. Запрос уходит в фоне с повторами; если он всё-таки не прошёл —
// откатываем кэш и громко сообщаем кассиру.
// Расширения в путях указаны намеренно: с ними файл загружается не только
// сборщиком, но и напрямую — этим пользуются тесты слоя данных.
import { api } from './api.js'
import { db, setCollection, refresh, uid, beginMutate, endMutate, realId } from './store.js'
import { normalizeScan, canonBarcode } from '../lib/scan.js'
import { serverNow } from '../lib/time.js'
import { uppOf, unitCost, sellableUnits, expiredUnits, stockUnits, splitUnits } from '../lib/units.js'

// Короткие перебои связи (Wi-Fi моргнул) не должны беспокоить кассира: тихо пробуем ещё раз.
// Повторяем только сетевые сбои — отказ сервера («нет на складе») повторять бессмысленно.
const RETRY_DELAYS = [700, 2000]
const isNetworkError = (e) => !e?.status || e.status >= 500 || e.status === 408

async function postWithRetry(path, body) {
  let lastErr
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await api.post(path, body)
    } catch (e) {
      lastErr = e
      if (!isNetworkError(e) || attempt === RETRY_DELAYS.length) break
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
    }
  }
  throw lastErr
}

// Найти товар по штрихкоду ИЛИ DataMatrix в загруженном кэше (синхронно, для кассы).
// DataMatrix-код содержит GTIN товара — приводим обе стороны к каноническому виду.
export function findByBarcode(code) {
  const raw = String(code ?? '').trim()
  if (!raw) return null
  const products = db.get('products')
  // 1) точное совпадение по введённой строке (обычный штрихкод — без изменений)
  const exact = products.find((p) => p.barcode === raw)
  if (exact) return exact
  // 2) совпадение по каноническому коду (DataMatrix GTIN ↔ штрихкод EAN-13)
  const norm = canonBarcode(normalizeScan(raw))
  return products.find((p) => canonBarcode(p.barcode) === norm) || null
}

// Провести продажу. items: [{productId, name, qty(упаковки), pieces(штуки), price, cost, unitsPerPack, discount}]
// Возвращает { sale, synced }: sale — чек для немедленной печати (считается локально,
// цифры те же, что на сервере), synced — промис фоновой записи (для показа ошибки).
// Бросает исключение сразу только при явных ошибках ввода (пустая корзина, нет остатка).

export function checkout({ items, payment, payVia, customer }) {
  if (!items.length) throw new Error('Корзина пуста')

  // ── Товар мог сменить номер, пока лежал в корзине ──
  // Новый товар показывается сразу, ещё до ответа сервера, под временным номером.
  // Кассир успевает завести его и тут же положить в корзину — а к моменту оплаты
  // номер уже настоящий. Без перевода касса отвечала бы «Товар не найден» на товар,
  // который прямо перед глазами. То же и с клиентом, заведённым минуту назад.
  items = items.map((i) => ({ ...i, productId: realId(i.productId) }))
  if (customer?.id) customer = { ...customer, id: realId(customer.id) }

  const products = db.get('products')
  // Проверка остатков В ШТУКАХ, и только ГОДНЫХ: просроченные партии лежат на складе,
  // но продаже недоступны — сервер их не отдаст. Ловим это здесь, до печати чека,
  // иначе покупатель уже ушёл бы с чеком, а продажа не записалась.
  for (const it of items) {
    const p = products.find((x) => x.id === it.productId)
    if (!p) throw new Error('Товар не найден: ' + it.name)
    const upp = uppOf(it)
    const need = (Number(it.qty) || 0) * upp + (Number(it.pieces) || 0)
    if (need <= 0) throw new Error(`Укажите количество: ${it.name}`)
    const avail = sellableUnits(p)
    if (need > avail) {
      const bad = expiredUnits(p)
      throw new Error(
        bad > 0
          ? `«${p.name}»: годных ${avail} шт, просрочено ${bad} шт. Просроченное продавать нельзя — уберите с полки и спишите.`
          : `Недостаточно «${p.name}» на складе (есть ${avail} шт)`,
      )
    }
  }

  const saleItems = items.map((i) => {
    const upp = uppOf(i)
    const units = (Number(i.qty) || 0) * upp + (Number(i.pieces) || 0)
    const gross = (i.price / upp) * units
    const discount = Math.min(Math.max(0, Number(i.discount) || 0), gross)
    return { productId: i.productId, name: i.name, qty: Number(i.qty) || 0, pieces: Number(i.pieces) || 0, unitsPerPack: upp, unit: i.unit || '', price: i.price, cost: i.cost, discount }
  })
  const total = saleItems.reduce((s, i) => {
    const units = i.qty * i.unitsPerPack + i.pieces
    return s + (i.price / i.unitsPerPack) * units - i.discount
  }, 0)
  const cost = saleItems.reduce((s, i) => {
    const units = i.qty * i.unitsPerPack + i.pieces
    return s + ((i.cost || 0) / i.unitsPerPack) * units
  }, 0)

  const prevP = db.get('products')
  const prevS = db.get('sales')
  const prevC = db.get('customers')

  // Привязываем к открытой смене сразу: тогда счётчики смены и предварительный
  // Z-отчёт учитывают продажу немедленно, не дожидаясь ответа сервера
  const openShiftId = (db.get('shifts').find((s) => !s.closedAt) || {}).id ?? null

  const tempSale = {
    id: 'tmp_' + uid(),
    date: serverNow().toISOString(),
    items: saleItems,
    total,
    cost,
    profit: total - cost,
    payment,
    // Через какой сервис пришёл перевод — только у оплаты переводом
    payVia: payment === 'transfer' ? payVia || null : null,
    shiftId: openShiftId,
    customer: payment === 'debt' && customer ? { id: customer.id, name: customer.name } : null,
  }

  // Сколько ШТУК списываем по каждому товару (суммарно)
  const needByProduct = {}
  saleItems.forEach((i) => {
    needByProduct[i.productId] = (needByProduct[i.productId] || 0) + i.qty * i.unitsPerPack + i.pieces
  })

  // Оптимистично: списываем остатки (пачки + вскрытая), добавляем продажу, наращиваем долг
  setCollection('products', prevP.map((p) => {
    const need = needByProduct[p.id]
    if (!need) return p
    return { ...p, ...splitUnits(stockUnits(p) - need, p) }
  }))
  setCollection('sales', [tempSale, ...prevS])
  if (payment === 'debt' && customer) {
    setCollection('customers', prevC.map((c) => (c.id === customer.id ? { ...c, debt: (c.debt || 0) + total } : c)))
  }

  beginMutate(['products', 'sales', 'customers'])
  // Запрос уходит в фоне — чек уже можно печатать. Промис возвращаем отдельно,
  // чтобы касса показала предупреждение, если продажа всё-таки не записалась.
  const synced = postWithRetry('/sales', {
    items: saleItems.map((i) => ({ productId: i.productId, qty: i.qty, pieces: i.pieces, discount: i.discount })),
    payment,
    payVia: payment === 'transfer' ? payVia : undefined,
    customerId: payment === 'debt' && customer ? customer.id : undefined,
    // Ключ один и тот же у всех повторов: сервер не создаст второй чек,
    // если первый запрос всё-таки дошёл, а ответ потерялся
    clientId: tempSale.id,
  })
    .then((sale) => {
      // Заменяем временную запись серверной (канонические цены/итоги)
      setCollection('sales', db.get('sales').map((s) => (s.id === tempSale.id ? sale : s)))
      // Точные остатки/долги/историю продаж подтягиваем с сервера в фоне
      refresh('products', 'customers', 'sales')
      return sale
    })
    .catch((e) => {
      // Не записалось: возвращаем остатки, долг и список продаж как было
      setCollection('products', prevP)
      setCollection('sales', prevS)
      setCollection('customers', prevC)
      throw e
    })
    .finally(() => endMutate(['products', 'sales', 'customers']))

  return { sale: tempSale, synced }
}

// Провести приход. items: [{productId, name, qty, cost, expiryDate}] — мгновенно, сверка с сервером.
// Срок годности необязателен; если указан — он задаёт
// партию, из которой продажа спишет товар первым. Без него партия просто без срока.
// supplierId и debt — поставщик из справочника и неоплаченная часть (долг перед ним)
export function receiveArrival({ supplier, supplierId, debt, payMethod, paidCash, shiftId, items }) {
  // Товар мог быть заведён только что и ещё не получить настоящий номер — см. realId
  items = items.map((i) => (i.productId ? { ...i, productId: realId(i.productId) } : i))
  if (!items.length) throw new Error('Добавьте хотя бы один товар')

  const arrItems = items.map((i) => ({
    productId: i.productId, name: i.name, qty: Number(i.qty), pieces: Math.max(0, Number(i.pieces) || 0), cost: Number(i.cost),
    expiryDate: i.expiryDate || '',
    // Новая цена продажи, назначенная в приходе (наценкой). Нет — цена прежняя
    ...(Number(i.price) > 0 ? { price: Math.round(Number(i.price) * 100) / 100 } : {}),
  }))
  // Цена за упаковку (за килограмм): граммы оплачиваются долей тысячной
  const total = arrItems.reduce((s, i) => s + i.cost * (i.qty + i.pieces / 1000), 0)

  const prevP = db.get('products')
  const prevA = db.get('arrivals')

  const tempArrival = {
    id: 'tmp_' + uid(),
    date: serverNow().toISOString(),
    supplier: supplier || '—',
    supplierId: supplierId || null,
    debt: supplierId ? Math.max(0, Number(debt) || 0) : 0,
    payMethod: payMethod || '',
    total,
    items: arrItems,
  }

  setCollection('products', prevP.map((p) => {
    const it = arrItems.find((i) => i.productId === p.id)
    if (!it) return p
    // Граммы сверх целых килограммов складываются со вскрытым остатком и
    // перекладываются в целые — иначе «350 + 800 г» показывались бы как 1150 г
    const vsego = stockUnits(p) + it.qty * uppOf(p) + it.pieces
    return { ...p, ...splitUnits(vsego, p), ...(it.price ? { price: it.price } : {}) }
  }))
  setCollection('arrivals', [tempArrival, ...prevA])

  beginMutate(['products', 'arrivals'])
  return api
    .post('/arrivals', {
      supplier,
      ...(supplierId ? { supplierId, debt: Math.max(0, Number(debt) || 0) } : {}),
      ...(payMethod ? { payMethod } : {}),
      // Оплаченная из ящика часть: сервер запишет оплату поставщику из этой смены
      ...(Number(paidCash) > 0 ? { paidCash: Number(paidCash), ...(shiftId ? { shiftId } : {}) } : {}),
      items: arrItems.map((i) => ({
        productId: i.productId,
        qty: i.qty,
        ...(i.pieces > 0 ? { pieces: i.pieces } : {}),
        cost: i.cost,
        // Пустую строку не шлём: у категорий без срока сервер ждёт именно её отсутствия
        ...(i.expiryDate ? { expiryDate: i.expiryDate } : {}),
        ...(i.price ? { price: i.price } : {}),
      })),
    })
    .then((arrival) => {
      setCollection('arrivals', db.get('arrivals').map((a) => (a.id === tempArrival.id ? arrival : a)))
      // Себестоимость пересчитана средневзвешенно на сервере — подтянем точные значения.
      // Приход в долг изменил долг поставщика, оплата из кассы — деньги смены
      refresh('products', 'suppliers', ...(Number(paidCash) > 0 ? ['shifts', 'supplierPayments'] : []))
    })
    .catch((e) => {
      setCollection('products', prevP)
      setCollection('arrivals', prevA)
      throw new Error('Приход не сохранён: ' + e.message)
    })
    .finally(() => endMutate(['products', 'arrivals']))
}

// ── Правка и удаление прихода ──
//
// Здесь мы намеренно НЕ угадываем новый остаток на месте, как делает продажа.
// Приход двигает не только количество: он пересчитывает средневзвешенную
// закупочную цену, а её на устройстве не вывести — она считается по партиям,
// которых у нас нет. Поэтому склад забираем с сервера готовым. Операция редкая
// и хозяйская, доля секунды тут не решает, а вот разъехавшаяся цена решает.

// Один приход с подробностями: сколько от каждой строки уже продано
// и ниже чего нельзя опускать количество
export const getArrival = (id) => api.get(`/arrivals/${realId(id)}`)

export function updateArrival(id, { supplier, supplierId, debt, items }) {
  const prevA = db.get('arrivals')
  beginMutate(['products', 'arrivals'])
  return api
    // Пустой supplierId — убрать поставщика; не прислан — оставить как было
    .patch(`/arrivals/${realId(id)}`, { supplier, ...(supplierId !== undefined ? { supplierId, debt: Math.max(0, Number(debt) || 0) } : {}), items })
    .then((arrival) => {
      setCollection('arrivals', db.get('arrivals').map((a) => (a.id === arrival.id ? arrival : a)))
      refresh('products', 'suppliers')
      return arrival
    })
    .catch((e) => {
      setCollection('arrivals', prevA)
      throw e
    })
    .finally(() => endMutate(['products', 'arrivals']))
}

export function deleteArrival(id) {
  const real = realId(id)
  const prevA = db.get('arrivals')
  // Строку убираем сразу: её исчезновение — это ровно то, что человек нажал,
  // и угадывать тут нечего
  setCollection('arrivals', prevA.filter((a) => a.id !== id))
  beginMutate(['products', 'arrivals'])
  return api
    .del(`/arrivals/${real}`)
    .then(() => refresh('products', 'suppliers'))
    .catch((e) => {
      setCollection('arrivals', prevA)
      throw e
    })
    .finally(() => endMutate(['products', 'arrivals']))
}

// Погасить долг клиента — мгновенно, сверка с сервером
export function payDebt(customerId, amount) {
  customerId = realId(customerId)
  const amt = Number(amount)
  const prevC = db.get('customers')
  setCollection('customers', prevC.map((c) => (c.id === customerId ? { ...c, debt: Math.max(0, (c.debt || 0) - amt) } : c)))
  beginMutate(['customers', 'payments'])
  return api
    .post(`/customers/${customerId}/pay`, { amount: amt })
    .then((updated) => {
      setCollection('customers', db.get('customers').map((c) => (c.id === customerId ? updated : c)))
      refresh('payments')
    })
    .catch((e) => {
      setCollection('customers', prevC)
      throw new Error('Погашение не сохранено: ' + e.message)
    })
    .finally(() => endMutate(['customers', 'payments']))
}

// ── Смена кассы ──
// Обе операции мгновенные: интерфейс меняется сразу, запись уходит в фоне.
// При неудаче возвращаем прежнее состояние и отдаём ошибку вызывающей стороне.

export function openShift(openingCash, user) {
  const prev = db.get('shifts')
  const tempShift = {
    id: 'tmp_' + uid(),
    openedAt: serverNow().toISOString(),
    openingCash: Number(openingCash) || 0,
    closedAt: null,
    count: 0,
    user: user ? { id: user.id, name: user.name } : null,
    userId: user?.id ?? null,
  }
  setCollection('shifts', [tempShift, ...prev])

  // Без автоповторов: повторное открытие/закрытие смены не идемпотентно, а покупатель
  // здесь не ждёт — при сбое проще показать ошибку и повторить вручную
  beginMutate(['shifts'])
  const synced = api.post('/shifts/open', { openingCash: tempShift.openingCash })
    .then((shift) => {
      setCollection('shifts', db.get('shifts').map((s) => (s.id === tempShift.id ? shift : s)))
      refresh('shifts')
      return shift
    })
    .catch((e) => {
      setCollection('shifts', prev)
      throw e
    })
    .finally(() => endMutate(['shifts']))

  return { shift: tempShift, synced }
}

// localShift — предварительный Z-отчёт, посчитанный кассой (показываем сразу).
// Итоговые цифры приходят с сервера и заменяют предварительные.
export function closeShift(countedCash, localShift) {
  const prev = db.get('shifts')
  const current = prev.find((s) => !s.closedAt)
  const closedTemp = { ...current, ...localShift, closedAt: serverNow().toISOString(), countedCash: Number(countedCash) || 0 }
  if (current) setCollection('shifts', prev.map((s) => (s.id === current.id ? closedTemp : s)))

  beginMutate(['shifts'])
  const synced = api.post('/shifts/close', { countedCash: Number(countedCash) || 0 })
    .then((shift) => {
      setCollection('shifts', db.get('shifts').map((s) => (s.id === closedTemp.id || s.id === shift.id ? shift : s)))
      refresh('shifts', 'sales', 'customers', 'payments')
      return shift
    })
    .catch((e) => {
      setCollection('shifts', prev)
      throw e
    })
    .finally(() => endMutate(['shifts']))

  return { shift: closedTemp, synced }
}

// Пересчёт остатка товара после возврата или списания: держим упаковки и
// вскрытые штуки согласованными, как это делает сервер
function applyUnits(list, byProduct, sign) {
  return list.map((p) => {
    const change = byProduct[p.id]
    if (!change) return p
    return { ...p, ...splitUnits(stockUnits(p) + sign * change, p) }
  })
}

// ── Возврат товара — мгновенно ──
// Кассир не должен ждать сервер, стоя перед покупателем: товар возвращается на
// склад и в журнал сразу, запись уходит следом. У возврата есть ключ повтора,
// поэтому короткий обрыв связи можно тихо переиграть — второго возврата не будет.
export function returnGoods({ saleId, refund, refundVia, customerId, lines, total }) {
  lines = lines.map((l) => (l.productId ? { ...l, productId: realId(l.productId) } : l))
  if (customerId) customerId = realId(customerId)
  const items = lines.filter((l) => l.units > 0 && !l.deleted)
  if (!items.length) throw new Error('Укажите количество для возврата')

  const prevP = db.get('products')
  const prevR = db.get('returns')
  const prevC = db.get('customers')
  const openShiftId = (db.get('shifts').find((s) => !s.closedAt) || {}).id ?? null

  const temp = {
    id: 'ret_' + uid(),
    date: serverNow().toISOString(),
    saleId: saleId ?? null,
    shiftId: openShiftId,
    refund,
    refundVia: refund === 'transfer' ? refundVia || null : null,
    total,
    note: '',
    user: null,
    items: items.map((l, n) => ({
      id: 'reti_' + n + '_' + uid(),
      productId: l.productId,
      name: l.name,
      units: l.units,
      unit: l.unit || '',
      unitsPerPack: l.unitsPerPack || 1,
      price: l.price || 0,
      cost: l.cost || 0,
      amount: l.amount || 0,
      restock: l.restock !== false,
    })),
  }

  // Вернувшийся в продажу товар сразу кладём обратно на полку
  const back = {}
  items.forEach((l) => {
    if (l.restock !== false) back[l.productId] = (back[l.productId] || 0) + l.units
  })

  setCollection('products', applyUnits(prevP, back, +1))
  setCollection('returns', [temp, ...prevR])
  if (refund === 'debt' && customerId) {
    setCollection('customers', prevC.map((c) => (c.id === customerId ? { ...c, debt: Math.max(0, (c.debt || 0) - total) } : c)))
  }

  beginMutate(['products', 'returns', 'customers'])
  const synced = postWithRetry('/returns', {
    saleId: saleId ?? undefined,
    refund,
    ...(refund === 'transfer' && refundVia ? { refundVia } : {}),
    clientId: temp.id,
    items: items.map((l) => ({
      productId: l.productId,
      units: l.units,
      restock: l.restock !== false,
      // Срок с упаковки — только если кассир его вписал; иначе срок ставит сервер
      ...(l.restock !== false && l.expiry ? { expiryDate: l.expiry } : {}),
    })),
  })
    .then((ret) => {
      setCollection('returns', db.get('returns').map((r) => (r.id === temp.id ? ret : r)))
      refresh('products', 'customers', 'returns', 'shifts')
      return ret
    })
    .catch((e) => {
      setCollection('products', prevP)
      setCollection('returns', prevR)
      setCollection('customers', prevC)
      throw e
    })
    .finally(() => endMutate(['products', 'returns', 'customers']))

  return { ret: temp, synced }
}

// ── Списание — мгновенно ──
// Повторов при сбое НЕ делаем: у списания нет ключа защиты от задвоения,
// и молчаливая вторая попытка убрала бы товар со склада дважды.
export function writeOffGoods({ items, reason, note }) {
  items = items.map((i) => (i.productId ? { ...i, productId: realId(i.productId) } : i))
  const rows = items.filter((i) => i.units > 0)
  if (!rows.length) throw new Error('Укажите количество для списания')

  const prevP = db.get('products')
  const prevW = db.get('writeoffs')
  const products = db.get('products')

  const totalCost = rows.reduce((s, r) => {
    const p = products.find((x) => x.id === r.productId)
    return p ? s + unitCost(p) * r.units : s
  }, 0)

  const temp = {
    id: 'wo_' + uid(),
    date: serverNow().toISOString(),
    reason: reason || 'expired',
    note: note || '',
    source: 'manual',
    totalCost,
    user: null,
    items: rows.map((r, n) => {
      const p = products.find((x) => x.id === r.productId)
      return {
        id: 'woi_' + n + '_' + uid(),
        productId: r.productId,
        name: r.name,
        units: r.units,
        cost: p ? p.cost : 0,
        expiryDate: p ? p.expiryDate : null,
      }
    }),
  }

  const off = {}
  rows.forEach((r) => (off[r.productId] = (off[r.productId] || 0) + r.units))

  setCollection('products', applyUnits(prevP, off, -1))
  setCollection('writeoffs', [temp, ...prevW])

  beginMutate(['products', 'writeoffs'])
  const synced = api
    .post('/writeoffs', { reason, note, items: rows.map((r) => ({ productId: r.productId, units: r.units })) })
    .then((wo) => {
      setCollection('writeoffs', db.get('writeoffs').map((w) => (w.id === temp.id ? wo : w)))
      refresh('products', 'writeoffs')
      return wo
    })
    .catch((e) => {
      setCollection('products', prevP)
      setCollection('writeoffs', prevW)
      throw e
    })
    .finally(() => endMutate(['products', 'writeoffs']))

  return { writeOff: temp, synced }
}

// ── Расходы магазина ──
// Здесь ответа сервера ждём, а не показываем запись заранее: расход вносит владелец
// за столом, а не кассир перед покупателем, и знать наверняка, что запись легла,
// важнее выигранной полсекунды. У запроса есть ключ повтора, поэтому короткий обрыв
// связи переигрывается тихо — второго расхода не будет.
const repeatKey = () => {
  try {
    return 'exp_' + crypto.randomUUID()
  } catch {
    return 'exp_' + uid() + uid()
  }
}

// Расход из кассы меняет и наличные, которые ждут в смене, — смены перечитываем следом
const afterExpense = (touchesShift) => refresh(...(touchesShift ? ['expenses', 'shifts'] : ['expenses']))

export async function addExpense({ date, category, amount, note, fromCash, shiftId, employeeId, salaryMonth, bonusFrom, bonusTo }) {
  const body = {
    category,
    amount: Math.round(Number(amount) * 100) / 100,
    note: (note || '').trim(),
    clientId: repeatKey(),
    // Зарплата: кому выдана (имя сервер запомнит сам) и за какой месяц — по нему
    // считается, сколько ещё осталось выдать
    // И за какие дни считали бонус от продаж
    ...(employeeId ? { employeeId, ...(salaryMonth ? { salaryMonth } : {}), ...(bonusFrom && bonusTo ? { bonusFrom, bonusTo } : {}) } : {}),
    // У расхода из кассы дата всегда «сейчас» — её ставит сервер; смену называем сами,
    // чтобы деньги списались именно с той кассы, которую выбрал владелец
    ...(fromCash ? { fromCash: true, ...(shiftId ? { shiftId } : {}) } : date ? { date } : {}),
  }
  beginMutate(['expenses'])
  try {
    const created = await postWithRetry('/expenses', body)
    setCollection('expenses', [created, ...db.get('expenses').filter((e) => e.id !== created.id)])
    return created
  } finally {
    endMutate(['expenses'])
    afterExpense(!!fromCash)
  }
}

export async function updateExpense(expense, patch) {
  beginMutate(['expenses'])
  try {
    const updated = await api.patch('/expenses/' + expense.id, patch)
    setCollection('expenses', db.get('expenses').map((e) => (e.id === updated.id ? updated : e)))
    return updated
  } finally {
    endMutate(['expenses'])
    afterExpense(!!expense.fromCash)
  }
}

export async function removeExpense(expense) {
  beginMutate(['expenses'])
  try {
    await api.del('/expenses/' + expense.id)
    setCollection('expenses', db.get('expenses').filter((e) => e.id !== expense.id))
  } finally {
    endMutate(['expenses'])
    afterExpense(!!expense.fromCash)
  }
}

// ── Доходы вне продаж ──
// Как расходы, но без кассы: в денежный ящик доход не попадает, поэтому смену не трогает.
// Ответа сервера ждём; ключ повтора — на случай обрыва связи
export async function addIncome({ date, category, amount, note }) {
  const body = {
    category,
    amount: Math.round(Number(amount) * 100) / 100,
    note: (note || '').trim(),
    clientId: repeatKey(),
    ...(date ? { date } : {}),
  }
  beginMutate(['incomes'])
  try {
    const created = await postWithRetry('/incomes', body)
    setCollection('incomes', [created, ...db.get('incomes').filter((e) => e.id !== created.id)])
    return created
  } finally {
    endMutate(['incomes'])
    refresh('incomes')
  }
}

export async function updateIncome(income, patch) {
  beginMutate(['incomes'])
  try {
    const updated = await api.patch('/incomes/' + income.id, patch)
    setCollection('incomes', db.get('incomes').map((e) => (e.id === updated.id ? updated : e)))
    return updated
  } finally {
    endMutate(['incomes'])
    refresh('incomes')
  }
}

export async function removeIncome(income) {
  beginMutate(['incomes'])
  try {
    await api.del('/incomes/' + income.id)
    setCollection('incomes', db.get('incomes').filter((e) => e.id !== income.id))
  } finally {
    endMutate(['incomes'])
    refresh('incomes')
  }
}

// ── Наличные в смене: внести размен, изъять выручку ──
// Ответа сервера ждём: деньги в ящике — не продажа, покупатель не стоит, а знать
// наверняка, что запись легла, важнее полсекунды. Ключ повтора — на случай обрыва
export async function cashMove({ kind, amount, note, shiftId }) {
  beginMutate(['cashMoves', 'shifts'])
  try {
    const move = await postWithRetry('/shifts/cash', {
      kind,
      amount: Math.round(Number(amount) * 100) / 100,
      note: (note || '').trim(),
      ...(shiftId ? { shiftId } : {}),
      clientId: repeatKey(),
    })
    setCollection('cashMoves', [move, ...db.get('cashMoves').filter((m) => m.id !== move.id)])
    return move
  } finally {
    endMutate(['cashMoves', 'shifts'])
    refresh('cashMoves', 'shifts')
  }
}

export async function removeCashMove(id) {
  beginMutate(['cashMoves', 'shifts'])
  try {
    await api.del('/cash-moves/' + id)
    setCollection('cashMoves', db.get('cashMoves').filter((m) => m.id !== id))
  } finally {
    endMutate(['cashMoves', 'shifts'])
    refresh('cashMoves', 'shifts')
  }
}

// ── Оплата поставщику ──
// Долг поставщика уменьшается на сервере; из кассы — ещё и наличные в смене
export async function paySupplier(id, { amount, note, fromCash, shiftId }) {
  beginMutate(['suppliers', 'supplierPayments', 'shifts'])
  try {
    const payment = await postWithRetry(`/suppliers/${realId(id)}/pay`, {
      amount: Math.round(Number(amount) * 100) / 100,
      note: (note || '').trim(),
      clientId: repeatKey(),
      ...(fromCash ? { fromCash: true, ...(shiftId ? { shiftId } : {}) } : {}),
    })
    setCollection('supplierPayments', [payment, ...db.get('supplierPayments').filter((p) => p.id !== payment.id)])
    setCollection('suppliers', db.get('suppliers').map((s) => (s.id === payment.supplierId ? { ...s, debt: Math.max(0, (Number(s.debt) || 0) - Number(payment.amount)) } : s)))
    return payment
  } finally {
    endMutate(['suppliers', 'supplierPayments', 'shifts'])
    refresh('suppliers', 'supplierPayments', 'shifts')
  }
}

export async function removeSupplierPayment(id) {
  beginMutate(['suppliers', 'supplierPayments', 'shifts'])
  try {
    await api.del('/supplier-payments/' + id)
    setCollection('supplierPayments', db.get('supplierPayments').filter((p) => p.id !== id))
  } finally {
    endMutate(['suppliers', 'supplierPayments', 'shifts'])
    refresh('suppliers', 'supplierPayments', 'shifts')
  }
}

// Товары ниже минимума — для авто-заявки (синхронно из кэша).
// Считаем ГОДНЫЙ остаток: просроченные упаковки заказ не отменяют, их всё равно
// придётся списать. И считаем в штуках — вскрытая упаковка тоже товар, из-за неё
// заявка предлагала заказать то, что ещё лежит на полке.
export function lowStockProducts() {
  return db
    .get('products')
    .filter((p) => sellableUnits(p) <= p.minStock * uppOf(p))
    .map((p) => {
      const packs = Math.floor(sellableUnits(p) / uppOf(p))
      return { ...p, need: Math.max(p.minStock * 2 - packs, p.minStock) }
    })
}
