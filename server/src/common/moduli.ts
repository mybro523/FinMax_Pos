// ── Модули магазина (1.8.1) ──
//
// Копия client/src/lib/moduli.js (канон) и desktop/src/local/moduli.mjs: проверка
// server/test/moduli.test.js сверяет все три — ключи, порядок, права и адреса.
//
// Владелец сервиса выбирает, какие разделы есть у клиента: при заведении магазина и
// потом в его карточке (магазинам без интернета — в коде активации). Выключенный модуль
// исчезает целиком; сервер не пускает в его разделы даже владельца.
//
// Хранится список ВЫКЛЮЧЕННЫХ (Pharmacy.modulesOff): пустой — всё включено, так магазины,
// заведённые до 1.8.1, ничего не заметят.
//
// ПОРЯДОК НЕ МЕНЯТЬ И НИЧЕГО НЕ УДАЛЯТЬ: номер в списке — номер бита в коде активации
// (бит стоит — модуль выключен). Новые модули — только в конец.
//
// perms — права модуля. Право пропадает (у всех, включая владельца), только когда
// выключены ВСЕ модули, где оно названо.
export type ModuleDef = { key: string; label: string; routes: string[]; perms: string[] }

export const MODULES: ModuleDef[] = [
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
  // Сырьё и состав (1.8.11): не раздел меню, а встроенные элементы — вкладка «Сырьё» в
  // «Товарах», редактор состава и галочка «Сырьё — не для продажи» в карточке и приходе.
  // routes/perms пусты: модуль только прячет эти элементы на фронте (moduleOn), а продажа
  // составных товаров остаётся data-driven и от модуля не зависит.
  { key: 'raw', label: 'Сырьё и состав', routes: [], perms: [] },
  // Отложенные товары (1.8.20): не раздел меню, а встроенные элементы — вкладка «Отложенные
  // товары» на странице «Отложенные штрихкоды» и значок/F7 «отложить» в кассе. routes/perms
  // пусты: модуль только прячет эти элементы на фронте (moduleOn). Сам список отложенных
  // хранится на устройстве (localStorage), от модуля не зависит.
  { key: 'otlozhTovary', label: 'Отложенные товары', routes: [], perms: [] },
  // Фискальный принтер Fiscat (1.8.21): не раздел меню, а фискализация продаж и смены на
  // фискальном устройстве в сети магазина. routes/perms пусты: модуль только включает
  // фискализацию и показывает её настройки на фронте (moduleOn(user,'fiskal')). Работает
  // лишь в программе на кассе (устройство — локальное, по http); на сайте настроек нет.
  { key: 'fiskal', label: 'Фискальный принтер', routes: [], perms: [] },
]

export const MODULE_KEYS: string[] = MODULES.map((m) => m.key)
const KNOWN = new Set(MODULE_KEYS)

// Список выключенных из чего угодно (тело запроса, старая запись, мусор) → только
// известные ключи, без повторов, в порядке MODULES
export function cleanModulesOff(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const set = new Set(list.filter((k): k is string => typeof k === 'string' && KNOWN.has(k)))
  return MODULE_KEYS.filter((k) => set.has(k))
}

type HasModules = { modulesOff?: unknown } | null | undefined
const offOf = (userOrList: unknown): string[] =>
  cleanModulesOff(Array.isArray(userOrList) ? userOrList : (userOrList as HasModules)?.modulesOff)

// Права, которых нет из-за выключенных модулей: право пропадает, только когда выключены
// все модули, где оно названо
export function offPerms(userOrList: unknown): Set<string> {
  const off = new Set(offOf(userOrList))
  const out = new Set<string>()
  if (!off.size) return out
  for (const m of MODULES) {
    if (!off.has(m.key)) continue
    for (const p of m.perms) {
      if (MODULES.every((x) => !x.perms.includes(p) || off.has(x.key))) out.add(p)
    }
  }
  return out
}

export const moduleOn = (userOrList: unknown, key: string) => !offOf(userOrList).includes(key)

// Подписи выключенных для журнала панели: «Срок годности, Склад»
export const modulesLabel = (list: unknown) =>
  cleanModulesOff(list)
    .map((k) => MODULES.find((m) => m.key === k)!.label)
    .join(', ')

// ── Код активации ──
// Маска выключенных: бит i — модуль MODULES[i] выключен. 0 — всё включено
export function modulesMask(list: unknown): number {
  let mask = 0
  for (const k of cleanModulesOff(list)) mask |= 1 << MODULE_KEYS.indexOf(k)
  return mask >>> 0
}
export function modulesFromMask(mask: number): string[] {
  const m = Number(mask) >>> 0
  return MODULE_KEYS.filter((_, i) => (m >>> i) & 1)
}
