// ── Один список прав на сайт, сервер и программу для Windows ──
//
// Право проверяется в трёх местах: кнопку прячет сайт, запрос отклоняет сервер,
// без интернета — программа для Windows. Списки лежат в трёх файлах на трёх языках
// сборки, и общего модуля у них быть не может. Разойдутся они молча: право, которое
// есть на сайте и которого не знает сервер, — это кнопка, за которой всегда отказ.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_PERMISSIONS, CASHIER_DEFAULT, PERMISSION_GROUPS, can, permissionsOf } from '../src/lib/permissions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// Ключи из исходника сервера — по тексту, как они написаны в каталоге
const серверныеКлючи = () => {
  const src = read('server/src/auth/permissions.ts')
  const start = src.indexOf('export const PERMISSION_GROUPS')
  const end = src.indexOf('\n]', start)
  return [...src.slice(start, end).matchAll(/\['([a-z]+\.[A-Za-z]+)',/g)].map((m) => m[1])
}
const списокИз = (src, name) => {
  // Объявление может нести тип: `export const X: string[] = [`
  const decl = src.indexOf('export const ' + name)
  assert.ok(decl >= 0, `в файле нет списка ${name}`)
  const start = src.indexOf('= [', decl)
  const end = src.indexOf(']', start)
  return [...src.slice(start, end).matchAll(/'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1])
}

test('каталог прав на сайте и на сервере — один и тот же, в том же порядке', () => {
  assert.deepEqual(ALL_PERMISSIONS, серверныеКлючи())
})

test('ключи не повторяются и у каждого есть подпись', () => {
  assert.equal(new Set(ALL_PERMISSIONS).size, ALL_PERMISSIONS.length)
  for (const g of PERMISSION_GROUPS) for (const [key, label] of g.items) assert.ok(label && label.length > 3, `без подписи: ${key}`)
})

test('кассир по умолчанию везде одинаков: сайт, сервер, программа для Windows', () => {
  assert.deepEqual(списокИз(read('server/src/auth/permissions.ts'), 'CASHIER_DEFAULT'), CASHIER_DEFAULT, 'сервер')
  assert.deepEqual(списокИз(read('desktop/src/local/accounts.mjs'), 'CASHIER_DEFAULT'), CASHIER_DEFAULT, 'программа для Windows')
  for (const k of CASHIER_DEFAULT) assert.ok(ALL_PERMISSIONS.includes(k), `кассиру дано несуществующее право ${k}`)
})

test('владелец может всё, кассир без списка — минимум, роль без прав — ничего', () => {
  assert.equal(can({ role: 'founder' }, 'settings.backup'), true)
  assert.equal(can({ role: 'cashier' }, 'pos.sell'), true)
  assert.equal(can({ role: 'cashier' }, 'reports.view'), false)
  assert.equal(can({ role: 'cashier', permissions: [] }, 'pos.sell'), false, 'пустой список — это решение владельца, а не отсутствие данных')
  assert.equal(can({ role: 'cashier', permissions: ['reports.view'] }, 'pos.sell', 'reports.view'), true, 'достаточно любого из перечисленных')
  assert.equal(can(null, 'pos.sell'), false)
  assert.deepEqual(permissionsOf({ role: 'founder' }), ALL_PERMISSIONS)
})

test('разделы меню и маршруты требуют только существующие права', () => {
  const src = read('client/src/components/Layout.jsx') + read('client/src/App.jsx')
  const used = [...src.matchAll(/(?:perm:\s*|guarded\()'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1])
  const нет = used.filter((k) => !ALL_PERMISSIONS.includes(k))
  assert.deepEqual(нет, [], `в меню или маршрутах указано несуществующее право: ${нет.join(', ')}`)
})

test('страницы спрашивают только существующие права', () => {
  // can('ключ') на страницах — опечатка в ключе означала бы вечно спрятанную кнопку
  const dir = join(ROOT, 'client', 'src')
  const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(jsx?|mjs)$/.test(String(f)))
  const нет = new Set()
  for (const f of files) {
    const src = readFileSync(join(dir, String(f)), 'utf8')
    for (const m of src.matchAll(/\bcan\(([^)]*)\)/g)) {
      for (const k of m[1].matchAll(/'([a-z]+\.[A-Za-z]+)'/g)) if (!ALL_PERMISSIONS.includes(k[1])) нет.add(`${f}: ${k[1]}`)
    }
  }
  assert.deepEqual([...нет], [])
})
