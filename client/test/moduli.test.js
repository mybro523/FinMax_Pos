// ── Модули магазина (1.8.1): выключенный модуль исчезает целиком ──
//
// Владелец сервиса выключает модуль у магазина (lib/moduli.js) — его права пропадают у
// всех, включая владельца магазина; раздел не открывается; уроки и шаги тура про него
// не показываются. Здесь — то, что можно проверить без браузера.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULES, MODULE_KEYS, cleanModulesOff, offPerms, moduleOn, routeOn, modulesMask, modulesFromMask } from '../src/lib/moduli.js'
import { ALL_PERMISSIONS, CASHIER_DEFAULT, can, permissionsOf } from '../src/lib/permissions.js'
import { urokiFor, ekranFor, OBUCHENIE } from '../src/lib/obuchenie.js'
import { stepsFor } from '../src/lib/tury.js'
import { OBSHIY } from '../src/lib/tur.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const owner = (off = []) => ({ role: 'founder', modulesOff: off })
const kassir = (off = [], perms = CASHIER_DEFAULT) => ({ role: 'cashier', roleSystem: 'cashier', permissions: perms, modulesOff: off })

test('модули: права модулей — настоящие права, адреса — настоящие разделы меню', () => {
  const nav = read('src/components/Layout.jsx')
  for (const m of MODULES) {
    for (const p of m.perms) assert.ok(ALL_PERMISSIONS.includes(p), `${m.key}: нет права ${p}`)
    for (const r of m.routes) assert.ok(nav.includes(`to: '${r}'`), `${m.key}: нет раздела ${r} в меню`)
  }
  assert.equal(new Set(MODULE_KEYS).size, MODULE_KEYS.length)
})

test('модули: обязательные разделы модулями не являются', () => {
  for (const r of ['/pos', '/shift', '/products', '/arrivals', '/suppliers', '/employees', '/roles', '/settings', '/']) {
    assert.ok(routeOn(owner(MODULE_KEYS), r), r)
  }
})

test('модули: пустой список — всё как прежде', () => {
  assert.deepEqual(permissionsOf(owner()), ALL_PERMISSIONS)
  assert.deepEqual(permissionsOf({ role: 'founder' }), ALL_PERMISSIONS)
  assert.equal(can({ role: 'founder' }, 'expiry.view'), true)
  assert.equal(routeOn({ role: 'founder' }, '/expiry'), true)
  assert.equal(moduleOn(null, 'expiry'), true)
})

test('модули: мусор в списке отбрасывается, порядок — как в MODULES', () => {
  assert.deepEqual(cleanModulesOff(['expiry', 'нет-такого', 'dashboard', 'expiry', 5, null]), ['dashboard', 'expiry'])
  assert.deepEqual(cleanModulesOff('expiry'), [])
  assert.deepEqual(cleanModulesOff(undefined), [])
})

test('модули: выключенный «Срок годности» — права нет даже у владельца, раздел закрыт', () => {
  const u = owner(['expiry'])
  assert.equal(can(u, 'expiry.view'), false)
  assert.equal(permissionsOf(u).includes('expiry.view'), false)
  assert.equal(routeOn(u, '/expiry'), false)
  assert.equal(routeOn(u, '/expiry/123'), false)
  assert.equal(routeOn(u, '/expiryX'), true) // не вложенный адрес
  assert.equal(moduleOn(u, 'expiry'), false)
  // Остальное у владельца на месте
  assert.equal(can(u, 'products.view'), true)
  assert.equal(can(u, 'sklad.view'), true)
})

test('модули: право общее для двух модулей пропадает, только когда выключены оба', () => {
  assert.equal(can(owner(['salesReport']), 'reports.view'), true)
  assert.equal(routeOn(owner(['salesReport']), '/sales-report'), false)
  assert.equal(routeOn(owner(['salesReport']), '/reports'), true)
  assert.equal(can(owner(['opu']), 'reports.view'), true)
  assert.equal(can(owner(['salesReport', 'opu']), 'reports.view'), false)
  assert.equal(offPerms(['salesReport', 'opu']).has('reports.export'), true)
  // «Отчёт поставщиков» прав не забирает: «Поставщики» обязательны
  assert.equal(can(owner(['supplierReport']), 'suppliers.view'), true)
  assert.equal(routeOn(owner(['supplierReport']), '/supplier-report'), false)
})

test('модули: кассир теряет права выключенных модулей — «В долг» и «отложить» в кассе', () => {
  const k = kassir(['debts', 'deferred'])
  assert.equal(can(k, 'pos.debt'), false)
  assert.equal(can(k, 'pos.defer'), false)
  assert.equal(can(k, 'pos.defer', 'deferred.manage'), false)
  assert.equal(can(k, 'pos.sell'), true)
  assert.equal(permissionsOf(k).includes('pos.debt'), false)
  // Без возвратов нет и «Отмены чека» (она оформляется возвратом)
  assert.equal(can(kassir(['returns']), 'returns.create'), false)
  // Кассир прежнего сервера без списка прав — те же правила
  assert.equal(can({ role: 'cashier', modulesOff: ['debts'] }, 'pos.debt'), false)
})

test('модули: касса магазина без интернета — правило «только на главном» сохранено', () => {
  const reg = { role: 'founder', register: true, modulesOff: [] }
  assert.equal(can(reg, 'inventory.apply'), false)
  assert.equal(can(reg, 'inventory.view'), true)
  assert.equal(can({ ...reg, modulesOff: ['inventory'] }, 'inventory.view'), false)
  assert.equal(can({ role: 'founder', modulesOff: [] }, 'inventory.apply'), true)
})

test('модули: маска кода активации — туда и обратно', () => {
  assert.equal(modulesMask([]), 0)
  assert.deepEqual(modulesFromMask(0), [])
  const off = ['dashboard', 'expiry', 'obuchenie']
  assert.deepEqual(modulesFromMask(modulesMask(off)), off)
  assert.equal(modulesMask(['dashboard']), 1)
  assert.equal(modulesMask(MODULE_KEYS) >>> 0, 2 ** MODULE_KEYS.length - 1)
})

test('модули: уроки и шаги тура про выключенные разделы не показываются', () => {
  const vse = urokiFor(owner()).map((u) => u.to)
  assert.ok(vse.includes('/expiry'))
  const bez = urokiFor(owner(['expiry', 'debts', 'dashboard'])).map((u) => u.to)
  assert.equal(bez.includes('/expiry'), false)
  assert.equal(bez.includes('/debts'), false)
  assert.equal(bez.includes('/dashboard'), false)
  assert.ok(bez.includes('/pos'))

  // Общий тур: плитки выключенных разделов и кнопка «?» без «Обучения»
  const shagi = stepsFor(OBSHIY, owner(['expiry', 'obuchenie']))
  assert.equal(shagi.some((s) => s.t === 'nav:/expiry'), false)
  assert.equal(shagi.some((s) => s.t === 'nav:/obuchenie'), false)
  assert.equal(shagi.some((s) => s.t === 'app.help'), false)
  assert.ok(stepsFor(OBSHIY, owner()).some((s) => s.t === 'nav:/expiry'))

  // Поле срока в карточке товара и выбор клиента «В долг» — пункты уроков прячутся тоже
  const tovary = OBUCHENIE.find((u) => u.to === '/products')
  const metki = (u, user) => ekranFor(u, user).map(([, , s]) => (typeof s === 'string' ? s : s?.t))
  assert.ok(metki(tovary, owner()).includes('pf.expiry'))
  assert.equal(metki(tovary, owner(['expiry'])).includes('pf.expiry'), false)
  const kassa = OBUCHENIE.find((u) => u.to === '/pos')
  assert.equal(metki(kassa, owner(['debts'])).includes('pos.customer'), false)
  assert.ok(metki(kassa, owner()).includes('pos.customer'))
  // Тур раздела выключенного модуля пуст
  assert.deepEqual(stepsFor('/expiry', owner(['expiry'])), [])
})

test('модули: меню прячет выключенные разделы целиком, маршруты закрыты', () => {
  const layout = read('src/components/Layout.jsx')
  assert.match(layout, /export const navShown = \(user, n\) => routeOn\(user, n\.to\)/)
  assert.match(layout, /export const allowedNav = \(user, n\) => navShown\(user, n\) &&/)
  const home = read('src/pages/Home.jsx')
  assert.match(home, /NAV\.filter\(\(n\) => navShown\(user, n\)\)/)
  const app = read('src/App.jsx')
  assert.match(app, /routeOn\(user, pathname\)/)
  assert.match(app, /path="\/obuchenie" element=\{guarded\(/)
})
