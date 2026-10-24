// ── Справочники и правки документов, сделанные на кассе без связи (версия 1.4.14) ──
//
// Касса присылает правку так: что стало (set), что было у неё (base) и когда (at). Здесь
// стережётся граница — разбор того, что прислали, — и правило, которое выбрал владелец:
// побеждает последняя по времени правка; столкновение он видит в «Расхождениях».
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')
const { Prisma } = require('@prisma/client')

const {
  Reject,
  OP_TYPES,
  parseProductCreate,
  parseProductUpdate,
  parseRemove,
  parseCategoryCreate,
  parseCategoryUpdate,
  parseNamed,
  parseSupplierCreate,
  parseSupplierUpdate,
  parseSupplierPay,
  parseExpenseUpdate,
  parseIncomeUpdate,
  parseArrivalUpdate,
  parseInventoryCreate,
  parseInventoryCount,
  parseInventoryApply,
  parseUserCreate,
  parseUserUpdate,
  parseRoleCreate,
  parseRoleUpdate,
  passwordHashOf,
} = require('../dist/sync/payload')
const { OP_PERMISSIONS } = require('../dist/auth/permissions')
const { resolveEdit, same, conflictNote, changedFields, alreadySame } = require('../dist/common/stamps')
const { rewriteAliases, aliasOf, EDIT_TYPES } = require('../dist/sync/edits')
const { randomInternalBarcode, ean13CheckDigit } = require('../dist/common/barcode')

const NOW = Date.parse('2026-10-23T12:00:00Z')
const AT = '2026-10-23T09:00:00.000Z'
const rejected = (fn, re) => assert.throws(fn, (e) => e instanceof Reject && (!re || re.test(e.message)), 'ожидался отказ по существу')

test('все новые операции известны обмену и требуют тех же прав, что на сайте', () => {
  for (const type of EDIT_TYPES) {
    assert.ok(OP_TYPES.includes(type), type)
    assert.ok(Array.isArray(OP_PERMISSIONS[type]) && OP_PERMISSIONS[type].length, 'нет права для ' + type)
  }
  assert.deepEqual(OP_PERMISSIONS['product.create'], ['products.create'])
  assert.deepEqual(OP_PERMISSIONS['product.update'], ['products.edit'])
  assert.deepEqual(OP_PERMISSIONS['product.delete'], ['products.delete'])
  assert.deepEqual(OP_PERMISSIONS['productType.update'], ['settings.categories'])
  assert.deepEqual(OP_PERMISSIONS['supplier.pay'], ['suppliers.pay'])
  assert.deepEqual(OP_PERMISSIONS['cashMove.delete'], ['shift.others'])
  assert.deepEqual(OP_PERMISSIONS['arrival.update'], ['arrivals.edit'])
  assert.deepEqual(OP_PERMISSIONS['supplierReturn.delete'], ['arrivals.edit'])
})

test('товар с кассы: поля карточки — в пределах сайта; категория пустая — пустая, нет — «Прочее»', () => {
  const base = { id: 'p-1', name: ' Анальгин ', barcode: '4600000000031', cost: 20, price: 30, stock: 3, looseUnits: 4, unitsPerPack: 10, expiryDate: '2027-05-31', createdAt: AT }
  const p = parseProductCreate({ product: base }, NOW)
  assert.deepEqual(
    [p.id, p.name, p.barcode, p.category, p.cost, p.price, p.stock, p.looseUnits, p.unitsPerPack, p.minStock, p.unit, p.expiryDate.toISOString().slice(0, 10)],
    ['p-1', 'Анальгин', '4600000000031', 'Прочее', 20, 30, 3, 4, 10, 5, 'уп', '2027-05-31'],
  )
  assert.equal(parseProductCreate({ product: { ...base, category: '' } }, NOW).category, '')
  rejected(() => parseProductCreate({ product: { ...base, name: '  ' } }, NOW), /название/)
  rejected(() => parseProductCreate({ product: { ...base, barcode: undefined } }, NOW), /штрихкод/)
  rejected(() => parseProductCreate({ product: { ...base, price: -1 } }, NOW), /сумма/)
  rejected(() => parseProductCreate({ product: { ...base, unitsPerPack: 0 } }, NOW))
  rejected(() => parseProductCreate({ product: { ...base, image: 'javascript:alert(1)' } }, NOW), /Фото/)
  rejected(() => parseProductCreate({ product: { ...base, stock: 3_000_000_000 } }, NOW))
})

test('правка товара: только присланные поля, что было у кассы, остаток и срок — отдельно', () => {
  const u = parseProductUpdate({ id: 'p-1', at: AT, set: { price: 170, name: 'Нурофен форте' }, base: { price: 150, name: 'Нурофен', junk: { a: 1 } }, stock: { units: 7, explicit: true } }, NOW)
  assert.deepEqual(u.set, { price: 170, name: 'Нурофен форте' })
  assert.deepEqual(u.base, { price: 150, name: 'Нурофен' })
  assert.deepEqual(u.stock, { units: 7, explicit: true })
  assert.equal(u.expiryTouched, false)
  assert.equal(u.at.toISOString(), AT)
  const e = parseProductUpdate({ id: 'p-1', at: AT, set: {}, base: {}, expiryDate: null }, NOW)
  assert.deepEqual([e.expiryTouched, e.expiryDate], [true, null])
  rejected(() => parseProductUpdate({ id: 'p 1', at: AT, set: {} }, NOW), /номер/)
  rejected(() => parseProductUpdate({ id: 'p-1', at: 'вчера', set: {} }, NOW), /дата/)
  // Удаление называет запись и время
  assert.deepEqual(parseRemove({ id: 'p-1', at: AT }, 'товар', NOW), { id: 'p-1', at: new Date(AT) })
  rejected(() => parseRemove({ id: 'p-1' }, 'товар', NOW), /дата/)
})

test('категории, статьи, сервисы, поставщики, оплата: разбор поле за полем', () => {
  assert.deepEqual(parseCategoryCreate({ category: { id: 'c-1', name: ' Витамины ', noExpiry: true, createdAt: AT } }, NOW), { id: 'c-1', name: 'Витамины', noExpiry: true, createdAt: new Date(AT) })
  rejected(() => parseCategoryCreate({ category: { id: 'c-1', name: '', createdAt: AT } }, NOW))
  assert.deepEqual(parseCategoryUpdate({ id: 'c-1', at: AT, set: { name: 'Лекарства' }, base: { name: 'Таблетки' } }, NOW).set, { name: 'Лекарства' })
  assert.deepEqual(parseNamed({ service: { id: 's-1', name: 'Humo', createdAt: AT } }, 'service', 'сервис перевода', 40, NOW).name, 'Humo')
  rejected(() => parseNamed({ service: { id: 's-1', name: 'x'.repeat(41).replace(/x/g, ' '), createdAt: AT } }, 'service', 'сервис перевода', 40, NOW))
  const s = parseSupplierCreate({ supplier: { id: 'sp-1', name: 'Хлебозавод', phone: ' 900 ', openingDebt: 300, createdAt: AT } }, NOW)
  assert.deepEqual([s.name, s.phone, s.openingDebt], ['Хлебозавод', '900', 300])
  assert.deepEqual(parseSupplierUpdate({ id: 'sp-1', at: AT, set: { note: 'по средам' }, base: { note: '' } }, NOW).set, { note: 'по средам' })
  const pay = parseSupplierPay({ payment: { id: 'pay-1', supplierId: 'sp-1', amount: 200, fromCash: true, shiftId: 'sh-1', date: AT } }, NOW)
  assert.deepEqual([pay.amount, pay.fromCash, pay.shiftId], [200, true, 'sh-1'])
  rejected(() => parseSupplierPay({ payment: { id: 'pay-1', supplierId: 'sp-1', amount: 0, date: AT } }, NOW), /больше нуля/)
})

test('правка расхода, дохода и прихода: пределы как у сайта', () => {
  const e = parseExpenseUpdate({ id: 'e-1', at: AT, set: { amount: 25, note: ' такси ', employeeId: null, salaryMonth: 'не месяц' }, base: { amount: 40 } }, NOW)
  assert.deepEqual(e.set, { amount: 25, note: 'такси', employeeId: null, salaryMonth: '' })
  rejected(() => parseExpenseUpdate({ id: 'e-1', at: AT, set: { amount: 0 } }, NOW), /больше нуля/)
  assert.deepEqual(parseIncomeUpdate({ id: 'i-1', at: AT, set: { category: 'Услуги' } }, NOW).set, { category: 'Услуги' })
  const a = parseArrivalUpdate({ at: AT, arrival: { id: 'a-1', supplierId: '', items: [{ id: 'l-1', qty: 2, cost: 60, expiryDate: '2028-01-31' }] } }, NOW)
  assert.equal(a.supplierId, '')
  assert.deepEqual(a.items, [{ id: 'l-1', qty: 2, pieces: 0, cost: 60, expiryDate: '2028-01-31T00:00:00.000Z' }])
  rejected(() => parseArrivalUpdate({ at: AT, arrival: { id: 'a-1', items: [] } }, NOW), /позиций/)
})

// ── Чья правка новее ──
const at = (iso) => new Date(iso)

test('поле с тех пор никто не трогал — правка кассы ложится без столкновения', () => {
  const r = resolveEdit({ price: 170 }, { price: 150 }, { price: new Prisma.Decimal('150.00') }, new Map(), at('2026-10-23T09:00:00Z'))
  assert.deepEqual(r, { apply: ['price'], overrode: [], kept: [] })
})

test('поле правили и там, и тут: побеждает та правка, что позже по времени', () => {
  const current = { price: new Prisma.Decimal(160) }
  // На сайте поправили в 08:00, на кассе — в 09:00: остаётся правка кассы
  const kassaLater = resolveEdit({ price: 170 }, { price: 150 }, current, new Map([['price', at('2026-10-23T08:00:00Z')]]), at('2026-10-23T09:00:00Z'))
  assert.deepEqual(kassaLater, { apply: ['price'], overrode: ['price'], kept: [] })
  // На сайте — в 10:00: остаётся правка сайта
  const siteLater = resolveEdit({ price: 170 }, { price: 150 }, current, new Map([['price', at('2026-10-23T10:00:00Z')]]), at('2026-10-23T09:00:00Z'))
  assert.deepEqual(siteLater, { apply: [], overrode: [], kept: ['price'] })
  // Штампа нет (правили до 1.4.14) — правка кассы новее
  assert.deepEqual(resolveEdit({ price: 170 }, { price: 150 }, current, new Map(), at('2026-10-23T09:00:00Z')).overrode, ['price'])
  // Поправили на одно и то же — делать нечего
  assert.deepEqual(resolveEdit({ price: 160 }, { price: 150 }, current, new Map(), at('2026-10-23T09:00:00Z')), { apply: [], overrode: [], kept: [] })
})

test('у кассы «было» совпало с сервером, но поле с тех пор правили позже — более ранняя правка не ложится', () => {
  // Касса X без связи разблокировала сотрудника в 09:00 (у неё он был заблокирован). Касса Y,
  // узнав об этом по сети, заблокировала его снова в 09:05 и дошла до сервера первой: на сервере
  // он заблокирован, отметка поля — 09:05. Правка X приходит последней, её «было» совпадает с
  // сервером — но она раньше, и блокировка остаётся
  const current = { active: false }
  const stamps = new Map([['active', at('2026-10-23T09:05:00Z')]])
  assert.deepEqual(resolveEdit({ active: true }, { active: false }, current, stamps, at('2026-10-23T09:00:00Z')), { apply: [], overrode: [], kept: ['active'] })
  // Правка позже отметки (обычный порядок: сначала сервер, потом касса) — ложится, как и раньше
  assert.deepEqual(resolveEdit({ active: true }, { active: false }, current, stamps, at('2026-10-23T09:10:00Z')), { apply: ['active'], overrode: [], kept: [] })
  // Отметки нет — ложится
  assert.deepEqual(resolveEdit({ active: true }, { active: false }, current, new Map(), at('2026-10-23T09:00:00Z')), { apply: ['active'], overrode: [], kept: [] })
})

test('правка «из будущего» (часы кассы спешат) считается сделанной сейчас: более поздней отметки на сервере она не перебивает', () => {
  const soon = new Date(Date.now() + 3 * 60000)
  const stamped = new Date(Date.now() + 60000)
  // На сервере поле отмечено минутой «вперёд» (так быть не должно, но пусть): правка кассы
  // «через три минуты» считается сделанной сейчас — и уступает
  assert.deepEqual(resolveEdit({ price: 170 }, { price: 150 }, { price: 160 }, new Map([['price', stamped]]), soon).kept, ['price'])
})

test('поля, которые уже такие, как прислала касса, — отдельным списком для отметки времени', () => {
  const out = resolveEdit({ name: 'Б', phone: '2', note: 'x' }, { name: 'А', phone: '1', note: 'y' }, { name: 'А', phone: '2', note: 'z' }, new Map([['note', at('2026-10-23T10:00:00Z')]]), at('2026-10-23T09:00:00Z'))
  assert.deepEqual(out, { apply: ['name'], overrode: [], kept: ['note'] })
  assert.deepEqual(alreadySame({ name: 'Б', phone: '2', note: 'x' }, { name: 'А', phone: '2', note: 'z' }, out), ['phone'])
})

test('одинаковость полей: деньги числом, пустое — пустым, списки поэлементно', () => {
  assert.equal(same(new Prisma.Decimal('12.00'), 12), true)
  assert.equal(same('', null), true)
  assert.equal(same(['a', 'b'], ['a', 'b']), true)
  assert.equal(same(['a', 'b'], ['b', 'a']), false)
  assert.equal(same(true, false), false)
  assert.equal(same(new Date('2026-10-23T09:00:00Z'), '2026-10-23T09:00:00.000Z'), true)
  assert.deepEqual(changedFields({ name: 'A', price: new Prisma.Decimal(10) }, { name: 'A', price: 12 }, ['name', 'price']), ['price'])
})

test('подробности столкновения: фото в них не кладётся, длинный текст обрезается', () => {
  const note = JSON.parse(conflictNote('Product', { image: 'data:image/jpeg;base64,AAAA', name: 'x'.repeat(500) }, { image: 'data:image/jpeg;base64,BBBB', name: 'y' }, { apply: [], overrode: ['image'], kept: ['name'] }))
  assert.equal(note.fields[0].kassa, '[фото]')
  assert.equal(note.fields[1].kassa.length, 201)
  assert.equal(note.fields[1].won, 'server')
})

test('псевдонимы: объединённый товар и поставщик-двойник ведут к основной записи', () => {
  const aliases = new Map([['product:dup', 'main'], ['product:main', 'final'], ['supplier:s-kassa', 's-site']])
  assert.equal(aliasOf(aliases, 'product', 'dup'), 'final')
  const payload = { sale: { items: [{ productId: 'dup', qty: 1 }, { productId: 'other', qty: 2 }] }, arrival: { supplierId: 's-kassa' } }
  assert.deepEqual(rewriteAliases(payload, aliases), { sale: { items: [{ productId: 'final', qty: 1 }, { productId: 'other', qty: 2 }] }, arrival: { supplierId: 's-site' } })
})

test('внутренний штрихкод: EAN-13 с префиксом 2 и верной контрольной цифрой', () => {
  for (let i = 0; i < 50; i++) {
    const code = randomInternalBarcode()
    assert.match(code, /^2\d{12}$/)
    assert.equal(ean13CheckDigit(code.slice(0, 12)), code[12])
  }
})

test('псевдонимы категорий и типов: правка с номером кассы ведёт к записи сайта с тем же названием', () => {
  const aliases = new Map([['category:cat-kassa', 'cat-site'], ['productType:t-kassa', 't-site'], ['supplier:s-kassa', 's-site']])
  assert.equal(aliasOf(aliases, 'category', 'cat-kassa'), 'cat-site')
  assert.equal(aliasOf(aliases, 'productType', 't-kassa'), 't-site')
  // Виды не путаются: номер категории не ведёт к поставщику и наоборот
  assert.equal(aliasOf(aliases, 'supplier', 'cat-kassa'), 'cat-kassa')
  assert.equal(aliasOf(aliases, 'category', 's-kassa'), 's-kassa')
  // Старые операции с номером категории в полях товара не переписываются: товар хранит её названием
  assert.deepEqual(rewriteAliases({ product: { category: 'Таблетки', categoryId: 'cat-kassa' } }, aliases), { product: { category: 'Таблетки', categoryId: 'cat-kassa' } })
})

test('инвентаризация с кассы (1.4.15): лист, пересчёт и применение — в пределах сайта, права те же', () => {
  const sheet = {
    inventory: {
      id: 'inv-1', scope: 'Таблетки', note: '', date: AT,
      items: [
        { id: 'l-1', productId: 'p-1', name: 'Анальгин', expectedUnits: 30, cost: 20 },
        { id: 'l-2', productId: null, name: 'Удалённый', expectedUnits: 0, cost: 0, actualUnits: 0 },
      ],
    },
  }
  const inv = parseInventoryCreate(sheet, NOW)
  assert.deepEqual([inv.id, inv.scope, inv.items.length, inv.items[0].actualUnits, inv.items[1].productId, inv.items[1].actualUnits], ['inv-1', 'Таблетки', 2, null, null, 0])
  assert.equal(parseInventoryCreate({ inventory: { ...sheet.inventory, scope: '' } }, NOW).scope, 'all')
  rejected(() => parseInventoryCreate({ inventory: { ...sheet.inventory, items: [] } }, NOW), /позиц/i)
  rejected(() => parseInventoryCreate({ inventory: { ...sheet.inventory, items: [{ ...sheet.inventory.items[0], expectedUnits: -1 }] } }, NOW))
  // Название — снимок карточки: карточка с одними пробелами лист не ломает
  assert.equal(parseInventoryCreate({ inventory: { ...sheet.inventory, items: [{ ...sheet.inventory.items[0], name: ' ' }] } }, NOW).items[0].name, '—')

  const c = parseInventoryCount({ id: 'inv-1', at: AT, items: [{ id: 'l-1', actualUnits: 28 }, { id: 'l-2', actualUnits: null }] }, NOW)
  assert.deepEqual(c.items, [{ id: 'l-1', actualUnits: 28 }, { id: 'l-2', actualUnits: null }])
  rejected(() => parseInventoryCount({ id: 'inv-1', items: [] }, NOW), /дата/i)
  rejected(() => parseInventoryCount({ id: 'inv-1', at: AT, items: [{ id: 'l-1', actualUnits: 1.5 }] }, NOW))
  // Применить можно и без новых чисел — по сохранённым
  assert.deepEqual(parseInventoryApply({ id: 'inv-1', at: AT }, NOW).items, [])
  // Строку посчитала соседняя касса по сети — у неё свой момент
  const peer = parseInventoryApply({ id: 'inv-1', at: AT, items: [{ id: 'l-1', actualUnits: 5, at: '2026-10-20T08:00:00.000Z' }] }, NOW)
  assert.equal(peer.items[0].at.toISOString(), '2026-10-20T08:00:00.000Z')
  assert.equal('at' in c.items[0], false)
  rejected(() => parseInventoryApply({ id: 'inv-1', at: AT, items: [{ id: 'l-1', actualUnits: 5, at: 'вчера' }] }, NOW), /дата/i)
  assert.deepEqual(OP_PERMISSIONS['inventory.create'], ['inventory.count'])
  assert.deepEqual(OP_PERMISSIONS['inventory.count'], ['inventory.count'])
  assert.deepEqual(OP_PERMISSIONS['inventory.apply'], ['inventory.apply'])
  assert.deepEqual(OP_PERMISSIONS['inventory.delete'], ['inventory.count'])
})

test('сотрудники и роли с кассы (1.4.16): только отпечаток пароля, поля — в пределах сайта, только владелец', () => {
  const HASH = 's3$16384$8$4$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)
  const user = { user: { id: 'acc-k1', userId: 'u-k1', name: '  vali ', passwordHash: HASH, roleId: 'r-1', fullName: ' Валиев ', salary: 2500, bonusPercent: 1.5, salaryDay: 5, createdAt: AT } }
  const u = parseUserCreate(user, NOW)
  assert.deepEqual([u.name, u.fullName, u.roleId, u.salary, u.bonusPercent, u.salaryDay], ['vali', 'Валиев', 'r-1', 2500, 1.5, 5])
  assert.equal(parseUserCreate({ user: { ...user.user, roleId: 'owner' } }, NOW).roleId, 'owner')
  assert.equal(parseUserCreate({ user: { ...user.user, roleId: undefined, salaryDay: undefined } }, NOW).salaryDay, 1)
  // Пароль открытым текстом, слабый отпечаток или «дорогой» — отказ
  rejected(() => parseUserCreate({ user: { ...user.user, passwordHash: 'qwerty123' } }, NOW), /пароль/i)
  rejected(() => passwordHashOf('s3$1024$8$1$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)), /пароль/i)
  rejected(() => passwordHashOf('s3$1048576$8$4$' + 'a'.repeat(32) + '$' + 'b'.repeat(128)), /пароль/i)
  rejected(() => parseUserCreate({ user: { ...user.user, name: ' ' } }, NOW), /имя/i)
  rejected(() => parseUserCreate({ user: { ...user.user, salaryDay: 31 } }, NOW))
  rejected(() => parseUserCreate({ user: { ...user.user, bonusPercent: 120 } }, NOW))

  const upd = parseUserUpdate({ id: 'acc-k1', at: AT, set: { active: false, roleId: 'owner', passwordHash: HASH, salary: 3000 }, base: { active: true, roleId: 'r-1', salary: 2500 } }, NOW)
  assert.deepEqual(upd.set, { active: false, roleId: 'owner', salary: 3000 })
  assert.equal(upd.passwordHash, HASH)
  assert.equal(parseUserUpdate({ id: 'acc-k1', at: AT, set: { name: 'x' } }, NOW).passwordHash, null)

  const role = parseRoleCreate({ role: { id: 'r-k1', name: '  Кладовщик   склада ', description: 'Приход', permissions: ['arrivals.create', 'arrivals.create', 42], createdAt: AT } }, NOW)
  assert.deepEqual([role.name, role.permissions], ['Кладовщик склада', ['arrivals.create']])
  rejected(() => parseRoleCreate({ role: { id: 'r-k1', name: '', createdAt: AT } }, NOW), /роли/i)
  rejected(() => parseRoleCreate({ role: { id: 'r-k1', name: 'x', permissions: 'все', createdAt: AT } }, NOW), /списком/i)
  assert.equal(parseRoleUpdate({ id: 'owner', at: AT, set: { permissions: [] } }, NOW).id, 'owner')
  assert.deepEqual(parseRoleUpdate({ id: 'r-k1', at: AT, set: { permissions: ['pos.sell'] }, base: { permissions: [] } }, NOW).set, { permissions: ['pos.sell'] })

  for (const t of ['user.create', 'user.update', 'user.delete', 'role.create', 'role.update', 'role.delete']) {
    assert.deepEqual(OP_PERMISSIONS[t], ['owner.only'], t)
  }
})
