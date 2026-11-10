// ── Авто-заявка: поставщик товара и отбор (1.7.2) ──
//
// Поставщик товара — по последнему приходу, где он указан: и с сервера (за всё время), и
// из журнала приходов устройства (там же приходы, которых сервер ещё не видел). Отбор —
// поиск, поставщик, категория.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { poiskZapros } from '../src/lib/poisk.js'
import {
  BEZ_POSTAVSHIKA, otborZayavki, postavshikiTovarov, postavshikKey, sPostavshikom, spisokKategoriy, spisokPostavshikov,
} from '../src/lib/zayavka.js'

const suppliers = [
  { id: 's1', name: 'Фарма Плюс' },
  { id: 's2', name: 'Дору' },
]

test('поставщик товара — последний приход, где он указан', () => {
  const arrivals = [
    { date: '2026-11-01T10:00:00Z', supplierId: 's1', supplier: 'Фарма Плюс', items: [{ productId: 'a' }, { productId: 'b' }] },
    { date: '2026-11-05T10:00:00Z', supplierId: 's2', supplier: 'Дору', items: [{ productId: 'a' }] },
    // Поставщика не выбрали — такой приход поставщика не меняет
    { date: '2026-11-09T10:00:00Z', supplierId: null, supplier: '—', items: [{ productId: 'a' }, { productId: 'c' }] },
  ]
  const map = postavshikiTovarov({ arrivals, suppliers })
  assert.equal(map.get('a').name, 'Дору')
  assert.equal(map.get('a').key, postavshikKey('s2'))
  assert.equal(map.get('b').name, 'Фарма Плюс')
  assert.equal(map.has('c'), false)
})

test('сервер знает давние приходы, устройство — ещё не отправленные: побеждает более поздний', () => {
  const server = [
    { productId: 'a', supplierId: 's1', supplier: 'Фарма Плюс', date: '2026-01-01T00:00:00Z' },
    { productId: 'old', supplierId: 's1', supplier: 'Фарма Плюс', date: '2025-03-01T00:00:00Z' },
  ]
  const arrivals = [{ date: '2026-11-10T08:00:00Z', supplierId: 's2', supplier: 'Дору', items: [{ productId: 'a' }] }]
  const map = postavshikiTovarov({ arrivals, server, suppliers })
  assert.equal(map.get('a').name, 'Дору')
  // Товар, приходивший больше полугода назад: журнала у устройства уже нет — знает сервер
  assert.equal(map.get('old').name, 'Фарма Плюс')
})

test('имя — нынешнее из справочника; поставщика удалили — отбор по имени из прихода', () => {
  const arrivals = [
    { date: '2026-11-01T00:00:00Z', supplierId: 's1', supplier: 'Старое имя', items: [{ productId: 'a' }] },
    { date: '2026-11-01T00:00:00Z', supplierId: 'gone', supplier: 'Закрылся', items: [{ productId: 'b' }] },
    { date: '2026-11-02T00:00:00Z', supplierId: null, supplier: 'Без справочника', items: [{ productId: 'c' }] },
  ]
  const map = postavshikiTovarov({ arrivals, suppliers })
  assert.equal(map.get('a').name, 'Фарма Плюс')
  assert.equal(map.get('b').key, postavshikKey(null, 'Закрылся'))
  assert.equal(map.get('c').key, postavshikKey(null, 'без справочника'))
})

test('строки заявки: поставщик, отбор по поставщику, категории и поиску', () => {
  const low = [
    { id: 'a', name: 'Анальгин 500мг', barcode: '4870204010022', category: 'Анальгетики', cost: 10, need: 5 },
    { id: 'b', name: 'Аугментин', barcode: '4870204010107', category: 'Антибиотики', cost: 20, need: 2 },
    { id: 'c', name: 'Масло для волос', barcode: '8964000114001', category: 'Кремы', cost: 0, need: 5 },
  ]
  const map = postavshikiTovarov({
    arrivals: [
      { date: '2026-11-01T00:00:00Z', supplierId: 's1', supplier: 'Фарма Плюс', items: [{ productId: 'a' }, { productId: 'b' }] },
    ],
    suppliers,
  })
  const rows = sPostavshikom(low, map)
  assert.equal(rows[0].supplier, 'Фарма Плюс')
  assert.equal(rows[2].supplierKey, BEZ_POSTAVSHIKA)
  assert.equal(rows[2].supplier, '')

  assert.deepEqual(otborZayavki(rows, { sup: postavshikKey('s1') }).map((r) => r.id), ['a', 'b'])
  assert.deepEqual(otborZayavki(rows, { sup: BEZ_POSTAVSHIKA }).map((r) => r.id), ['c'])
  assert.deepEqual(otborZayavki(rows, { cat: 'Антибиотики' }).map((r) => r.id), ['b'])
  assert.deepEqual(otborZayavki(rows, { z: poiskZapros('анальг') }).map((r) => r.id), ['a'])
  // Штрихкод — кусок цифр или целиком, как со сканера
  assert.deepEqual(otborZayavki(rows, { z: poiskZapros('010107') }).map((r) => r.id), ['b'])
  assert.deepEqual(otborZayavki(rows, { z: poiskZapros('ау'), sup: postavshikKey('s1'), cat: 'Анальгетики' }).map((r) => r.id), [])
  assert.equal(otborZayavki(rows, {}).length, 3)

  const sups = spisokPostavshikov(rows)
  assert.deepEqual(sups.list, [{ key: postavshikKey('s1'), name: 'Фарма Плюс', count: 2 }])
  assert.equal(sups.none, 1)
  assert.deepEqual(spisokKategoriy(rows).map((c) => c.name), ['Анальгетики', 'Антибиотики', 'Кремы'])
})

test('приход прежней версии без ссылки, но с именем из справочника — тот же поставщик', () => {
  const map = postavshikiTovarov({
    arrivals: [
      { date: '2026-10-01T00:00:00Z', supplierId: null, supplier: 'фарма плюс ', items: [{ productId: 'old' }] },
      { date: '2026-11-01T00:00:00Z', supplierId: 's1', supplier: 'Фарма Плюс', items: [{ productId: 'new' }] },
    ],
    server: [{ productId: 'srv', supplierId: null, supplier: 'Дору', date: '2026-01-01T00:00:00Z' }],
    suppliers,
  })
  assert.equal(map.get('old').key, map.get('new').key)
  assert.equal(map.get('old').name, 'Фарма Плюс')
  assert.equal(map.get('srv').key, postavshikKey('s2'))
  const rows = sPostavshikom([{ id: 'old' }, { id: 'new' }], map)
  assert.deepEqual(spisokPostavshikov(rows).list, [{ key: postavshikKey('s1'), name: 'Фарма Плюс', count: 2 }])
})

test('битые записи не ломают расчёт', () => {
  const map = postavshikiTovarov({ arrivals: [null, { items: null }, { date: 'x', supplier: 'А', items: [null, {}] }], server: 'не список' })
  assert.equal(map.size, 0)
})
