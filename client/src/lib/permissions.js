// ── Права сотрудников ──
//
// Тот же список, что на сервере (server/src/auth/permissions.ts): проверка сервера
// сверяет ключи, чтобы два списка не разошлись. Здесь к ключам добавлены подписи
// для экрана «Роли и права» и помощники для интерфейса: по ним прячутся плитки
// разделов и кнопки, на которые у сотрудника нет права.
//
// Владелец может всё: у него нет роли, и спрашивать его права незачем.
// Расширение в путях не указано: файл грузится и проверками без сборщика.
export const PERMISSION_GROUPS = [
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

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map(([key]) => key))

// Кассир по умолчанию: касса, смена и возвраты. То же, что заводит сервер
export const CASHIER_DEFAULT = [
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

export const OWNER_ROLE_ID = 'owner'

export const isOwner = (user) => user?.role === 'founder'

// Права вошедшего. Сотрудник, вошедший до появления ролей, ещё не принёс их с
// сервера — до обновления «кто я» он считается кассиром по умолчанию
export function permissionsOf(user) {
  if (!user) return []
  if (user.role === 'founder') return ALL_PERMISSIONS
  if (Array.isArray(user.permissions)) return user.permissions
  return user.role === 'cashier' ? CASHIER_DEFAULT : []
}

// Достаточно любого из перечисленных прав
export function can(user, ...keys) {
  if (!user) return false
  if (user.role === 'founder') return true
  const own = permissionsOf(user)
  return keys.some((k) => own.includes(k))
}

export function labelOf(key) {
  for (const g of PERMISSION_GROUPS) for (const [k, label] of g.items) if (k === key) return label
  return key
}
