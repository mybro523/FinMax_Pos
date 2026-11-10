// ── «Чеки»: отбор по виду чека (1.7.2) ──
// Отменённые, с возвратом, без возвратов, со скидкой — по тем же строкам, что строит
// spisokChekov (вкладка «Чеки» отчёта продаж).
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { chekVida, spisokChekov, VIDY_CHEKOV } from '../src/lib/otchety.js'

const sale = (id, total, discount = 0) => ({
  id, date: '2026-11-05T10:00:00Z', total, payment: 'cash',
  items: [{ productId: 'p', name: 'Товар', qty: 1, price: total + discount, discount }],
})

test('вид чека: отменённый, с возвратом, без возвратов, со скидкой', () => {
  const sales = [sale('plain', 100), sale('ret', 200), sale('off', 300), sale('disc', 90, 10), sale('discOff', 50, 5)]
  const returns = [
    { id: 'r1', saleId: 'ret', total: 50, note: '' },
    { id: 'r2', saleId: 'off', total: 300, note: 'Отмена чека' },
    { id: 'r3', saleId: 'discOff', total: 50, note: 'Отмена чека' },
  ]
  const { rows } = spisokChekov({ sales, returns, from: new Date('2026-11-01'), to: new Date('2026-11-30') })
  const ids = (vid) => rows.filter((r) => chekVida(r, vid)).map((r) => r.id).sort()
  assert.deepEqual(ids(''), ['disc', 'discOff', 'off', 'plain', 'ret'])
  assert.deepEqual(ids('otmena'), ['discOff', 'off'])
  assert.deepEqual(ids('vozvrat'), ['ret'])
  assert.deepEqual(ids('chistye'), ['disc', 'plain'])
  // Скидка — отдельный признак: и отменённый со скидкой виден (с отметкой «Отменён»)
  assert.deepEqual(ids('skidka'), ['disc', 'discOff'])
})

test('у каждого вида есть подпись, «Все чеки» — первым', () => {
  assert.equal(VIDY_CHEKOV[0].key, '')
  assert.ok(VIDY_CHEKOV.every((v) => v.label))
  assert.equal(chekVida({}, 'неизвестно'), true)
})
