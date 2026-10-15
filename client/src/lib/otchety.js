// ── Отчёты: продажи, закупки у поставщиков, сверка с поставщиками, зарплата ──
//
// Все расчёты здесь — без браузера и без запросов: страница даёт списки (продажи,
// приходы, оплаты), а получает готовые строки и итоги. Так одни и те же числа видны
// на экране, в Excel и на печати, и каждое проверяется тестом.
//
// Деньги считаем до дирама: копейки, расползшиеся по строкам, в итоге должны
// сходиться ровно с суммой документа.
import { uppOf, lineNet, lineCost, lineUnits, isVesovoy, kgText, edinica, KG } from './units.js'

const num = (v) => Number(v) || 0
// До дирама, половина — от нуля. 8,325 в двоичной арифметике хранится как
// 8,32499…, поэтому сначала отбрасываем этот хвост (12 значащих цифр), потом округляем
const kop = (x) => (Math.sign(x) * Math.round(Number((Math.abs(x) * 100).toPrecision(12)))) / 100 || 0
const ts = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime())
// Попадает ли момент в период [from, to). Пустой конец — без ограничения
export const vPeriode = (date, from, to) => {
  const t = ts(date)
  if (Number.isNaN(t)) return false
  if (from && t < ts(from)) return false
  if (to && t >= ts(to)) return false
  return true
}

// Сколько единиц товара в штуках (у дробного — в тысячных) — текстом в его единице:
// «12 уп + 3 шт», «2,5 л», «40 рулон»
export function qtyText(units, product, t = (s) => s) {
  const u = Math.max(0, Math.round(num(units)))
  const p = product || {}
  if (isVesovoy(p)) return `${kgText(u)} ${t(edinica(p))}`
  const upp = uppOf(p)
  if (upp <= 1) return `${u} ${t(edinica(p))}`
  const packs = Math.floor(u / upp)
  const loose = u % upp
  return [packs ? `${packs} ${t(edinica(p))}` : '', loose ? `${loose} ${t('шт')}` : ''].filter(Boolean).join(' + ') || `0 ${t(edinica(p))}`
}

// ── Продажи по товарам ──
// Сколько продано каждого товара, выручка (после скидок), себестоимость и прибыль.
// Строки — от самого прибыльного по выручке
export function prodazhiPoTovaram({ sales, products, from, to, t = (s) => s }) {
  const byId = new Map((products || []).map((p) => [p.id, p]))
  const rows = new Map()
  for (const s of sales || []) {
    if (!vPeriode(s.date, from, to)) continue
    for (const i of s.items || []) {
      const key = i.productId || 'name:' + i.name
      const r = rows.get(key) || { key, productId: i.productId || null, name: i.name, category: '', units: 0, revenue: 0, cost: 0, lines: 0 }
      r.units += lineUnits(i)
      r.revenue += lineNet(i)
      r.cost += lineCost(i)
      r.lines += 1
      rows.set(key, r)
    }
  }
  const list = [...rows.values()].map((r) => {
    const p = byId.get(r.productId)
    // Единица — по карточке; у удалённого товара — по снимку в чеке
    const like = p || { unitsPerPack: 1, unit: 'шт' }
    const revenue = kop(r.revenue)
    const cost = kop(r.cost)
    const profit = kop(revenue - cost)
    return {
      ...r,
      name: p?.name || r.name,
      category: p?.category || '',
      qty: qtyText(r.units, like, t),
      revenue,
      cost,
      profit,
      margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
    }
  })
  list.sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru'))
  const itogo = list.reduce((a, r) => ({ revenue: a.revenue + r.revenue, cost: a.cost + r.cost, profit: a.profit + r.profit }), { revenue: 0, cost: 0, profit: 0 })
  return { rows: list, itogo: { revenue: kop(itogo.revenue), cost: kop(itogo.cost), profit: kop(itogo.profit), positions: list.length } }
}

// ── Все продажи построчно ──
// Каждая позиция чека: когда, какой чек, кто продал, что, сколько, скидка, сумма, оплата
export function vseProdazhi({ sales, products, from, to, t = (s) => s }) {
  const byId = new Map((products || []).map((p) => [p.id, p]))
  const rows = []
  for (const s of sales || []) {
    if (!vPeriode(s.date, from, to)) continue
    for (const i of s.items || []) {
      const p = byId.get(i.productId) || { unitsPerPack: uppOf(i), unit: uppOf(i) === KG ? 'кг' : 'уп' }
      rows.push({
        saleId: s.id,
        date: s.date,
        cashier: s.user?.name || '',
        userId: s.userId || s.user?.id || null,
        payment: s.payment || 'cash',
        payVia: s.payVia || '',
        name: i.name,
        qty: qtyText(lineUnits(i), { ...p, unitsPerPack: uppOf(i) }, t),
        price: num(i.price),
        discount: kop(Math.max(0, num(i.discount))),
        sum: kop(lineNet(i)),
      })
    }
  }
  rows.sort((a, b) => ts(b.date) - ts(a.date))
  const itogo = rows.reduce((a, r) => ({ sum: a.sum + r.sum, discount: a.discount + r.discount }), { sum: 0, discount: 0 })
  return { rows, itogo: { sum: kop(itogo.sum), discount: kop(itogo.discount), lines: rows.length, cheki: new Set(rows.map((r) => r.saleId)).size } }
}

// Оплата прихода из ящика кассы записывается оплатой поставщику с ключом
// «<приход>:pay». Это не погашение долга, а оплата самого прихода: она уже видна
// как «оплачено» в его строках, и второй раз её считать нельзя
export const oplataPrihoda = (p) => typeof p?.clientId === 'string' && p.clientId.endsWith(':pay')

// Сумма строки прихода: цена за упаковку (за килограмм) × сколько пришло
function arrivalLineSum(it, product) {
  const upp = product ? uppOf(product) : num(it.pieces) > 0 ? KG : 1
  return num(it.cost) * (num(it.qty) + num(it.pieces) / upp)
}

// ── Закупки и оплаты поставщикам — одной таблицей по датам ──
// Строка закупки: что купили, сколько, почём, на какую сумму и сколько из неё
// оплачено сразу и сколько ушло в долг. Оплата и долг прихода делятся между его
// строками пропорционально сумме, остаток округления — последней строке: так
// итоги колонок сходятся с приходом до дирама. Строка оплаты — погашение долга.
export function zakupkiIOplaty({ arrivals, supplierPayments, products, from, to, supplierId = '', t = (s) => s }) {
  const byId = new Map((products || []).map((p) => [p.id, p]))
  const rows = []
  for (const a of arrivals || []) {
    if (!vPeriode(a.date, from, to)) continue
    if (supplierId && a.supplierId !== supplierId) continue
    const items = a.items || []
    const sums = items.map((it) => kop(arrivalLineSum(it, byId.get(it.productId))))
    const total = kop(sums.reduce((s, x) => s + x, 0))
    const debtAll = kop(Math.min(Math.max(0, num(a.debt)), total))
    let debtLeft = debtAll
    items.forEach((it, n) => {
      const last = n === items.length - 1
      const debt = last ? kop(debtLeft) : total > 0 ? kop((debtAll * sums[n]) / total) : 0
      debtLeft = kop(debtLeft - debt)
      const p = byId.get(it.productId)
      const units = num(it.qty) * (p ? uppOf(p) : num(it.pieces) > 0 ? KG : 1) + num(it.pieces)
      rows.push({
        kind: 'buy',
        id: `${a.id}:${n}`,
        arrivalId: a.id,
        date: a.date,
        supplierId: a.supplierId || null,
        supplier: a.supplier && a.supplier !== '—' ? a.supplier : '',
        name: it.name,
        qty: qtyText(units, p || { unitsPerPack: num(it.pieces) > 0 ? KG : 1, unit: num(it.pieces) > 0 ? 'кг' : 'уп' }, t),
        price: num(it.cost),
        sum: sums[n],
        paid: kop(sums[n] - debt),
        debt,
        user: a.user?.name || '',
      })
    })
  }
  for (const p of supplierPayments || []) {
    if (oplataPrihoda(p)) continue
    if (!vPeriode(p.date, from, to)) continue
    if (supplierId && p.supplierId !== supplierId) continue
    const amount = kop(num(p.amount))
    rows.push({
      kind: 'pay',
      id: 'pay:' + p.id,
      date: p.date,
      supplierId: p.supplierId,
      supplier: p.supplier?.name || '',
      name: p.note ? `${t('Оплата долга')} · ${p.note}` : t('Оплата долга'),
      fromCash: !!p.fromCash,
      qty: '',
      price: 0,
      sum: 0,
      paid: amount,
      debt: -amount,
      user: p.user?.name || '',
    })
  }
  rows.sort((x, y) => ts(y.date) - ts(x.date) || (x.kind === y.kind ? 0 : x.kind === 'pay' ? -1 : 1))
  const itogo = rows.reduce((s, r) => ({ sum: s.sum + r.sum, paid: s.paid + r.paid, debt: s.debt + r.debt }), { sum: 0, paid: 0, debt: 0 })
  return { rows, itogo: { sum: kop(itogo.sum), paid: kop(itogo.paid), debt: kop(itogo.debt) } }
}

// ── Сверка с поставщиками за период ──
// По каждому: долг на начало, закуплено, оплачено, долг на конец.
// Долг на конец периода считаем от нынешнего долга назад: вычитаем всё, что
// добавилось в долг после конца периода, и возвращаем оплаты, сделанные после.
// Поэтому списки приходов и оплат нужны от начала периода до сегодняшнего дня.
// Сходится всегда: конец = начало + закуплено − оплачено.
export function sverkaPostavshikov({ suppliers, arrivals, supplierPayments, from, to }) {
  const rows = new Map()
  const row = (id, name, debtNow) => {
    if (!rows.has(id)) rows.set(id, { supplierId: id, name, debtNow: num(debtNow), zakupleno: 0, oplacheno: 0, vDolg: 0, oplatyDolga: 0, posle: 0 })
    return rows.get(id)
  }
  for (const s of suppliers || []) row(s.id, s.name, s.debt)
  const afterTo = (d) => to && ts(d) >= ts(to)
  for (const a of arrivals || []) {
    if (from && ts(a.date) < ts(from)) continue
    const id = a.supplierId || ''
    const r = row(id, id ? a.supplier : '', 0)
    const debt = Math.max(0, num(a.debt))
    if (afterTo(a.date)) {
      r.posle -= debt // долг, добавившийся после периода, на конец периода ещё не числился
      continue
    }
    r.zakupleno += num(a.total)
    r.oplacheno += num(a.total) - debt
    r.vDolg += debt
  }
  for (const p of supplierPayments || []) {
    if (oplataPrihoda(p)) continue
    if (from && ts(p.date) < ts(from)) continue
    const r = row(p.supplierId, p.supplier?.name || '', 0)
    if (afterTo(p.date)) {
      r.posle += num(p.amount) // оплаченное после периода в конце периода ещё было долгом
      continue
    }
    r.oplacheno += num(p.amount)
    r.oplatyDolga += num(p.amount)
  }
  const list = [...rows.values()]
    .map((r) => {
      // У прихода без поставщика долга нет: «должны» некому
      const konec = r.supplierId ? kop(r.debtNow + r.posle) : 0
      const nachalo = r.supplierId ? kop(konec - r.vDolg + r.oplatyDolga) : 0
      return {
        supplierId: r.supplierId,
        name: r.name,
        nachalo,
        zakupleno: kop(r.zakupleno),
        oplacheno: kop(r.oplacheno),
        konec,
      }
    })
    // Поставщик без движения и без долга в отчёте только мешает
    .filter((r) => r.nachalo || r.zakupleno || r.oplacheno || r.konec)
  list.sort((a, b) => (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) || b.konec - a.konec || a.name.localeCompare(b.name, 'ru'))
  const sum = (k) => kop(list.reduce((s, r) => s + r[k], 0))
  return { rows: list, itogo: { nachalo: sum('nachalo'), zakupleno: sum('zakupleno'), oplacheno: sum('oplacheno'), konec: sum('konec') } }
}

// ── Зарплата ──
// Продажи сотрудника за период — сумма его чеков после скидок
export function prodazhiSotrudnika(sales, userId, from, to) {
  if (!userId) return 0
  return kop((sales || []).filter((s) => (s.userId || s.user?.id) === userId && vPeriode(s.date, from, to)).reduce((a, s) => a + num(s.total), 0))
}

// К выдаче: оклад + бонус (процент от продаж). Всё до дирама
export function zarplataKVydache({ salary, bonusPercent, salesSum }) {
  const bonus = kop((Math.max(0, num(salesSum)) * Math.max(0, num(bonusPercent))) / 100)
  return { salary: kop(Math.max(0, num(salary))), bonus, total: kop(Math.max(0, num(salary)) + bonus) }
}

// Месяц по таджикскому времени: начало и конец как моменты. key — «2026-10»
export function mesyac(key) {
  const [y, m] = String(key).split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1) - 5 * 3600000)
  const to = new Date(Date.UTC(y, m, 1) - 5 * 3600000)
  return { from, to }
}

// Последние n месяцев от месяца now (таджикское время), от нынешнего назад
export function poslednieMesyacy(n, now = new Date()) {
  const tj = new Date(ts(now) + 5 * 3600000)
  let y = tj.getUTCFullYear()
  let m = tj.getUTCMonth() + 1
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) {
      m = 12
      y -= 1
    }
  }
  return out
}
