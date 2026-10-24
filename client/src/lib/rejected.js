// ── Что было в операции, которую сервер не принял ──
//
// Программа для Windows снимает отвергнутую операцию с учёта: в журналах кассы её
// больше нет. Список «не принято сервером» — единственное место, где владелец видит,
// что именно было сделано, и по нему решает, оформлять ли операцию заново. Поэтому
// здесь она показывается целиком: все позиции с количеством и ценой, оплата, клиент.
//
// Основная часть программы присылает только данные (desktop/src/local/outbox.mjs,
// describeOp). Слова подбираются здесь — вместе со всем интерфейсом они переводятся.
//
// Перевод, вид денег и дат передаются снаружи (t, money, fmt), а надписи стоят в коде
// целиком — их наличие в таджикском словаре стережёт test/i18n.test.js.
import { qtyPriceText } from './ticket.js'
import { fieldLabel } from './discrepancy.js'

function payLabel(payment, t) {
  if (payment === 'card') return t('Карта')
  if (payment === 'debt') return t('В долг')
  return t('Наличные')
}

function refundLabel(refund, t) {
  if (refund === 'card') return t('Возврат на карту')
  if (refund === 'debt') return t('Уменьшить долг клиента')
  return t('Наличными из кассы')
}

function reasonLabel(reason, t) {
  if (reason === 'expired') return t('Просрочен')
  if (reason === 'damaged') return t('Брак или повреждение')
  if (reason === 'lost') return t('Недостача (не нашли)')
  return t('Другое')
}

const has = (v) => v !== null && v !== undefined && v !== ''
const list = (v) => (Array.isArray(v) ? v : [])

// r — запись списка: { type, detail }. Возвращает { facts, lines }:
//   facts — пары «подпись — значение» (оплата, клиент, причина…);
//   lines — позиции: { name, text }, где text — «2 уп × 150.00 с.».
// fmt.when — как печатать дату со временем, fmt.day — дату без времени.
// Незнакомая операция или запись прежней версии программы (без detail) — пусто.
export function rejectedDetail(r, t, money = String, fmt = {}) {
  const when = fmt.when || String
  const day = fmt.day || String
  const d = r?.detail && typeof r.detail === 'object' ? r.detail : {}
  const facts = []
  const fact = (label, value) => {
    if (has(value)) facts.push({ label, value: String(value) })
  }
  let lines = []

  switch (r?.type) {
    case 'sale':
      fact(t('Оплата'), payLabel(d.payment, t))
      fact(t('Клиент'), d.customer)
      lines = list(d.lines).map((i) => ({
        name: i.name || '',
        text: qtyPriceText(i, t, money) + (i.discount > 0 ? ` · ${t('скидка')} −${money(i.discount)}` : ''),
      }))
      break
    case 'return':
      // По какому чеку: без этого возврат не оформить заново
      if (d.sale?.date) fact(t('Чек'), `${when(d.sale.date)} · ${money(d.sale.total)}`)
      fact(t('Чем возвращаем деньги'), refundLabel(d.refund, t))
      fact(t('Примечание'), d.note)
      lines = list(d.lines).map((i) => ({
        name: i.name || '',
        // Товар, который на полку не вернули, уходит в списание
        text: `${i.units} ${t('шт')} · ${money(i.amount)}` + (i.restock === false ? ` · ${t('списано')}` : ''),
      }))
      break
    case 'arrival':
      fact(t('Поставщик'), d.supplier && d.supplier !== '—' ? d.supplier : '')
      lines = list(d.lines).map((i) => ({
        name: i.name || '',
        text: `${i.qty} ${t('уп')} × ${money(i.cost)}` + (i.expiry ? ` · ${t('Срок годности')}: ${day(i.expiry)}` : ''),
      }))
      break
    case 'writeoff':
      fact(t('Причина'), reasonLabel(d.reason, t))
      fact(t('Примечание'), d.note)
      lines = list(d.lines).map((i) => ({ name: i.name || '', text: `${i.units} ${t('шт')}` }))
      break
    case 'debt.pay':
      fact(t('Клиент'), d.customer)
      break
    case 'customer.create':
      fact(t('Телефон'), d.phone)
      if (d.debt > 0) fact(t('Долг'), money(d.debt))
      break
    case 'expense':
      // Расход сервер не принял — в отчётах его нет. По этим строкам его вносят заново
      fact(t('Статья расхода'), d.category ? t(d.category) : '')
      if (d.date) fact(t('Дата'), day(d.date))
      if (d.fromCash) fact(t('Оплата'), t('из кассы'))
      fact(t('Примечание'), d.note)
      break
    case 'cash.move':
      fact(t('Что'), d.kind === 'out' ? t('Изъятие из кассы') : t('Внесение в кассу'))
      fact(t('Примечание'), d.note)
      break
    case 'supplier.return':
      // Возврат поставщику сервер не принял — товар по нему на складе снова, долг прежний.
      // По этим строкам его оформляют заново
      fact(t('Поставщик'), d.supplier && d.supplier !== '—' ? d.supplier : '')
      fact(t('Как вернули деньги'), supplierRefundLabel(d.refund, t))
      fact(t('Причина'), d.note)
      lines = list(d.lines).map((i) => ({
        name: i.name || '',
        text: `${i.qty || 0} ${t('уп')}${i.pieces > 0 ? ` + ${i.pieces} ${t('шт')}` : ''} × ${money(i.price)}`,
      }))
      break
    case 'shift.open':
      fact(t('касса на старте'), money(d.openingCash || 0))
      break
    // ── Справочники и правки документов (версия 1.4.14) ──
    case 'product.create':
      fact(t('Штрихкод'), d.barcode)
      if (has(d.price)) fact(t('Цена продажи'), money(d.price))
      if (d.stock > 0) fact(t('Остаток'), d.stock)
      break
    case 'supplier.create':
      fact(t('Телефон'), d.phone)
      if (d.openingDebt > 0) fact(t('Долг на начало'), money(d.openingDebt))
      break
    case 'supplier.pay':
      if (d.fromCash) fact(t('Оплата'), t('из кассы'))
      fact(t('Примечание'), d.note)
      break
    case 'product.update':
    case 'category.update':
    case 'productType.update':
    case 'supplier.update':
    case 'expense.update':
    case 'income.update':
    case 'arrival.update':
    case 'supplierPayment.delete':
    case 'supplierReturn.delete':
    case 'expense.delete':
    case 'income.delete':
    case 'cashMove.delete':
    case 'arrival.delete':
      if (d.date) fact(t('Дата'), day(d.date))
      // Что поменяли — по полям, как назвал бы человек
      if (list(d.fields).length) fact(t('Что поменяли'), list(d.fields).map((f) => fieldLabel(f, t)).join(', '))
      if (has(d.stock)) fact(t('Остаток'), d.stock)
      break
    // ── Инвентаризация (версия 1.4.15) ──
    case 'inventory.create':
      if (d.date) fact(t('Дата'), when(d.date))
      fact(t('Позиций в листе'), d.lines)
      break
    case 'inventory.count':
    case 'inventory.apply':
    case 'inventory.delete':
      if (d.date) fact(t('Дата'), when(d.date))
      if (d.counted > 0) fact(t('Пересчитано'), d.counted)
      break
    // ── Сотрудники и роли (версия 1.4.16) ──
    case 'user.create':
      fact(t('ФИО'), d.fullName)
      if (d.salary > 0) fact(t('Оклад'), money(d.salary))
      break
    case 'user.update':
    case 'role.update':
      if (list(d.fields).length) fact(t('Что поменяли'), list(d.fields).map((f) => fieldLabel(f, t)).join(', '))
      break
    case 'shift.close':
      fact(t('Чеков'), d.count ?? 0)
      fact(t('касса на старте'), money(d.openingCash || 0))
      fact(t('Ожидается в кассе'), money(d.expectedCash || 0))
      fact(t('Наличные (факт)'), money(d.countedCash || 0))
      fact(t('Расхождение'), money(d.difference || 0))
      break
    default:
      break
  }
  return { facts, lines }
}

// Как поставщик вернул деньги за возвращённый ему товар
function supplierRefundLabel(refund, t) {
  if (refund === 'debt') return t('В счёт долга')
  if (refund === 'cash') return t('В кассу')
  if (refund === 'own') return t('Наличными')
  if (refund === 'card') return t('На карту')
  return refund || ''
}

// Есть ли что показать под «Что было в операции»
export const hasRejectedDetail = (r, t, money, fmt) => {
  const d = rejectedDetail(r, t, money, fmt)
  return d.facts.length > 0 || d.lines.length > 0
}
