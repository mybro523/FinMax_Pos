// ── Локальный сервер аптеки ──
//
// Те же адреса, что у настоящего сервера, но отвечает на них локальная база. Окно
// не знает разницы: оно просит «/sales», а откуда придёт ответ, решает основная
// часть программы. Здесь перечислено всё, что касса умеет без интернета:
// продажа, возврат, смена, долг и его погашение, приход и списание уже заведённого
// товара, отложенные штрихкоды, новый расход аптеки, внесение и изъятие наличных,
// просмотр товаров, поставщиков и журналов.
//
// Остального здесь нет намеренно — заведение и правка товаров, сотрудники,
// пересчёт остатков, настройки, правка прихода и расхода, оплата поставщику,
// история движения товара. Такой запрос уходит на сервер.
import { categoriesList, customersList, deferredList, productByBarcode, productsList, productView1 } from './catalog.mjs'
import { forbidden, q } from './db.mjs'
import { listDocs, listShifts, WINDOW_DAYS } from './docs.mjs'
import { createArrival } from './ops/arrival.mjs'
import { createCustomer, payDebt } from './ops/customer.mjs'
import { addDeferred, removeDeferred } from './ops/deferred.mjs'
import { cashSources, createExpense, expenseCategoriesList } from './ops/expense.mjs'
import { createCashMove } from './ops/cash.mjs'
import { payServicesList, suppliersList } from './suppliers.mjs'
import { createReturn } from './ops/return.mjs'
import { checkout } from './ops/sale.mjs'
import { closeShift, openShift, shiftView } from './ops/shift.mjs'
import { createWriteOff } from './ops/writeoff.mjs'
import { DAY_MS } from './time.mjs'

const MAX_DAYS = 3650

// ── За какой срок просят журнал ──
// Правила те же, что на сервере (server/src/common/period.ts). Недавнее касса
// отдаёт сама. Давнее — отрезок дат, «за всё время» или срок длиннее того, что
// хранится на компьютере, — есть только на сервере; тогда возвращается deep,
// и основная часть программы идёт за ним в интернет.
export function periodOf(kind, query, now) {
  const window = WINDOW_DAYS[kind]
  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : null
    const to = query.to ? new Date(query.to) : null
    return {
      deep: true,
      from: from && !Number.isNaN(from.getTime()) ? from.toISOString() : null,
      to: to && !Number.isNaN(to.getTime()) ? to.toISOString() : null,
    }
  }
  const asked = query.days === undefined || query.days === '' ? window : Number(query.days)
  // Явный ноль означает «всё время»
  if (!Number.isFinite(asked) || asked <= 0) return { deep: true, from: null, to: null }
  const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(asked)))
  const from = new Date(now - days * DAY_MS).toISOString()
  return days > window ? { deep: true, from, to: null } : { deep: false, from, to: null }
}

// Журнал за период. Если период глубже локального — отдаём пометку вместо данных
const journal = (kind) => (ctx) => {
  const period = periodOf(kind, ctx.query, ctx.now)
  if (period.deep) return { __deep: { kind, from: period.from, to: period.to } }
  return listDocs(ctx.db, kind, { from: period.from })
}

// Свои неотправленные документы за период — их добавляют к ответу сервера,
// когда за давним периодом ходили в интернет: сервер о них ещё не знает
export function pendingInPeriod(db, kind, { from, to }) {
  const rows = q(
    db,
    `SELECT body FROM docs
     WHERE kind = ? AND sync = 'pending' AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)`,
  ).all(kind, from, from, to, to)
  return rows.map((r) => JSON.parse(r.body))
}

const founder = (handler) => (ctx) => {
  if (ctx.user.role !== 'founder') throw forbidden('Недостаточно прав')
  return handler(ctx)
}

// Что и как отвечаем. Путь — уже без /api и без строки запроса
const ROUTES = [
  ['GET', /^\/products$/, (ctx) => productsList(ctx.db, ctx.now)],
  [
    'GET',
    /^\/products\/barcode\/([^/]+)$/,
    (ctx) => {
      const row = productByBarcode(ctx.db, ctx.params[0])
      return row ? productView1(ctx.db, row, ctx.now) : null
    },
  ],
  ['GET', /^\/categories$/, (ctx) => categoriesList(ctx.db)],
  ['GET', /^\/customers$/, (ctx) => customersList(ctx.db)],
  ['GET', /^\/deferred$/, (ctx) => deferredList(ctx.db)],
  ['GET', /^\/shifts$/, (ctx) => listShifts(ctx.db, ctx.deviceId).map((s) => shiftView(ctx.db, s))],
  ['GET', /^\/sales$/, journal('sale')],
  ['GET', /^\/returns$/, journal('return')],
  ['GET', /^\/arrivals$/, journal('arrival')],
  // Списание — это убыток, поэтому журнал видит только владелец
  ['GET', /^\/writeoffs$/, founder(journal('writeoff'))],
  ['GET', /^\/payments$/, journal('payment')],
  // Расходы — деньги аптеки и её чистая прибыль: только владельцу, как и на сервере
  ['GET', /^\/expenses$/, founder(journal('expense'))],
  ['GET', /^\/expenses\/cash-sources$/, founder((ctx) => cashSources(ctx.db, ctx.deviceId))],
  ['GET', /^\/expense-categories$/, founder((ctx) => expenseCategoriesList(ctx.db))],
  // Поставщики нужны приходу — всем; долги в них видит только владелец
  ['GET', /^\/suppliers$/, (ctx) => suppliersList(ctx.db, ctx.user.role === 'founder')],
  ['GET', /^\/supplier-payments$/, founder(journal('supplierpayment'))],
  ['GET', /^\/pay-services$/, (ctx) => payServicesList(ctx.db)],
  ['GET', /^\/cash-moves$/, journal('cashmove')],
  ['GET', /^\/shifts\/cash-sources$/, (ctx) => cashSources(ctx.db, ctx.deviceId)],

  ['POST', /^\/sales$/, (ctx) => checkout(ctx, ctx.body)],
  ['POST', /^\/returns$/, (ctx) => createReturn(ctx, ctx.body)],
  ['POST', /^\/arrivals$/, (ctx) => createArrival(ctx, ctx.body)],
  ['POST', /^\/writeoffs$/, founder((ctx) => createWriteOff(ctx, ctx.body))],
  ['POST', /^\/expenses$/, founder((ctx) => createExpense(ctx, ctx.body))],
  ['POST', /^\/shifts\/open$/, (ctx) => openShift(ctx, ctx.body)],
  ['POST', /^\/shifts\/cash$/, (ctx) => createCashMove(ctx, ctx.body)],
  ['POST', /^\/shifts\/close$/, (ctx) => closeShift(ctx, ctx.body)],
  ['POST', /^\/customers$/, (ctx) => createCustomer(ctx, ctx.body)],
  ['POST', /^\/customers\/([^/]+)\/pay$/, (ctx) => payDebt(ctx, ctx.params[0], ctx.body)],
  ['POST', /^\/deferred$/, (ctx) => addDeferred(ctx, ctx.body)],
  ['DELETE', /^\/deferred\/([^/]+)$/, (ctx) => removeDeferred(ctx, ctx.params[0])],
]

const decode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// Строка запроса → простой объект (как её видит сервер)
export function parseQuery(path) {
  const at = path.indexOf('?')
  const out = {}
  if (at < 0) return out
  for (const [k, v] of new URLSearchParams(path.slice(at + 1))) out[k] = v
  return out
}

// Найти обработчик. Нет — значит запрос не для локальной базы
export function matchLocal(method, path) {
  const route = path.split('?')[0]
  for (const [m, re, handler] of ROUTES) {
    if (m !== method) continue
    const found = route.match(re)
    if (found) return { handler, params: found.slice(1).map(decode), query: parseQuery(path) }
  }
  return null
}
