// ── Долг клиента: история операций и выписка ──
//
// Что видно в окне клиента (раздел «Долги клиентов») и что печатается ему на руки:
// покупки в долг, погашения и возвраты в счёт долга — в том числе отмены чеков в
// кассе. Без возвратов выписка не сходилась бы: долг уменьшился, а в истории — ни
// строчки почему.
//
// Устройство держит продажи только за последние SALES_CACHE_DAYS дней, поэтому история
// — за этот срок, а всё, что было раньше, сводится в одну строку «Прежний долг до <даты>».
// Так выписка сходится всегда:
//   прежний долг + куплено в долг − возвращено − погашено = текущий долг.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { lineUnits, sEdinicami } from './units.js'
import { qtyText } from './otchety.js'
import { isOtmena } from './otmena.js'

// Сколько дней истории держит устройство (как SALES_CACHE_DAYS в db/store.js — здесь
// своё число, чтобы расчёт проверялся без хранилища браузера)
export const DOLG_DAYS = 60

const num = (v) => Number(v) || 0
const kop = (v) => Math.round(num(v) * 100) / 100
const ts = (d) => new Date(d).getTime()

// Товары строкой: «Нурофен ×2 уп, Мука ×1,5 кг». Количество с единицей — через
// неразрывный пробел: «×1» и «уп» не разъезжаются по строкам узкого чека
export function tovaryText(items, t = (s) => s) {
  return (items || [])
    .map((i) => `${i.name} ×${qtyText(i.units !== undefined && i.qty === undefined ? i.units : lineUnits(i), i, t).replace(/ /g, '\u00a0')}`)
    .join(', ')
}

// products — карточки товаров: у строк с сервера нет единицы, она берётся из карточки
// (иначе весовой товар показался бы «×1 уп + 500 шт» вместо «×1,5 кг»)
export function istoriyaDolga({ customer, sales = [], payments = [], returns = [], products = [], now = new Date(), days = DOLG_DAYS }) {
  const id = customer?.id
  const byId = new Map((products || []).map((p) => [p.id, p]))
  const start = new Date(ts(now) - days * 86400000)
  // Верхней границы нет: часы сервера могут спешить, и только что записанное погашение
  // оказалось бы «в будущем» и выпало бы из выписки
  const inWindow = (d) => !!d && ts(d) >= start.getTime()

  // Покупки в долг этого клиента
  const own = new Map()
  for (const s of sales) {
    if (!s || s.payment !== 'debt' || !Array.isArray(s.items)) continue
    if (s.customerId !== id && s.customer?.id !== id) continue
    own.set(s.id, s)
  }
  const events = []
  for (const s of own.values()) {
    if (inWindow(s.date)) events.push({ kind: 'debt', date: s.date, amount: kop(s.total), items: sEdinicami(s.items, byId), saleId: s.id })
  }
  // Погашения
  for (const p of payments) {
    if (p && p.customerId === id && inWindow(p.createdAt || p.date)) {
      events.push({ kind: 'pay', date: p.createdAt || p.date, amount: kop(p.amount) })
    }
  }
  // Возвраты в счёт долга — по чекам этого клиента. Возврат по чеку старше истории
  // устройства сюда не попадёт: его сумма уйдёт в «Прежний долг», и выписка сойдётся
  for (const r of returns) {
    if (!r || r.refund !== 'debt' || !own.has(r.saleId) || !inWindow(r.date)) continue
    events.push({ kind: 'return', date: r.date, amount: kop(r.total), items: sEdinicami(r.items, byId), saleId: r.saleId, otmena: isOtmena(r) })
  }
  // Новые сверху. В одну и ту же секунду покупка — раньше своей отмены и погашения
  const rank = { debt: 0, return: 1, pay: 2 }
  events.sort((a, b) => ts(b.date) - ts(a.date) || rank[b.kind] - rank[a.kind])

  const sum = (kind) => kop(events.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount, 0))
  const totalCredit = sum('debt')
  const totalPaid = sum('pay')
  const totalReturned = sum('return')
  const debt = kop(customer?.debt)
  // «Прежний долг» — всё, что было до начала истории (и долг, вписанный при добавлении
  // клиента), одной суммой
  let opening = kop(debt - totalCredit + totalReturned + totalPaid)
  if (Math.abs(opening) < 0.005) opening = 0
  return { events, start, opening, totalCredit, totalPaid, totalReturned, debt }
}
