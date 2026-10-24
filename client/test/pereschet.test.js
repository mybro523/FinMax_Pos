// ── Лист пересчёта на экране ──
//
// Лист считают часами и с разных устройств. Здесь проверяется всё, что решается без
// браузера: какие строки уходят на сервер, что остаётся на устройстве, пока сервер не
// принял, и как страница понимает, что применён не тот лист, который был на экране.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'

// Заглушка хранилища браузера — с length и key(), как у настоящего
function makeStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _keys: () => [...map.keys()],
  }
}
globalThis.localStorage = makeStorage()

const {
  MAX_DIGITS, countOf, shownOf, retype, deltaOf, merged, settle, sameCounts, tally,
  readDraft, writeDraft, dropDraft, closeDraft,
} = await import('../src/lib/pereschet.js')

// Страницу перезагрузили: память пуста, осталось только хранилище браузера
let reloads = 0
const afterReload = () => import('../src/lib/pereschet.js?reload=' + ++reloads)

const DAY = 86400000
const line = (id, expectedUnits, actualUnits = null, extra = {}) => ({ id, productId: 'p-' + id, name: 'Товар ' + id, expectedUnits, actualUnits, cost: '120', ...extra })
const sheetOf = (id, items, status = 'draft') => ({ id, status, scope: 'all', items })

test('пустое поле — «не считали», а не ноль', () => {
  assert.equal(countOf(''), null)
  assert.equal(countOf(undefined), null)
  assert.equal(countOf(null), null)
  assert.equal(countOf('0'), 0)
  assert.equal(countOf('007'), 7)
  assert.equal(countOf('12'), 12)
})

test('в поле — своё, если строку здесь меняли, иначе то, что лежит на сервере', () => {
  assert.equal(shownOf(line('a', 10, 5), {}), '5')
  assert.equal(shownOf(line('a', 10, null), {}), '')
  assert.equal(shownOf(line('a', 10, 0), {}), '0', 'насчитанный ноль виден как ноль')
  assert.equal(shownOf(line('a', 10, 5), { a: '8' }), '8')
  assert.equal(shownOf(line('a', 10, 5), { a: '' }), '', 'число стёрли — поле пустое, а не прежнее')
})

test('изменённой считается только строка, где стоит не то, что на сервере', () => {
  const a = line('a', 10, 5)
  const empty = line('b', 10, null)
  assert.deepEqual(retype({}, a, '8'), { a: '8' })
  assert.deepEqual(retype({ a: '8' }, a, '5'), {}, 'вернули то, что и так на сервере, — слать нечего')
  assert.deepEqual(retype({ a: '8' }, a, '05'), {}, '«05» — те же пять')
  assert.deepEqual(retype({}, a, ''), { a: '' }, 'стёрли число, лежащее на сервере, — это изменение')
  // Набрали и стёрли в пустой строке — как будто не трогали
  assert.deepEqual(retype(retype({}, empty, '3'), empty, ''), {})
  assert.deepEqual(retype({}, empty, '0'), { b: '0' }, 'ноль в несчитанной строке — изменение')
  // Прежний набор не портится
  const before = { a: '8' }
  retype(before, a, '9')
  assert.deepEqual(before, { a: '8' })
})

test('на сервер уходят только строки, изменённые здесь', () => {
  const sheet = sheetOf('s1', [line('a', 10), line('b', 10, 4), line('c', 10)])
  assert.deepEqual(deltaOf(sheet, {}), [])
  assert.deepEqual(deltaOf(sheet, { a: '7', b: '' }), [{ id: 'a', actualUnits: 7 }, { id: 'b', actualUnits: null }])
  // Строки не из этого листа никуда не уходят
  assert.deepEqual(deltaOf(sheet, { chuzhaya: '9' }), [])
  assert.deepEqual(deltaOf(null, { a: '1' }), [])
})

test('вкладка, открытая с утра, не стирает то, что за день насчитали с другого устройства', () => {
  // Утром лист был пуст — таким вкладка его и помнит
  const morning = sheetOf('s1', Array.from({ length: 200 }, (_, n) => line('r' + n, 10)))
  // Днём с телефона насчитали все двести строк. Вкладка об этом не знает; в ней
  // ввели пять чисел и нажали «Применить»
  let typed = {}
  for (let n = 0; n < 5; n++) typed = retype(typed, morning.items[n], String(n + 1))
  const sent = deltaOf(morning, typed)
  assert.equal(sent.length, 5, 'ушло пять строк, а не двести')
  assert.ok(sent.every((row) => row.actualUnits !== null), 'ни одна чужая строка пустотой не затёрта')
  assert.deepEqual(sent.map((row) => row.id), ['r0', 'r1', 'r2', 'r3', 'r4'])
})

test('лист на экране: числа с сервера и введённое поверх', () => {
  const sheet = sheetOf('s1', [line('a', 10, 4), line('b', 10, 6), line('c', 10)])
  const seen = merged(sheet, { a: '9', b: '' })
  assert.deepEqual(seen.items.map((i) => i.actualUnits), [9, null, null])
  assert.equal(seen.id, 's1')
  assert.deepEqual(sheet.items.map((i) => i.actualUnits), [4, 6, null], 'лист с сервера не тронут')
})

test('итог листа: недостача, излишек и её стоимость по штукам', () => {
  // Пачка из 20 штук за 120 — штука стоит 6
  const products = [{ id: 'p-a', unitsPerPack: 20 }, { id: 'p-b', unitsPerPack: 1 }]
  const sheet = sheetOf('s1', [line('a', 50, 45), line('b', 10, 12), line('c', 7, 7), line('d', 3)])
  const sum = tally(sheet, products)
  assert.equal(sum.counted, 3, 'несчитанная строка в итог не входит')
  assert.deepEqual(sum.shortage.map((d) => [d.id, d.diff]), [['a', -5]])
  assert.deepEqual(sum.surplus.map((d) => [d.id, d.diff]), [['b', 2]])
  assert.equal(sum.shortageCost, 30)
  assert.equal(tally(null, products).counted, 0)
})

test('итог листа: две строки одного товара (карточки объединили) — как один товар, как у сервера', () => {
  const products = [{ id: 'p-a', unitsPerPack: 1 }]
  // «Основная» — 5 по учёту, «лишняя» — 3; насчитали 9 в основной, лишнюю не считали
  const sheet = sheetOf('s1', [line('a', 5, 9), line('a2', 3, null, { productId: 'p-a' })])
  const sum = tally(sheet, products)
  assert.equal(sum.counted, 1)
  assert.deepEqual(sum.surplus.map((d) => [d.id, d.diff]), [['a', 1]])
  // Насчитали в обеих: 6 + 1 = 7 против 8 — недостача 1
  const both = tally(sheetOf('s1', [line('a', 5, 6), line('a2', 3, 1, { productId: 'p-a' })]), products)
  assert.deepEqual(both.shortage.map((d) => [d.id, d.diff]), [['a', -1]])
})

test('сервер принял сохранение: из «введённого здесь» уходит только то, что с отправки не меняли', () => {
  const sent = { a: '7', b: '3' }
  // Пока запрос шёл, в строке b исправили число и ввели новую строку c
  const now = { a: '7', b: '4', c: '1' }
  assert.deepEqual(settle(now, sent), { b: '4', c: '1' })
  assert.deepEqual(settle(sent, sent), {})
  assert.deepEqual(now, { a: '7', b: '4', c: '1' })
})

test('применён тот ли лист, что был на экране', () => {
  const wanted = sheetOf('s1', [line('a', 10, 7), line('b', 10, null), line('c', 10, 0)])
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 10, 7), line('b', 10, null), line('c', 10, 0)], 'applied')), true)
  // Опечатку исправили, а применён лист с ней: 70 вместо 7
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 10, 70), line('b', 10, null), line('c', 10, 0)], 'applied')), false)
  // С другого устройства успели внести число в строку, которую здесь не трогали
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 10, 7), line('b', 10, 4), line('c', 10, 0)], 'applied')), false)
  // «Не считали» и «насчитали ноль» — разное
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 10, 7), line('b', 10, null), line('c', 10, null)], 'applied')), false)
  // Строки на сервере нет вовсе
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 10, 7)], 'applied')), false)
  // «По учёту» сервер при применении переписывает — на сверку это не влияет
  assert.equal(sameCounts(wanted, sheetOf('s1', [line('a', 3, 7), line('b', 8, null), line('c', 1, 0)], 'applied')), true)
})

test('введённое лежит на устройстве и переживает перезагрузку страницы', async () => {
  writeDraft('s-keep', { a: '7', b: '' })
  assert.deepEqual(readDraft('s-keep'), { a: '7', b: '' })
  assert.ok(localStorage.getItem('apteka_inv_s-keep'))
  const page = await afterReload()
  assert.deepEqual(page.readDraft('s-keep'), { a: '7', b: '' })
  // У каждого листа — своё
  assert.deepEqual(page.readDraft('s-drugoy'), {})
})

test('сервер всё принял — на устройстве по листу ничего не остаётся', async () => {
  writeDraft('s-done', { a: '7' })
  writeDraft('s-done', {})
  assert.deepEqual(readDraft('s-done'), {})
  assert.equal(localStorage.getItem('apteka_inv_s-done'), null)
  writeDraft('s-done', { a: '7' })
  dropDraft('s-done')
  assert.equal(localStorage.getItem('apteka_inv_s-done'), null)
  assert.deepEqual((await afterReload()).readDraft('s-done'), {})
})

test('мусор в хранилище браузера за введённое не принимается', async () => {
  localStorage.setItem('apteka_inv_s-bad1', '{не json')
  localStorage.setItem('apteka_inv_s-bad2', JSON.stringify({ at: 1, typed: ['7'] }))
  localStorage.setItem('apteka_inv_s-bad3', JSON.stringify({ at: 1, typed: { a: 7, b: '-3', c: '1e9', d: '12', e: '1'.repeat(MAX_DIGITS + 1), f: '' } }))
  const page = await afterReload()
  assert.deepEqual(page.readDraft('s-bad1'), {})
  assert.deepEqual(page.readDraft('s-bad2'), {})
  assert.deepEqual(page.readDraft('s-bad3'), { d: '12', f: '' }, 'остаются только строки цифр не длиннее поля')
  for (const id of ['s-bad1', 's-bad2', 's-bad3']) localStorage.removeItem('apteka_inv_' + id)
})

test('хранилище браузера недоступно (приватный режим) — введённое живёт, пока открыта страница', async () => {
  const real = globalThis.localStorage
  const broken = () => {
    throw new Error('хранилище запрещено')
  }
  globalThis.localStorage = { get length() { return broken() }, key: broken, getItem: broken, setItem: broken, removeItem: broken }
  try {
    const page = await afterReload()
    assert.deepEqual(page.readDraft('s-priv'), {})
    page.writeDraft('s-priv', { a: '5' })
    assert.deepEqual(page.readDraft('s-priv'), { a: '5' })
    assert.deepEqual(page.pruneDrafts([]), [])
    assert.deepEqual(page.readDraft('s-priv'), { a: '5' })
    page.dropDraft('s-priv')
    assert.deepEqual(page.readDraft('s-priv'), {})
  } finally {
    globalThis.localStorage = real
  }
})

test('лист применён: введённое на устройстве убирается; не попало в лист — об этом надо сказать', () => {
  // Применено ровно то, что было введено (ответ на применение потерялся) — молча
  writeDraft('s-same', { a: '7' })
  assert.equal(closeDraft(sheetOf('s-same', [line('a', 10, 7), line('b', 10, 2)], 'applied')), false)
  assert.deepEqual(readDraft('s-same'), {})
  // Число исправили уже после того, как лист применился, — оно в него не попало
  writeDraft('s-late', { a: '7' })
  assert.equal(closeDraft(sheetOf('s-late', [line('a', 10, 70)], 'applied')), true)
  assert.deepEqual(readDraft('s-late'), {})
  // На устройстве ничего не было — и говорить не о чем
  assert.equal(closeDraft(sheetOf('s-none', [line('a', 10, 70)], 'applied')), false)
})

test('разбор введённого по списку листов: применённые — убрать, чужие — не трогать, забытые — убрать', async () => {
  const now = Date.UTC(2026, 9, 5)
  writeDraft('s-applied-same', { a: '7' }, now)
  writeDraft('s-applied-other', { a: '7' }, now)
  writeDraft('s-draft', { a: '3' }, now)
  writeDraft('s-chuzhoy', { a: '4' }, now) // лист другого магазина в этом же браузере
  writeDraft('s-zabyty', { a: '5' }, now - 61 * DAY)
  writeDraft('s-idet', { a: '6' }, now) // применяется прямо сейчас
  const list = [
    sheetOf('s-applied-same', [line('a', 10, 7)], 'applied'),
    sheetOf('s-applied-other', [line('a', 10, 70)], 'applied'),
    sheetOf('s-draft', [line('a', 10)]),
    sheetOf('s-idet', [line('a', 10, 60)], 'applied'),
  ]
  // После перезагрузки страницы всё то же самое: разбор идёт по хранилищу браузера
  const page = await afterReload()
  const missed = page.pruneDrafts(list, { skip: new Set(['s-idet']), now })
  assert.deepEqual(missed.map((s) => s.id), ['s-applied-other'], 'сказать надо только о листе, применённом с другими числами')
  assert.deepEqual(page.readDraft('s-applied-same'), {})
  assert.deepEqual(page.readDraft('s-applied-other'), {})
  assert.deepEqual(page.readDraft('s-draft'), { a: '3' }, 'неприменённый лист — введённое на месте')
  assert.deepEqual(page.readDraft('s-chuzhoy'), { a: '4' }, 'листа нет в списке — возможно, он другого магазина')
  assert.deepEqual(page.readDraft('s-zabyty'), {}, 'два месяца не возвращались')
  assert.deepEqual(page.readDraft('s-idet'), { a: '6' }, 'судьбу листа, который применяется сейчас, решает ответ на применение')
  assert.equal(localStorage.getItem('apteka_inv_s-zabyty'), null)
  assert.equal(localStorage.getItem('apteka_inv_s-applied-other'), null)
  // Второй разбор ничего нового не находит
  assert.deepEqual(page.pruneDrafts(list, { skip: new Set(['s-idet']), now }), [])
})
