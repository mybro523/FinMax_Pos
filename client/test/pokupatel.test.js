// ── Экран покупателя на сайте (1.7.5) ──
// Страница окна покупателя сайта (public/pokupatel) показывает то же, что программа для
// Windows: её оформление и разбор присланного — копии desktop/src/screen. Копии не должны
// разойтись с программой молча
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

test('окно покупателя сайта — те же customer.js и customer.css, что в программе', () => {
  for (const f of ['customer.js', 'customer.css']) {
    assert.equal(read(`client/public/pokupatel/${f}`), read(`desktop/src/screen/${f}`), f)
  }
})

test('страница окна покупателя подключает мост сайта раньше разбора', () => {
  const html = read('client/public/pokupatel/index.html')
  assert.ok(html.indexOf('web-bridge.js') > 0 && html.indexOf('web-bridge.js') < html.indexOf('customer.js'))
  for (const id of ['screen', 'items', 'total', 'thanks', 'change', 'idle-shop']) assert.ok(html.includes(`id="${id}"`), id)
})
