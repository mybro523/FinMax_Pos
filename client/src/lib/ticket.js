// ── Чек и Z-отчёт для чекового принтера ──
//
// Обычная печать — это снимок того, что на экране. Чековому принтеру (программа для
// Windows, ESC/POS) шлют не картинку, а строки: шапку, позиции, итоги. Здесь из
// чека и из Z-отчёта собираются именно такие строки — уже готовыми словами, на
// выбранном языке и с деньгами в принятом виде. Принтеру остаётся разложить их
// по ленте (desktop/src/print/escpos.mjs).
//
// Перевод, вид денег и дат передаются снаружи — модуль проверяется без браузера.
import { uppOf, lineNet } from './units.js'

// Сколько и почём: целые упаковки — по цене упаковки, всё остальное — в штуках по
// цене штуки. То же, что видит кассир в чеке на экране
export function qtyPriceText(i, t, money) {
  const upp = uppOf(i)
  if (!i.pieces && i.qty) return `${i.qty} ${t('уп')} × ${money(i.price)}`
  const units = (i.qty || 0) * upp + (i.pieces || 0)
  return `${units} ${t('шт')} × ${money(i.price / upp)}`
}

function payLabel(payment, t) {
  if (payment === 'card') return t('Карта')
  if (payment === 'debt') return t('В долг')
  if (payment === 'transfer') return t('Перевод')
  return t('Наличные')
}

// ── Чек продажи ──
export function saleTicket(sale, { t, money, when, pharmacy = '', cashier = '' }) {
  const items = Array.isArray(sale?.items) ? sale.items : []
  const discount = items.reduce((s, i) => s + (i.discount || 0), 0)
  const totals = []
  if (discount > 0) totals.push({ label: t('Скидка'), value: '−' + money(discount) })
  totals.push({ label: t('Итого'), value: money(sale.total), big: true })
  // У перевода — через какой сервис: по нему покупатель и аптека ищут платёж
  totals.push({ label: t('Оплата'), value: payLabel(sale.payment, t) + (sale.payment === 'transfer' && sale.payVia ? ` · ${sale.payVia}` : '') })
  // Покупатель сверяет сдачу по чеку: сколько дал и сколько ему вернули
  if (sale.received !== null && sale.received !== undefined) {
    totals.push({ label: t('Получено'), value: money(sale.received) })
    totals.push({ label: t('Сдача'), value: money(sale.change) })
  }
  if (sale.customer?.name) totals.push({ label: t('Клиент'), value: sale.customer.name })
  const who = cashier || sale.user?.name || ''
  return {
    head: [pharmacy || t('Аптека'), when(sale.date)],
    rows: items.map((i) => ({
      name: i.name,
      sub: qtyPriceText(i, t, money) + (i.discount > 0 ? ` · ${t('скидка')} −${money(i.discount)}` : ''),
      value: money(lineNet(i)),
    })),
    totals,
    tail: [...(who ? [`${t('Кассир')}: ${who}`] : []), t('Спасибо за покупку!')],
  }
}

// ── Z-отчёт смены ──
// totals — чистые числа смены (shiftTotals из lib/finance): выручка и прибыль за
// вычетом возвратов
export function shiftTicket(shift, totals, { t, money, when, pharmacy = '' }) {
  const rows = [
    { label: t('Чеков'), value: String(shift.count ?? 0) },
    { label: t('Наличными'), value: money(shift.salesCash) },
    { label: t('Картой'), value: money(shift.salesCard) },
    { label: t('В долг'), value: money(shift.salesDebt) },
  ]
  // Переводы — и всего, и по сервисам: их сверяют с выпиской каждого
  if ((shift.salesTransfer || 0) > 0) {
    rows.push({ label: t('Переводом'), value: money(shift.salesTransfer) })
    for (const [via, sum] of Object.entries(shift.transferBy || {})) rows.push({ label: '  ' + via, value: money(sum) })
  }
  if ((shift.debtPaid || 0) > 0) rows.push({ label: t('Погашено долгов (нал.)'), value: money(shift.debtPaid) })
  rows.push({ label: t('Скидки'), value: '−' + money(shift.discount) })
  if (totals.refunds > 0) {
    rows.push({ label: t('Продано за смену'), value: money(totals.gross) })
    rows.push({ label: t('Возвраты покупателям'), value: '−' + money(totals.refunds) })
  }
  rows.push({ label: t('Выручка'), value: money(totals.netSales), big: true })
  rows.push({ label: t('Прибыль'), value: money(totals.netProfit) })
  rows.push({ label: t('Касса на старте'), value: money(shift.openingCash) })
  if ((shift.cashIn || 0) > 0) rows.push({ label: t('Внесено в кассу'), value: '+' + money(shift.cashIn) })
  if ((shift.refundCash || 0) > 0) rows.push({ label: t('Выдано за возвраты (нал.)'), value: '−' + money(shift.refundCash) })
  // Деньги, взятые из ящика на расходы аптеки: без этой строки «ожидалось» не сходится
  // с продажами на бумаге
  if ((shift.expenseCash || 0) > 0) rows.push({ label: t('Расходы из кассы'), value: '−' + money(shift.expenseCash) })
  if ((shift.supplierCash || 0) > 0) rows.push({ label: t('Оплачено поставщикам (нал.)'), value: '−' + money(shift.supplierCash) })
  if ((shift.cashOut || 0) > 0) rows.push({ label: t('Изъято из кассы'), value: '−' + money(shift.cashOut) })
  rows.push({ label: t('Ожидалось в кассе'), value: money(shift.expectedCash) })
  rows.push({ label: t('Пересчитано (факт)'), value: money(shift.countedCash || 0) })
  rows.push({ label: t('Расхождение'), value: (shift.difference > 0 ? '+' : '') + money(shift.difference), big: true })
  const period = `${when(shift.openedAt)} — ${shift.closedAt ? when(shift.closedAt) : ''}`.trim()
  return {
    head: [pharmacy || t('Аптека'), t('Z-отчёт смены'), period, ...(shift.deviceName ? [shift.deviceName] : [])],
    rows: [],
    totals: rows,
    tail: [...(shift.user?.name ? [`${t('Кассир')}: ${shift.user.name}`] : [])],
  }
}
