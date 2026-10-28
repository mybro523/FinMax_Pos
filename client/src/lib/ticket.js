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
// вписал их в Настройках (lib/rekvizity.js). Сразу за ней — строка документа («Чек №…»,
// «Z-отчёт смены»): её номер в шапке чек несёт в docAt — экран и лента печатают
// эту строку жирной (-1 — такой строки нет)
function shapka(pharmacy, rekvizity, t) {
  const r = rekvizity || {}
  return [String(pharmacy || '').trim() || t('Магазин'), ...(r.address ? [r.address] : []), ...(r.phone ? [`${t('Тел.')} ${r.phone}`] : [])]
}

// Подвал тоже один: кассир, подпись владельца («Будьте здоровы!» и т.п.) и последней
// строкой — название магазина (то, что задано магазину в панели): чек покупателя несёт
// имя магазина, а не программы. Её номер в подвале — в signAt: экран и лента печатают
// её жирной (-1 — магазин без названия, строки нет)
function podval(who, rekvizity, t, spasibo, pharmacy) {
  const r = rekvizity || {}
  const shop = String(pharmacy || '').trim()
  const tail = [
    ...(who ? [`${t('Кассир')}: ${who}`] : []),
    ...(r.footer ? [r.footer] : []),
    ...(spasibo ? [t('Спасибо за покупку!')] : []),
    ...(shop ? [shop] : []),
  ]
  return { tail, signAt: shop ? tail.length - 1 : -1 }
}

// ── Чек продажи ──
// rekvizity — адрес/телефон/подпись с этого устройства; nomer — номер чека из даты
// (lib/time.js, chekNomer); customerDebt — долг клиента после продажи в долг:
// покупатель видит в чеке, сколько он теперь должен магазину; pometka — строка под датой
// (повтор отменённого чека из отчёта «Чеки» печатается с «Чек отменён …»)
export function saleTicket(sale, { t, money, when, pharmacy = '', cashier = '', rekvizity = null, nomer = '', customerDebt = null, pometka = '' }) {
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
  const top = shapka(pharmacy, rekvizity, t)
  return {
    head: [...top, ...(nomer ? [`${t('Чек')} № ${nomer}`] : []), when(sale.date), ...(pometka ? [pometka] : [])],
    docAt: nomer ? top.length : -1,
    rows: items.map((i) => ({
      name: i.name,
      sub: qtyPriceText(i, t, money) + (i.discount > 0 ? ` · ${t('скидка')} −${money(i.discount)}` : ''),
      value: money(lineNet(i)),
    })),
    totals,
    ...podval(who, rekvizity, t, true, pharmacy),
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
  const top = shapka(pharmacy, rekvizity, t)
  return {
    head: [...top, `${t('Чек возврата')}${nomer ? ` № ${nomer}` : ''}`, when(ret.date)],
    docAt: top.length,
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
    ...podval(cashier || ret.user?.name || '', rekvizity, t, false, pharmacy),
  }
}

// ── Долг клиента ──
// Выписка клиенту на руки (раздел «Долги клиентов», кнопка «Печать» в окне клиента):
// что он брал в долг, что вернул и сколько погасил, внизу итоги и крупно — текущий долг.
// h — расчёт istoriyaDolga (lib/dolg.js). Строки — от старых к новым, как в выписке
// банка; всё, что было раньше истории устройства, — строкой «Прежний долг до <даты>» в
// итогах: прежний долг + куплено − возвращено − погашено = текущий долг.
// tovary(items) — товары строкой, nomer(date) — номер чека: их дают снаружи, чтобы
// модуль проверялся без браузера
export function debtTicket(customer, h, { t, money, when, day = when, pharmacy = '', rekvizity = null, now = new Date(), tovary = () => '', nomer = () => '' }) {
  const x = h || { events: [], opening: 0, totalCredit: 0, totalPaid: 0, totalReturned: 0, debt: 0, start: now }
  const top = shapka(pharmacy, rekvizity, t)
  const line = (e) => [when(e.date), tovary(e.items)].filter(Boolean).join(' · ')
  const rows = [...(x.events || [])].reverse().map((e) => {
    if (e.kind === 'pay') return { name: t('Погашение'), sub: when(e.date), value: '−' + money(e.amount) }
    if (e.kind === 'return') return { name: e.otmena ? t('Отмена чека') : t('Возврат товара'), sub: line(e), value: '−' + money(e.amount) }
    const n = nomer(e.date)
    return { name: t('Покупка в долг') + (n ? ` · ${t('Чек')} № ${n}` : ''), sub: line(e), value: '+' + money(e.amount) }
  })
  return {
    head: [...top, t('Долг клиента'), String(customer?.name || ''), ...(customer?.phone ? [`${t('Тел.')} ${customer.phone}`] : []), when(now)],
    docAt: top.length,
    rows,
    totals: [
      ...(x.opening ? [{ label: `${t('Прежний долг до')} ${day(x.start)}`, value: money(x.opening) }] : []),
      { label: t('Куплено в долг'), value: money(x.totalCredit) },
      ...(x.totalReturned > 0 ? [{ label: t('Возвращено'), value: money(x.totalReturned) }] : []),
      { label: t('Погашено'), value: money(x.totalPaid) },
      { label: t('Текущий долг'), value: money(x.debt), big: true },
    ],
    ...podval('', rekvizity, t, false, pharmacy),
  }
}

// ── Z-отчёт смены ──
// totals — чистые числа смены (shiftTotals из lib/finance): выручка и прибыль за
// вычетом возвратов. otmeny — { count, total }: сколько чеков отменили кнопкой «Отмена»
// в кассе (они среди возвратов, но владелец видит их отдельной строкой)
export function shiftTicket(shift, totals, { t, money, when, pharmacy = '', rekvizity = null, otmeny = null }) {
  const rows = [
    { label: t('Чеков'), value: String(shift.count ?? 0) },
    { label: t('Наличными'), value: money(shift.salesCash) },
    { label: t('Картой'), value: money(shift.salesCard) },
    // Переводы — всегда (и нулём), сразу под картой: безналичные рядом. Под ними — по каждому
    // сервису («DC», «Алиф»): их сверяют с выпиской каждого банка
    { label: t('Переводом'), value: money(shift.salesTransfer || 0) },
  ]
  for (const [via, sum] of Object.entries(shift.transferBy || {})) {
    if ((Number(sum) || 0) !== 0) rows.push({ label: '  ' + via, value: money(sum) })
  }
  rows.push({ label: t('В долг'), value: money(shift.salesDebt) })
  if ((shift.debtPaid || 0) > 0) rows.push({ label: t('Погашено долгов (нал.)'), value: money(shift.debtPaid) })
  // Скидок не было — просто ноль, без «−0»
  rows.push({ label: t('Скидки'), value: (Number(shift.discount) > 0 ? '−' : '') + money(shift.discount) })
  if (totals.refunds > 0) {
    rows.push({ label: t('Продано за смену'), value: money(totals.gross) })
    rows.push({ label: t('Возвраты покупателям'), value: '−' + money(totals.refunds) })
    if (otmeny?.total > 0) rows.push({ label: `  ${t('в т.ч. отмены чеков')} (${otmeny.count})`, value: '−' + money(otmeny.total) })
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
    docAt: shapka(pharmacy, rekvizity, t).length,
    rows: [],
    totals: rows,
    ...podval(shift.user?.name || '', rekvizity, t, false, pharmacy),
  }
}
