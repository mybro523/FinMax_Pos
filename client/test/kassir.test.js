// ── Кассир (1.5.5): касса сразу после входа, «Меню» окном, свой общий тур ──
//
// Сотрудник со встроенной ролью «Кассир» плиток главного меню не видит: после входа сразу
// касса, «Меню» внизу — окно со списком его разделов. Кто кассир — по слову сервера
// (roleSystem), а не по имени роли: имя владелец может сменить. Общий тур для кассира —
// без шагов про главный экран, а шаг про «Меню» — своими словами.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { isKassir, kassaFirst, CASHIER_DEFAULT } from '../src/lib/permissions.js'
import { stepsFor } from '../src/lib/tury.js'
import { OBSHIY } from '../src/lib/tur.js'

const owner = { role: 'founder', roleSystem: 'owner' }
const kassir = { role: 'cashier', roleSystem: 'cashier', roleName: 'Кассир', permissions: CASHIER_DEFAULT }
const renamed = { ...kassir, roleName: 'Продавец' }
const senior = { role: 'cashier', roleSystem: null, roleName: 'Старший', permissions: ['pos.sell', 'returns.view'] }
const oldServer = { role: 'cashier', roleName: 'Кассир', permissions: CASHIER_DEFAULT }
const noKassa = { role: 'cashier', roleSystem: 'cashier', permissions: ['shift.view'] }

test('кассир — только встроенная роль «Кассир» (по слову сервера, не по имени роли)', () => {
  assert.equal(isKassir(kassir), true)
  assert.equal(isKassir(renamed), true, 'владелец переименовал роль — она всё та же «Кассир»')
  assert.equal(isKassir(owner), false)
  assert.equal(isKassir(senior), false, 'своя роль владельца — обычное меню')
  assert.equal(isKassir(oldServer), false, 'сервер прежней версии роль не называет — обычное меню')
  assert.equal(isKassir(null), false)
})

test('касса сразу после входа — кассиру, у которого касса открыта', () => {
  assert.equal(kassaFirst(kassir), true)
  assert.equal(kassaFirst(renamed), true)
  assert.equal(kassaFirst(owner), false)
  assert.equal(kassaFirst(senior), false)
  assert.equal(kassaFirst(noKassa), false, 'владелец закрыл кассу для роли — обычное меню, иначе кассиру некуда попасть')
})

test('общий тур кассира — без главного экрана, «Меню» — своими словами', () => {
  const own = stepsFor(OBSHIY, owner)
  const mine = stepsFor(OBSHIY, kassir)
  assert.ok(own.some((s) => s.to === '/'), 'у владельца тур показывает главный экран')
  assert.deepEqual(mine.filter((s) => s.to === '/'), [], 'кассиру тур не ведёт на главный экран — его там нет')
  const menu = mine.find((s) => s.t === 'app.menu')
  assert.ok(menu, 'шаг про «Меню» у кассира есть')
  assert.match(menu.text, /список ваших разделов/)
  assert.doesNotMatch(menu.text, /плитками/)
  assert.equal(mine[0].title, own[0].title, 'начинается с того же приветствия')
  assert.ok(mine.length >= 3, `в туре кассира ${mine.length} шагов`)
  // У остальных сотрудников шаг про «Меню» прежний
  assert.match(stepsFor(OBSHIY, senior).find((s) => s.t === 'app.menu').text, /плитками/)
})
