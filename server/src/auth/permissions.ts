// ── Права сотрудников магазина ──
//
// Раньше ролей было две: владелец и кассир, и всё, что не для кассира, помечалось
// «только владелец». Теперь владелец сам решает, кому что можно: роль — это имя
// и набор прав из этого списка. Владелец всегда может всё; его права не редактируются,
// иначе он мог бы запереть сам себя.
//
// Ключ права — «раздел.действие». Этот же список лежит в интерфейсе
// (client/src/lib/permissions.js) с подписями и переводами; проверка на сервере
// сверяет оба списка, чтобы они не разошлись.
export type PermissionGroup = { key: string; title: string; items: [string, string][] }

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'sales',
    title: 'Продажи',
    items: [
      ['pos.sell', 'Касса: продажа'],
      ['pos.discount', 'Касса: скидка на позицию'],
      ['pos.debt', 'Касса: продажа в долг'],
      ['pos.defer', 'Касса: отложить незнакомый штрихкод'],
      ['returns.view', 'Возврат товара: журнал'],
      ['returns.create', 'Возврат товара: оформить возврат'],
      ['discounts.view', 'История скидок'],
    ],
  },
  {
    key: 'stock',
    title: 'Склад',
    items: [
      ['products.view', 'Товары: просмотр'],
      ['products.create', 'Товары: завести товар'],
      ['products.edit', 'Товары: изменить карточку и цены'],
      ['products.delete', 'Товары: удалить'],
      ['products.history', 'Товары: история движения'],
      ['products.labels', 'Товары: печать ценников'],
      ['arrivals.view', 'Приход товара: просмотр'],
      ['arrivals.create', 'Приход товара: оформить приход'],
      ['arrivals.edit', 'Приход товара: изменить и удалить'],
      ['arrivals.debt', 'Приход товара: в долг поставщику'],
      ['arrivals.return', 'Приход товара: возврат поставщику'],
      ['expiry.view', 'Срок годности'],
      ['writeoffs.view', 'Списание: журнал'],
      ['writeoffs.create', 'Списание: списать товар'],
      ['inventory.view', 'Инвентаризация: просмотр'],
      ['inventory.count', 'Инвентаризация: создать лист и пересчитать'],
      ['inventory.apply', 'Инвентаризация: применить пересчёт'],
      ['deferred.view', 'Отложенные штрихкоды: просмотр'],
      ['deferred.manage', 'Отложенные штрихкоды: завести товар и убрать'],
      ['orders.view', 'Авто-заявка'],
    ],
  },
  {
    key: 'finance',
    title: 'Финансы',
    items: [
      ['dashboard.view', 'Панель управления: выручка, прибыль, остатки'],
      ['shift.view', 'Смена кассы: своя смена'],
      ['shift.open', 'Смена кассы: открыть и закрыть'],
      ['shift.cash', 'Смена кассы: внести и изъять наличные'],
      ['shift.others', 'Смена кассы: смены других кассиров и отмена внесений'],
      ['shift.closeAny', 'Смена кассы: закрыть смену другого сотрудника'],
      ['debts.view', 'Долги клиентов: просмотр'],
      ['debts.pay', 'Долги клиентов: принять оплату'],
      ['customers.create', 'Клиенты: добавить'],
      ['customers.delete', 'Клиенты: удалить'],
      ['suppliers.view', 'Поставщики: просмотр и долги'],
      ['suppliers.edit', 'Поставщики: завести и изменить'],
      ['suppliers.pay', 'Поставщики: оплатить долг'],
      ['suppliers.delete', 'Поставщики: удалить'],
      ['expenses.view', 'Расходы: журнал'],
      ['expenses.create', 'Расходы: внести расход'],
      ['expenses.edit', 'Расходы: изменить и удалить'],
      ['incomes.view', 'Доходы: журнал'],
      ['incomes.create', 'Доходы: внести доход'],
      ['incomes.edit', 'Доходы: изменить и удалить'],
      ['reports.view', 'Отчёты: просмотр'],
      ['reports.export', 'Отчёты: выгрузка CSV'],
    ],
  },
  {
    key: 'admin',
    title: 'Управление',
    items: [
      ['settings.categories', 'Настройки: категории товаров'],
      ['settings.expenseCategories', 'Настройки: статьи расходов'],
      ['settings.incomeCategories', 'Настройки: статьи доходов'],
      ['settings.payServices', 'Настройки: сервисы перевода'],
      ['settings.print', 'Настройки: печать и данные чека'],
      ['settings.devices', 'Настройки: кассы и устройства'],
      ['settings.backup', 'Настройки: резервная копия'],
      ['profile.password', 'Настройки: сменить свой пароль'],
    ],
  },
]

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.items.map(([key]) => key))
const KNOWN = new Set(ALL_PERMISSIONS)
export const isPermission = (key: unknown): key is string => typeof key === 'string' && KNOWN.has(key)

// Кассир по умолчанию: касса, смена и возвраты — минимум, с которого владелец
// начинает и добавляет остальное сам
export const CASHIER_DEFAULT: string[] = [
  'pos.sell',
  'pos.discount',
  'pos.debt',
  'pos.defer',
  'customers.create',
  'returns.view',
  'returns.create',
  'shift.view',
  'shift.open',
  'shift.cash',
]

// Заготовки, которые заводятся вместе с системными ролями. Их можно переименовать,
// перенастроить или удалить
export const ROLE_PRESETS: { name: string; description: string; permissions: string[] }[] = [
  {
    name: 'Заведующий',
    description: 'Склад, финансы и настройки магазина, кроме резервной копии и устройств',
    permissions: ALL_PERMISSIONS.filter((k) => k !== 'settings.backup' && k !== 'settings.devices'),
  },
  {
    name: 'Наблюдатель',
    description: 'Только просмотр: панель, журналы и отчёты без права что-либо менять',
    // Свой пароль наблюдатель меняет сам: это не действие с данными магазина
    permissions: ALL_PERMISSIONS.filter((k) => k.endsWith('.view') || k === 'shift.others' || k === 'profile.password'),
  },
]

export const SYSTEM_CASHIER = { name: 'Кассир', description: 'Приём оплаты и кассовые операции' }
export const OWNER_ROLE = { id: 'owner', name: 'Владелец', description: 'Все права. Роль нельзя изменить или удалить' }

// Права вошедшего: владелец может всё, остальные — то, что записано в их роли.
// Кассир без роли (учётная запись из прежней версии) получает права кассира по умолчанию
export function permissionsOf(acc: { role: string; roleRef?: { permissions: string[] } | null }): string[] {
  if (acc.role === 'founder') return ALL_PERMISSIONS
  if (acc.roleRef) return acc.roleRef.permissions.filter(isPermission)
  return CASHIER_DEFAULT
}

// ── Смена своего пароля ──
// По праву «Настройки: сменить свой пароль». Владелец магазина и владелец сервиса
// меняют свой пароль всегда: запереть их без пароля было бы нельзя исправить
export const NO_PASSWORD_CHANGE = 'Менять пароль вам не разрешено. Пароль меняет владелец в разделе «Сотрудники».'
export function mayChangeOwnPassword(acc: { role: string; roleRef?: { permissions: string[] } | null }): boolean {
  if (acc.role === 'founder' || acc.role === 'superadmin') return true
  return permissionsOf(acc).includes('profile.password')
}

export type Actor = { role?: string; permissions?: string[] }
export const isOwner = (u: Actor | null | undefined) => u?.role === 'founder'
// Достаточно любого из перечисленных прав
export function hasPerm(u: Actor | null | undefined, ...keys: string[]): boolean {
  if (!u) return false
  if (u.role === 'founder') return true
  const own = u.permissions || []
  return keys.some((k) => own.includes(k))
}

// Что нужно, чтобы касса прислала операцию, сделанную без связи: то же, что и на сайте
export const OP_PERMISSIONS: Record<string, string[]> = {
  sale: ['pos.sell'],
  return: ['returns.create'],
  writeoff: ['writeoffs.create'],
  arrival: ['arrivals.create'],
  'shift.open': ['shift.open'],
  'shift.close': ['shift.open'],
  'debt.pay': ['debts.pay'],
  'customer.create': ['customers.create'],
  'deferred.add': ['pos.defer', 'deferred.manage'],
  'deferred.remove': ['deferred.manage'],
  expense: ['expenses.create'],
  income: ['incomes.create'],
  'cash.move': ['shift.cash'],
  'supplier.return': ['arrivals.return'],
  // ── Справочники и правки документов без связи — те же права, что на сайте ──
  'product.create': ['products.create'],
  'product.update': ['products.edit'],
  'product.delete': ['products.delete'],
  'category.create': ['settings.categories'],
  'category.update': ['settings.categories'],
  'category.delete': ['settings.categories'],
  // Типы товаров настраиваются там же, где категории
  'productType.create': ['settings.categories'],
  'productType.update': ['settings.categories'],
  'productType.delete': ['settings.categories'],
  'payService.create': ['settings.payServices'],
  'payService.delete': ['settings.payServices'],
  'expenseCategory.create': ['settings.expenseCategories'],
  'expenseCategory.delete': ['settings.expenseCategories'],
  'incomeCategory.create': ['settings.incomeCategories'],
  'incomeCategory.delete': ['settings.incomeCategories'],
  'supplier.create': ['suppliers.edit'],
  'supplier.update': ['suppliers.edit'],
  'supplier.delete': ['suppliers.delete'],
  'supplier.pay': ['suppliers.pay'],
  'supplierPayment.delete': ['suppliers.pay'],
  'supplierReturn.delete': ['arrivals.edit'],
  'expense.update': ['expenses.edit'],
  'expense.delete': ['expenses.edit'],
  'income.update': ['incomes.edit'],
  'income.delete': ['incomes.edit'],
  'cashMove.delete': ['shift.others'],
  'arrival.update': ['arrivals.edit'],
  'arrival.delete': ['arrivals.edit'],
}
