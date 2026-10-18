// ── Чек, чек возврата и Z-отчёт: строки одного вида для экрана и принтера ──
//
// Раньше на экране чек рисовался одним кодом, а на ленту уходил другим — и они
// уже начали расходиться. Теперь любой чек сначала собирается здесь в один вид
// (шапка, позиции, итоги, подвал), а дальше его одинаково показывают на экране
// (components/TicketView.jsx), печатают окном браузера, шлют на чековую ленту
// (desktop/src/print/escpos.mjs) и кладут в PDF. Поменяется строка — поменяется
// во всех четырёх местах разом.
//
// Перевод, вид денег и дат передаются снаружи — модуль проверяется без браузера.
import { uppOf, lineNet, lineUnits, isVesovoy, kgText, edinica } from './units.js'

// Сколько и почём: целые упаковки — по цене упаковки, всё остальное — в штуках по
// цене штуки. То же, что видит кассир в чеке на экране
export function qtyPriceText(i, t, money) {
  const upp = uppOf(i)
  // Дробный товар: количество в своей единице и цена за единицу — «1,5 л × 30»
  if (isVesovoy(i)) return `${kgText(lineUnits(i))} ${t(edinica(i))} × ${money(i.price)}`
  if (!i.pieces && i.qty) return `${i.qty} ${t(edinica(i))} × ${money(i.price)}`
  const units = (i.qty || 0) * upp + (i.pieces || 0)
  return `${units} ${t('шт')} × ${money(i.price / upp)}`
}

function payLabel(payment, t) {
  if (payment === 'card') return t('Карта')
  if (payment === 'debt') return t('В долг')
  if (payment === 'transfer') return t('Перевод')
  return t('Наличные')
}

// Шапка одна на все бумаги: название магазина, затем адрес и телефон, если владелец
// вписал их в Настройках (lib/rekvizity.js)
function shapka(pharmacy, rekvizity, t) {
  const r = rekvizity || {}
  return [pharmacy || t('Магазин'), ...(r.address ? [r.address] : []), ...(r.phone ? [`${t('Тел.')} ${r.phone}`] : [])]
}

// Подвал тоже один: кассир, подпись владельца («Будьте здоровы!» и т.п.) и имя
// программы — по нему покупатель и проверяющий видят, чем напечатан чек
function podval(who, rekvizity, t, spasibo) {
  const r = rekvizity || {}
  return [
    ...(who ? [`${t('Кассир')}: ${who}`] : []),
    ...(r.footer ? [r.footer] : []),
    ...(spasibo ? [t('Спасибо за покупку!')] : []),
    'FinMax POS',
  ]
}

// ── Чек продажи ──
// rekvizity — адрес/телефон/подпись с этого устройства; nomer — номер чека из даты
// (lib/time.js, chekNomer); customerDebt — долг клиента после продажи в долг:
// покупатель видит в чеке, сколько он теперь должен магазину
export function saleTicket(sale, { t, money, when, pharmacy = '', cashier = '', rekvizity = null, nomer = '', customerDebt = null }) {
  const items = Array.isArray(sale?.items) ? sale.items : []
  const discount = items.reduce((s, i) => s + (i.discount || 0), 0)
  const totals = []
  if (discount > 0) totals.push({ label: t('Скидка'), value: '−' + money(discount) })
  totals.push({ label: t('Итого'), value: money(sale.total), big: true })
  // У перевода — через какой сервис: по нему покупатель и магазин ищут платёж
  totals.push({ label: t('Оплата'), value: payLabel(sale.payment, t) + (sale.payment === 'transfer' && sale.payVia ? ` · ${sale.payVia}` : '') })
  // Покупатель сверяет сдачу по чеку: сколько дал и сколько ему вернули
  if (sale.received !== null && sale.received !== undefined) {
    totals.push({ label: t('Получено'), value: money(sale.received) })
    totals.push({ label: t('Сдача'), value: money(sale.change) })
  }
  if (sale.customer?.name) totals.push({ label: t('Клиент'), value: sale.customer.name })
  if (sale.payment === 'debt' && customerDebt !== null && customerDebt !== undefined) {
    totals.push({ label: t('Долг клиента'), value: money(customerDebt) })
  }
  const who = cashier || sale.user?.name || ''
  return {
    head: [...shapka(pharmacy, rekvizity, t), ...(nomer ? [`${t('Чек')} № ${nomer}`] : []), when(sale.date)],
    rows: items.map((i) => ({
      name: i.name,
      sub: qtyPriceText(i, t, money) + (i.discount > 0 ? ` · ${t('скидка')} −${money(i.discount)}` : ''),
      value: money(lineNet(i)),
    })),
    totals,
    tail: podval(who, rekvizity, t, true),
  }
}

// ── Чек возврата ──
// Покупателю на руки: что вернули, сколько денег и каким способом. saleNomer —
// номер чека продажи, по которому оформлен возврат: по нему их сверяют друг с другом
export function returnTicket(ret, { t, money, when, pharmacy = '', cashier = '', rekvizity = null, nomer = '', saleNomer = '' }) {
  const items = Array.isArray(ret?.items) ? ret.items : []
  const sposob =
    ret.refund === 'card'
      ? t('Возврат на карту')
      : ret.refund === 'transfer'
        ? t('Возврат переводом') + (ret.refundVia ? ` · ${ret.refundVia}` : '')
        : ret.refund === 'debt'
          ? t('Уменьшен долг клиента')
          : t('Наличными из кассы')
  return {
    head: [...shapka(pharmacy, rekvizity, t), `${t('Чек возврата')}${nomer ? ` № ${nomer}` : ''}`, when(ret.date)],
    rows: items.map((i) => ({
      name: i.name,
      // Списанная упаковка на полку не вернётся — об этом прямо в чеке.
      // Весовой товар возвращается в килограммах
      sub:
        (isVesovoy(i) ? `${kgText(i.units)} ${t(edinica(i))}` : `${i.units} ${t('шт')}`) +
        (i.restock ? '' : ` · ${t('списано')}`),
      value: money(i.amount || 0),
    })),
    totals: [
      { label: t('Возвращено покупателю'), value: money(ret.total), big: true },
      { label: t('Способ возврата'), value: sposob },
      ...(saleNomer ? [{ label: t('По чеку'), value: `№ ${saleNomer}` }] : []),
    ],
    tail: podval(cashier || ret.user?.name || '', rekvizity, t, false),
  }
}

// ── Z-отчёт смены ──
// totals — чистые числа смены (shiftTotals из lib/finance): выручка и прибыль за
// вычетом возвратов
export function shiftTicket(shift, totals, { t, money, when, pharmacy = '', rekvizity = null }) {
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
  // Возврат товара поставщику «в кассу»: поставщик отдал деньги, их положили в ящик
  if ((shift.supplierRefund || 0) > 0) rows.push({ label: t('Вернули поставщики (нал.)'), value: '+' + money(shift.supplierRefund) })
  if ((shift.refundCash || 0) > 0) rows.push({ label: t('Выдано за возвраты (нал.)'), value: '−' + money(shift.refundCash) })
  // Деньги, взятые из ящика на расходы магазина: без этой строки «ожидалось» не сходится
  // с продажами на бумаге
  if ((shift.expenseCash || 0) > 0) rows.push({ label: t('Расходы из кассы'), value: '−' + money(shift.expenseCash) })
  if ((shift.supplierCash || 0) > 0) rows.push({ label: t('Оплачено поставщикам (нал.)'), value: '−' + money(shift.supplierCash) })
  if ((shift.cashOut || 0) > 0) rows.push({ label: t('Изъято из кассы'), value: '−' + money(shift.cashOut) })
  rows.push({ label: t('Ожидалось в кассе'), value: money(shift.expectedCash) })
  rows.push({ label: t('Пересчитано (факт)'), value: money(shift.countedCash || 0) })
  rows.push({ label: t('Расхождение'), value: (shift.difference > 0 ? '+' : '') + money(shift.difference), big: true })
  const period = `${when(shift.openedAt)} — ${shift.closedAt ? when(shift.closedAt) : ''}`.trim()
  return {
    head: [...shapka(pharmacy, rekvizity, t), t('Z-отчёт смены'), period, ...(shift.deviceName ? [shift.deviceName] : [])],
    rows: [],
    totals: rows,
    tail: podval(shift.user?.name || '', rekvizity, t, false),
  }
}
