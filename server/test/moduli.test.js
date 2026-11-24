// ── Модули магазина (1.8.1) ──
//
// Владелец сервиса выключает модули магазина; выключенный раздел закрыт для всех, включая
// владельца. Здесь: три копии списка (сайт, сервер, программа) не разошлись, права
// пропадают по правилу «все модули, где право названо, выключены», сторож закрывает разделы
// модуля (@Modul) и не трогает обязательные, обмен с программой не принимает операции
// выключенного модуля.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { existsSync } = require('node:fs')
const { Reflector } = require('@nestjs/core')

const M = require('../dist/common/moduli')
const { ALL_PERMISSIONS, hasPerm, permissionsOf, OP_PERMISSIONS } = require('../dist/auth/permissions')
const { AuthGuard } = require('../dist/auth/auth.guard')
const { MODULE_OFF } = require('../dist/auth/decorators')

const plain = (list) => list.map((m) => ({ key: m.key, label: m.label, routes: [...m.routes], perms: [...m.perms] }))

test('три копии списка модулей совпадают: сайт, сервер, программа', async () => {
  const client = await import(pathToFileURL(join(__dirname, '..', '..', 'client', 'src', 'lib', 'moduli.js')).href)
  assert.deepEqual(plain(M.MODULES), plain(client.MODULES), 'сервер и сайт')
  const desktopPath = join(__dirname, '..', '..', 'desktop', 'src', 'local', 'moduli.mjs')
  assert.ok(existsSync(desktopPath), 'копия программы на месте')
  const desktop = await import(pathToFileURL(desktopPath).href)
  assert.deepEqual(plain(M.MODULES), plain(desktop.MODULES), 'сервер и программа')
  // Помощники считают одинаково
  for (const off of [[], ['sklad'], ['salesReport'], ['salesReport', 'opu', 'expiry'], M.MODULE_KEYS]) {
    assert.deepEqual([...M.offPerms(off)].sort(), [...client.offPerms(off)].sort())
    assert.deepEqual([...M.offPerms(off)].sort(), [...desktop.offPerms(off)].sort())
    assert.equal(M.modulesMask(off), client.modulesMask(off))
    assert.equal(M.modulesMask(off), desktop.modulesMask(off))
  }
})

test('порядок модулей закреплён: номер — бит в коде активации', () => {
  assert.deepEqual(M.MODULE_KEYS, [
    'dashboard', 'debts', 'discounts', 'deferred', 'salesReport', 'sklad', 'returns', 'writeoffs',
    'expiry', 'inventory', 'orders', 'supplierReport', 'incomes', 'expenses', 'opu', 'obuchenie', 'raw',
  ])
  assert.ok(M.MODULES.length <= 24, 'в коде под маску 24 бита')
})

test('права модулей — из общего списка прав; обязательные разделы модулями не выключаются', () => {
  for (const m of M.MODULES) for (const p of m.perms) assert.ok(ALL_PERMISSIONS.includes(p), `${m.key}: ${p}`)
  const all = new Set(M.MODULES.flatMap((m) => m.perms))
  for (const p of ['pos.sell', 'shift.view', 'shift.open', 'products.view', 'arrivals.view', 'arrivals.create', 'suppliers.view', 'settings.print', 'customers.create']) {
    assert.ok(!all.has(p), 'обязательное право не в модуле: ' + p)
  }
})

test('cleanModulesOff и маска: мусор отбрасывается, порядок — как в списке', () => {
  assert.deepEqual(M.cleanModulesOff(null), [])
  assert.deepEqual(M.cleanModulesOff('sklad'), [])
  assert.deepEqual(M.cleanModulesOff(['obuchenie', 'нет', 5, 'sklad', 'sklad']), ['sklad', 'obuchenie'])
  assert.equal(M.modulesMask([]), 0)
  assert.equal(M.modulesMask(['dashboard']), 1)
  assert.equal(M.modulesMask(['sklad', 'expiry']), (1 << 5) | (1 << 8))
  assert.deepEqual(M.modulesFromMask((1 << 5) | (1 << 8)), ['sklad', 'expiry'])
  assert.deepEqual(M.modulesFromMask(M.modulesMask(M.MODULE_KEYS)), M.MODULE_KEYS)
  assert.equal(M.modulesLabel(['expiry', 'sklad']), 'Склад, Срок годности')
})

test('общее право пропадает, только когда выключены все модули, где оно названо', () => {
  assert.equal(M.offPerms(['salesReport']).has('reports.view'), false, 'ОПУ ещё включён')
  assert.equal(M.offPerms(['opu']).has('reports.view'), false, 'отчёт продаж ещё включён')
  assert.equal(M.offPerms(['salesReport', 'opu']).has('reports.view'), true)
  assert.deepEqual([...M.offPerms(['supplierReport'])], [], 'у отчёта поставщиков своих прав нет')
  assert.deepEqual([...M.offPerms(['debts'])].sort(), ['debts.pay', 'debts.view', 'pos.debt'])
  assert.deepEqual([...M.offPerms({ modulesOff: ['sklad'] })].sort(), ['sklad.move', 'sklad.view'])
})

test('hasPerm и permissionsOf: выключенный модуль отбирает права у всех, даже у владельца', () => {
  const owner = { role: 'founder', permissions: ALL_PERMISSIONS, modulesOff: ['sklad', 'debts'] }
  assert.equal(hasPerm(owner, 'sklad.view'), false)
  assert.equal(hasPerm(owner, 'pos.debt'), false)
  assert.equal(hasPerm(owner, 'pos.sell'), true)
  // Достаточно одного живого права из перечисленных
  assert.equal(hasPerm(owner, 'sklad.view', 'arrivals.view'), true)
  const cashier = { role: 'cashier', permissions: ['pos.sell', 'pos.debt', 'sklad.view'], modulesOff: ['sklad', 'debts'] }
  assert.equal(hasPerm(cashier, 'pos.debt'), false)
  assert.equal(hasPerm(cashier, 'sklad.view'), false)
  assert.equal(hasPerm(cashier, 'pos.sell'), true)
  // Без модулей — как прежде
  assert.equal(hasPerm({ role: 'founder' }, 'sklad.view'), true)
  assert.equal(hasPerm({ role: 'cashier', permissions: ['sklad.view'] }, 'sklad.view'), true)

  const ownerAcc = { role: 'founder', pharmacy: { modulesOff: ['expiry', 'salesReport', 'opu'] } }
  const p = permissionsOf(ownerAcc)
  assert.ok(!p.includes('expiry.view') && !p.includes('reports.view') && !p.includes('reports.export'))
  assert.ok(p.includes('pos.sell') && p.includes('dashboard.view'))
  assert.equal(permissionsOf({ role: 'founder' }).length, ALL_PERMISSIONS.length)
  // Явный список сильнее записи магазина (обмен: сосед по магазину)
  assert.ok(!permissionsOf({ role: 'cashier', roleRef: { permissions: ['returns.create', 'pos.sell'] } }, ['returns']).includes('returns.create'))
})

test('операции программы: права каждой операции выключенного модуля пропадают', () => {
  const off = M.offPerms(M.MODULE_KEYS)
  // Операции модулей — все закрыты, если выключено всё
  for (const type of ['writeoff', 'return', 'debt.pay', 'deferred.add', 'deferred.remove', 'expense', 'income', 'sklad.toShop', 'sklad.edit', 'inventory.apply', 'inventory.count', 'income.update', 'expense.delete']) {
    assert.ok(OP_PERMISSIONS[type].every((k) => off.has(k)), type)
  }
  // Обязательные операции — живы
  for (const type of ['sale', 'arrival', 'shift.open', 'shift.close', 'cash.move', 'product.create', 'supplier.pay']) {
    assert.ok(OP_PERMISSIONS[type].some((k) => !off.has(k)), type)
  }
})

// ── Сторож: разделы модуля закрыты, обязательные — открыты ──
function guardFor(modulesOff, role = 'founder', roleRef = null) {
  const acc = {
    id: 'acc-1',
    active: true,
    login: 'farhod',
    role,
    roleRef,
    roleId: roleRef?.id ?? null,
    pharmacyId: 'ph-1',
    tenantUserId: 'u-1',
    passwordChangedAt: null,
    pharmacy: { id: 'ph-1', code: 'demo', name: 'Демо', schemaName: 'tenant_demo', blocked: false, paidUntil: new Date(Date.now() + 30 * 86400000), trial: false, offlineDays: 7, logoAt: null, modulesOff },
  }
  const auth = { verify: () => ({ sub: 'acc-1', sch: 'tenant_demo', iat: Date.now() }) }
  const accounts = { get: async () => acc }
  return new AuthGuard(new Reflector(), auth, accounts)
}
function ctxFor(Cls, method) {
  const req = { headers: { authorization: 'Bearer x' } }
  return { req, ctx: { getHandler: () => Cls.prototype[method], getClass: () => Cls, switchToHttp: () => ({ getRequest: () => req }) } }
}
async function verdict(guard, Cls, method) {
  const { ctx, req } = ctxFor(Cls, method)
  try {
    await guard.canActivate(ctx)
    return { ok: true, user: req.user }
  } catch (e) {
    return { ok: false, status: e.getStatus?.(), message: e.message }
  }
}

test('сторож: склад и отложенные закрыты владельцу выключенного магазина, товары/поставщики/смены открыты', async () => {
  const { SkladController } = require('../dist/sklad/sklad.controller')
  const { DeferredController } = require('../dist/deferred/deferred.controller')
  const { ProductsController } = require('../dist/products/products.controller')
  const { SuppliersController } = require('../dist/suppliers/suppliers.controller')
  const { ShiftsController } = require('../dist/shifts/shifts.controller')
  const { WriteOffsController } = require('../dist/writeoffs/writeoffs.controller')
  const { ExpensesController } = require('../dist/expenses/expenses.controller')
  const { ReturnsController } = require('../dist/returns/returns.controller')
  const { CustomersController } = require('../dist/customers/customers.controller')
  const { InventoryController } = require('../dist/inventory/inventory.controller')
  const off = ['expiry', 'sklad', 'debts', 'deferred', 'obuchenie']
  const g = guardFor(off)

  const sklad = await verdict(g, SkladController, 'findAll')
  assert.equal(sklad.ok, false)
  assert.equal(sklad.status, 403)
  assert.equal(sklad.message, MODULE_OFF)
  assert.equal((await verdict(g, SkladController, 'toShop')).status, 403)
  assert.equal((await verdict(g, DeferredController, 'findAll')).status, 403)
  assert.equal((await verdict(g, DeferredController, 'add')).status, 403)
  assert.equal((await verdict(g, CustomersController, 'pay')).status, 403, 'оплата долга')

  for (const [Cls, m] of [[ProductsController, 'findAll'], [SuppliersController, 'findAll'], [ShiftsController, 'findAll'], [ShiftsController, 'open'], [CustomersController, 'findAll'], [ReturnsController, 'create'], [WriteOffsController, 'create'], [InventoryController, 'findAll']]) {
    const r = await verdict(g, Cls, m)
    assert.equal(r.ok, true, `${Cls.name}.${m}: ${r.message || ''}`)
  }
  // «Кто я» сторожа несёт список выключенных, права владельца — без них
  const ok = await verdict(g, ProductsController, 'findAll')
  assert.deepEqual(ok.user.modulesOff, ['debts', 'deferred', 'sklad', 'expiry', 'obuchenie'])
  assert.ok(!ok.user.permissions.includes('sklad.view'))

  // Склад включили — открыт
  assert.equal((await verdict(guardFor(['expiry']), SkladController, 'findAll')).ok, true)

  // Журнал расходов читает и отчёт: закрыт, только когда выключены и расходы, и оба отчёта
  assert.equal((await verdict(guardFor(['expenses']), ExpensesController, 'findAll')).ok, true)
  assert.equal((await verdict(guardFor(['expenses']), ExpensesController, 'create')).status, 403)
  assert.equal((await verdict(guardFor(['expenses', 'salesReport', 'opu']), ExpensesController, 'findAll')).status, 403)
  // Журнал списаний — то же, вместе с панелью
  assert.equal((await verdict(guardFor(['writeoffs']), WriteOffsController, 'findAll')).ok, true)
  assert.equal((await verdict(guardFor(['writeoffs', 'salesReport', 'opu', 'dashboard']), WriteOffsController, 'findAll')).status, 403)
  // Возврат выключен: журнал прежних возвратов нужен смене — открыт, оформить новый — нет
  assert.equal((await verdict(guardFor(['returns']), ReturnsController, 'findAll')).ok, true)
  assert.equal((await verdict(guardFor(['returns']), ReturnsController, 'create')).status, 403)
  assert.equal((await verdict(guardFor(['inventory']), InventoryController, 'findAll')).status, 403)

  // Сотрудник с правом склада — тоже закрыто
  const cashier = guardFor(['sklad'], 'cashier', { id: 'r1', name: 'Кладовщик', permissions: ['sklad.view', 'sklad.move'], system: null })
  assert.equal((await verdict(cashier, SkladController, 'findAll')).status, 403)
})

test('приход на склад при выключенном «Складе» — отказ; в магазин — можно', async () => {
  const { ArrivalsController } = require('../dist/arrivals/arrivals.controller')
  let created = null
  const c = new ArrivalsController({ create: async (dto) => (created = dto) })
  const owner = { role: 'founder', permissions: ALL_PERMISSIONS, modulesOff: ['sklad'] }
  await assert.rejects(async () => c.create({ place: 'sklad', items: [] }, owner), (e) => e.getStatus() === 403 && e.message === MODULE_OFF)
  await c.create({ place: 'shop', items: [] }, owner)
  assert.equal(created.place, 'shop')
  await c.create({ place: 'sklad', items: [] }, { role: 'founder', permissions: ALL_PERMISSIONS, modulesOff: [] })
  assert.equal(created.place, 'sklad')
})
