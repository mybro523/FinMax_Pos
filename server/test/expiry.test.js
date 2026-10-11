// Тесты просрочки: календарь по Душанбе и выборка партий при продаже.
// Проверяем собранный код из dist — ровно то, что уходит на сервер.
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { BadRequestException } = require('@nestjs/common')
const { startOfTodayTj, isExpired, storableDate } = require('../dist/common/time')
const { consumeUnits, enteredExpiry, expiryFrom, RETURN_EXPIRED, returnExpiry, shortageWorth } = require('../dist/common/stock')

// ── Календарь ──

test('сутки начинаются по Душанбе, а не по UTC', () => {
  // 20 августа 02:00 по Душанбе — это ещё 19-е по UTC.
  // Сервер обязан считать, что уже 20-е, иначе вчерашняя просрочка
  // ещё пять часов проходила бы как годный товар.
  const night = new Date('2026-08-19T21:00:00.000Z') // 20.08 02:00 +05
  assert.equal(startOfTodayTj(night).toISOString(), '2026-08-19T19:00:00.000Z')
})

test('вечер по Душанбе — те же сутки', () => {
  const evening = new Date('2026-08-20T18:00:00.000Z') // 20.08 23:00 +05
  assert.equal(startOfTodayTj(evening).toISOString(), '2026-08-19T19:00:00.000Z')
})

test('срок годности — последний ГОДНЫЙ день', () => {
  const exp = new Date('2026-08-20T00:00:00.000Z')
  // 20-го числа товар ещё продаём
  assert.equal(isExpired(exp, new Date('2026-08-20T10:00:00.000Z')), false)
  // 21-го уже нет
  assert.equal(isExpired(exp, new Date('2026-08-21T10:00:00.000Z')), true)
})

test('товар без срока просроченным не бывает', () => {
  assert.equal(isExpired(null), false)
  assert.equal(isExpired(undefined), false)
})

// ── Выборка партий ──
// Поддельная база: consumeUnits трогает только эти четыре метода,
// поэтому логику FEFO можно проверить целиком, без настоящего Postgres.

function fakeTx(product, batches) {
  const rows = batches.map((b, n) => ({
    id: 'b' + n,
    productId: product.id,
    units: b.units,
    cost: b.cost ?? 10,
    expiryDate: b.expiryDate ?? null,
    createdAt: b.createdAt ?? new Date('2026-01-0' + (n + 1) + 'T00:00:00.000Z'),
  }))
  const card = { ...product }
  return {
    rows,
    card,
    product: {
      findUnique: async () => ({ ...card, batches: rows }),
      update: async ({ data }) => Object.assign(card, data),
    },
    batch: {
      update: async ({ where, data }) => {
        const r = rows.find((x) => x.id === where.id)
        Object.assign(r, data)
        return r
      },
      create: async ({ data }) => {
        const r = { id: 'new' + rows.length, createdAt: new Date(), ...data }
        rows.push(r)
        return r
      },
    },
  }
}

const PROD = { id: 'p1', name: 'Парацетамол', unitsPerPack: 1, stock: 0, looseUnits: 0, cost: 10, expiryDate: null }
const PAST = new Date('2020-01-01T00:00:00.000Z')
const FUTURE = new Date('2099-01-01T00:00:00.000Z')

test('продажа не берёт просроченную партию, хотя её срок ближе всех', () => {
  const tx = fakeTx(PROD, [
    { units: 5, expiryDate: PAST, cost: 10 },
    { units: 5, expiryDate: FUTURE, cost: 20 },
  ])
  return consumeUnits(tx, 'p1', 3, 'Парацетамол', { skipExpired: true }).then((taken) => {
    assert.equal(taken.length, 1)
    assert.equal(taken[0].units, 3)
    assert.equal(taken[0].expiryDate, FUTURE, 'взяли годную партию, а не просроченную')
    assert.equal(tx.rows[0].units, 5, 'просроченная партия не тронута')
    assert.equal(tx.rows[1].units, 2)
  })
})

test('без skipExpired списание добирается до просрочки — иначе её не убрать со склада', () => {
  const tx = fakeTx(PROD, [
    { units: 5, expiryDate: PAST },
    { units: 5, expiryDate: FUTURE },
  ])
  return consumeUnits(tx, 'p1', 3, 'Парацетамол').then((taken) => {
    assert.equal(taken[0].expiryDate, PAST, 'просроченное уходит первым')
    assert.equal(tx.rows[0].units, 2)
    assert.equal(tx.rows[1].units, 5)
  })
})

test('годного не хватает — отказ с понятной причиной, а не «мало товара»', async () => {
  const tx = fakeTx(PROD, [
    { units: 8, expiryDate: PAST },
    { units: 2, expiryDate: FUTURE },
  ])
  await assert.rejects(
    () => consumeUnits(tx, 'p1', 5, 'Парацетамол', { skipExpired: true }),
    (e) => {
      const m = String(e.message)
      assert.match(m, /годных 2 шт/)
      assert.match(m, /просрочено 8 шт/)
      assert.match(m, /спишите/)
      return true
    },
  )
  assert.equal(tx.rows[0].units, 8, 'при отказе склад не тронут')
  assert.equal(tx.rows[1].units, 2)
})

test('просрочки нет — прежний текст про нехватку остатка', async () => {
  const tx = fakeTx(PROD, [{ units: 2, expiryDate: FUTURE }])
  await assert.rejects(
    () => consumeUnits(tx, 'p1', 5, 'Парацетамол', { skipExpired: true }),
    /Недостаточно .*есть 2 шт/,
  )
})

test('карточка запоминает, сколько штук просрочено', () => {
  const tx = fakeTx(PROD, [
    { units: 6, expiryDate: PAST },
    { units: 4, expiryDate: FUTURE },
  ])
  return consumeUnits(tx, 'p1', 1, 'Парацетамол', { skipExpired: true }).then(() => {
    assert.equal(tx.card.expiredUnits, 6)
    assert.equal(tx.card.stock, 9, 'общий остаток считает и просрочку — она ещё на складе')
  })
})

test('делимый товар: просрочка считается в штуках', () => {
  const pill = { ...PROD, unitsPerPack: 20 }
  const tx = fakeTx(pill, [
    { units: 25, expiryDate: PAST },
    { units: 40, expiryDate: FUTURE },
  ])
  return consumeUnits(tx, 'p1', 5, 'Таблетки', { skipExpired: true }).then(() => {
    assert.equal(tx.card.expiredUnits, 25)
    assert.equal(tx.card.stock, 3, '60 штук = 3 упаковки')
    assert.equal(tx.card.looseUnits, 0)
  })
})

test('весь остаток просрочен — продать нельзя вовсе', async () => {
  const tx = fakeTx(PROD, [{ units: 10, expiryDate: PAST }])
  await assert.rejects(
    () => consumeUnits(tx, 'p1', 1, 'Парацетамол', { skipExpired: true }),
    /годных 0 шт, просрочено 10 шт/,
  )
})

// ── Срок годности, который можно сохранить ──

test('год длиннее четырёх цифр база не хранит: сайт получает понятный отказ, а не «ошибку сервера»', () => {
  // Поле даты в браузере пускает и шесть цифр года — «20266» вместо «2026»
  for (const raw of ['20266-01-01', '+020266-01-01T00:00:00.000Z', '275760-09-12']) {
    assert.throws(() => expiryFrom(raw), (e) => e instanceof BadRequestException && /Срок годности: проверьте год/.test(e.message), raw)
  }
  assert.equal(expiryFrom('2028-01-31').toISOString(), '2028-01-31T00:00:00.000Z')
  assert.equal(expiryFrom('9999-12-31').toISOString(), '9999-12-31T00:00:00.000Z')
  assert.equal(expiryFrom('0202-06-01').toISOString(), '0202-06-01T00:00:00.000Z', 'что сохранялось раньше — сохраняется и теперь')
  // Не дата вовсе — как и раньше, забота того, кто вызвал
  assert.ok(Number.isNaN(expiryFrom('2026-13-45').getTime()))
  assert.equal(storableDate(Date.parse('9999-12-31T23:59:59.999Z')), true)
  assert.equal(storableDate(Date.parse('9999-12-31T23:59:59.999Z') + 1), false)
  assert.equal(storableDate(Date.parse('0001-01-01T00:00:00.000Z')), true)
  assert.equal(storableDate(Date.parse('0001-01-01T00:00:00.000Z') - 1), false)
})

// ── Стоимость недостачи ──

test('недостача оценивается одной формулой: сначала сумма по строкам, потом деление на штуки в упаковке', () => {
  // Пачка из двенадцати за 2,50, недостача трёх штук: 0,625 — то есть 0,63
  assert.equal(shortageWorth([{ cost: 2.5, units: 3 }], 12).toString(), '0.63')
  assert.equal(shortageWorth([{ cost: 2.5, units: 2 }], 12).toString(), '0.42')
  // Те же три штуки из трёх партий — та же сумма: порядок и разбивка строк не важны
  assert.equal(shortageWorth([{ cost: 2.5, units: 1 }, { cost: 2.5, units: 1 }, { cost: 2.5, units: 1 }], 12).toString(), '0.63')
  // Упаковка из трёх за десять: десять штук — 33,33, две — 6,67
  assert.equal(shortageWorth([{ cost: 10, units: 10 }], 3).toString(), '33.33')
  assert.equal(shortageWorth([{ cost: 10, units: 2 }], 3).toString(), '6.67')
  assert.equal(shortageWorth([], 3).toString(), '0')
  // Штук в упаковке «ноль» не бывает, но делить на него нельзя в любом случае
  assert.equal(shortageWorth([{ cost: 10, units: 2 }], 0).toString(), '20')
})

// ── Срок годности товара, который вернул покупатель ──

const batch = (iso) => ({ expiryDate: iso ? new Date(iso + 'T00:00:00.000Z') : null })
const isoDay = (d) => (d ? d.toISOString().slice(0, 10) : null)

test('возвращённый товар получает самый ранний срок среди партий, годных в день покупки', () => {
  const sold = new Date('2026-10-05T07:00:00.000Z') // 5 октября, полдень по Душанбе
  // Склад пуст, партия была одна — её срок. Раньше товар оставался без срока вовсе
  assert.equal(isoDay(returnExpiry([batch('2027-05-31')], sold)), '2027-05-31')
  // Партий две. Продажа берёт ближайший срок, значит настоящий срок пачки не раньше
  // самого раннего: ошибиться можно только в осторожную сторону. Раньше пачка
  // получала срок партии, оставшейся на складе, — то есть позже настоящего
  assert.equal(isoDay(returnExpiry([batch('2027-08-31'), batch('2026-11-30')], sold)), '2026-11-30')
  // Партию, просроченную ко дню покупки, тогда не продавали — она не в счёт
  assert.equal(isoDay(returnExpiry([batch('2026-09-30'), batch('2027-03-31')], sold)), '2027-03-31')
  // «Годен до 5 октября» — пятого ещё продают
  assert.equal(isoDay(returnExpiry([batch('2026-10-05'), batch('2027-03-31')], sold)), '2026-10-05')
  // День покупки считается по Душанбе: в час ночи пятого партия «до четвёртого» уже просрочена
  const night = new Date('2026-10-04T20:00:00.000Z')
  assert.equal(isoDay(returnExpiry([batch('2026-10-04'), batch('2027-03-31')], night)), '2027-03-31')
})

test('возвращённый товар без срока остаётся без срока; не нашлось партии — срок из карточки', () => {
  const sold = new Date('2026-10-05T07:00:00.000Z')
  // Бинты и приборы: срока нет ни у одной партии
  assert.equal(returnExpiry([batch(null), batch(null)], sold), null)
  assert.equal(returnExpiry([], sold), null)
  // Партий с подходящим сроком нет — берётся то, что передали запасным (срок карточки)
  const card = new Date('2027-01-31T00:00:00.000Z')
  assert.equal(returnExpiry([batch('2026-01-31')], sold, card), card)
  assert.equal(returnExpiry([batch(null)], sold, card), card)
  // Бессрочная партия рядом с настоящей срока не отменяет
  assert.equal(isoDay(returnExpiry([batch(null), batch('2027-03-31')], sold)), '2027-03-31')
})

test('срок, вписанный кассиром с упаковки: пусто — решает правило, истёкший — в продажу нельзя', () => {
  assert.equal(enteredExpiry('', true), null)
  assert.equal(enteredExpiry(undefined, true), null)
  assert.equal(enteredExpiry(null, true), null)
  assert.equal(enteredExpiry('2099-01-31', true).toISOString(), '2099-01-31T00:00:00.000Z')
  const refusal = (re) => (e) => e instanceof BadRequestException && re.test(e.message)
  // Товар с истёкшим сроком в продажу не возвращают — его списывают
  assert.throws(() => enteredExpiry('2001-01-01', true), refusal(/Срок на упаковке уже истёк/))
  assert.match(RETURN_EXPIRED, /Выберите «Списать»/)
  // А при списании истёкший срок — как раз обычное дело
  assert.equal(enteredExpiry('2001-01-01', false).toISOString(), '2001-01-01T00:00:00.000Z')
  assert.throws(() => enteredExpiry('не дата', true), refusal(/Срок годности: неверная дата/))
  assert.throws(() => enteredExpiry('20266-01-01', true), refusal(/Срок годности: проверьте год/))
})
