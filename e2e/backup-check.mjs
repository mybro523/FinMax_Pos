// ── Проверка резервной копии ──
//
// ⚠️ ЭТА ПРОВЕРКА СТИРАЕТ БАЗУ. На работающей аптеке её запускать нельзя.
// Поэтому она вынесена из общего прогона и требует явного согласия:
//
//   node e2e/backup-check.mjs <адрес API> <логин> <пароль> --СТЕРЕТЬ-БАЗУ
//
// Смысл: копию делают ради одного дня — когда сервера больше нет и базу поднимают
// с нуля на новом. Проверить это можно только одним способом: снять копию, стереть
// всё и поднять обратно. Всё остальное — догадки.
import { get, post, del, login, API, group, check, summary, assert, eq, rejects } from './lib.mjs'

if (!process.argv.includes('--СТЕРЕТЬ-БАЗУ')) {
  console.log('Проверка стирает базу. Запуск: node e2e/backup-check.mjs <API> <логин> <пароль> --СТЕРЕТЬ-БАЗУ')
  process.exit(2)
}

const TAG = 'BK-' + Date.now().toString(36)
const bc = (n) => '266' + String(Date.now()).slice(-8) + String(n).padStart(2, '0')

console.log(`\x1b[1mПроверка резервной копии\x1b[0m  ${API}\n  метка: ${TAG}`)
const me = await login()
console.log(`  вошли как ${me.name}\n`)

let before
let dump

group('Готовим данные, которые должны пережить восстановление')

let product
let cashier
let category
let article
let tillExpense

await check('заводим категорию без срока годности, товар, сотрудника и клиента', async () => {
  category = await post('/categories', { name: TAG + '-bez-sroka', noExpiry: true })
  product = await post('/products', {
    name: TAG + ' Бинт', barcode: bc(1), category: category.name,
    cost: 0, price: 40, stock: 0, unitsPerPack: 1,
  })
  cashier = await post('/users', { name: TAG + '-kassir', password: 'parol-kassira', role: 'cashier' })
  await post('/customers', { name: TAG + ' Клиент', phone: '+992 900 00 00 00' })
})

await check('проводим приход, продажу и списание', async () => {
  await post('/arrivals', { supplier: TAG, items: [{ productId: product.id, qty: 10, cost: 18 }] })
  await post('/sales', { items: [{ productId: product.id, qty: 2 }], payment: 'cash', clientId: TAG + '-s1' })
  await post('/writeoffs', { reason: 'damaged', note: TAG, items: [{ productId: product.id, units: 1 }] })
})

await check('вносим расходы: обычный по своей статье и один из кассы', async () => {
  article = await post('/expense-categories', { name: TAG + ' статья' })
  await post('/expenses', { category: article.name, amount: 123.45, note: TAG })
  // Смена могла остаться открытой от прошлой работы в этой базе — тогда берём её
  const open = (await get('/shifts')).find((s) => !s.closedAt) || (await post('/shifts/open', { openingCash: 50 }))
  tillExpense = await post('/expenses', { category: 'Транспорт', amount: 20, fromCash: true, note: TAG })
  eq(tillExpense.shiftId, open.id, 'расход из кассы — в открытой смене')
  await post('/shifts/close', { countedCash: 0 })
})

await check('снимаем копию — в ней есть всё, на что ссылаются документы', async () => {
  dump = await get('/backup')
  eq(dump.format, 5, 'версия формата')
  assert(Array.isArray(dump.data.categories), 'справочник категорий в копии')
  assert(dump.data.categories.some((c) => c.name === category.name), 'наша категория в копии')
  // Доступ сотрудника (логин, пароль) живёт в панели сервиса, а в аптеке — только его
  // имя, под которым он значится в документах. Номера у этих записей разные, поэтому
  // в копии сотрудника ищем по имени
  assert(dump.data.users.some((u) => u.name === TAG + '-kassir'), 'сотрудник в копии')
  assert(!dump.data.users.some((u) => u.passwordHash), 'паролей в копии быть не должно')

  before = {
    products: (await get('/products')).length,
    sales: (await get('/sales?days=0')).length,
    arrivals: (await get('/arrivals?days=0')).length,
    writeoffs: (await get('/writeoffs?days=0')).length,
    customers: (await get('/customers')).length,
    categories: (await get('/categories')).length,
    expenses: (await get('/expenses?days=0')).length,
    expenseCategories: (await get('/expense-categories')).length,
  }
  assert(dump.data.expenses.some((e) => e.id === tillExpense.id), 'расход в копии')
  assert(dump.data.expenseCategories.some((c) => c.name === article.name), 'своя статья расходов в копии')
})

group('Стираем всё, как будто сервера больше нет')

await check('база опустела', async () => {
  const empty = {
    format: 3,
    createdAt: new Date(dump.createdAt).toISOString(),
    data: {
      categories: [], products: [], customers: [], sales: [], arrivals: [], shifts: [],
      payments: [], users: [], deferred: [], returns: [], writeOffs: [], batches: [], inventories: [],
    },
  }
  await post('/backup/restore', { dump: empty, confirm: 'ВОССТАНОВИТЬ' })
  eq((await get('/products')).length, 0, 'товаров не осталось')
  eq((await get('/sales?days=0')).length, 0, 'чеков не осталось')
  // Эта «пустая» копия — прежнего вида, без расходов: такие снимались до появления
  // раздела. Расходы она стирает, как и чеки, а список статей не трогает
  eq((await get('/expenses?days=0')).length, 0, 'расходов не осталось')
  eq((await get('/expense-categories')).length, before.expenseCategories, 'статьи расходов копия прежнего вида не трогает')
  // На новом сервере своих статей не было бы — убираем, чтобы вернуть её могла только копия
  await del('/expense-categories/' + article.id)
})

await check('убираем сотрудника — на новом сервере его бы и не было', async () => {
  // Восстановление намеренно НЕ трогает сотрудников: иначе владелец, поднимающий
  // базу, запер бы сам себя. Поэтому «чистый сервер» изображаем честно — удаляем
  // кассира руками, и дальше проверяем, что копия сумеет его вернуть.
  await del('/users/' + cashier.id)
  const users = await get('/users')
  assert(!users.some((u) => u.id === cashier.id), 'кассир должен был исчезнуть')
})

group('Поднимаем из копии')

await check('восстановление проходит без ошибок', async () => {
  const r = await post('/backup/restore', { dump, confirm: 'ВОССТАНОВИТЬ' })
  assert(r.ok, 'сервер должен подтвердить восстановление')
})

await check('данные вернулись в том же объёме', async () => {
  const after = {
    products: (await get('/products')).length,
    sales: (await get('/sales?days=0')).length,
    arrivals: (await get('/arrivals?days=0')).length,
    writeoffs: (await get('/writeoffs?days=0')).length,
    customers: (await get('/customers')).length,
    categories: (await get('/categories')).length,
    expenses: (await get('/expenses?days=0')).length,
    expenseCategories: (await get('/expense-categories')).length,
  }
  for (const k of Object.keys(before)) eq(after[k], before[k], `${k} после восстановления`)
})

await check('расходы вернулись: со статьёй, суммой и сменой, из кассы которой взяты деньги', async () => {
  const list = await get('/expenses?days=0')
  const plain = list.find((e) => e.category === article.name)
  assert(plain, 'расход по своей статье не восстановился')
  eq(Number(plain.amount), 123.45, 'сумма расхода')
  assert((await get('/expense-categories')).some((c) => c.name === article.name), 'своя статья расходов вернулась в список')
  const till = list.find((e) => e.id === tillExpense.id)
  assert(till?.fromCash, 'расход из кассы не восстановился')
  const shift = (await get('/shifts')).find((s) => s.id === till.shiftId)
  assert(shift, 'смена расхода не восстановилась')
  assert(Number(shift.expenseCash) >= 20, 'в отчёте смены нет расходов из кассы: ' + shift.expenseCash)
  // Смена закрыта — расход остаётся частью её отчёта и после восстановления
  await rejects(() => del('/expenses/' + till.id), /уже закрыта/i, 'удаление расхода закрытой смены')
})

await check('категория вернулась вместе с отметкой «срок не требуется»', async () => {
  const cats = await get('/categories')
  const mine = cats.find((c) => c.name === category.name)
  assert(mine, 'категория не восстановилась')
  eq(mine.noExpiry, true, 'потерялась отметка — приёмка начала бы требовать срок у бинтов')
})

await check('чек помнит, какой кассир его оформил', async () => {
  const sales = await get('/sales?days=0')
  const mine = sales.find((s) => s.items.some((i) => String(i.name).startsWith(TAG)))
  assert(mine, 'чек не восстановился')
  // Владелец оформлял сам — но сотрудник из копии должен существовать. Доступа у него
  // нет (в списке сотрудников его не будет), а имя в аптеке есть — его видно в свежей копии
  const back = (await get('/backup')).data.users.find((u) => u.name === TAG + '-kassir')
  assert(back, 'сотрудник из копии не восстановлен — документы ссылались бы в пустоту')
  eq(back.active, false, 'восстановленный сотрудник должен быть заблокирован: пароля у него нет')
  assert(!(await get('/users')).some((u) => u.name === TAG + '-kassir'), 'доступ вместе с копией не восстанавливается')
})

await check('войти под восстановленным сотрудником нельзя', async () => {
  const res = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: TAG + '-kassir', password: 'parol-kassira' }),
  })
  assert(!res.ok, 'старый пароль не должен подходить: в копии его не было')
})

await check('остаток товара сошёлся', async () => {
  const p = (await get('/products')).find((x) => x.name.startsWith(TAG))
  assert(p, 'товар не восстановился')
  eq(p.stock, 7, '10 пришло, 2 продали, 1 списали')
})

group('Уборка')

await check('тестовые данные убраны', async () => {
  const empty = {
    format: 3,
    createdAt: new Date().toISOString(),
    data: {
      categories: dump.data.categories.filter((c) => !c.name.startsWith(TAG)),
      products: [], customers: [], sales: [], arrivals: [], shifts: [],
      payments: [], users: [], deferred: [], returns: [], writeOffs: [], batches: [], inventories: [],
    },
  }
  await post('/backup/restore', { dump: empty, confirm: 'ВОССТАНОВИТЬ' })
  eq((await get('/products')).length, 0, 'товаров не осталось')
  const users = await get('/users')
  for (const u of users.filter((x) => x.name.startsWith(TAG))) await del(`/users/${u.id}`).catch(() => {})
  for (const c of (await get('/expense-categories')).filter((x) => x.name.startsWith(TAG))) await del('/expense-categories/' + c.id).catch(() => {})
  eq((await get('/expenses?days=0')).length, 0, 'расходов не осталось')
})

process.exit(summary() ? 1 : 0)
