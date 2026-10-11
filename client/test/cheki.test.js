// ── Открытые чеки, сдача и купюры ──
//
// Чек лежит на устройстве и переживает перезагрузку, а товар за это время живёт
// своей жизнью: его продаёт другая касса, владелец меняет цену. Здесь проверяется
// всё, что считается без браузера: разбор сохранённого, сверка чека с базой,
// сдача до дирама и подсказка купюр.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CHEKOV, klyuch, novyChek, svobodnyNomer, razobrat, chitat, pisat,
  osvezhit, sdacha, kupyury, pohozheNaKod, estBukva,
} from '../src/lib/cheki.js'

// Пачка из 20 таблеток по 200 сомони, на складе 3 упаковки и 5 штук
const pill = { id: 'p1', name: 'Парацетамол', price: 200, cost: 120, unitsPerPack: 20, unit: 'уп', stock: 3, looseUnits: 5 }
// Неделимый бинт
const bint = { id: 'p2', name: 'Бинт', price: 40, cost: 18, unitsPerPack: 1, unit: 'шт', stock: 10, looseUnits: 0 }

const line = (p, extra = {}) => ({
  productId: p.id, name: p.name, price: p.price, cost: p.cost, unitsPerPack: p.unitsPerPack,
  unit: p.unit, stock: p.stock, looseUnits: p.looseUnits, qty: 1, pieces: 0, discount: 0, ...extra,
})

// ── Хранение ──

test('у каждой аптеки свой ключ — чеки одной не видны другой в том же браузере', () => {
  assert.notEqual(klyuch('alfa'), klyuch('beta'))
  assert.equal(klyuch('alfa'), 'apteka_cheki_alfa')
  // Код неизвестен (вход ещё не завершён) — всё равно не общий ключ с аптекой
  assert.equal(klyuch(''), 'apteka_cheki_net')
})

test('новый чек пуст и платится наличными', () => {
  const c = novyChek(3)
  assert.equal(c.n, 3)
  assert.deepEqual(c.cart, [])
  assert.equal(c.payment, 'cash')
  assert.equal(c.customerId, '')
  assert.equal(c.received, '')
  assert.notEqual(novyChek(1).id, novyChek(1).id, 'у двух чеков совпал номер записи')
})

test('номер нового чека — наименьший свободный', () => {
  assert.equal(svobodnyNomer([]), 1)
  assert.equal(svobodnyNomer([{ n: 1 }, { n: 2 }]), 3)
  // Чек 2 закрыли — следующий снова «Чек 2», а не «Чек 4»
  assert.equal(svobodnyNomer([{ n: 1 }, { n: 3 }]), 2)
})

test('мусор в хранилище не роняет кассу — открывается один пустой чек', () => {
  for (const raw of [null, undefined, '', 'не json', '{"list":5}', '[]', '{"list":[null,7,"x",{"cart":"нет"}]}']) {
    const r = razobrat(raw)
    assert.equal(r.list.length, 1, `на входе ${raw}`)
    assert.deepEqual(r.list[0].cart, [])
    assert.equal(r.active, r.list[0].id)
  }
})

test('сохранённые чеки читаются обратно без потерь', () => {
  const a = { ...novyChek(1), cart: [line(pill, { qty: 2, pieces: 3, discount: 15 })], payment: 'debt', customerId: 'k1' }
  const b = { ...novyChek(2), cart: [line(bint)], received: '100' }
  const r = razobrat(JSON.stringify({ list: [a, b], active: b.id }))
  assert.equal(r.list.length, 2)
  assert.equal(r.active, b.id)
  assert.deepEqual(r.list[0], a)
  assert.deepEqual(r.list[1], b)
})

test('испорченные поля чека приводятся к допустимым', () => {
  const r = razobrat({
    active: 'нет такого',
    list: [
      { id: 'a', n: 2, payment: 'биткоин', customerId: 7, received: 5, cart: [
        { productId: 'p1', name: 'X', price: '200', qty: -3, pieces: 2.9, discount: -10, unitsPerPack: 0 },
        { productId: '', name: 'без товара' },
        null,
      ] },
      { id: 'a', n: 2, cart: [] }, // повтор и номера записи, и номера чека
      { id: 'c', n: 0, cart: [] },
    ],
  })
  assert.equal(r.list.length, 3)
  // Отсортированы по номеру, номера не повторяются
  assert.deepEqual(r.list.map((c) => c.n), [1, 2, 3])
  assert.equal(new Set(r.list.map((c) => c.id)).size, 3, 'номера записей совпали')
  const first = r.list.find((c) => c.id === 'a')
  assert.equal(first.payment, 'cash')
  assert.equal(first.customerId, '')
  assert.equal(first.received, '')
  assert.equal(first.cart.length, 1, 'строки без товара должны отсеяться')
  assert.deepEqual(
    { qty: first.cart[0].qty, pieces: first.cart[0].pieces, discount: first.cart[0].discount, upp: first.cart[0].unitsPerPack, price: first.cart[0].price },
    { qty: 0, pieces: 2, discount: 0, upp: 1, price: 200 },
  )
  // Активного чека с таким номером нет — активным становится первый
  assert.equal(r.active, r.list[0].id)
})

test('чеков не больше предела даже в подправленном руками хранилище', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, n: i + 1, cart: [] }))
  assert.ok(razobrat({ list }).list.length <= MAX_CHEKOV + 1)
})

test('запись и чтение через хранилище браузера', () => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  try {
    const c = { ...novyChek(1), cart: [line(pill)] }
    pisat('alfa', { list: [c], active: c.id, code: 'alfa' })
    assert.ok(store.has('apteka_cheki_alfa'))
    // Лишнее поле состояния в хранилище не пишется
    assert.equal(JSON.parse(store.get('apteka_cheki_alfa')).code, undefined)
    assert.deepEqual(chitat('alfa').list[0].cart, c.cart)
    // У другой аптеки своих чеков нет
    assert.deepEqual(chitat('beta').list[0].cart, [])
  } finally {
    delete globalThis.localStorage
  }
})

test('хранилище недоступно (приватный режим) — касса работает с пустым чеком', () => {
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => { throw new Error('QuotaExceededError') },
  }
  try {
    assert.equal(chitat('alfa').list.length, 1)
    assert.doesNotThrow(() => pisat('alfa', { list: [novyChek(1)], active: 'x' }))
  } finally {
    delete globalThis.localStorage
  }
})

// ── Сверка чека с базой ──

test('ничего не изменилось — чек возвращается тем же самым, без заметок', () => {
  const cart = [line(pill), line(bint, { qty: 2 })]
  const r = osvezhit(cart, [pill, bint])
  assert.equal(r.changed, false)
  assert.equal(r.cart, cart, 'чек пересобрали без причины — страница перерисовалась бы зря')
  assert.deepEqual(r.notes, [])
})

test('цена изменилась — чек берёт новую и говорит об этом', () => {
  const cart = [line(pill)]
  const r = osvezhit(cart, [{ ...pill, price: 250 }])
  assert.equal(r.changed, true)
  assert.equal(r.cart[0].price, 250)
  assert.deepEqual(r.notes, [{ kind: 'price', name: 'Парацетамол', was: 200, now: 250 }])
})

test('товара осталось меньше, чем в чеке, — количество урезается', () => {
  // Набрано 3 упаковки (60 штук), а другая касса продала: осталась 1 упаковка и 5 штук
  const cart = [line(pill, { qty: 3 })]
  const r = osvezhit(cart, [{ ...pill, stock: 1, looseUnits: 5 }])
  assert.equal(r.changed, true)
  assert.equal(r.cart[0].qty, 1)
  assert.equal(r.cart[0].pieces, 0)
  assert.deepEqual(r.notes, [{ kind: 'stock', name: 'Парацетамол', avail: 25 }])
})

test('товар закончился совсем — строка уходит из чека', () => {
  const cart = [line(pill), line(bint)]
  const r = osvezhit(cart, [{ ...pill, stock: 0, looseUnits: 0 }, bint])
  assert.equal(r.cart.length, 1)
  assert.equal(r.cart[0].productId, 'p2')
  assert.deepEqual(r.notes, [{ kind: 'out', name: 'Парацетамол' }])
})

test('весь остаток просрочен — для кассы это то же, что товара нет', () => {
  const cart = [line(pill)]
  const r = osvezhit(cart, [{ ...pill, expiredUnits: 65 }])
  assert.equal(r.cart.length, 0)
  assert.equal(r.notes[0].kind, 'out')
})

test('товар удалили из базы — строка уходит, название берётся из чека', () => {
  const r = osvezhit([line(pill)], [bint])
  assert.equal(r.cart.length, 0)
  assert.deepEqual(r.notes, [{ kind: 'gone', name: 'Парацетамол' }])
})

test('пустую строку, которую кассир сам довёл до нуля, сверка не трогает', () => {
  // «0 упаковок, 0 штук» — шаг на пути к «0 упаковок, 3 штуки» из последней пачки
  const cart = [line(pill, { qty: 0, pieces: 0 })]
  const r = osvezhit(cart, [pill])
  assert.equal(r.changed, false)
  assert.equal(r.cart.length, 1)
})

test('в карточке поменяли «штук в упаковке» — набранное пересчитывается через штуки', () => {
  // Было 20 в упаковке, набрано 1 уп + 5 шт = 25 штук. Стало 10 в упаковке: 2 уп + 5 шт
  const cart = [line(pill, { qty: 1, pieces: 5 })]
  const r = osvezhit(cart, [{ ...pill, unitsPerPack: 10, stock: 10, looseUnits: 0 }])
  assert.equal(r.cart[0].unitsPerPack, 10)
  assert.equal(r.cart[0].qty, 2)
  assert.equal(r.cart[0].pieces, 5)
})

test('скидка не остаётся больше суммы позиции после урезания', () => {
  // 3 упаковки по 200 со скидкой 500; осталась 1 упаковка — скидка не больше 200
  const cart = [line(pill, { qty: 3, discount: 500 })]
  const r = osvezhit(cart, [{ ...pill, stock: 1, looseUnits: 0 }])
  assert.equal(r.cart[0].qty, 1)
  assert.equal(r.cart[0].discount, 200)
})

test('временный номер только что заведённого товара меняется на настоящий без заметок', () => {
  const cart = [line({ ...pill, id: 'tmp-1' })]
  const r = osvezhit(cart, [pill], (id) => (id === 'tmp-1' ? 'p1' : id))
  assert.equal(r.changed, true)
  assert.equal(r.cart[0].productId, 'p1')
  assert.deepEqual(r.notes, [], 'подмена номера — не событие для кассира')
})

test('список товаров отстал от подмены номера — товар не считается удалённым', () => {
  // Сервер уже ответил (номер подменён), а список на экране ещё со старым номером
  const tmp = { ...pill, id: 'tmp-1' }
  const r = osvezhit([line(tmp)], [tmp], (id) => (id === 'tmp-1' ? 'p1' : id))
  assert.equal(r.cart.length, 1)
  assert.deepEqual(r.notes, [])
})

test('название и остаток в строке чека обновляются вместе с карточкой', () => {
  const cart = [line(pill)]
  const r = osvezhit(cart, [{ ...pill, name: 'Парацетамол 500 мг', stock: 9 }])
  assert.equal(r.changed, true)
  assert.equal(r.cart[0].name, 'Парацетамол 500 мг')
  assert.equal(r.cart[0].stock, 9)
  assert.deepEqual(r.notes, [])
})

// ── Сдача ──

test('пустое «Получено» — это «без сдачи», а не ноль', () => {
  assert.deepEqual(sdacha(137, ''), { state: 'none', diff: 0, received: null })
  assert.equal(sdacha(137, null).state, 'none')
  assert.equal(sdacha(137, '   ').state, 'none')
  assert.equal(sdacha(137, '.').state, 'none')
})

test('дали больше — сдача, дали меньше — не хватает', () => {
  assert.deepEqual(sdacha(137, '200'), { state: 'ok', diff: 63, received: 200 })
  assert.deepEqual(sdacha(137, '137'), { state: 'ok', diff: 0, received: 137 })
  assert.deepEqual(sdacha(137, '100'), { state: 'short', diff: -37, received: 100 })
  // Ноль набран руками — это уже «не хватает», а не «без сдачи»
  assert.equal(sdacha(137, '0').state, 'short')
})

test('сдача считается до дирама, без хвостов двоичной арифметики', () => {
  assert.equal(sdacha(0.1 + 0.2, '0.3').diff, 0)
  assert.equal(sdacha(0.1 + 0.2, '0.3').state, 'ok')
  assert.equal(sdacha(12.35, '20').diff, 7.65)
  // Запятая с телефона
  assert.equal(sdacha(12.35, '20,5').diff, 8.15)
})

// ── Купюры ──

test('купюры: ближайшие суммы, которые покупатель действительно даёт', () => {
  assert.deepEqual(kupyury(137), [140, 150, 200, 500])
  assert.deepEqual(kupyury(206), [210, 220, 250, 300])
  assert.deepEqual(kupyury(18), [20, 50, 100, 200])
  assert.deepEqual(kupyury(3.5), [5, 10, 20, 50])
})

test('купюры: круглая сумма не предлагает саму себя — для неё есть «Без сдачи»', () => {
  assert.deepEqual(kupyury(200), [500, 1000])
  assert.ok(!kupyury(50).includes(50))
})

test('купюры: мелочь для крупного чека не предлагается', () => {
  // 1260 при чеке на 1250 никто не даёт
  assert.deepEqual(kupyury(1250), [1300, 1400, 1500, 2000])
})

test('купюры: пустой чек и мусор — без подсказок', () => {
  assert.deepEqual(kupyury(0), [])
  assert.deepEqual(kupyury(-5), [])
  assert.deepEqual(kupyury('ерунда'), [])
})

test('купюр не больше четырёх и каждая больше суммы чека', () => {
  for (const total of [1, 7, 49.5, 99, 100, 333, 999, 4321, 15000]) {
    const k = kupyury(total)
    assert.ok(k.length <= 4, `для ${total} предложено ${k.length}`)
    assert.ok(k.every((v) => v > total), `для ${total} предложена сумма не больше чека: ${k}`)
    assert.deepEqual(k, [...k].sort((a, b) => a - b))
  }
})

// ── Штрихкод или название ──

test('незнакомый штрихкод отличается от поиска по названию', () => {
  assert.equal(pohozheNaKod('4870204010060'), true)
  assert.equal(pohozheNaKod('123456'), true)
  // Короткое число — обрывок, а не код: заводить по нему товар нельзя
  assert.equal(pohozheNaKod('12345'), false)
  assert.equal(pohozheNaKod('парацетамол'), false)
  // Название с цифрами и пробелом — это поиск
  assert.equal(pohozheNaKod('но-шпа 40 мг 100 шт'), false)
  assert.equal(pohozheNaKod(''), false)
  assert.equal(pohozheNaKod(null), false)
})

test('буква в строке отличает название от обрывка кода', () => {
  assert.equal(estBukva('пара'), true)
  assert.equal(estBukva('Ҷавҳар'), true) // таджикские буквы
  assert.equal(estBukva('aspirin'), true)
  assert.equal(estBukva('4870'), false)
  assert.equal(estBukva('12-34'), false)
  assert.equal(estBukva(''), false)
})

// ── Граница узкого экрана ──
//
// Ниже неё чек и каталог показываются по очереди. Число записано в трёх местах:
// в стилях (показать переключатель), в кассе (самой открывать каталог при наборе)
// и в туре (объяснять переключатель или клавиши). Разойдутся — и касса сочтёт экран
// широким, пока на нём показан переключатель: набранное название искалось бы
// в каталоге, которого не видно. Так уже было при разработке: 1199 против 1279.
test('граница узкого экрана одна и та же в стилях, в кассе и в туре', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const read = (p) => readFileSync(join(src, p), 'utf8')

  const kassa = read('pages/Pos.jsx').match(/const UZKO = '\(max-width: (\d+)px\)'/)
  const tur = read('lib/tur.js').match(/uzko: window\.matchMedia\('\(max-width: (\d+)px\)'\)/)
  const css = read('index.css')
  // Правило, которое показывает переключатель «Чек | Каталог»
  const blok = css.match(/@media \(max-width: (\d+)px\) \{\s*\.kassa \{ display: flex;[^}]*\}\s*\.kassa-switch \{ display: grid; \}/)
  const shiroko = css.match(/@media \(min-width: (\d+)px\) \{\s*\.kassa \{ display: grid;/)

  assert.ok(kassa, 'в кассе не найдена граница узкого экрана')
  assert.ok(tur, 'в туре не найдена граница узкого экрана')
  assert.ok(blok, 'в стилях не найдено правило переключателя «Чек | Каталог»')
  assert.ok(shiroko, 'в стилях не найдено правило двух колонок')
  assert.equal(kassa[1], blok[1], 'касса и стили по-разному понимают «узкий экран»')
  assert.equal(tur[1], blok[1], 'тур и стили по-разному понимают «узкий экран»')
  assert.equal(Number(shiroko[1]), Number(blok[1]) + 1, 'между «узко» и «широко» в стилях щель или нахлёст')
})
