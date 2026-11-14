// Копия client/src/lib/moduli.js для программы (desktop): проверка desktop/test/moduli.test.mjs
// сверяет её с каноном сайта — менять только вместе.
// ── Модули магазина (1.8.1) ──
//
// Владелец сервиса выбирает, какие разделы есть у клиента: при заведении магазина и
// потом в его карточке (магазинам без интернета — в коде активации). Выключенный модуль
// исчезает целиком: плитки нет в меню, раздел не открыть и по ссылке, сервер не пускает
// даже владельца, а связанное в других разделах (поле срока годности в приходе, кнопка
// «В долг» в кассе, «Куда: Склад»…) спрятано.
//
// Хранится список ВЫКЛЮЧЕННЫХ (modulesOff): пустой список — всё включено. Так магазины,
// заведённые до 1.8.1, ничего не заметят.
//
// ПОРЯДОК НЕ МЕНЯТЬ И НИЧЕГО НЕ УДАЛЯТЬ: номер в списке — номер бита в коде активации
// (бит стоит — модуль выключен). Новые модули — только в конец.
// Тот же список — server/src/common/moduli.ts и desktop/src/local/moduli.mjs (проверка
// сервера сверяет все три).
//
// perms — права модуля. Право пропадает (у всех, включая владельца), только когда
// выключены ВСЕ модули, где оно названо: «Отчёты: просмотр» нужно и «Отчёту продажи»,
// и «Отчёту ОПУ».
// Обязательные разделы (Касса, Смена кассы, Товары, Приход товара, Поставщики,
// Сотрудники, Роли и права, Настройки) модулями не являются и не выключаются.
export const MODULES = [
  { key: 'dashboard', label: 'Панель управления', routes: ['/dashboard'], perms: ['dashboard.view'] },
  { key: 'debts', label: 'Долги клиентов', routes: ['/debts'], perms: ['debts.view', 'debts.pay', 'pos.debt'] },
  { key: 'discounts', label: 'История скидок', routes: ['/discounts'], perms: ['discounts.view'] },
  { key: 'deferred', label: 'Отложенные штрихкоды', routes: ['/deferred'], perms: ['deferred.view', 'deferred.manage', 'pos.defer'] },
  { key: 'salesReport', label: 'Отчёт продажи', routes: ['/sales-report'], perms: ['reports.view', 'reports.export'] },
  { key: 'sklad', label: 'Склад', routes: ['/sklad'], perms: ['sklad.view', 'sklad.move'] },
  { key: 'returns', label: 'Возврат товара', routes: ['/returns'], perms: ['returns.view', 'returns.create'] },
  { key: 'writeoffs', label: 'Списание', routes: ['/writeoffs'], perms: ['writeoffs.view', 'writeoffs.create'] },
  { key: 'expiry', label: 'Срок годности', routes: ['/expiry'], perms: ['expiry.view'] },
  { key: 'inventory', label: 'Инвентаризация', routes: ['/inventory'], perms: ['inventory.view', 'inventory.count', 'inventory.apply'] },
  { key: 'orders', label: 'Авто-заявка', routes: ['/orders'], perms: ['orders.view'] },
  { key: 'supplierReport', label: 'Отчёт поставщиков', routes: ['/supplier-report'], perms: [] },
  { key: 'incomes', label: 'Доходы', routes: ['/incomes'], perms: ['incomes.view', 'incomes.create', 'incomes.edit', 'settings.incomeCategories'] },
  { key: 'expenses', label: 'Расходы', routes: ['/expenses'], perms: ['expenses.view', 'expenses.create', 'expenses.edit', 'settings.expenseCategories'] },
  { key: 'opu', label: 'Отчёт ОПУ', routes: ['/reports'], perms: ['reports.view', 'reports.export'] },
  { key: 'obuchenie', label: 'Обучение', routes: ['/obuchenie'], perms: [] },
]

export const MODULE_KEYS = MODULES.map((m) => m.key)
const KNOWN = new Set(MODULE_KEYS)

// Список выключенных из чего угодно (ответ сервера, старая запись, мусор) → только
// известные ключи, без повторов, в порядке MODULES
export function cleanModulesOff(list) {
  if (!Array.isArray(list)) return []
  const set = new Set(list.filter((k) => typeof k === 'string' && KNOWN.has(k)))
  return MODULE_KEYS.filter((k) => set.has(k))
}

const offOf = (userOrList) => cleanModulesOff(Array.isArray(userOrList) ? userOrList : userOrList?.modulesOff)

// Права, которых нет из-за выключенных модулей: право пропадает, только когда выключены
// все модули, где оно названо
export function offPerms(userOrList) {
  const off = new Set(offOf(userOrList))
  const out = new Set()
  if (!off.size) return out
  for (const m of MODULES) {
    if (!off.has(m.key)) continue
    for (const p of m.perms) {
      if (MODULES.every((x) => !x.perms.includes(p) || off.has(x.key))) out.add(p)
    }
  }
  return out
}

// Включён ли модуль у этого магазина (user — «кто я», в нём modulesOff)
export const moduleOn = (user, key) => !offOf(user).includes(key)

// Открыт ли адрес раздела: адрес выключенного модуля — закрыт (и вложенные адреса тоже)
export function routeOn(user, path) {
  const off = offOf(user)
  if (!off.length || typeof path !== 'string') return true
  return !MODULES.some((m) => off.includes(m.key) && m.routes.some((r) => path === r || path.startsWith(r + '/')))
}

// ── Код активации ──
// Маска выключенных: бит i — модуль MODULES[i] выключен. 0 — всё включено
export function modulesMask(list) {
  let mask = 0
  for (const k of cleanModulesOff(list)) mask |= 1 << MODULE_KEYS.indexOf(k)
  return mask >>> 0
}
export function modulesFromMask(mask) {
  const m = Number(mask) >>> 0
  return MODULE_KEYS.filter((_, i) => (m >>> i) & 1)
}
