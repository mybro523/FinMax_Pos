// ── Локальный сервер магазина ──
//
// Те же адреса, что у настоящего сервера, но отвечает на них локальная база. Окно
// не знает разницы: оно просит «/sales», а откуда придёт ответ, решает основная
// часть программы. Здесь перечислено всё, что касса умеет без интернета:
// продажа, возврат, смена, долг и его погашение, приход, списание, возврат поставщику,
// отложенные штрихкоды, расходы и доходы, внесение и изъятие наличных; с версии 1.4.14 —
// и справочники: товары, категории и типы, поставщики и оплаты им, сервисы перевода,
// статьи расходов и доходов, — а также правка и удаление прихода, расхода, дохода,
// возврата поставщику, внесения и изъятия.
//
// История товара и карточка поставщика — «сначала сервер»: у него все документы за всё
// время; нет связи — касса считает по своим журналам (FALLBACK ниже). Чего здесь нет
// вовсе (сотрудники, пересчёт остатков, резервная копия), уходит на сервер.
import { hasPerm } from './accounts.mjs'
import { categoriesList, productTypesList, customersList, deferredList, productByBarcode, productsList, productView1 } from './catalog.mjs'
import { bad, forbidden, notFound, q } from './db.mjs'
import { listDocs, listShifts, liveDoc, myOpenShift, WINDOW_DAYS } from './docs.mjs'
import { createArrival } from './ops/arrival.mjs'
import { createCustomer, payDebt } from './ops/customer.mjs'
import { addDeferred, removeDeferred } from './ops/deferred.mjs'
import { cashSources, createExpense, expenseCategoriesList } from './ops/expense.mjs'
import { createIncome, incomeCategoriesList } from './ops/income.mjs'
import { createCashMove } from './ops/cash.mjs'
import { suppliersDebts, payServicesList, suppliersList } from './suppliers.mjs'
import { createReturn } from './ops/return.mjs'
import { createSupplierReturn } from './ops/supplierreturn.mjs'
import { checkout, NO_SHIFT_SALE } from './ops/sale.mjs'
import { closeShift, openShift, shiftView } from './ops/shift.mjs'
import { createWriteOff } from './ops/writeoff.mjs'
import { createProduct, deleteProduct, updateProduct } from './ops/products.mjs'
import {
  createArticle,
  createCategory,
  createPayService,
  createProductType,
  deleteArticle,
  deleteCategory,
  deletePayService,
  deleteProductType,
  updateCategory,
  updateProductType,
} from './ops/refs.mjs'
import { createSupplier, deleteSupplier, paySupplier, removeSupplierPayment, updateSupplier } from './ops/supplierops.mjs'
import { deleteCashMove, deleteExpense, deleteIncome, deleteSupplierReturn, updateExpense, updateIncome } from './ops/docedits.mjs'
import { arrivalView, deleteArrival, updateArrival } from './ops/arrivaledit.mjs'
import { applyInventory, createInventory, deleteInventory, inventoriesList, inventoryOne, saveCounts } from './ops/inventory.mjs'
import { createRole, createUser, deleteRole, deleteUser, rolesList, staffList, updateRole, updateUser, usersList } from './ops/team.mjs'
import { productHistory, supplierCard } from './history.mjs'
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
// когда за давним периодом ходили в интернет: сервер о них ещё не знает. Туда же —
// пришедшие от соседней кассы по местной сети (sync = 'peer'): их сервер тоже ещё не видел.
// Поправленные здесь (edited) заменяют копию сервера, удалённые здесь (deleted) — убирают её
export function pendingInPeriod(db, kind, { from, to }) {
  const rows = q(
    db,
    `SELECT body, sync FROM docs
     WHERE kind = ? AND sync IN ('pending', 'peer', 'edited', 'deleted') AND (? IS NULL OR date >= ?) AND (? IS NULL OR date <= ?)`,
  ).all(kind, from, from, to, to)
  return rows.map((r) => (r.sync === 'deleted' ? { ...JSON.parse(r.body), __deleted: true } : JSON.parse(r.body)))
}

// Только владелец — как @Roles('founder') у сервера: тот же отказ «Недостаточно прав»
const owner = (handler) => (ctx) => {
  if (ctx.user?.role !== 'founder') throw forbidden('Недостаточно прав')
  return handler(ctx)
}
// Право на действие — то же, что на сайте и на сервере. Любое из перечисленных
const perm = (keys, handler) => (ctx) => {
  if (!hasPerm(ctx.user, ...keys)) throw forbidden('Недостаточно прав')
  return handler(ctx)
}
// Скидка, продажа в долг и приход в долг — отдельные права.
// Без открытой смены на этой кассе продажа не проводится: чек обязан войти в её отчёт
const canSell = (ctx) => {
  if (!myOpenShift(ctx.db, ctx.deviceId)) throw bad(NO_SHIFT_SALE)
  if (ctx.body?.payment === 'debt' && !hasPerm(ctx.user, 'pos.debt')) throw forbidden('Нет права продавать в долг')
  if ((Array.isArray(ctx.body?.items) ? ctx.body.items : []).some((i) => Number(i?.discount) > 0) && !hasPerm(ctx.user, 'pos.discount')) {
    throw forbidden('Нет права давать скидку')
  }
  return checkout(ctx, ctx.body)
}
// Правка и удаление документа: на кассе он есть — правим здесь; давний (журналы кассы
// короче) — запрос уходит на сервер, как раньше
const here = (kind, fn) => (ctx) => (liveDoc(ctx.db, kind, ctx.params[0]) ? fn(ctx) : { __remote: true })
const canArrive = (ctx) => {
  if (Number(ctx.body?.debt) > 0 && !hasPerm(ctx.user, 'arrivals.debt')) throw forbidden('Нет права оформлять приход в долг')
  return createArrival(ctx, ctx.body)
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
  ['GET', /^\/product-types$/, (ctx) => productTypesList(ctx.db)],
  ['GET', /^\/customers$/, (ctx) => customersList(ctx.db)],
  ['GET', /^\/deferred$/, (ctx) => deferredList(ctx.db)],
  ['GET', /^\/shifts$/, (ctx) => listShifts(ctx.db, ctx.deviceId).map((s) => shiftView(ctx.db, s))],
  ['GET', /^\/sales$/, journal('sale')],
  ['GET', /^\/returns$/, journal('return')],
  // Журнал приходов — закупочные цены: только с правом на раздел, как на сервере
  ['GET', /^\/arrivals$/, perm(['arrivals.view'], journal('arrival'))],
  // Возвраты поставщикам — тоже закупочные цены: по тому же праву
  ['GET', /^\/supplier-returns$/, perm(['arrivals.view'], journal('supplierreturn'))],
  // Списание — это убыток, поэтому журнал видит только владелец
  ['GET', /^\/writeoffs$/, perm(['writeoffs.view', 'reports.view', 'dashboard.view'], journal('writeoff'))],
  ['GET', /^\/payments$/, journal('payment')],
  // Расходы — деньги магазина и его чистая прибыль: только владельцу, как и на сервере
  ['GET', /^\/expenses$/, perm(['expenses.view', 'reports.view'], journal('expense'))],
  ['GET', /^\/expenses\/cash-sources$/, perm(['expenses.create'], (ctx) => cashSources(ctx.db, ctx.deviceId))],
  ['GET', /^\/expense-categories$/, perm(['expenses.view', 'expenses.create', 'settings.expenseCategories'], (ctx) => expenseCategoriesList(ctx.db))],
  // Доходы — деньги магазина: по тем же правам, что на сервере
  ['GET', /^\/incomes$/, perm(['incomes.view', 'reports.view'], journal('income'))],
  ['GET', /^\/income-categories$/, perm(['incomes.view', 'incomes.create', 'settings.incomeCategories'], (ctx) => incomeCategoriesList(ctx.db))],
  // Поставщики нужны приходу — всем; долги в них видит только владелец
  ['GET', /^\/suppliers$/, (ctx) => suppliersList(ctx.db, hasPerm(ctx.user, 'suppliers.view'))],
  // Сводка «кому сколько должны» — с учётом своих непосланных приходов в долг
  ['GET', /^\/suppliers\/debts$/, perm(['suppliers.view'], (ctx) => suppliersDebts(ctx.db))],
  ['GET', /^\/supplier-payments$/, perm(['suppliers.view'], journal('supplierpayment'))],
  ['GET', /^\/pay-services$/, (ctx) => payServicesList(ctx.db)],
  ['GET', /^\/cash-moves$/, journal('cashmove')],
  ['GET', /^\/shifts\/cash-sources$/, (ctx) => cashSources(ctx.db, ctx.deviceId)],

  ['POST', /^\/sales$/, perm(['pos.sell'], canSell)],
  ['POST', /^\/returns$/, perm(['returns.create'], (ctx) => createReturn(ctx, ctx.body))],
  ['POST', /^\/arrivals$/, perm(['arrivals.create'], canArrive)],
  ['POST', /^\/supplier-returns$/, perm(['arrivals.return'], (ctx) => createSupplierReturn(ctx, ctx.body))],
  ['POST', /^\/writeoffs$/, perm(['writeoffs.create'], (ctx) => createWriteOff(ctx, ctx.body))],
  ['POST', /^\/expenses$/, perm(['expenses.create'], (ctx) => createExpense(ctx, ctx.body))],
  ['POST', /^\/incomes$/, perm(['incomes.create'], (ctx) => createIncome(ctx, ctx.body))],
  ['POST', /^\/shifts\/open$/, perm(['shift.open'], (ctx) => openShift(ctx, ctx.body))],
  ['POST', /^\/shifts\/cash$/, perm(['shift.cash'], (ctx) => createCashMove(ctx, ctx.body))],
  ['POST', /^\/shifts\/close$/, perm(['shift.open'], (ctx) => closeShift(ctx, ctx.body))],
  ['POST', /^\/customers$/, perm(['customers.create'], (ctx) => createCustomer(ctx, ctx.body))],
  ['POST', /^\/customers\/([^/]+)\/pay$/, perm(['debts.pay'], (ctx) => payDebt(ctx, ctx.params[0], ctx.body))],
  ['POST', /^\/deferred$/, perm(['pos.defer', 'deferred.manage'], (ctx) => addDeferred(ctx, ctx.body))],
  ['DELETE', /^\/deferred\/([^/]+)$/, perm(['deferred.manage'], (ctx) => removeDeferred(ctx, ctx.params[0]))],

  // ── Справочники и правки документов (версия 1.4.14) — те же права, что на сайте ──
  ['POST', /^\/products$/, perm(['products.create'], (ctx) => createProduct(ctx, ctx.body))],
  ['PATCH', /^\/products\/([^/]+)$/, perm(['products.edit'], (ctx) => updateProduct(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/products\/([^/]+)$/, perm(['products.delete'], (ctx) => deleteProduct(ctx, ctx.params[0]))],
  ['POST', /^\/categories$/, perm(['settings.categories'], (ctx) => createCategory(ctx, ctx.body))],
  ['PATCH', /^\/categories\/([^/]+)$/, perm(['settings.categories'], (ctx) => updateCategory(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/categories\/([^/]+)$/, perm(['settings.categories'], (ctx) => deleteCategory(ctx, ctx.params[0]))],
  // Типы товаров настраиваются там же, где категории
  ['POST', /^\/product-types$/, perm(['settings.categories'], (ctx) => createProductType(ctx, ctx.body))],
  ['PATCH', /^\/product-types\/([^/]+)$/, perm(['settings.categories'], (ctx) => updateProductType(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/product-types\/([^/]+)$/, perm(['settings.categories'], (ctx) => deleteProductType(ctx, ctx.params[0]))],
  ['POST', /^\/pay-services$/, perm(['settings.payServices'], (ctx) => createPayService(ctx, ctx.body))],
  ['DELETE', /^\/pay-services\/([^/]+)$/, perm(['settings.payServices'], (ctx) => deletePayService(ctx, ctx.params[0]))],
  ['POST', /^\/expense-categories$/, perm(['settings.expenseCategories'], (ctx) => createArticle(ctx, 'expense', ctx.body))],
  ['DELETE', /^\/expense-categories\/([^/]+)$/, perm(['settings.expenseCategories'], (ctx) => deleteArticle(ctx, 'expense', ctx.params[0]))],
  ['POST', /^\/income-categories$/, perm(['settings.incomeCategories'], (ctx) => createArticle(ctx, 'income', ctx.body))],
  ['DELETE', /^\/income-categories\/([^/]+)$/, perm(['settings.incomeCategories'], (ctx) => deleteArticle(ctx, 'income', ctx.params[0]))],
  ['POST', /^\/suppliers$/, perm(['suppliers.edit'], (ctx) => createSupplier(ctx, ctx.body))],
  ['PATCH', /^\/suppliers\/([^/]+)$/, perm(['suppliers.edit'], (ctx) => updateSupplier(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/suppliers\/([^/]+)$/, perm(['suppliers.delete'], (ctx) => deleteSupplier(ctx, ctx.params[0]))],
  ['POST', /^\/suppliers\/([^/]+)\/pay$/, perm(['suppliers.pay'], (ctx) => paySupplier(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/supplier-payments\/([^/]+)$/, perm(['suppliers.pay'], here('supplierpayment', (ctx) => removeSupplierPayment(ctx, ctx.params[0])))],
  ['DELETE', /^\/supplier-returns\/([^/]+)$/, perm(['arrivals.edit'], here('supplierreturn', (ctx) => deleteSupplierReturn(ctx, ctx.params[0])))],
  ['PATCH', /^\/expenses\/([^/]+)$/, perm(['expenses.edit'], here('expense', (ctx) => updateExpense(ctx, ctx.params[0], ctx.body)))],
  ['DELETE', /^\/expenses\/([^/]+)$/, perm(['expenses.edit'], here('expense', (ctx) => deleteExpense(ctx, ctx.params[0])))],
  ['PATCH', /^\/incomes\/([^/]+)$/, perm(['incomes.edit'], here('income', (ctx) => updateIncome(ctx, ctx.params[0], ctx.body)))],
  ['DELETE', /^\/incomes\/([^/]+)$/, perm(['incomes.edit'], here('income', (ctx) => deleteIncome(ctx, ctx.params[0])))],
  // Отменить внесение или изъятие — по праву на чужие смены, как на сайте
  ['DELETE', /^\/cash-moves\/([^/]+)$/, perm(['shift.others'], here('cashmove', (ctx) => deleteCashMove(ctx, ctx.params[0])))],
  // Приход для окна правки: на кассе есть — отсюда; давний — с сервера
  ['GET', /^\/arrivals\/([^/]+)$/, perm(['arrivals.view'], (ctx) => arrivalView(ctx.db, ctx.params[0]) || { __remote: true })],
  ['PATCH', /^\/arrivals\/([^/]+)$/, perm(['arrivals.edit'], here('arrival', (ctx) => updateArrival(ctx, ctx.params[0], ctx.body)))],
  ['DELETE', /^\/arrivals\/([^/]+)$/, perm(['arrivals.edit'], here('arrival', (ctx) => deleteArrival(ctx, ctx.params[0])))],

  // ── Инвентаризация без связи (версия 1.4.15) ──
  // Права — как у сервера (inventory.controller): смотреть, пересчитывать, применять.
  // Лист, которого на кассе нет (давний, применённый раньше срока журналов), — у сервера
  // ── Сотрудники и роли (версия 1.4.16) — только владелец, как на сайте (@Roles('founder')) ──
  ['GET', /^\/users$/, owner((ctx) => usersList(ctx.db))],
  ['POST', /^\/users$/, owner((ctx) => createUser(ctx, ctx.body))],
  ['PATCH', /^\/users\/([^/]+)$/, owner((ctx) => updateUser(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/users\/([^/]+)$/, owner((ctx) => deleteUser(ctx, ctx.params[0]))],
  ['GET', /^\/roles$/, owner((ctx) => rolesList(ctx.db))],
  ['POST', /^\/roles$/, owner((ctx) => createRole(ctx, ctx.body))],
  ['PATCH', /^\/roles\/([^/]+)$/, owner((ctx) => updateRole(ctx, ctx.params[0], ctx.body))],
  ['DELETE', /^\/roles\/([^/]+)$/, owner((ctx) => deleteRole(ctx, ctx.params[0]))],
  // Кому выдают зарплату — те же права, что у сервера (expenses.controller, staff)
  ['GET', /^\/expenses\/staff$/, perm(['expenses.create', 'expenses.edit'], (ctx) => staffList(ctx.db))],
  ['GET', /^\/inventory$/, perm(['inventory.view'], (ctx) => inventoriesList(ctx.db))],
  ['GET', /^\/inventory\/([^/]+)$/, perm(['inventory.view'], (ctx) => inventoryOne(ctx.db, ctx.params[0]) || { __remote: true })],
  ['POST', /^\/inventory$/, perm(['inventory.count'], (ctx) => createInventory(ctx, ctx.body))],
  ['PATCH', /^\/inventory\/([^/]+)$/, perm(['inventory.count'], here('inventory', (ctx) => saveCounts(ctx, ctx.params[0], ctx.body)))],
  ['POST', /^\/inventory\/([^/]+)\/apply$/, perm(['inventory.apply'], here('inventory', (ctx) => applyInventory(ctx, ctx.params[0], ctx.body)))],
  ['DELETE', /^\/inventory\/([^/]+)$/, perm(['inventory.count'], here('inventory', (ctx) => deleteInventory(ctx, ctx.params[0])))],
]

// ── Сначала сервер, без связи — касса ──
// История товара и карточка поставщика: у сервера все документы за всё время, а у кассы —
// за последние месяцы. Поэтому на связи отвечает сервер, а без связи — касса, по своим
// журналам, с пометкой local (окно покажет, что это данные компьютера)
const FALLBACK = [
  ['GET', /^\/products\/([^/]+)\/history$/, perm(['products.history'], (ctx) => productHistory(ctx.db, ctx.params[0], ctx.query, ctx.now) || notThere('Товар не найден'))],
  ['GET', /^\/suppliers\/([^/]+)$/, perm(['suppliers.view'], (ctx) => supplierCard(ctx.db, ctx.params[0]) || notThere('Поставщик не найден'))],
]
const notThere = (text) => {
  throw notFound(text)
}

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

function match(list, method, path) {
  const route = path.split('?')[0]
  for (const [m, re, handler] of list) {
    if (m !== method) continue
    const found = route.match(re)
    if (found) return { handler, params: found.slice(1).map(decode), query: parseQuery(path) }
  }
  return null
}

// Найти обработчик. Нет — значит запрос не для локальной базы
export const matchLocal = (method, path) => match(ROUTES, method, path)
// Запрос «сначала сервер»: без связи на него ответит касса
export const matchFallback = (method, path) => match(FALLBACK, method, path)
