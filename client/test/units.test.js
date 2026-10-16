// Тесты общей арифметики упаковок и штук. Запуск: npm test (в папке client).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  uppOf, isDivisible, unitPrice, unitCost,
  lineUnits, lineGross, lineDiscount, lineNet, lineCost,
  stockUnits, stockValue, stockCost, splitUnits,
  fitLine, EDINICY, edinica, isDrobnyy,
} from '../src/lib/units.js'

// Упаковка 20 штук, продаётся по 200 сомони, закупка 100
const pill = { unitsPerPack: 20, price: 200, cost: 100 }
// Неделимый товар: бинт за 40
const bandage = { unitsPerPack: 1, price: 40, cost: 18 }

test('штук в упаковке: мусор и пустота означают неделимый товар', () => {
  assert.equal(uppOf({ unitsPerPack: 20 }), 20)
  assert.equal(uppOf({ unitsPerPack: 0 }), 1)
  assert.equal(uppOf({ unitsPerPack: null }), 1)
  assert.equal(uppOf({}), 1)
  assert.equal(uppOf(null), 1)
  assert.equal(uppOf({ unitsPerPack: 'ерунда' }), 1)
})

test('делимость', () => {
  assert.equal(isDivisible(pill), true)
  assert.equal(isDivisible(bandage), false)
})

test('цена и себестоимость штуки', () => {
  assert.equal(unitPrice(pill), 10)
  assert.equal(unitCost(pill), 5)
  assert.equal(unitPrice(bandage), 40)
})

// ── Позиция чека ──

test('только упаковки', () => {
  const i = { ...pill, qty: 2, pieces: 0 }
  assert.equal(lineUnits(i), 40)
  assert.equal(lineGross(i), 400)
})

test('только штуки из вскрытой упаковки — тот самый баг истории скидок', () => {
  // Пять штук по 10 = 50. Раньше здесь считалось цена × упаковки = 0,
  // и позиция со скидкой уходила в минус
  const i = { ...pill, qty: 0, pieces: 5, discount: 20 }
  assert.equal(lineUnits(i), 5)
  assert.equal(lineGross(i), 50)
  assert.equal(lineNet(i), 30)
})

test('упаковки и штуки вместе', () => {
  const i = { ...pill, qty: 1, pieces: 5 }
  assert.equal(lineUnits(i), 25)
  assert.equal(lineGross(i), 250)
  assert.equal(lineCost(i), 125)
})

test('скидка не больше суммы позиции и не отрицательная', () => {
  assert.equal(lineDiscount({ ...pill, qty: 1, discount: 1000 }), 200)
  assert.equal(lineDiscount({ ...pill, qty: 1, discount: -50 }), 0)
  assert.equal(lineNet({ ...pill, qty: 1, discount: 1000 }), 0, 'позиция не уходит в минус')
})

test('позиция без скидки', () => {
  const i = { ...bandage, qty: 3 }
  assert.equal(lineDiscount(i), 0)
  assert.equal(lineNet(i), 120)
})

// ── Остаток ──

test('остаток в штуках учитывает вскрытую упаковку', () => {
  assert.equal(stockUnits({ ...pill, stock: 3, looseUnits: 7 }), 67)
  assert.equal(stockUnits({ ...bandage, stock: 5 }), 5)
  assert.equal(stockUnits({ ...pill, stock: 0, looseUnits: 0 }), 0)
})

test('стоимость остатка считается по штукам, а не по целым упаковкам', () => {
  // 3 пачки + 7 штук = 67 штук × 10 = 670 по продаже и × 5 = 335 по закупке
  const p = { ...pill, stock: 3, looseUnits: 7 }
  assert.equal(stockValue(p), 670)
  assert.equal(stockCost(p), 335)
})

// ── Две цены одного склада ──
// Владелец завёл первый товар и прочитал в панели «Остаток на складе — 1000»,
// решив, что столько у него добра. На деле он вложил 500, а вторые 500 — прибыль,
// которой ещё нет: она появится, только когда всё продастся. Ради этого в панели
// и стоят два числа рядом, и вот проверка, что они считаются каждое по своему.
test('вложено и остаток — разные деньги: закупка против продажи', () => {
  const tovar = { cost: 10, price: 20, unitsPerPack: 1, stock: 50, looseUnits: 0 }
  assert.equal(stockCost(tovar), 500, 'вложено считается по закупочной')
  assert.equal(stockValue(tovar), 1000, 'остаток считается по цене продажи')
  assert.equal(stockValue(tovar) - stockCost(tovar), 500, 'разница — будущая прибыль')
})

test('продажа упаковки уменьшает вложенное и остаток каждое на свою цену', () => {
  const bylo = { cost: 10, price: 20, unitsPerPack: 1, stock: 50, looseUnits: 0 }
  const stalo = { ...bylo, stock: 47 }
  assert.equal(stockCost(bylo) - stockCost(stalo), 30, 'вложено падает по закупочной')
  assert.equal(stockValue(bylo) - stockValue(stalo), 60, 'остаток падает по цене продажи')
})

test('пустой склад — оба числа ноль, а не пустота', () => {
  const pusto = { cost: 10, price: 20, unitsPerPack: 20, stock: 0, looseUnits: 0 }
  assert.equal(stockCost(pusto), 0)
  assert.equal(stockValue(pusto), 0)
})

test('товар без закупочной цены не завышает вложенное', () => {
  // Товар мог быть заведён вручную, без цены закупки. Тогда честнее показать
  // ноль вложенных, чем подставить цену продажи и обмануть владельца
  const bezZakupki = { cost: 0, price: 20, unitsPerPack: 1, stock: 10, looseUnits: 0 }
  assert.equal(stockCost(bezZakupki), 0)
  assert.equal(stockValue(bezZakupki), 200)
})

test('раскладка штук обратно на упаковки и вскрытую', () => {
  assert.deepEqual(splitUnits(67, pill), { stock: 3, looseUnits: 7 })
  assert.deepEqual(splitUnits(40, pill), { stock: 2, looseUnits: 0 })
  assert.deepEqual(splitUnits(5, bandage), { stock: 5, looseUnits: 0 })
})

test('раскладка не уводит остаток в минус', () => {
  assert.deepEqual(splitUnits(-10, pill), { stock: 0, looseUnits: 0 })
  assert.deepEqual(splitUnits(null, pill), { stock: 0, looseUnits: 0 })
})

test('туда и обратно: остаток не меняется', () => {
  const p = { ...pill, stock: 12, looseUnits: 13 }
  assert.deepEqual(splitUnits(stockUnits(p), p), { stock: 12, looseUnits: 13 })
})

// ── Последнюю пачку надо уметь вскрыть ──
//
// Настоящий случай из магазина: остаток пять штук, в упаковке тоже пять. Касса
// при сканировании кладёт одну упаковку — те же самые пять штук. Покупателю нужны
// три штуки, кассир набирает «3» в поле «Штук» — и получает отказ: программа
// считает, что он хочет упаковку И ЕЩЁ три штуки поверх.
//
// Выхода не было вовсе: убрать упаковку кнопкой «−» тоже нельзя, при нуле строка
// исчезала из корзины. То есть последнюю пачку в системе нельзя было вскрыть.
test('из последней упаковки можно продать несколько штук', () => {
  // Три штуки при нуле упаковок помещаются — именно так теперь и делает кассир
  const ok = fitLine({ qty: 0, pieces: 3, upp: 5, avail: 5 })
  assert.deepEqual({ qty: ok.qty, pieces: ok.pieces, capped: ok.capped }, { qty: 0, pieces: 3, capped: false })
})

test('пока упаковка в корзине, штуки не помещаются — и об этом говорят по делу', () => {
  // Отказ остаётся: числа под пальцами кассира сами не прыгают. Но он перестаёт
  // быть тупиком — программа подсказывает, что упаковку надо убрать.
  const no = fitLine({ qty: 1, pieces: 3, upp: 5, avail: 5 })
  assert.equal(no.capped, true)
  assert.equal(no.blockedByPacks, true, 'причина — упаковка, а не нехватка товара')
  assert.equal(no.qty, 1)
  assert.equal(no.pieces, 0)
})

test('когда товара и правда мало, подсказка про упаковку не появляется', () => {
  // Остаток две штуки, просят пять. Убирать нечего — упаковок в корзине нет.
  const no = fitLine({ qty: 0, pieces: 5, upp: 5, avail: 2 })
  assert.equal(no.capped, true)
  assert.equal(no.blockedByPacks, false, 'нельзя советовать убрать упаковку, когда её нет')
  assert.equal(no.pieces, 2)
})

test('набранное не отбрасывается целиком, а ограничивается максимумом', () => {
  // Иначе число из нескольких цифр откатывалось бы на предыдущее прямо под пальцами
  const r = fitLine({ qty: 9, pieces: 0, upp: 10, avail: 25 })
  assert.equal(r.qty, 2, 'осталось столько упаковок, сколько помещается')
  assert.equal(r.capped, true)
})

test('упаковки и штуки вместе укладываются в остаток', () => {
  // Две упаковки по десять плюс пять штук — ровно двадцать пять, весь остаток
  const r = fitLine({ qty: 2, pieces: 5, upp: 10, avail: 25 })
  assert.equal(r.capped, false)
  assert.equal(r.qty, 2)
  assert.equal(r.pieces, 5)

  const over = fitLine({ qty: 2, pieces: 9, upp: 10, avail: 25 })
  assert.equal(over.qty, 2)
  assert.equal(over.pieces, 5, 'штуки урезаны до места, оставшегося после упаковок')
})

test('мусор во входных данных не ломает расчёт', () => {
  for (const bad of [{}, { qty: -3, pieces: -1, upp: 0, avail: -5 }, { qty: 1.7, pieces: 2.9, upp: 5, avail: 10 }]) {
    const r = fitLine(bad)
    assert.ok(Number.isInteger(r.qty) && r.qty >= 0, JSON.stringify(bad))
    assert.ok(Number.isInteger(r.pieces) && r.pieces >= 0, JSON.stringify(bad))
  }
})

test('единицы в карточке товара: шт, уп, меры и рулон — без пачек, коробок и ящиков', () => {
  assert.deepEqual(EDINICY.map((x) => x.v), ['шт', 'уп', 'кг', 'л', 'м', 'м²', 'рулон'])
  // Дробно продаются только меры
  assert.deepEqual(EDINICY.filter((x) => x.drob).map((x) => x.v), ['кг', 'л', 'м', 'м²'])
})

test('товар, заведённый с убранной единицей, работает как прежде', () => {
  const p = { unit: 'пачка', unitsPerPack: 20, price: 200 }
  assert.equal(edinica(p), 'пачка', 'подпись прежняя')
  assert.equal(isDrobnyy(p), false, 'продаётся целыми, как раньше')
  assert.equal(unitPrice(p), 10, 'и поштучно — из своих штук внутри')
})
