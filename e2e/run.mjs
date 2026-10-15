// Сквозной прогон по работающей системе. Подробности — в e2e/lib.mjs
import {
  API, get, post, patch, del, login, loginAs, setToken, getToken, socketAccepted, group, check, summary,
  assert, eq, eqMoney, rejects, daysFromNow, serverNow, money,
} from './lib.mjs'
import { randomUUID } from 'node:crypto'

const TAG = 'E2E-' + Date.now().toString(36)
const bc = (n) => '299' + String(Date.now()).slice(-8) + String(n).padStart(2, '0')

const created = { products: [], customers: [], users: [], categories: [], expenses: [], expenseCategories: [], suppliers: [], payServices: [] }

async function makeProduct(over = {}) {
  const p = await post('/products', {
    name: `${TAG} ${over.name || 'Товар'}`,
    barcode: over.barcode || bc(created.products.length),
    category: over.category || 'Таблетки',
    cost: over.cost ?? 100,
    price: over.price ?? 150,
    stock: over.stock ?? 0,
    minStock: over.minStock ?? 5,
    unitsPerPack: over.unitsPerPack ?? 1,
    unit: 'уп',
  })
  created.products.push(p.id)
  return p
}

const productById = async (id) => (await get('/products')).find((p) => p.id === id)

// ── Свой магазин на каждый прогон ──
// Раньше проверки работали в единственной базе и убирали за собой поштучно. Теперь
// у каждого магазина своя схема, поэтому прогон заводит собственную: задеть работающую
// магазин он не может даже при обрыве посередине, а в конце схема удаляется целиком —
// вместе с чеками, которые поштучно удалить нельзя, да и не нужно.
//
// Если вошли не владельцем сервиса, а сотрудником магазина, работаем в ней, как раньше:
// так прогон можно направить на конкретный магазин.
async function ownPharmacy(serviceUser) {
  if (serviceUser.role !== 'superadmin') {
    console.log('  вход сотрудником магазина — работаю в её базе')
    return null
  }
  const code = TAG.toLowerCase()
  const password = 'e2e-' + Math.random().toString(36).slice(2, 10)
  const ph = await post('/admin/pharmacies', { code, name: TAG + ' Магазин', ownerPassword: password })
  setToken(await loginAs(ph.ownerLogin, password))
  console.log(`  завёл магазин «${code}» и вошёл её владельцем`)
  return ph
}

async function main() {
  console.log(`\x1b[1mСквозной прогон\x1b[0m  ${API}\n  метка: ${TAG}`)
  const user = await login()
  console.log(`  вошли как: ${user.name} (${user.role})`)
  // Токен владельца сервиса держим отдельно: им в конце удаляется магазин прогона,
  // а основной токен к тому моменту принадлежит уже её владельцу
  const serviceToken = getToken()
  const temp = await ownPharmacy(user)

  // ────────────────────────────────────────────────────────────
  group('Схема и связь')

  let probe
  await check('карточка товара содержит просроченный остаток (expiredUnits)', async () => {
    probe = await makeProduct({ name: 'Проверка схемы' })
    assert('expiredUnits' in probe, 'поля expiredUnits нет — на сервере старая версия')
    eq(probe.expiredUnits, 0, 'у нового товара просрочки быть не должно')
  })

  await check('деньги приходят числами, а не строками', async () => {
    assert(typeof probe.price === 'number', `price пришла как ${typeof probe.price}`)
    assert(typeof probe.cost === 'number', `cost пришла как ${typeof probe.cost}`)
  })

  // ────────────────────────────────────────────────────────────
  group('Приход и себестоимость')

  await check('остаток в карточке не меняется сам собой после первой операции', async () => {
    // Владелец вписал «0 упаковок и 13 штук» при десяти в упаковке. Штук столько
    // и есть, но заведение сохраняло это как есть, а любая операция потом приводила
    // карточку к партии — и остаток сам превращался в «1 уп + 3 шт». Со стороны это
    // выглядит как ошибка счёта, и доверия к остаткам после такого не остаётся.
    const odd = await post('/products', {
      name: `${TAG} Странный остаток`,
      barcode: bc(91),
      category: 'Таблетки',
      cost: 50, price: 100, unitsPerPack: 10, unit: 'уп',
      stock: 0, looseUnits: 13,
    })
    created.products.push(odd.id)
    eq(odd.stock, 1, 'упаковки при заведении')
    eq(odd.looseUnits, 3, 'вскрытые штуки при заведении')

    // И после операции со складом число остаётся тем же
    await post('/sales', {
      items: [{ productId: odd.id, qty: 0, pieces: 1, discount: 0 }],
      payment: 'cash',
      clientId: `${TAG}-norm`,
    })
    const after = await productById(odd.id)
    eq(after.stock * 10 + after.looseUnits, 12, 'всего штук после продажи одной')
    eq(after.stock, 1, 'упаковки после продажи')
    eq(after.looseUnits, 2, 'вскрытые штуки после продажи')
  })

  let pill
  await check('приёмка заводит партию и остаток', async () => {
    pill = await makeProduct({ name: 'Таблетки', cost: 0, price: 200, unitsPerPack: 20 })
    await post('/arrivals', {
      supplier: TAG,
      items: [{ productId: pill.id, qty: 10, cost: 100, expiryDate: daysFromNow(180) }],
    })
    pill = await productById(pill.id)
    eq(pill.stock, 10, 'остаток после прихода')
    eqMoney(pill.cost, 100, 'себестоимость после первой поставки')
  })

  await check('вторая поставка усредняет закупочную цену', async () => {
    await post('/arrivals', {
      supplier: TAG,
      items: [{ productId: pill.id, qty: 10, cost: 200, expiryDate: daysFromNow(365) }],
    })
    pill = await productById(pill.id)
    eq(pill.stock, 20, 'остаток после второй поставки')
    eqMoney(pill.cost, 150, 'средневзвешенная из 100 и 200')
  })

  await check('товару без срока годности приёмка отказывает', async () => {
    await rejects(
      () => post('/arrivals', { supplier: TAG, items: [{ productId: pill.id, qty: 1, cost: 100 }] }),
      /срок годности/i,
      'приход без срока',
    )
  })

  // ────────────────────────────────────────────────────────────
  group('Продажа')

  let sale
  await check('продажа упаковками списывает остаток и считает прибыль', async () => {
    sale = await post('/sales', {
      items: [{ productId: pill.id, qty: 2, pieces: 0 }],
      payment: 'cash',
      clientId: TAG + '-sale1',
    })
    eqMoney(sale.total, 400, 'сумма чека: 2 × 200')
    eqMoney(sale.cost, 300, 'себестоимость: 2 × 150')
    eqMoney(sale.profit, 100, 'прибыль')
    pill = await productById(pill.id)
    eq(pill.stock, 18, 'остаток после продажи')
  })

  await check('поштучная продажа делит упаковку', async () => {
    const s = await post('/sales', {
      items: [{ productId: pill.id, qty: 0, pieces: 5 }],
      payment: 'cash',
      clientId: TAG + '-sale2',
    })
    eqMoney(s.total, 50, '5 штук по 10')
    pill = await productById(pill.id)
    eq(pill.stock, 17, 'упаковок осталось')
    eq(pill.looseUnits, 15, 'во вскрытой упаковке')
  })

  await check('скидка не может превысить сумму позиции', async () => {
    const s = await post('/sales', {
      items: [{ productId: pill.id, qty: 1, pieces: 0, discount: 99999 }],
      payment: 'cash',
      clientId: TAG + '-sale3',
    })
    eqMoney(s.total, 0, 'чек не уходит в минус')
  })

  await check('повтор запроса не задваивает чек', async () => {
    const again = await post('/sales', {
      items: [{ productId: pill.id, qty: 2, pieces: 0 }],
      payment: 'cash',
      clientId: TAG + '-sale1',
    })
    eq(again.id, sale.id, 'вернулся тот же чек')
    pill = await productById(pill.id)
    eq(pill.stock, 16, 'остаток не списался повторно')
    eq(pill.looseUnits, 15, 'вскрытая упаковка не тронута')
  })

  await check('продать больше остатка нельзя', async () => {
    await rejects(
      () => post('/sales', { items: [{ productId: pill.id, qty: 9999 }], payment: 'cash' }),
      /Недостаточно|годных/,
      'продажа сверх остатка',
    )
  })

  await check('продажа в долг без клиента отклоняется', async () => {
    await rejects(
      () => post('/sales', { items: [{ productId: pill.id, qty: 1 }], payment: 'debt' }),
      /клиент/i,
      'долг без клиента',
    )
  })

  await check('возвращённый в продажу товар получает срок годности — и при пустом складе, и когда его партию уже распродали', async () => {
    const near = daysFromNow(200)
    const far = daysFromNow(500)
    const iso = (d) => d + 'T00:00:00.000Z'
    const sell = (p, key) => post('/sales', { items: [{ productId: p.id, qty: 1 }], payment: 'cash', clientId: `${TAG}-${key}` })
    const giveBack = (sale, p, extra = {}) => post('/returns', { saleId: sale.id, items: [{ productId: p.id, units: 1, restock: true, ...extra }] })

    // ── Склад пуст ──
    let a = await makeProduct({ name: 'Возврат на пустой склад', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: a.id, qty: 1, cost: 10, expiryDate: near }] })
    const saleA = await sell(a, 'ret-pusto')
    a = await productById(a.id)
    eq([a.stock, a.expiryDate].join(), '0,', 'последняя упаковка продана: на складе пусто, срока в карточке нет')
    await giveBack(saleA, a)
    a = await productById(a.id)
    eq(a.stock, 1, 'товар вернулся на полку')
    eq(a.expiryDate, iso(near), 'со сроком партии, из которой был продан; раньше срока не было вовсе, и товар выпадал из контроля сроков')

    // ── Партию, из которой продали, уже распродали ──
    let b = await makeProduct({ name: 'Возврат из распроданной партии', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: b.id, qty: 1, cost: 10, expiryDate: near }] })
    await post('/arrivals', { supplier: TAG, items: [{ productId: b.id, qty: 3, cost: 10, expiryDate: far }] })
    const saleB = await sell(b, 'ret-partiya')
    b = await productById(b.id)
    eq(b.expiryDate, iso(far), 'ближняя партия продана — в карточке срок дальней')
    await giveBack(saleB, b)
    b = await productById(b.id)
    eq(b.stock, 4, 'товар вернулся на полку')
    eq(b.expiryDate, iso(near), 'со своим сроком, ближним; раньше получал срок оставшейся партии — позже настоящего')

    // ── Срок с упаковки ──
    let c = await makeProduct({ name: 'Возврат со сроком с коробки', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: c.id, qty: 2, cost: 10, expiryDate: near }] })
    const first = await sell(c, 'ret-korobka-1')
    const second = await sell(c, 'ret-korobka-2')
    await giveBack(first, c, { expiryDate: far })
    c = await productById(c.id)
    eq([c.stock, c.expiryDate].join(), `1,${iso(far)}`, 'кассир вписал срок с упаковки — взят он')
    // Истёкший срок: такой товар в продажу не возвращают
    await rejects(() => giveBack(second, c, { expiryDate: daysFromNow(-1) }), /Срок на упаковке уже истёк/, 'возврат в продажу с истёкшим сроком')
    await rejects(() => giveBack(second, c, { expiryDate: 'не дата' }), /Срок годности: неверная дата/, 'мусор вместо срока')
    await rejects(() => giveBack(second, c, { expiryDate: '20266-01-01' }), /Срок годности: проверьте год/, 'лишняя цифра в годе')
    eq((await productById(c.id)).stock, 1, 'ни один отказ остаток не тронул')
    // А списать просроченное при возврате — можно
    const off = await post('/returns', { saleId: second.id, items: [{ productId: c.id, units: 1, restock: false, expiryDate: daysFromNow(-1) }] })
    eq(off.items[0].restock, false, 'возврат со списанием оформлен')
    eq((await productById(c.id)).stock, 1, 'списанное на полку не попало')

    // ── Товар без срока ──
    const noDate = await post('/categories', { name: TAG + '-bez-sroka', noExpiry: true })
    created.categories.push(noDate.id)
    let d = await makeProduct({ name: 'Возврат бинта', category: noDate.name, cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: d.id, qty: 1, cost: 10 }] })
    const saleD = await sell(d, 'ret-bint')
    await giveBack(saleD, d)
    d = await productById(d.id)
    eq([d.stock, d.expiryDate].join(), '1,', 'бинт вернулся на полку — и срока у него по-прежнему нет')
  })

  // ────────────────────────────────────────────────────────────
  group('Просроченный товар')

  let old
  await check('приёмка принимает партию с истёкшим сроком (её надо будет списать)', async () => {
    old = await makeProduct({ name: 'Просрочка', cost: 0, price: 60 })
    await post('/arrivals', {
      supplier: TAG,
      items: [{ productId: old.id, qty: 4, cost: 30, expiryDate: daysFromNow(-10) }],
    })
    old = await productById(old.id)
    eq(old.stock, 4, 'остаток на складе')
  })

  await check('карточка знает, сколько штук просрочено', async () => {
    eq(old.expiredUnits, 4, 'все 4 упаковки негодны')
  })

  await check('продать просроченный товар нельзя', async () => {
    const e = await rejects(
      () => post('/sales', { items: [{ productId: old.id, qty: 1 }], payment: 'cash' }),
      /годных 0 шт, просрочено 4 шт/,
      'продажа просрочки',
    )
    assert(/спишите/.test(e.message), 'в отказе не сказано, что делать дальше')
  })

  await check('склад после отказа не тронут', async () => {
    old = await productById(old.id)
    eq(old.stock, 4, 'остаток прежний')
  })

  await check('годная партия того же товара продаётся, просроченная остаётся', async () => {
    await post('/arrivals', {
      supplier: TAG,
      items: [{ productId: old.id, qty: 3, cost: 30, expiryDate: daysFromNow(200) }],
    })
    const s = await post('/sales', {
      items: [{ productId: old.id, qty: 2 }],
      payment: 'cash',
      clientId: TAG + '-sale-good',
    })
    eqMoney(s.total, 120, '2 × 60')
    old = await productById(old.id)
    eq(old.stock, 5, '7 было, 2 продали')
    eq(old.expiredUnits, 4, 'просроченные упаковки на месте — их не продали')
  })

  await check('годного меньше, чем просят — отказ называет оба числа', async () => {
    await rejects(
      () => post('/sales', { items: [{ productId: old.id, qty: 3 }], payment: 'cash' }),
      /годных 1 шт, просрочено 4 шт/,
      'продажа сверх годного остатка',
    )
  })

  await check('списать просроченное можно — иначе его не убрать со склада', async () => {
    const w = await post('/writeoffs', {
      reason: 'expired',
      note: TAG,
      items: [{ productId: old.id, units: 4 }],
    })
    eqMoney(w.totalCost, 120, 'убыток: 4 × 30')
    old = await productById(old.id)
    eq(old.stock, 1, 'осталась только годная упаковка')
    eq(old.expiredUnits, 0, 'просрочки больше нет')
  })

  // ────────────────────────────────────────────────────────────
  group('Инвентаризация')

  // Своя категория, чтобы лист пересчёта содержал только наши товары,
  // а не весь склад магазина
  const catName = TAG + '-kat'
  let sheet
  let counted

  await check('лист пересчёта берёт ожидаемый остаток из учёта', async () => {
    const cat = await post('/categories', { name: catName, noExpiry: true })
    created.categories.push(cat.id)

    counted = await makeProduct({ name: 'Пересчёт', category: catName, cost: 50, price: 90 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: counted.id, qty: 10, cost: 50 }] })

    sheet = await post('/inventory', { scope: catName, note: TAG })
    eq(sheet.status, 'draft', 'новый лист — черновик')
    eq(sheet.items.length, 1, 'в листе только товары этой категории')
    eq(sheet.items[0].expectedUnits, 10, 'по учёту должно быть 10')
    eq(sheet.items[0].actualUnits, null, 'фактическое ещё не вносили')
  })

  await check('пока лист не применён, склад не меняется', async () => {
    await patch('/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 7 }] })
    const p = await productById(counted.id)
    eq(p.stock, 10, 'остаток прежний')
  })

  await check('внесённое количество сохраняется и его можно поправить', async () => {
    const saved = await get('/inventory')
    const mine = saved.find((i) => i.id === sheet.id)
    eq(mine.items[0].actualUnits, 7, 'сохранилось 7')

    await patch('/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 8 }] })
    const again = (await get('/inventory')).find((i) => i.id === sheet.id)
    eq(again.items[0].actualUnits, 8, 'исправили на 8')
  })

  await check('строку чужого листа переписать нельзя', async () => {
    const other = await post('/inventory', { scope: catName, note: TAG + '-chuzhoy' })
    // Шлём в СВОЙ лист строку чужого — она не должна ни примениться, ни сломать запрос
    await patch('/inventory/' + sheet.id, { items: [{ id: other.items[0].id, actualUnits: 999 }] })
    const check2 = (await get('/inventory')).find((i) => i.id === other.id)
    eq(check2.items[0].actualUnits, null, 'чужая строка осталась нетронутой')
    await del('/inventory/' + other.id)
  })

  await check('применение приводит остаток к факту и оформляет недостачу', async () => {
    const before = (await get('/writeoffs')).length
    const applied = await post('/inventory/' + sheet.id + '/apply', {})
    eq(applied.status, 'applied', 'лист применён')

    const p = await productById(counted.id)
    eq(p.stock, 8, 'остаток стал таким, как насчитали')

    const offs = await get('/writeoffs')
    eq(offs.length, before + 1, 'недостача оформлена списанием')
    const w = offs[0]
    eq(w.source, 'inventory', 'источник — пересчёт')
    eq(w.reason, 'lost', 'причина — недостача')
    eqMoney(w.totalCost, 100, 'убыток: 2 упаковки по 50')
  })

  await check('применить дважды нельзя', async () => {
    await rejects(() => post('/inventory/' + sheet.id + '/apply', {}), /уже применён/, 'повторное применение')
    await rejects(() => patch('/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 1 }] }), /уже применён/, 'запись в применённый лист')
    eq((await get('/inventory')).find((i) => i.id === sheet.id).items[0].actualUnits, 8, 'насчитанное в применённом листе не переписано')
  })

  await check('лист применили дважды в одну секунду — проходит одно применение, и недостача записана один раз', async () => {
    // Нажали дважды, повторили после обрыва связи, открыли на двух устройствах.
    // Категория своя: в соседних проверках лист должен состоять из одного их товара
    const catTwice = catName + '-dvazhdy'
    created.categories.push((await post('/categories', { name: catTwice, noExpiry: true })).id)
    const twice = await makeProduct({ name: 'Дважды', category: catTwice, cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: twice.id, qty: 10, cost: 10 }] })
    const s = await post('/inventory', { scope: catTwice, note: TAG + '-dvazhdy' })
    const row = s.items.find((i) => i.productId === twice.id)
    await patch('/inventory/' + s.id, { items: [{ id: row.id, actualUnits: 6 }] })
    const before = (await get('/writeoffs')).length
    const tries = await Promise.allSettled([post('/inventory/' + s.id + '/apply', {}), post('/inventory/' + s.id + '/apply', {})])
    eq(tries.map((t) => t.status).sort().join(), 'fulfilled,rejected', 'прошло одно применение из двух')
    assert(/уже применён/.test(tries.find((t) => t.status === 'rejected').reason.message), 'второе получило отказ: ' + tries.find((t) => t.status === 'rejected').reason.message)
    eq((await productById(twice.id)).stock, 6, 'остаток — как насчитали')
    const offs = await get('/writeoffs')
    eq(offs.length, before + 1, 'списание недостачи одно')
    eq(offs[0].items.filter((i) => i.productId === twice.id).reduce((n, i) => n + i.units, 0), 4, 'на четыре упаковки')
    // Второе применение не должно было переписать «по учёту» уже изменённым остатком:
    // лист показывал бы «расхождения нет», а списание на четыре упаковки осталось бы
    const line = (await get('/inventory')).find((i) => i.id === s.id).items.find((i) => i.productId === twice.id)
    eq([line.expectedUnits, line.actualUnits].join(), '10,6', 'лист: по учёту было десять, насчитали шесть')

    // Сохранение и применение, пришедшие разом (так их слал сайт): либо числа сохранены
    // и применены они, либо применение успело первым и сохранение получило отказ.
    // Третьего — применён по старым числам, а в листе записаны новые — быть не должно
    const s2 = await post('/inventory', { scope: catTwice, note: TAG + '-razom' })
    const row2 = s2.items.find((i) => i.productId === twice.id)
    await patch('/inventory/' + s2.id, { items: [{ id: row2.id, actualUnits: 6 }] })
    const both = await Promise.allSettled([
      patch('/inventory/' + s2.id, { items: [{ id: row2.id, actualUnits: 9 }] }),
      post('/inventory/' + s2.id + '/apply', {}),
    ])
    eq(both[1].status, 'fulfilled', 'применение прошло')
    const after = (await get('/inventory')).find((i) => i.id === s2.id).items.find((i) => i.productId === twice.id)
    const stock = (await productById(twice.id)).stock
    eq(after.actualUnits, stock, 'в листе записано то же число, по которому выставлен остаток')
    eq(stock, both[0].status === 'fulfilled' ? 9 : 6, both[0].status === 'fulfilled' ? 'сохранение успело — применено новое число' : 'сохранение опоздало и получило отказ — применено прежнее')
    if (both[0].status === 'rejected') assert(/уже применён/.test(both[0].reason.message), 'отказ сохранению: ' + both[0].reason.message)
  })

  await check('применённый лист не удаляется — это история', async () => {
    await rejects(() => del('/inventory/' + sheet.id), /история/, 'удаление применённого листа')
  })

  await check('излишек по пересчёту просто добавляется на склад', async () => {
    const s2 = await post('/inventory', { scope: catName, note: TAG + '-izlishek' })
    await patch('/inventory/' + s2.id, { items: [{ id: s2.items[0].id, actualUnits: 12 }] })
    await post('/inventory/' + s2.id + '/apply', {})
    const p = await productById(counted.id)
    eq(p.stock, 12, 'остаток вырос до насчитанного')
  })

  await check('насчитанное можно прислать вместе с «применить» — одним запросом', async () => {
    // Так шлёт страница пересчёта: между «сохранить» и «применить» не должно помещаться
    // ничего — ни другой запрос, ни закрытая вкладка
    const s3 = await post('/inventory', { scope: catName, note: TAG + '-razom' })
    await patch('/inventory/' + s3.id, { items: [{ id: s3.items[0].id, actualUnits: 12 }] })
    const done = await post('/inventory/' + s3.id + '/apply', { items: [{ id: s3.items[0].id, actualUnits: 9 }] })
    eq(done.status, 'applied', 'лист применён')
    eq(done.items[0].actualUnits, 9, 'в листе — присланное число, а не сохранённое раньше')
    eq((await productById(counted.id)).stock, 9, 'и остаток выставлен по нему')

    // Мусор вместо числа отвергается целиком: лист не применён и не тронут
    const s4 = await post('/inventory', { scope: catName, note: TAG + '-musor' })
    await rejects(() => post('/inventory/' + s4.id + '/apply', { items: [{ id: s4.items[0].id, actualUnits: 'много' }] }), /./, 'мусор вместо числа')
    const still = (await get('/inventory')).find((i) => i.id === s4.id)
    eq([still.status, still.items[0].actualUnits].join(), 'draft,', 'лист с мусором не применён, насчитанного в нём нет')
    await del('/inventory/' + s4.id)
    // Прежняя страница шлёт пустое «применить» — оно работает как раньше
    const s5 = await post('/inventory', { scope: catName, note: TAG + '-kak-ranshe' })
    await patch('/inventory/' + s5.id, { items: [{ id: s5.items[0].id, actualUnits: 10 }] })
    eq((await post('/inventory/' + s5.id + '/apply', {})).status, 'applied', 'пустое «применить» — по сохранённому')
    eq((await productById(counted.id)).stock, 10, 'остаток — по сохранённому числу')
  })

  await check('один лист можно запросить отдельно; применённый с другими числами виден таким, какой он есть', async () => {
    // Страница пересчёта открывает лист свежим и после потерянного ответа спрашивает,
    // чем кончилось применение, — не скачивая ради этого всю историю пересчётов
    const s6 = await post('/inventory', { scope: catName, note: TAG + '-odin' })
    const one = await get('/inventory/' + s6.id)
    eq([one.id, one.status, one.items.length].join(), [s6.id, 'draft', s6.items.length].join(), 'лист — тот самый, со строками')
    eq((await get('/inventory/' + s6.id + '?wait=1')).status, 'draft', 'и с ожиданием идущего применения — он же')
    // Два применения разом с разными числами: проходит одно, и лист хранит именно его числа
    const row6 = s6.items[0]
    const tries = await Promise.allSettled([
      post('/inventory/' + s6.id + '/apply', { items: [{ id: row6.id, actualUnits: 7 }] }),
      post('/inventory/' + s6.id + '/apply', { items: [{ id: row6.id, actualUnits: 70 }] }),
    ])
    eq(tries.map((t) => t.status).sort().join(), 'fulfilled,rejected', 'применилось одно из двух')
    assert(/уже применён/.test(tries.find((t) => t.status === 'rejected').reason.message), 'второе получило отказ «уже применён»')
    const won = tries.find((t) => t.status === 'fulfilled').value.items[0].actualUnits
    const after = await get('/inventory/' + s6.id + '?wait=1')
    eq(after.status, 'applied', 'лист применён')
    eq(after.items[0].actualUnits, won, 'числа проигравшего запроса в применённый лист не попали')
    eq((await productById(counted.id)).stock, won, 'и остаток стоит по применённому')
    await rejects(() => get('/inventory/' + randomUUID()), /Лист не найден/, 'несуществующий лист')
    // Вернём остаток к прежнему, чтобы не мешать соседним проверкам
    const back = await post('/inventory', { scope: catName, note: TAG + '-nazad' })
    await post('/inventory/' + back.id + '/apply', { items: [{ id: back.items[0].id, actualUnits: 10 }] })
  })

  await check('числа, которые база не хранит, отвергаются с понятными словами, а не «ошибкой сервера»', async () => {
    // Штрихкод, считанный сканером в поле «по факту»
    const s7 = await post('/inventory', { scope: catName, note: TAG + '-predel' })
    await rejects(() => patch('/inventory/' + s7.id, { items: [{ id: s7.items[0].id, actualUnits: 4780012345678 }] }), /не больше 2000000000/, 'сохранение со штрихкодом вместо количества')
    await rejects(() => post('/inventory/' + s7.id + '/apply', { items: [{ id: s7.items[0].id, actualUnits: 4780012345678 }] }), /не больше 2000000000/, 'применение со штрихкодом вместо количества')
    eq((await get('/inventory/' + s7.id)).status, 'draft', 'лист не применён')
    await del('/inventory/' + s7.id)

    // Штук в упаковке — не больше, чем принимает обмен с кассами: иначе каждый чек
    // кассы с таким товаром был бы отвергнут
    const base = { barcode: '2' + String(Date.now()).slice(-11), category: catName, cost: 1, price: 2, stock: 0, minStock: 0, unit: 'уп' }
    await rejects(() => post('/products', { ...base, name: TAG + ' Упаковка-гигант', unitsPerPack: 100001 }), /не больше 100000/, 'карточка со ста тысячами и одной штукой в упаковке')
    await rejects(() => patch('/products/' + counted.id, { unitsPerPack: 100001 }), /не больше 100000/, 'правка карточки')

    // Срок годности с лишней цифрой в годе: поле даты в браузере пускает и шесть цифр
    for (const expiryDate of ['20266-01-01', '+020266-01-01T00:00:00.000Z']) {
      await rejects(() => post('/arrivals', { supplier: TAG, items: [{ productId: counted.id, qty: 1, cost: 1, expiryDate }] }), /Срок годности: проверьте год/, 'приход со сроком ' + expiryDate)
      await rejects(() => post('/products', { ...base, name: TAG + ' Год', unitsPerPack: 1, expiryDate }), /Срок годности: проверьте год/, 'карточка со сроком ' + expiryDate)
      await rejects(() => patch('/products/' + counted.id, { expiryDate }), /Срок годности: проверьте год/, 'правка срока на ' + expiryDate)
    }
    eq((await productById(counted.id)).stock, 10, 'ни один из отвергнутых запросов остаток не тронул')
  })

  // ────────────────────────────────────────────────────────────
  group('Кассы без интернета')

  // Программа для Windows продаёт и без связи, а потом присылает сделанное пачкой
  // и спрашивает, что изменилось. Здесь мы сами играем роль такой кассы: собираем
  // операции так, как собирает их она, и смотрим, что сервер с ними сделает.
  const KASSA_A = randomUUID()
  const KASSA_B = randomUUID()
  const op = (type, payload, extra = {}) => ({ id: randomUUID(), type, createdAt: serverNow().toISOString(), payload, ...extra })
  const push = (deviceId, ops, t) => post('/sync/push', { deviceId, appVersion: 'e2e', ops }, t)
  const pull = (deviceId, cursor, t) => get(`/sync/pull?deviceId=${deviceId}${cursor ? '&cursor=' + cursor : ''}`, t)

  // Чек, каким его записала бы касса: суммы посчитаны ею самой
  // price и date — для чеков, пробитых по другой цене или в другое время
  // pieces и upp — для продажи штуками из вскрытой упаковки
  const saleOp = (p, { qty = 1, pieces = 0, upp = 1, payment = 'cash', customerId = null, shiftId = null, price = p.price, date = serverNow().toISOString(), extra = {} } = {}) => {
    const id = randomUUID()
    const packs = (qty * upp + pieces) / upp
    return op('sale', {
      sale: {
        id, clientId: 'tmp_' + id.slice(0, 8), date,
        total: money(packs * price), cost: money(packs * p.cost), profit: money(money(packs * price) - money(packs * p.cost)),
        payment, customerId, shiftId,
        items: [{ id: randomUUID(), saleId: id, productId: p.id, name: p.name, qty, pieces, unitsPerPack: upp, price, cost: p.cost, discount: 0 }],
      },
      ...extra,
    })
  }

  let kassaGoods
  let kassaCursor

  await check('первый обмен отдаёт кассе весь магазин: товары, партии и отметку «докуда»', async () => {
    kassaGoods = await makeProduct({ name: 'Касса', cost: 60, price: 100 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: kassaGoods.id, qty: 5, cost: 60, expiryDate: daysFromNow(400) }] })
    kassaGoods = await productById(kassaGoods.id)

    const first = await pull(KASSA_A)
    eq(first.full, true, 'первый обмен — полный')
    assert(/^\d+$/.test(first.cursor), 'отметка должна быть числом в виде строки')
    const mine = first.data.products.upsert.find((p) => p.id === kassaGoods.id)
    assert(mine, 'товара нет в ответе')
    const batches = first.data.batches.upsert.filter((b) => b.productId === kassaGoods.id)
    eq(batches.reduce((s, b) => s + b.units, 0), 5, 'партии товара: штук на полке')
    assert(batches[0].expiryDate, 'у партии должен быть срок годности — по нему касса не продаст просрочку')
    eq(first.me.role, 'founder', 'касса узнаёт, кто за ней')
    assert(first.me.tenantUserId, 'и на кого записывать документы')
    eq(first.me.subscription.canWrite, true, 'каждый обмен — проверка подписки')
    eq(first.device.name, 'Касса 1', 'касса получает человеческое имя')
    kassaCursor = first.cursor
  })

  let kassaSale
  await check('чек, пробитый без связи, ложится на сервер таким, каким его напечатали', async () => {
    kassaSale = saleOp(kassaGoods, { qty: 2 })
    const r = await push(KASSA_A, [kassaSale])
    eq(r.results[0].status, 'ok', 'операция принята')
    const s = (await get('/sales')).find((x) => x.id === kassaSale.payload.sale.id)
    assert(s, 'чека нет на сервере')
    eqMoney(s.total, 200, 'сумма чека')
    eqMoney(s.profit, 80, 'прибыль чека')
    eq(s.date, kassaSale.payload.sale.date, 'время чека — когда продали, а не когда дошло')
    eq(s.items[0].id, kassaSale.payload.sale.items[0].id, 'номера позиций — те же, что на кассе')
    eq((await productById(kassaGoods.id)).stock, 3, 'остаток уменьшился')
  })

  await check('повторная отправка той же операции ничего не задваивает', async () => {
    const again = await push(KASSA_A, [kassaSale])
    eq(again.results[0].status, 'duplicate', 'сервер узнал операцию по номеру')
    eq(again.results[0].docId, kassaSale.payload.sale.id, 'и назвал тот же чек')
    eq((await productById(kassaGoods.id)).stock, 3, 'остаток не списался второй раз')
    eq((await get('/sales')).filter((x) => x.id === kassaSale.payload.sale.id).length, 1, 'чек один')
    // Два запроса с одной и той же операцией разом — как при обрыве связи и повторе
    const twin = saleOp(kassaGoods, { qty: 1 })
    const both = await Promise.all([push(KASSA_A, [twin]), push(KASSA_A, [twin])])
    const statuses = both.map((r) => r.results[0].status).sort()
    assert(statuses[0] === 'duplicate' || statuses[0] === 'ok', 'оба запроса обязаны ответить «принято»: ' + statuses.join(','))
    assert(!statuses.includes('rejected') && !statuses.includes('retry'), 'одновременный повтор не должен давать отказ: ' + statuses.join(','))
    eq((await productById(kassaGoods.id)).stock, 2, 'списана одна упаковка, а не две')
  })

  await check('второй обмен отдаёт только изменившееся', async () => {
    const delta = await pull(KASSA_A, kassaCursor)
    eq(delta.full, false, 'это уже не полный обмен')
    const ids = delta.data.sales.upsert.map((s) => s.id)
    assert(ids.includes(kassaSale.payload.sale.id), 'чек кассы должен вернуться серверной копией')
    eq(delta.data.products.upsert.length, 1, 'изменился один товар — он один и пришёл')
    eq(delta.data.products.upsert[0].stock, 2, 'с новым остатком')
    assert(delta.data.batches.upsert.every((b) => b.productId === kassaGoods.id), 'и только его партии')
    eq(delta.data.categories.upsert.length, 0, 'категории не менялись')
    kassaCursor = delta.cursor

    const quiet = await pull(KASSA_A, kassaCursor)
    eq(quiet.full, false, 'снова не полный')
    const changed = Object.values(quiet.data).reduce((n, d) => n + d.upsert.length + d.remove.length, 0)
    eq(changed, 0, 'ничего не менялось — ничего и не пришло')
  })

  await check('удалённое на сервере приходит кассе как удалённое', async () => {
    const temp = await makeProduct({ name: 'Ненадолго' })
    const withIt = await pull(KASSA_A, kassaCursor)
    assert(withIt.data.products.upsert.some((p) => p.id === temp.id), 'новый товар должен прийти')
    await del('/products/' + temp.id)
    const without = await pull(KASSA_A, withIt.cursor)
    assert(without.data.products.remove.includes(temp.id), 'удалённый товар должен прийти в списке на удаление')
    kassaCursor = without.cursor
  })

  await check('отметка «из будущего» или мусор — касса получает всё заново, а не ошибку', async () => {
    eq((await pull(KASSA_A, '999999999999999')).full, true, 'отметка из будущего (базу поднимали из копии)')
    eq((await pull(KASSA_A, 'abc')).full, true, 'мусор вместо отметки')
  })

  await check('две кассы продали одну и ту же последнюю упаковку: оба чека приняты, расхождение видно владельцу', async () => {
    const last = await makeProduct({ name: 'Последняя', cost: 10, price: 30 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: last.id, qty: 1, cost: 10, expiryDate: daysFromNow(400) }] })
    const a = saleOp(last)
    const b = saleOp(last)
    eq((await push(KASSA_A, [a])).results[0].status, 'ok', 'первая касса')
    eq((await push(KASSA_B, [b])).results[0].status, 'ok', 'вторая касса: чек настоящий, товар отдан — отказывать поздно')
    eq((await productById(last.id)).stock, 0, 'остаток — ноль, а не минус')
    eq((await get('/sales')).filter((s) => s.items.some((i) => i.productId === last.id)).length, 2, 'оба чека в журнале')

    const list = await get('/discrepancies')
    const mine = list.filter((o) => o.productId === last.id)
    eq(mine.length, 1, 'одна запись о продаже сверх остатка')
    eq(mine[0].kind, 'sale', 'вид расхождения — продано больше, чем было')
    eq(mine[0].units, 1, 'сверх остатка — одна упаковка')
    eq(mine[0].docId, b.payload.sale.id, 'и видно, каким чеком')
    eq(mine[0].deviceName, 'Касса 2', 'и на какой кассе')
    await post(`/discrepancies/${mine[0].id}/resolve`, {})
    assert(!(await get('/discrepancies')).some((o) => o.id === mine[0].id), 'разобранная запись уходит из списка')
    // Журнал движений сходится с остатком и здесь
    eq((await get('/sync/moves/' + last.id)).units, 0, 'по журналу движений на полке тоже ноль')
  })

  let priced
  await check('цена в чеке сверяется с историей цен: прежняя цена до её смены — норма, после — расхождение', async () => {
    priced = await makeProduct({ name: 'С ценой', cost: 50, price: 100 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: priced.id, qty: 10, cost: 50, expiryDate: daysFromNow(400) }] })
    priced = await productById(priced.id)
    const mine = async () => (await get('/discrepancies')).filter((d) => d.productId === priced.id)
    const minutes = (n) => new Date(serverNow().getTime() + n * 60000).toISOString()

    // Владелец поднял цену, пока касса была без связи
    await patch('/products/' + priced.id, { price: 150 })

    // Чек пробит ДО смены цены, по тогдашней цене — всё честно
    const before = saleOp(priced, { price: 100, date: minutes(-30) })
    eq((await push(KASSA_A, [before])).results[0].status, 'ok', 'чек по прежней цене, пробитый до её смены')
    eq((await mine()).length, 0, 'расхождения нет: в тот момент цена была именно такой')

    // Чек пробит ПОСЛЕ смены, а цена в нём прежняя: касса о новой не знала
    const after = saleOp(priced, { price: 100, date: minutes(3) })
    eq((await push(KASSA_A, [after])).results[0].status, 'ok', 'чек принят: он уже напечатан')
    eqMoney((await get('/sales')).find((x) => x.id === after.payload.sale.id).total, 100, 'и записан по цене кассы')
    let list = await mine()
    eq(list.length, 1, 'но владелец видит расхождение')
    eq(list[0].kind, 'price', 'вид расхождения — цена')
    eqMoney(list[0].checkPrice, 100, 'цена в чеке')
    eqMoney(list[0].basePrice, 150, 'цена в базе в тот момент')
    eq(list[0].docId, after.payload.sale.id, 'каким чеком')
    eq(list[0].deviceName, 'Касса 1', 'на какой кассе')

    // По новой цене — расхождения нет
    eq((await push(KASSA_A, [saleOp(priced, { price: 150, date: minutes(3) })])).results[0].status, 'ok', 'чек по новой цене')
    eq((await mine()).length, 1, 'чек по новой цене расхождением не считается')

    // Цена, которой у товара не было никогда: её подправили на самой кассе
    const forged = saleOp(priced, { price: 1 })
    eq((await push(KASSA_B, [forged])).results[0].status, 'ok', 'чек с выдуманной ценой тоже принят')
    list = await mine()
    eq(list.length, 2, 'и тоже попал в расхождения')
    const f = list.find((d) => d.docId === forged.payload.sale.id)
    eqMoney(f.checkPrice, 1, 'цена в чеке — выдуманная')
    eqMoney(f.basePrice, 150, 'цена в базе — настоящая')
    for (const d of list) await post(`/discrepancies/${d.id}/resolve`, {})
  })

  await check('остаток по журналу движений равен остатку в карточке', async () => {
    const j = await get('/sync/moves/' + kassaGoods.id)
    eq(j.units, 2, '5 пришло, 3 продано')
    eq(j.moves.reduce((s, m) => s + m.delta, 0), 2, 'сумма движений')
    assert(j.moves.some((m) => m.delta === 5), 'приход записан')
    assert(j.moves.filter((m) => m.delta < 0).length >= 2, 'каждая продажа записана')
  })

  await check('чек, у которого суммы не сходятся с позициями, не принимается — и повтор это помнит', async () => {
    const bad = saleOp(kassaGoods)
    bad.payload.sale.total = 1
    const r = await push(KASSA_A, [bad])
    eq(r.results[0].status, 'rejected', 'испорченный чек отвергнут')
    assert(/не сходятся/.test(r.results[0].error), 'с объяснением: ' + r.results[0].error)
    eq((await push(KASSA_A, [bad])).results[0].status, 'rejected', 'повтор получает тот же отказ')
    eq((await productById(kassaGoods.id)).stock, 2, 'остаток не тронут')
    // Мусор вместо операции — тоже отказ, а не падение сервера
    const junk = await push(KASSA_A, [op('sale', { sale: { id: 'x' } }), op('teleport', {})])
    eq(junk.results.map((x) => x.status).join(), 'rejected,rejected', 'мусор отвергнут')
  })

  await check('возврат и приход с кассы: товар возвращается на полку, цена пересчитывается', async () => {
    const retId = randomUUID()
    const ret = op('return', {
      ret: {
        id: retId, clientId: 'ret_' + retId.slice(0, 8), date: serverNow().toISOString(), saleId: kassaSale.payload.sale.id,
        shiftId: null, refund: 'cash', total: 100, note: '',
        items: [{ id: randomUUID(), returnId: retId, productId: kassaGoods.id, name: kassaGoods.name, units: 1, unitsPerPack: 1, price: 100, cost: 60, amount: 100, restock: true }],
      },
      writeOff: null,
    })
    const arrId = randomUUID()
    const arrival = op('arrival', {
      arrival: {
        id: arrId, date: serverNow().toISOString(), supplier: TAG, total: 240,
        items: [{ id: randomUUID(), arrivalId: arrId, productId: kassaGoods.id, name: kassaGoods.name, qty: 3, cost: 80 }],
      },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })
    const r = await push(KASSA_A, [ret, arrival])
    eq(r.results.map((x) => x.status).join(), 'ok,ok', 'обе операции приняты по порядку')
    const p = await productById(kassaGoods.id)
    eq(p.stock, 6, '2 было + 1 вернули + 3 пришло')
    // (3 × 60 + 3 × 80) / 6 = 70
    eqMoney(p.cost, 70, 'закупочная цена — средневзвешенная')
    assert((await get('/returns')).some((x) => x.id === retId), 'возврат в журнале')
    assert((await get('/arrivals')).some((x) => x.id === arrId), 'приход в журнале')

    const orphan = op('return', {
      ret: { ...ret.payload.ret, id: randomUUID(), clientId: null, saleId: randomUUID(), items: [{ ...ret.payload.ret.items[0], id: randomUUID() }] },
      writeOff: null,
    })
    const bad = await push(KASSA_A, [orphan])
    eq(bad.results[0].status, 'rejected', 'возврат по чеку, которого нет')
    assert(/Чек не найден/.test(bad.results[0].error), bad.results[0].error)
  })

  await check('возврат с кассы сверяется с чеком: лишнее видно владельцу, чужой товар и завышенная сумма — отказ', async () => {
    let back = await makeProduct({ name: 'Возвратный', cost: 10, price: 40 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: back.id, qty: 3, cost: 10, expiryDate: daysFromNow(400) }] })
    back = await productById(back.id)
    const sold = saleOp(back)
    eq((await push(KASSA_A, [sold])).results[0].status, 'ok', 'чек, по которому будут возвращать')
    const saleId = sold.payload.sale.id
    const retOp = (over = {}, item = {}) => {
      const id = randomUUID()
      return op('return', {
        ret: {
          id, clientId: 'ret_' + id.slice(0, 8), date: serverNow().toISOString(), saleId, shiftId: null, refund: 'cash', total: 40, note: '',
          items: [{ id: randomUUID(), returnId: id, productId: back.id, name: back.name, units: 1, unitsPerPack: 1, price: 40, cost: 10, amount: 40, restock: true, ...item }],
          ...over,
        },
        writeOff: null,
      })
    }

    // Покупателю вернули деньги на сайте, а касса без связи оформила тот же возврат ещё раз
    await post('/returns', { saleId, items: [{ productId: back.id, units: 1, restock: true }], clientId: TAG + '-web-ret' })
    const twice = retOp()
    eq((await push(KASSA_A, [twice])).results[0].status, 'ok', 'деньги уже отданы — возврат записан')
    const mine = (await get('/discrepancies')).filter((d) => d.productId === back.id)
    eq(mine.length, 1, 'но владелец видит: вернули больше, чем продали')
    eq(mine[0].kind, 'return', 'вид расхождения — возврат')
    eq(mine[0].units, 1, 'лишняя — одна штука')
    eq(mine[0].docId, twice.payload.ret.id, 'каким возвратом')
    await post(`/discrepancies/${mine[0].id}/resolve`, {})

    // Товар, которого в чеке не было
    const alien = await push(KASSA_A, [retOp({}, { productId: kassaGoods.id, name: kassaGoods.name })])
    eq(alien.results[0].status, 'rejected', 'возврат товара, которого нет в чеке')
    assert(/нет в этом чеке/.test(alien.results[0].error), alien.results[0].error)

    // Вернуть больше, чем за товар заплатили
    const greedy = await push(KASSA_A, [retOp({ total: 400 }, { price: 400, amount: 400 })])
    eq(greedy.results[0].status, 'rejected', 'возврат на сумму больше заплаченной')
    assert(/больше цены/.test(greedy.results[0].error), greedy.results[0].error)
    eq((await productById(kassaGoods.id)).stock, 6, 'отвергнутые возвраты склад не тронули')
  })

  let kassaCashier
  await check('кассир не может прислать списание и чужую операцию; владелец может прислать операцию кассира', async () => {
    const name = TAG + '-kassa'
    const u = await post('/users', { name, password: 'kassa-parol-1', role: 'cashier' })
    created.users.push(u.id)
    kassaCashier = { id: u.id, token: await loginAs(name, 'kassa-parol-1'), name }

    const wo = (units) => op('writeoff', {
      writeOff: { id: randomUUID(), date: serverNow().toISOString(), reason: 'damaged', note: TAG },
      ask: [{ productId: kassaGoods.id, units }],
    })
    const byCashier = await push(KASSA_B, [wo(1)], kassaCashier.token)
    eq(byCashier.results[0].status, 'rejected', 'списание — только владельцу')
    assert(/прав/i.test(byCashier.results[0].error), byCashier.results[0].error)

    // Кассир выдаёт свою операцию за хозяйскую
    const me = await get('/auth/me')
    const forged = await push(KASSA_B, [{ ...wo(1), accountId: me.id }], kassaCashier.token)
    eq(forged.results[0].status, 'rejected', 'чужую операцию кассир прислать не может')
    eq((await productById(kassaGoods.id)).stock, 6, 'остаток не тронут')

    // А владелец — может: так уходит на сервер то, что кассир сделал без связи,
    // когда его собственный вход уже недействителен
    const his = saleOp(kassaGoods)
    const sent = await push(KASSA_B, [{ ...his, accountId: kassaCashier.id }])
    eq(sent.results[0].status, 'ok', 'операция кассира, присланная владельцем')
    const s = (await get('/sales')).find((x) => x.id === his.payload.sale.id)
    eq(s.user?.name, name, 'чек записан на кассира, который его пробил, а не на приславшего')

    const real = await push(KASSA_A, [wo(2)])
    eq(real.results[0].status, 'ok', 'списание владельца')
    eq((await productById(kassaGoods.id)).stock, 3, '6 − 1 продали − 2 списали')
  })

  await check('кассиру обмен не отдаёт журнал списаний', async () => {
    const full = await pull(KASSA_B, undefined, kassaCashier.token)
    eq('writeoffs' in full.data, false, 'у кассира раздела нет вовсе')
    assert(full.data.sales.upsert.length > 0, 'а чеки есть')
    const owner = await pull(KASSA_A)
    assert(owner.data.writeoffs.upsert.length > 0, 'владельцу списания приходят')

    // Владельца за кассой сменил кассир, и при нём на сайте оформили списание.
    // Общая отметка кассы ушла вперёд, а списаний кассир не получал. Владелец,
    // вернувшись, добирает их со своей отметки — без полной загрузки
    const made = await post('/writeoffs', { reason: 'damaged', note: TAG + ' при кассире', items: [{ productId: priced.id, units: 1 }] })
    const atCashier = await pull(KASSA_A, owner.cursor, kassaCashier.token)
    eq('writeoffs' in atCashier.data, false, 'кассиру раздел не приходит и частично')
    assert(BigInt(atCashier.cursor) > BigInt(owner.cursor), 'отметка кассы ушла вперёд')
    const missed = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${atCashier.cursor}`)
    eq(missed.data.writeoffs.upsert.length, 0, 'по одной общей отметке это списание владельцу уже не пришло бы')
    const back = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${atCashier.cursor}&wcursor=${owner.cursor}`)
    eq(back.full, false, 'полная загрузка не нужна')
    eq(back.data.writeoffs.upsert.map((w) => w.id).join(), made.id, 'списание, оформленное при кассире, дошло до владельца')
    // Кассиру своя отметка списаний ничего не открывает
    const sly = await get(`/sync/pull?deviceId=${KASSA_B}&cursor=${atCashier.cursor}&wcursor=1`, kassaCashier.token)
    eq('writeoffs' in sly.data, false, 'кассир списания не получает, что бы ни прислал')
  })

  let kassaShift
  await check('смена своя у каждой кассы и не мешает смене на сайте', async () => {
    kassaShift = { id: randomUUID(), openedAt: serverNow().toISOString(), openingCash: 100 }
    eq((await push(KASSA_A, [op('shift.open', { shift: kassaShift })])).results[0].status, 'ok', 'касса открыла смену')

    // Сайт её открытой не видит — и открывает свою
    assert(!(await get('/shifts')).some((s) => s.id === kassaShift.id), 'сайт принял бы смену кассы за свою')
    const web = await post('/shifts/open', { openingCash: 10 })
    assert(web.id !== kassaShift.id, 'смена сайта — отдельная')

    // Чек с сайта идёт в смену сайта, чек кассы — в смену кассы
    const onWeb = await post('/sales', { items: [{ productId: kassaGoods.id, qty: 1 }], payment: 'card', clientId: TAG + '-web-shift' })
    eq(onWeb.shiftId, web.id, 'чек сайта — в смене сайта')
    const onKassa = saleOp(kassaGoods, { shiftId: kassaShift.id })
    await push(KASSA_A, [onKassa])
    eq((await get('/sales')).find((s) => s.id === onKassa.payload.sale.id).shiftId, kassaShift.id, 'чек кассы — в смене кассы')

    // Вторая открытая смена на той же кассе — отказ
    const second = await push(KASSA_A, [op('shift.open', { shift: { ...kassaShift, id: randomUUID() } })])
    eq(second.results[0].status, 'rejected', 'у кассы одна открытая смена')

    // Вписать чек в смену соседней кассы нельзя: чек принят, но остаётся без смены
    const foreign = saleOp(priced, { shiftId: kassaShift.id })
    eq((await push(KASSA_B, [foreign])).results[0].status, 'ok', 'чек с другой кассы')
    eq((await get('/sales')).find((s) => s.id === foreign.payload.sale.id).shiftId, null, 'в чужую смену он не попал')

    const closedWeb = await post('/shifts/close', { countedCash: 10 })
    eq(closedWeb.id, web.id, 'сайт закрыл свою смену, а не смену кассы')
    eq(closedWeb.count, 1, 'в смене сайта один чек')
  })

  await check('закрытие смены кассы: итоги считает сервер, смена появляется в истории', async () => {
    const close = op('shift.close', { shift: { ...kassaShift, closedAt: serverNow().toISOString(), countedCash: 195 } })
    eq((await push(KASSA_A, [close])).results[0].status, 'ok', 'смена закрыта')
    const s = (await get('/shifts')).find((x) => x.id === kassaShift.id)
    assert(s, 'закрытая смена кассы должна появиться в истории на сайте')
    eq(s.count, 1, 'один чек')
    eqMoney(s.salesCash, 100, 'наличными')
    eqMoney(s.expectedCash, 200, '100 на начало + 100 наличными')
    eqMoney(s.difference, -5, 'в кассе на 5 меньше')
    eq((await push(KASSA_A, [close])).results[0].status, 'duplicate', 'повторное закрытие ничего не меняет')
  })

  await check('клиент, долг и погашение, сделанные без связи', async () => {
    const customer = { id: randomUUID(), name: TAG + ' Должник', phone: '', debt: 0, createdAt: serverNow().toISOString() }
    created.customers.push(customer.id)
    const sale = saleOp(kassaGoods, { payment: 'debt', customerId: customer.id })
    const pay = op('debt.pay', { payment: { id: randomUUID(), customerId: customer.id, amount: 30, shiftId: null, createdAt: serverNow().toISOString() } })
    const r = await push(KASSA_A, [op('customer.create', { customer }), sale, pay])
    eq(r.results.map((x) => x.status).join(), 'ok,ok,ok', 'клиент, чек в долг и погашение — по порядку')
    const c = (await get('/customers')).find((x) => x.id === customer.id)
    eqMoney(c.debt, 70, '100 в долг − 30 погасил')
    assert((await get('/payments')).some((p) => p.id === pay.payload.payment.id), 'погашение в журнале')

    // Чек в долг на клиента, которого нет, записать некуда
    const ghost = saleOp(kassaGoods, { payment: 'debt', customerId: randomUUID() })
    const bad = await push(KASSA_A, [ghost])
    eq(bad.results[0].status, 'rejected', 'долг на несуществующего клиента')
  })

  await check('отложенный штрихкод с кассы; владелец видит, какие кассы есть', async () => {
    const code = '277' + String(Date.now()).slice(-10)
    const d = { id: randomUUID(), barcode: code, createdAt: serverNow().toISOString() }
    await push(KASSA_A, [op('deferred.add', { deferred: d })])
    assert((await get('/deferred')).some((x) => x.barcode === code), 'штрихкод отложен')
    await push(KASSA_A, [op('deferred.remove', { id: d.id, barcode: code })])
    assert(!(await get('/deferred')).some((x) => x.barcode === code), 'штрихкод убран')

    const devices = await get('/sync/devices')
    assert(devices.some((x) => x.id === KASSA_A) && devices.some((x) => x.id === KASSA_B), 'обе кассы в списке')
    await rejects(() => get('/sync/devices', kassaCashier.token), /прав/i, 'список касс — только владельцу')
    await rejects(() => get('/discrepancies', kassaCashier.token), /прав/i, 'расхождения — только владельцу')
  })

  await check('владелец называет кассы по-своему, и имя видно в истории смен', async () => {
    eq((await get('/sync/devices')).find((x) => x.id === KASSA_A).name, 'Касса 1', 'имя, которое дал сервер')
    const renamed = await patch('/sync/devices/' + KASSA_A, { name: '  У входа  ' })
    eq(renamed.name, 'У входа', 'имя сохранено без лишних пробелов')
    const shifts = await get('/shifts')
    eq(shifts.find((x) => x.id === kassaShift.id).deviceName, 'У входа', 'в истории смен видно, на какой кассе была смена')
    assert(!('deviceName' in shifts.find((x) => !x.deviceId)), 'у смены сайта имени кассы нет')
    // Касса получает имя вместе со сменой — и видит, чья смена в общей истории
    const full = await pull(KASSA_B)
    eq(full.data.shifts.upsert.find((x) => x.id === kassaShift.id).deviceName, 'У входа', 'имя кассы приходит и в обмене')

    await rejects(() => patch('/sync/devices/' + KASSA_A, { name: '   ' }), /название/i, 'пустое имя')
    await rejects(() => patch('/sync/devices/' + randomUUID(), { name: 'Нет такой' }), /не найдена/i, 'несуществующая касса')
    await rejects(() => patch('/sync/devices/' + KASSA_A, { name: 'Моя' }, kassaCashier.token), /прав/i, 'кассир кассы не переименовывает')
  })

  await check('касса называет отметку, которой сервер ей не выдавал, — получает всё заново', async () => {
    // Так выглядит база сервера, поднятая из копии или перенесённая: касса успела
    // получить то, чего в базе теперь нет. «Изменения» ей не помогут — нужно всё

    // Сервер о кассе не знает вовсе, а она приходит с отметкой
    eq((await pull(randomUUID(), kassaCursor)).full, true, 'незнакомая касса с отметкой')

    // Сервер помнит более раннюю отметку, чем называет касса
    const mine = randomUUID()
    const first = await pull(mine)
    const later = await makeProduct({ name: 'После копии' })
    const ahead = await pull(mine, String(BigInt(first.cursor) + 1n))
    eq(ahead.full, true, 'отметка кассы новее выданной')
    assert(ahead.data.products.upsert.some((p) => p.id === later.id), 'в полном ответе есть всё, что на сервере сейчас')

    // Дальше — как обычно: только изменившееся
    eq((await pull(mine, ahead.cursor)).full, false, 'после полной загрузки обмен снова частичный')

    // А отметка старше выданной — обычное дело: прошлый ответ до кассы не дошёл.
    // Она спрашивает с прежнего места и получает изменения, а не весь магазин
    const lost = await pull(mine, first.cursor)
    eq(lost.full, false, 'потерянный ответ — не повод отдавать всё заново')
    assert(lost.data.products.upsert.some((p) => p.id === later.id), 'изменения с прежней отметки на месте')
  })

  // Запас товара для проверок ниже — чтобы они не зависели от остатков, оставшихся выше
  let plenty
  const minutesAgo = (n) => new Date(serverNow().getTime() - n * 60000).toISOString()

  await check('копеечное округление — не повод отвергать настоящий чек или приход', async () => {
    plenty = await makeProduct({ name: 'Запас', cost: 60, price: 100 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: plenty.id, qty: 60, cost: 60, expiryDate: daysFromNow(400) }] })
    plenty = await productById(plenty.id)

    // Таблетка из упаковки «10 сомони за 3 штуки» стоит 3,3333… Первую отдали даром:
    // скидку, срезанную до суммы позиции, касса считает точно, а в чек пишет 3.33
    const frac = await makeProduct({ name: 'Дробный', cost: 6, price: 10, unitsPerPack: 3 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: frac.id, qty: 5, cost: 6, expiryDate: daysFromNow(400) }] })
    const id = randomUUID()
    const line = (discount) => ({ id: randomUUID(), saleId: id, productId: frac.id, name: frac.name, qty: 0, pieces: 1, unitsPerPack: 3, price: 10, cost: 6, discount })
    const sale = op('sale', {
      sale: {
        id, clientId: 'tmp_' + id.slice(0, 8), date: serverNow().toISOString(), total: 3.33, cost: 4, profit: -0.67,
        payment: 'cash', customerId: null, shiftId: null, items: [line(3.33), line(0)],
      },
    })
    const r = await push(KASSA_A, [sale])
    eq(r.results[0].status, 'ok', 'чек с разницей в дирам принят: ' + (r.results[0].error || ''))
    eqMoney((await get('/sales')).find((x) => x.id === id).total, 3.33, 'и записан с суммой кассы — той, что напечатана на чеке')
    const left = await productById(frac.id)
    eq(left.stock * 3 + left.looseUnits, 13, 'две штуки списаны')

    // Закупочная цена 33,333 за упаковку: три упаковки — 99,999, то есть 100.00
    const arrId = randomUUID()
    const arrival = op('arrival', {
      arrival: { id: arrId, date: serverNow().toISOString(), supplier: TAG, total: 100, items: [{ id: randomUUID(), arrivalId: arrId, productId: frac.id, name: frac.name, qty: 3, cost: 33.333 }] },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })
    const a = await push(KASSA_A, [arrival])
    eq(a.results[0].status, 'ok', 'приход с дробной закупочной ценой принят: ' + (a.results[0].error || ''))
    eqMoney((await get('/arrivals')).find((x) => x.id === arrId).total, 100, 'сумма прихода — как на кассе')

    // А вот чек, где суммы расходятся по-настоящему, по-прежнему не проходит
    const wrong = saleOp(plenty)
    wrong.payload.sale.total = 99.5
    eq((await push(KASSA_A, [wrong])).results[0].status, 'rejected', 'полсомони разницы на одну позицию — уже не округление')
  })

  await check('остаток пересчитали, пока касса была без связи: её прежние операции второй раз не считаются', async () => {
    const cat = TAG + '-peresch'
    let cnt = await makeProduct({ name: 'Пересчитанный', cost: 10, price: 20, category: cat })
    await post('/arrivals', { supplier: TAG, items: [{ productId: cnt.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    cnt = await productById(cnt.id)
    const mine = async () => (await get('/discrepancies')).filter((d) => d.productId === cnt.id)

    // Час назад касса без связи продала три упаковки и приняла пять. Сервер об этом не знает
    const sold = saleOp(cnt, { qty: 3, date: minutesAgo(60) })
    const arrId = randomUUID()
    const came = op('arrival', {
      arrival: { id: arrId, date: minutesAgo(50), supplier: TAG, total: 50, items: [{ id: randomUUID(), arrivalId: arrId, productId: cnt.id, name: cnt.name, qty: 5, cost: 10 }] },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })
    // Владелец пересчитал полку: на ней двенадцать (10 − 3 + 5). Применил пересчёт
    const sheet = await post('/inventory', { scope: cat, note: TAG + '-kassa' })
    await patch('/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 12 }] })
    await post('/inventory/' + sheet.id + '/apply', {})
    eq((await productById(cnt.id)).stock, 12, 'после пересчёта — двенадцать')

    // Касса вышла на связь
    const r = await push(KASSA_A, [sold, came])
    eq(r.results.map((x) => x.status).join(), 'ok,ok', 'чек и приход приняты')
    eq((await productById(cnt.id)).stock, 12, 'остаток не тронут: пересчёт всё это уже учёл')
    assert((await get('/sales')).some((x) => x.id === sold.payload.sale.id), 'чек в журнале есть')
    assert((await get('/arrivals')).some((x) => x.id === arrId), 'приход в журнале есть')
    let list = await mine()
    eq(list.map((d) => d.kind).join(), 'counted,counted', 'владелец видит обе операции')
    eq(list.map((d) => d.units).sort((x, y) => x - y).join(), '3,5', 'и сколько штук в каждой')
    // Лист пересчёта считал «должно быть 10» — без продажи и прихода кассы. Теперь он
    // знает, что должно было быть 12: ровно столько и насчитали, недостачи нет
    const line = (await get('/inventory')).find((x) => x.id === sheet.id).items[0]
    eq(line.expectedUnits, 12, 'лист пересчёта: «должно быть» — с учётом операций кассы')
    eq(line.actualUnits, 12, 'насчитано — как насчитали')
    eq((await get('/writeoffs')).filter((w) => w.items.some((i) => i.productId === cnt.id)).length, 0, 'недостачи по товару нет')

    // Чек, пробитый ПОСЛЕ пересчёта, вычитается как обычно. (Несколько секунд запаса:
    // часы проверки сверены с сервером до секунды, а пересчёт применён только что)
    const afterCount = new Date(serverNow().getTime() + 5000).toISOString()
    eq((await push(KASSA_A, [saleOp(cnt, { qty: 2, date: afterCount })])).results[0].status, 'ok', 'чек после пересчёта')
    eq((await productById(cnt.id)).stock, 10, '12 − 2')
    eq((await mine()).length, 2, 'и расхождением не считается')
    for (const d of await mine()) await post(`/discrepancies/${d.id}/resolve`, {})

    // То же, когда число на полке поправили прямо в карточке товара
    let card = await makeProduct({ name: 'Правленый', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: card.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    card = await productById(card.id)
    const before = saleOp(card, { qty: 2, date: minutesAgo(20) })
    await patch('/products/' + card.id, { stock: 8 })
    eq((await push(KASSA_A, [before])).results[0].status, 'ok', 'чек, пробитый до правки остатка')
    eq((await productById(card.id)).stock, 8, 'правка остатка эту продажу уже учла')
    const flagged = (await get('/discrepancies')).filter((d) => d.productId === card.id)
    eq(flagged.map((d) => d.kind).join(), 'counted', 'и владелец это видит')
    await post(`/discrepancies/${flagged[0].id}/resolve`, {})

    // А правка карточки, которая остаток не меняла (цена), ничего не «учитывает»
    let plain = await makeProduct({ name: 'Переоценённый', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: plain.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    plain = await productById(plain.id)
    const old = saleOp(plain, { qty: 2, date: minutesAgo(20) })
    await patch('/products/' + plain.id, { price: 25, stock: 10 })
    eq((await push(KASSA_A, [old])).results[0].status, 'ok', 'чек, пробитый до смены цены')
    eq((await productById(plain.id)).stock, 8, 'вычтен как обычно')
    eq((await get('/discrepancies')).filter((d) => d.productId === plain.id).length, 0, 'расхождений нет: цена в тот момент была прежней')
  })

  await check('недостача по пересчёту поправляется сама, когда выясняется, что товар продан или списан кассой', async () => {
    const cat = TAG + '-nedostacha'
    let x = await makeProduct({ name: 'Недостача', cost: 10, price: 20, category: cat })
    await post('/arrivals', { supplier: TAG, items: [{ productId: x.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    x = await productById(x.id)
    const lost = async () => (await get('/writeoffs')).filter((w) => w.source === 'inventory' && w.items.some((i) => i.productId === x.id))
    const lostUnits = async () => (await lost()).flatMap((w) => w.items).filter((i) => i.productId === x.id).reduce((n, i) => n + i.units, 0)
    const sheetLine = async (id) => (await get('/inventory')).find((s) => s.id === id).items[0]

    // Касса без связи: час назад продала три упаковки, сорок минут назад владелец на ней
    // списал одну (просрочка), полчаса назад приняла две. Сервер ничего этого не знает
    const sold = saleOp(x, { qty: 3, date: minutesAgo(60) })
    const woId = randomUUID()
    const written = op('writeoff', { writeOff: { id: woId, date: minutesAgo(40), reason: 'expired', note: TAG }, ask: [{ productId: x.id, units: 1 }] })
    const arrId = randomUUID()
    const came = op('arrival', {
      arrival: { id: arrId, date: minutesAgo(30), supplier: TAG, total: 20, items: [{ id: randomUUID(), arrivalId: arrId, productId: x.id, name: x.name, qty: 2, cost: 10 }] },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })

    // На полке должно лежать 10 − 3 − 1 + 2 = 8. Владелец насчитал шесть: двух нет.
    // Но сервер думает, что должно быть десять, и записывает в недостачу четыре
    const sheet = await post('/inventory', { scope: cat, note: TAG + '-nedostacha' })
    await patch('/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 6 }] })
    await post('/inventory/' + sheet.id + '/apply', {})
    eq(await lostUnits(), 4, 'пересчёт записал недостачу: четыре упаковки')
    eqMoney((await lost())[0].totalCost, 40, 'на сорок сомони')

    // Касса вышла на связь. Чек: три из «недостающих» проданы
    eq((await push(KASSA_A, [sold])).results[0].status, 'ok', 'чек принят')
    eq((await productById(x.id)).stock, 6, 'остаток — как насчитали')
    eq(await lostUnits(), 1, 'недостача уменьшилась: три упаковки не пропали, а проданы')
    eqMoney((await lost())[0].totalCost, 10, 'и её сумма тоже')
    eq((await sheetLine(sheet.id)).expectedUnits, 7, 'лист: должно было быть семь')

    // Списание: ещё одна «недостающая» была списана как просрочка. Убыток остаётся,
    // но один раз и со своей причиной
    const w = await push(KASSA_A, [written])
    eq(w.results[0].status, 'ok', 'списание принято')
    eq(w.results[0].docId, woId, 'и записано документом')
    const doc = (await get('/writeoffs')).find((d) => d.id === woId)
    eq(doc.reason, 'expired', 'причина — та, что указала касса')
    eq(doc.items.map((i) => i.units).join(), '1', 'одна упаковка')
    eqMoney(doc.totalCost, 10, 'по закупочной цене')
    eq((await lost()).length, 0, 'недостачи по пересчёту не осталось вовсе — документ убран')
    eq((await productById(x.id)).stock, 6, 'остаток не тронут')

    // Приход: две упаковки приняли ДО пересчёта, значит, на полке их не хватает
    eq((await push(KASSA_A, [came])).results[0].status, 'ok', 'приход принят')
    eq((await productById(x.id)).stock, 6, 'остаток не тронут: принятое уже было на полке, когда считали')
    eq(await lostUnits(), 2, 'настоящая недостача — две упаковки')
    eqMoney((await lost())[0].totalCost, 20, 'на двадцать сомони')
    const line = await sheetLine(sheet.id)
    eq([line.expectedUnits, line.actualUnits].join(), '8,6', 'лист: должно было быть восемь, насчитали шесть')
    for (const d of (await get('/discrepancies')).filter((d) => d.productId === x.id)) await post(`/discrepancies/${d.id}/resolve`, {})

    // Остаток поправили в карточке (листа пересчёта нет): списание кассы, сделанное
    // раньше, всё равно записывается документом — иначе убыток не попал бы никуда
    let y = await makeProduct({ name: 'Списанный до правки', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: y.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    y = await productById(y.id)
    const earlyId = randomUUID()
    const early = op('writeoff', { writeOff: { id: earlyId, date: minutesAgo(20), reason: 'damaged', note: TAG }, ask: [{ productId: y.id, units: 2 }] })
    await patch('/products/' + y.id, { stock: 8 })
    const r = await push(KASSA_A, [early])
    eq(r.results[0].docId, earlyId, 'списание записано')
    eq((await get('/writeoffs')).find((d) => d.id === earlyId).items.map((i) => i.units).join(), '2', 'две упаковки')
    eq((await productById(y.id)).stock, 8, 'остаток — как поправили в карточке')
    for (const d of (await get('/discrepancies')).filter((d) => d.productId === y.id)) await post(`/discrepancies/${d.id}/resolve`, {})
  })

  await check('итог пересчёта не зависит от порядка, в котором кассы прислали операции, а сумма недостачи не расходится с её позициями', async () => {
    const lostOf = async (id) => (await get('/writeoffs')).filter((w) => w.source === 'inventory' && w.items.some((i) => i.productId === id))
    const unitsOf = (docs, id) => docs.flatMap((w) => w.items).filter((i) => i.productId === id).reduce((n, i) => n + i.units, 0)
    const lineOf = async (sheetId, id) => (await get('/inventory')).find((s) => s.id === sheetId).items.find((i) => i.productId === id)
    const count = async (cat, id, units) => {
      const sheet = await post('/inventory', { scope: cat, note: TAG })
      await patch('/inventory/' + sheet.id, { items: [{ id: sheet.items.find((i) => i.productId === id).id, actualUnits: units }] })
      await post('/inventory/' + sheet.id + '/apply', {})
      return sheet
    }
    const settle = async (id) => {
      for (const d of (await get('/discrepancies')).filter((d) => d.productId === id)) await post(`/discrepancies/${d.id}/resolve`, {})
    }

    // ── Порядок ──
    // На учёте две упаковки. Без связи одна касса приняла десять, другая потом продала
    // пять: на полке 2 + 10 − 5 = 7. Столько владелец и насчитал
    const catA = TAG + '-poryadok'
    let a = await makeProduct({ name: 'Порядок', cost: 10, price: 20, category: catA })
    await post('/arrivals', { supplier: TAG, items: [{ productId: a.id, qty: 2, cost: 10, expiryDate: daysFromNow(400) }] })
    a = await productById(a.id)
    const arrId = randomUUID()
    const came = op('arrival', {
      arrival: { id: arrId, date: minutesAgo(90), supplier: TAG, total: 100, items: [{ id: randomUUID(), arrivalId: arrId, productId: a.id, name: a.name, qty: 10, cost: 10 }] },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })
    const sold = saleOp(a, { qty: 5, date: minutesAgo(60) })
    const sheetA = await count(catA, a.id, 7)
    eq((await lostOf(a.id)).length, 0, 'насчитали больше, чем на учёте, — недостачи нет')
    // Первой на связь вышла касса с продажей — хотя приход был раньше
    eq((await push(KASSA_A, [sold])).results[0].status, 'ok', 'чек принят')
    eq((await lineOf(sheetA.id, a.id)).expectedUnits, -3, 'с одной этой продажей «по учёту» выходит минус три — и нулём не обрезается')
    eq((await push(KASSA_B, [came])).results[0].status, 'ok', 'приход принят')
    eq((await lineOf(sheetA.id, a.id)).expectedUnits, 7, 'с приходом — семь: ровно столько и насчитали')
    eq((await lostOf(a.id)).length, 0, 'недостачи нет: обрезанное нулём дало бы «должно быть десять» и три упаковки убытка')
    eq((await productById(a.id)).stock, 7, 'остаток — как насчитали')
    await settle(a.id)

    // ── Округление ──
    // Упаковка из трёх штук за десять сомони: штука стоит 3,3333… Без связи касса
    // продала восемь штук — по одной. На полке 30 − 8 = 22, насчитали двадцать
    const catB = TAG + '-okruglenie'
    let b = await makeProduct({ name: 'Поштучный', cost: 10, price: 30, unitsPerPack: 3, category: catB })
    await post('/arrivals', { supplier: TAG, items: [{ productId: b.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    b = await productById(b.id)
    const singles = Array.from({ length: 8 }, (_, n) => saleOp(b, { qty: 0, pieces: 1, upp: 3, date: minutesAgo(60 - n) }))
    await count(catB, b.id, 20)
    eq(unitsOf(await lostOf(b.id), b.id), 10, 'пересчёт записал недостачу: десять штук')
    eqMoney((await lostOf(b.id))[0].totalCost, 33.33, 'на 33,33')
    for (const s of singles) eq((await push(KASSA_A, [s])).results[0].status, 'ok', 'чек на одну штуку принят')
    const left = await lostOf(b.id)
    eq(unitsOf(left, b.id), 2, 'настоящая недостача — две штуки')
    eq(money(left[0].totalCost), 6.67, 'и стоит она ровно столько, сколько её позиции: ошибка округления не копится')
    eq((await productById(b.id)).stock * 3 + (await productById(b.id)).looseUnits, 20, 'остаток — как насчитали')
    await settle(b.id)

    // ── «Штук в упаковке» поправили после пересчёта ──
    // Упаковка из десяти за сто сомони. Касса продала три штуки, на полке 17, насчитали 16
    const catC = TAG + '-upakovka'
    let c = await makeProduct({ name: 'Переупакованный', cost: 100, price: 200, unitsPerPack: 10, category: catC })
    await post('/arrivals', { supplier: TAG, items: [{ productId: c.id, qty: 2, cost: 100, expiryDate: daysFromNow(400) }] })
    c = await productById(c.id)
    const three = saleOp(c, { qty: 0, pieces: 3, upp: 10, date: minutesAgo(60) })
    await count(catC, c.id, 16)
    eqMoney((await lostOf(c.id))[0].totalCost, 40, 'недостача: четыре штуки по десять сомони')
    await patch('/products/' + c.id, { unitsPerPack: 20 })
    eq((await push(KASSA_A, [three])).results[0].status, 'ok', 'чек принят')
    const rest = await lostOf(c.id)
    eq(unitsOf(rest, c.id), 1, 'недостача — одна штука')
    eq(money(rest[0].totalCost), 10, 'по той цене штуки, по какой её оценил пересчёт, — а не вперемешку с новой')
    await settle(c.id)

    // ── Недостача выросла уже после правки карточки ──
    // Упаковка из десяти за сто (штука — десять сомони). Насчитали шестнадцать при двадцати
    // на учёте: недостача четыре штуки, сорок сомони. Потом карточку поправили: в упаковке
    // двадцать штук и стоит она двести (штука — те же десять). И тут касса прислала приход,
    // принятый ДО пересчёта: недостача выросла, и каждая новая штука стоит те же десять
    const catD = TAG + '-dorozhe'
    let d = await makeProduct({ name: 'Подорожавшая упаковка', cost: 100, price: 200, unitsPerPack: 10, category: catD })
    await post('/arrivals', { supplier: TAG, items: [{ productId: d.id, qty: 2, cost: 100, expiryDate: daysFromNow(400) }] })
    d = await productById(d.id)
    await count(catD, d.id, 16)
    eq(money((await lostOf(d.id))[0].totalCost), 40, 'недостача: четыре штуки по десять')
    await patch('/products/' + d.id, { unitsPerPack: 20, cost: 200 })
    const lateId = randomUUID()
    const late = op('arrival', {
      arrival: { id: lateId, date: minutesAgo(90), supplier: TAG, total: 20, items: [{ id: randomUUID(), arrivalId: lateId, productId: d.id, name: d.name, qty: 2, cost: 10 }] },
      expiry: [daysFromNow(500) + 'T00:00:00.000Z'],
    })
    eq((await push(KASSA_B, [late])).results[0].status, 'ok', 'приход принят')
    const grown = await lostOf(d.id)
    const added = unitsOf(grown, d.id) - 4
    assert(added > 0, 'недостача выросла')
    eq(money(grown[0].totalCost), 40 + added * 10, 'новая строка стоит по десять сомони за штуку, а не по двадцать')
    await settle(d.id)

    // ── Половинка дирама ──
    // Упаковка из двенадцати за 2,50. Недостача трёх штук стоит 0,625 — то есть 0,63.
    // Пересчёт и его поправка обязаны считать одной формулой: когда пересчёт записал
    // 0,62, а поправка вычитала 0,63, сумма списания расходилась с его строками на дирам
    const catE = TAG + '-diram'
    let e = await makeProduct({ name: 'Половинка дирама', cost: 2.5, price: 6, unitsPerPack: 12, category: catE })
    await post('/arrivals', { supplier: TAG, items: [{ productId: e.id, qty: 1, cost: 2.5, expiryDate: daysFromNow(400) }] })
    e = await productById(e.id)
    const one = saleOp(e, { qty: 0, pieces: 1, upp: 12, date: minutesAgo(60) })
    await count(catE, e.id, 9)
    eq(unitsOf(await lostOf(e.id), e.id), 3, 'пересчёт записал недостачу: три штуки')
    eq(money((await lostOf(e.id))[0].totalCost), 0.63, 'на 0,63 — как и её строки')
    eq((await push(KASSA_A, [one])).results[0].status, 'ok', 'чек на одну штуку принят')
    const two = await lostOf(e.id)
    eq(unitsOf(two, e.id), 2, 'настоящая недостача — две штуки')
    eq(money(two[0].totalCost), 0.42, 'и стоит 0,42: 2,50 × 2 / 12, а не на дирам меньше')
    await settle(e.id)
  })

  await check('срок годности, который база не хранит, от кассы: операция отвергнута, а очередь кассы не встала', async () => {
    let y = await makeProduct({ name: 'Год с опечаткой', cost: 10, price: 20 })
    const badId = randomUUID()
    const bad = op('arrival', {
      arrival: { id: badId, date: minutesAgo(30), supplier: TAG, total: 10, items: [{ id: randomUUID(), arrivalId: badId, productId: y.id, name: y.name, qty: 1, cost: 10 }] },
      expiry: ['+020266-01-01T00:00:00.000Z'],
    })
    const goodId = randomUUID()
    const good = op('arrival', {
      arrival: { id: goodId, date: minutesAgo(20), supplier: TAG, total: 20, items: [{ id: randomUUID(), arrivalId: goodId, productId: y.id, name: y.name, qty: 2, cost: 10 }] },
      expiry: [daysFromNow(400) + 'T00:00:00.000Z'],
    })
    // Раньше сервер отвечал на такую операцию «не смог, пришлите ещё раз» — и так без
    // конца: записать её нельзя никогда, а за ней стояла вся очередь кассы
    const res = (await push(KASSA_A, [bad, good])).results
    eq(res[0].status, 'rejected', 'приход со сроком в 20266 году отвергнут по существу')
    assert(/Недопустимая дата: срок годности/.test(res[0].error), 'и с понятной причиной: ' + res[0].error)
    eq(res[1].status, 'ok', 'следующая операция кассы прошла')
    eq((await productById(y.id)).stock, 2, 'на полке — только настоящий приход')
  })

  await check('возврат с кассы: срок годности — вписанный кассиром, а если его нет — по партиям сервера', async () => {
    const near = daysFromNow(200)
    const far = daysFromNow(500)
    const iso = (d) => d + 'T00:00:00.000Z'
    let r = await makeProduct({ name: 'Возврат с кассы со сроком', cost: 10, price: 20 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: r.id, qty: 2, cost: 10, expiryDate: near }] })
    r = await productById(r.id)
    const s1 = saleOp(r, { qty: 1, date: minutesAgo(30) })
    const s2 = saleOp(r, { qty: 1, date: minutesAgo(29) })
    eq((await push(KASSA_A, [s1, s2])).results.map((x) => x.status).join(), 'ok,ok', 'оба чека приняты')
    r = await productById(r.id)
    eq([r.stock, r.expiryDate].join(), '0,', 'обе упаковки проданы — склад пуст')

    const retOp = (sale, extra = {}) => {
      const id = randomUUID()
      return op('return', {
        ret: {
          id, clientId: 'ret_' + id.slice(0, 8), date: serverNow().toISOString(), saleId: sale.payload.sale.id,
          shiftId: null, refund: 'cash', total: 20, note: '',
          items: [{ id: randomUUID(), returnId: id, productId: r.id, name: r.name, units: 1, unitsPerPack: 1, price: 20, cost: 10, amount: 20, restock: true, ...extra }],
        },
        writeOff: null,
      })
    }
    // Кассир срок не вписал. Касса знает не все распроданные партии — срок ставит сервер
    eq((await push(KASSA_A, [retOp(s1)])).results[0].status, 'ok', 'возврат без срока принят')
    r = await productById(r.id)
    eq([r.stock, r.expiryDate].join(), `1,${iso(near)}`, 'сервер поставил срок партии, из которой товар был продан')

    // Кассир вписал срок с упаковки — берётся он
    eq((await push(KASSA_A, [retOp(s2, { expiryDate: iso(far) })])).results[0].status, 'ok', 'возврат со сроком принят')
    eq((await productById(r.id)).stock, 2, 'на полке две упаковки')
    // Ближняя уйдёт первой — и в карточке останется срок, вписанный кассиром
    await post('/sales', { items: [{ productId: r.id, qty: 1 }], payment: 'cash', clientId: TAG + '-ret-kassa' })
    eq((await productById(r.id)).expiryDate, iso(far), 'вторая упаковка — со сроком с коробки')

    // Лишняя цифра в годе: отказ по существу, а не операция, которая не пройдёт никогда
    const s3 = saleOp(r, { qty: 1, date: minutesAgo(5) })
    await push(KASSA_A, [s3])
    const bad = (await push(KASSA_A, [retOp(s3, { expiryDate: '+020266-01-01T00:00:00.000Z' })])).results[0]
    eq(bad.status, 'rejected', 'возврат со сроком в 20266 году отвергнут')
    assert(/Недопустимая дата: срок годности/.test(bad.error), bad.error)
  })

  await check('два возврата одной позиции разом: второй видит первый', async () => {
    let once = await makeProduct({ name: 'Возврат разом', cost: 10, price: 40 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: once.id, qty: 5, cost: 10, expiryDate: daysFromNow(400) }] })
    once = await productById(once.id)

    // На сайте: два окна нажали «вернуть» в одну и ту же секунду
    const web = await post('/sales', { items: [{ productId: once.id, qty: 1 }], payment: 'cash', clientId: TAG + '-razom' })
    const tries = await Promise.allSettled([
      post('/returns', { saleId: web.id, items: [{ productId: once.id, units: 1, restock: true }] }),
      post('/returns', { saleId: web.id, items: [{ productId: once.id, units: 1, restock: true }] }),
    ])
    eq(tries.map((t) => t.status).sort().join(), 'fulfilled,rejected', 'прошёл один возврат из двух')
    assert(/уже возвращено 1 из 1/.test(tries.find((t) => t.status === 'rejected').reason.message), 'второй получил отказ: ' + tries.find((t) => t.status === 'rejected').reason.message)
    eq((await productById(once.id)).stock, 5, 'на полку вернулась одна упаковка, а не две')

    // С двух касс без связи: оба возврата записаны (деньги отданы), но владелец видит лишний
    const sold = saleOp(once)
    await push(KASSA_A, [sold])
    const ret = () => {
      const id = randomUUID()
      return op('return', {
        ret: {
          id, clientId: 'ret_' + id.slice(0, 8), date: serverNow().toISOString(), saleId: sold.payload.sale.id, shiftId: null, refund: 'cash', total: 40, note: '',
          items: [{ id: randomUUID(), returnId: id, productId: once.id, name: once.name, units: 1, unitsPerPack: 1, price: 40, cost: 10, amount: 40, restock: true }],
        },
        writeOff: null,
      })
    }
    const both = await Promise.all([push(KASSA_A, [ret()]), push(KASSA_B, [ret()])])
    eq(both.map((x) => x.results[0].status).join(), 'ok,ok', 'оба возврата приняты')
    const flagged = (await get('/discrepancies')).filter((d) => d.productId === once.id && d.kind === 'return')
    eq(flagged.length, 1, 'и лишний виден: раньше оба «не видели» друг друга, и расхождения не было')
    await post(`/discrepancies/${flagged[0].id}/resolve`, {})
  })

  await check('клиент заплатил на кассе долг, которого уже нет, — владелец это видит', async () => {
    const debtor = { id: randomUUID(), name: TAG + ' Переплатил', phone: '', debt: 0, createdAt: serverNow().toISOString() }
    created.customers.push(debtor.id)
    const inDebt = saleOp(plenty, { payment: 'debt', customerId: debtor.id })
    eq((await push(KASSA_A, [op('customer.create', { customer: debtor }), inDebt])).results.map((x) => x.status).join(), 'ok,ok', 'клиент и чек в долг')
    // Долг погасили на сайте…
    await post(`/customers/${debtor.id}/pay`, { amount: 100 })
    // …а касса без связи приняла от клиента те же сто сомони ещё раз
    const payId = randomUUID()
    const pay = op('debt.pay', { payment: { id: payId, customerId: debtor.id, amount: 100, shiftId: null, createdAt: serverNow().toISOString() } })
    eq((await push(KASSA_A, [pay])).results[0].status, 'ok', 'деньги уже в кассе — погашение записано')
    eqMoney((await get('/customers')).find((c) => c.id === debtor.id).debt, 0, 'долг — ноль, а не минус')
    const flagged = (await get('/discrepancies')).filter((d) => d.docId === payId)
    eq(flagged.length, 1, 'лишние деньги не пропали молча')
    eq(flagged[0].kind, 'debt', 'вид расхождения — долг')
    eq(flagged[0].name, debtor.name, 'чей долг')
    eqMoney(flagged[0].checkPrice, 100, 'сколько принято')
    eqMoney(flagged[0].basePrice, 0, 'сколько был должен')
    await post(`/discrepancies/${flagged[0].id}/resolve`, {})

    // Два погашения разом с двух касс: оба должны уменьшить долг
    const two = { id: randomUUID(), name: TAG + ' Две кассы', phone: '', debt: 0, createdAt: serverNow().toISOString() }
    created.customers.push(two.id)
    await push(KASSA_A, [op('customer.create', { customer: two }), saleOp(plenty, { payment: 'debt', customerId: two.id })])
    const part = (amount) => op('debt.pay', { payment: { id: randomUUID(), customerId: two.id, amount, shiftId: null, createdAt: serverNow().toISOString() } })
    const both = await Promise.all([push(KASSA_A, [part(30)]), push(KASSA_B, [part(40)])])
    eq(both.map((x) => x.results[0].status).join(), 'ok,ok', 'оба погашения приняты')
    eqMoney((await get('/customers')).find((c) => c.id === two.id).debt, 30, '100 − 30 − 40: ни одно погашение не потерялось')
  })

  await check('обмен отвечает о судьбе операций, на которые касса не дождалась ответа', async () => {
    const cur = (await pull(KASSA_A, kassaCursor)).cursor
    // Принята, а ответ «потерялся»
    const sent = saleOp(plenty)
    await push(KASSA_A, [sent])
    // До сервера не дошла вовсе
    const never = saleOp(plenty)
    // Отвергнута
    const bad = saleOp(plenty)
    bad.payload.sale.total = 1
    await push(KASSA_A, [bad])

    const r = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${cur}&ops=${[sent.id, never.id, bad.id].join(',')}`)
    eq(r.ops[sent.id]?.status, 'ok', 'принятая')
    eq(r.ops[sent.id]?.docId, sent.payload.sale.id, 'и каким чеком она стала')
    eq(never.id in r.ops, false, 'о недошедшей сервер ничего не знает')
    eq(r.ops[bad.id]?.status, 'rejected', 'отвергнутая')
    assert(/не сходятся/.test(r.ops[bad.id].error), 'с причиной: ' + r.ops[bad.id].error)
    // Ответ и данные — из одного снимка: принятый чек в этих же данных и лежит
    assert(r.data.sales.upsert.some((x) => x.id === sent.payload.sale.id), 'принятый чек пришёл в том же ответе')
    assert(r.data.products.upsert.some((x) => x.id === plenty.id), 'вместе с товаром, который он списал')
    // О чужих операциях другой кассе знать незачем
    const other = await get(`/sync/pull?deviceId=${KASSA_B}&ops=${sent.id}`)
    eq(sent.id in other.ops, false, 'соседняя касса ответа не получает')
    // Мусор вместо номеров — не ошибка
    eq(Object.keys((await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${r.cursor}&ops=,,%20,${'x'.repeat(70)}`)).ops).length, 0, 'мусор в списке')
  })

  await check('номер кассы закрепляется за её ключом: соседняя касса не может выдать себя за неё', async () => {
    // Свой заголовок общий помощник не умеет — ходим сами
    const withKey = async (method, path, key, body) => {
      const res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken(), ...(key ? { 'X-Device-Key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, data: await res.json().catch(() => null) }
    }
    const kassa = randomUUID()
    const key = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
    eq((await withKey('GET', `/sync/pull?deviceId=${kassa}`, key)).status, 200, 'первый обмен — касса называет ключ')
    eq((await withKey('POST', '/sync/push', key, { deviceId: kassa, ops: [saleOp(plenty)] })).status, 201, 'с тем же ключом — принято')

    // Кто-то другой называет её номер: с чужим ключом и вовсе без ключа
    const shift = op('shift.open', { shift: { id: randomUUID(), openedAt: serverNow().toISOString(), openingCash: 0 } })
    const forged = await withKey('POST', '/sync/push', 'x'.repeat(40), { deviceId: kassa, ops: [shift] })
    eq(forged.status, 409, 'чужой ключ')
    assert(/закреплён за другой установкой/.test(forged.data?.message || ''), 'с объяснением: ' + forged.data?.message)
    eq((await withKey('POST', '/sync/push', '', { deviceId: kassa, ops: [shift] })).status, 409, 'без ключа')
    eq((await withKey('GET', `/sync/pull?deviceId=${kassa}`, '')).status, 409, 'и получить её данные без ключа нельзя')
    eq((await withKey('GET', `/sync/pull?deviceId=${kassa}`, 'short')).status, 400, 'мусор вместо ключа')
    eq((await get('/sync/devices')).find((d) => d.id === kassa).openShift, null, 'смена от её имени не открылась')
    // Касса, которая ключа никогда не называла (проверки выше), работает как работала
    eq((await push(KASSA_A, [saleOp(plenty)])).results[0].status, 'ok', 'касса без ключа')
  })

  await check('давний чек касса получает целиком — с прежними возвратами', async () => {
    const got = await get('/sync/sale/' + kassaSale.payload.sale.id)
    eq(got.sale.id, kassaSale.payload.sale.id, 'сам чек')
    eq(got.sale.items.length, 1, 'с позициями')
    assert(got.returns.length >= 1 && got.returns[0].items.length >= 1, 'и возвраты по нему — чтобы не вернуть больше купленного')
    await rejects(() => get('/sync/sale/' + randomUUID()), /не найден/i, 'чека с таким номером нет')
  })

  await check('смену кассы, которая сама её уже не закроет, закрывает владелец; опоздавший чек попадает в её итоги', async () => {
    // Касса открыла смену, пробила чек — и компьютер сломался
    const broken = randomUUID()
    const sh = { id: randomUUID(), openedAt: serverNow().toISOString(), openingCash: 50 }
    const first = saleOp(plenty, { shiftId: sh.id })
    eq((await push(broken, [op('shift.open', { shift: sh }), first])).results.map((x) => x.status).join(), 'ok,ok', 'смена и чек')
    const dev = (await get('/sync/devices')).find((d) => d.id === broken)
    eq(dev.openShift?.id, sh.id, 'владелец видит, что на кассе открыта смена')
    eqMoney(dev.openShift.openingCash, 50, 'и с чем её открыли')

    await rejects(() => post(`/sync/devices/${broken}/close-shift`, { countedCash: 150 }, kassaCashier.token), /прав/i, 'кассир чужую смену не закрывает')
    const closed = await post(`/sync/devices/${broken}/close-shift`, { countedCash: 150 })
    assert(closed.closedAt, 'смена закрыта')
    eq(closed.count, 1, 'в ней один чек')
    eqMoney(closed.expectedCash, 150, '50 на начало + 100 наличными')
    eqMoney(closed.difference, 0, 'сошлось')
    eq((await get('/sync/devices')).find((d) => d.id === broken).openShift, null, 'открытой смены на кассе больше нет')
    assert((await get('/shifts')).some((s) => s.id === sh.id), 'закрытая смена — в общей истории')
    await rejects(() => post(`/sync/devices/${broken}/close-shift`, { countedCash: 1 }), /нет открытой смены/, 'второй раз закрывать нечего')

    // Компьютер починили: касса дослала чек, пробитый в той смене, и своё закрытие
    const late = saleOp(plenty, { shiftId: sh.id })
    const own = op('shift.close', { shift: { ...sh, closedAt: serverNow().toISOString(), countedCash: 999 } })
    eq((await push(broken, [late, own])).results.map((x) => x.status).join(), 'ok,ok', 'опоздавший чек и закрытие кассы')
    const after = (await get('/shifts')).find((s) => s.id === sh.id)
    eq(after.count, 2, 'опоздавший чек — в итогах смены')
    eqMoney(after.expectedCash, 250, '50 + 100 + 100')
    eqMoney(after.countedCash, 150, 'пересчитанные наличные — те, что указал владелец, а не касса задним числом')
    eqMoney(after.difference, -100, 'и разница это показывает')
  })

  // ────────────────────────────────────────────────────────────
  group('Расходы')

  // Расходы — деньги магазина помимо закупки товара. Из них и из прибыли от продаж
  // отчёты считают чистую прибыль. Расход «из кассы» ещё и уменьшает наличные,
  // которые ждут в смене: денег в ящике уже нет.
  const READY = ['Аренда', 'Зарплата', 'Коммунальные услуги', 'Налоги', 'Транспорт', 'Реклама', 'Хозяйственные нужды', 'Другое']
  const expenseById = async (id) => (await get('/expenses?days=0')).find((e) => e.id === id)
  const shiftById = async (id) => (await get('/shifts')).find((s) => s.id === id)
  const expenseOp = (over = {}) =>
    op('expense', { expense: { id: randomUUID(), date: serverNow().toISOString(), category: 'Реклама', amount: 25, note: TAG, fromCash: false, shiftId: null, ...over } })

  let ownArticle
  await check('статьи расходов: готовый список есть сразу, свои добавляются и убираются', async () => {
    const ready = (await get('/expense-categories')).map((c) => c.name)
    for (const name of READY) assert(ready.includes(name), `в готовом списке нет статьи «${name}»`)

    ownArticle = await post('/expense-categories', { name: `  ${TAG} Охрана  ` })
    created.expenseCategories.push(ownArticle.id)
    eq(ownArticle.name, `${TAG} Охрана`, 'пробелы по краям обрезаны')
    assert((await get('/expense-categories')).some((c) => c.id === ownArticle.id), 'своя статья появилась в списке')
    await rejects(() => post('/expense-categories', { name: `${TAG} Охрана` }), /уже есть/i, 'вторая статья с тем же названием')
    await rejects(() => post('/expense-categories', { name: '   ' }), /назван|пуст|заполн/i, 'статья без названия')
    await rejects(() => del('/expense-categories/' + randomUUID()), /не найден/i, 'удаление статьи, которой нет')
  })

  let rent
  await check('расход вносится задним числом, но не будущим; повтор запроса его не задваивает', async () => {
    const day = daysFromNow(-10)
    const body = { category: 'Аренда', amount: 1500.5, note: `  ${TAG} за месяц `, date: day, clientId: TAG + '-rent' }
    rent = await post('/expenses', body)
    created.expenses.push(rent.id)
    eqMoney(rent.amount, 1500.5, 'сумма')
    eq(rent.category, 'Аренда', 'статья')
    eq(rent.note, `${TAG} за месяц`, 'примечание без пробелов по краям')
    eq(rent.fromCash, false, 'обычный расход — не из кассы')
    eq(rent.shiftId, null, 'и к смене не привязан')
    // День без времени ставится на полдень по Душанбе: расход не уедет в соседний день
    eq(rent.date, day + 'T07:00:00.000Z', 'дата — тот день, что указал владелец')
    assert(rent.user?.name, 'видно, кто внёс')

    const again = await post('/expenses', body)
    eq(again.id, rent.id, 'тот же запрос повторно — тот же расход')
    const twins = await Promise.all([1, 2].map(() => post('/expenses', { ...body, clientId: TAG + '-twin', amount: 7 })))
    eq(twins[0].id, twins[1].id, 'два одинаковых запроса разом — один расход')
    created.expenses.push(twins[0].id)
    eq((await get('/expenses?days=0')).filter((e) => e.note === `${TAG} за месяц`).length, 2, 'лишних расходов не появилось')

    await rejects(() => post('/expenses', { category: 'Аренда', amount: 10, date: daysFromNow(2) }), /в будущем/i, 'расход будущим числом')
    await rejects(() => post('/expenses', { category: 'Аренда', amount: 10, date: 'вчера' }), /дат/i, 'мусор вместо даты')
    await rejects(() => post('/expenses', { category: 'Аренда', amount: 0 }), /Сумма/i, 'нулевая сумма')
    await rejects(() => post('/expenses', { category: 'Аренда', amount: -5 }), /Сумма/i, 'отрицательная сумма')
    await rejects(() => post('/expenses', { category: 'Аренда', amount: 1e12 }), /Сумма/i, 'сумма, какой не бывает')
    await rejects(() => post('/expenses', { category: TAG + ' нет такой', amount: 10 }), /нет в списке/i, 'статья не из списка')
    await rejects(() => post('/expenses', { amount: 10 }), /Статья|категор/i, 'расход без статьи')
  })

  await check('расход правится и удаляется; убранная статья остаётся в прежних расходах', async () => {
    const edited = await patch('/expenses/' + rent.id, { amount: 1600, note: TAG + ' поправлено', category: ownArticle.name, date: daysFromNow(-3) })
    eqMoney(edited.amount, 1600, 'новая сумма')
    eq(edited.note, TAG + ' поправлено', 'новое примечание')
    eq(edited.category, ownArticle.name, 'новая статья')
    eq(edited.date, daysFromNow(-3) + 'T07:00:00.000Z', 'новая дата')
    await rejects(() => patch('/expenses/' + rent.id, { amount: 0 }), /Сумма/i, 'правка на нулевую сумму')
    await rejects(() => patch('/expenses/' + rent.id, { date: daysFromNow(2) }), /в будущем/i, 'правка на будущую дату')
    await rejects(() => patch('/expenses/' + rent.id, { category: TAG + ' нет такой' }), /нет в списке/i, 'правка на статью не из списка')
    await rejects(() => patch('/expenses/' + randomUUID(), { amount: 5 }), /не найден/i, 'правка расхода, которого нет')

    // Статью убрали из списка — расход хранит её название и остаётся как был
    await del('/expense-categories/' + ownArticle.id)
    assert(!(await get('/expense-categories')).some((c) => c.id === ownArticle.id), 'статья убрана из списка')
    eq((await expenseById(rent.id)).category, ownArticle.name, 'у прежнего расхода статья осталась')
    await rejects(() => post('/expenses', { category: ownArticle.name, amount: 10 }), /нет в списке/i, 'новый расход по убранной статье')
    // Править такой расход можно — статью он не меняет, сверять её не с чем
    eqMoney((await patch('/expenses/' + rent.id, { amount: 1700, category: ownArticle.name })).amount, 1700, 'сумма расхода по убранной статье')

    const extra = await post('/expenses', { category: 'Другое', amount: 3 })
    eq((await del('/expenses/' + extra.id)).ok, true, 'расход удалён')
    eq(await expenseById(extra.id), undefined, 'в списке его больше нет')
    await rejects(() => del('/expenses/' + extra.id), /не найден/i, 'повторное удаление')
  })

  await check('расходы — только владельцу: кассиру закрыты и сами расходы, и их статьи', async () => {
    const t = kassaCashier.token
    await rejects(() => get('/expenses', t), /прав/i, 'список расходов')
    await rejects(() => get('/expenses/cash-sources', t), /прав/i, 'список касс для расхода')
    await rejects(() => post('/expenses', { category: 'Аренда', amount: 10 }, t), /прав/i, 'новый расход')
    await rejects(() => patch('/expenses/' + rent.id, { amount: 1 }, t), /прав/i, 'правка расхода')
    await rejects(() => del('/expenses/' + rent.id, t), /прав/i, 'удаление расхода')
    await rejects(() => get('/expense-categories', t), /прав/i, 'список статей')
    await rejects(() => post('/expense-categories', { name: TAG + ' кассир' }, t), /прав/i, 'новая статья')
    eqMoney((await expenseById(rent.id)).amount, 1700, 'расход не тронут')
  })

  let tillGoods
  let tillShift
  let tillExpense
  await check('расход из кассы без открытой смены не принимается', async () => {
    tillGoods = await makeProduct({ name: 'Расход', cost: 60, price: 150 })
    await post('/arrivals', { supplier: TAG, items: [{ productId: tillGoods.id, qty: 20, cost: 60, expiryDate: daysFromNow(400) }] })
    tillGoods = await productById(tillGoods.id)
    assert(!(await get('/expenses/cash-sources')).some((s) => s.deviceId === null), 'смена сайта закрыта — кассы сайта в списке нет')
    await rejects(() => post('/expenses', { category: 'Транспорт', amount: 40, fromCash: true }), /Нет открытой смены/i, 'расход из кассы без смены')
    await rejects(() => post('/expenses', { category: 'Транспорт', amount: 40, fromCash: true, shiftId: randomUUID() }), /Смена не найдена/i, 'расход в смену, которой нет')
  })

  await check('расход из кассы уменьшает наличные, которые ждут в смене сайта', async () => {
    tillShift = await post('/shifts/open', { openingCash: 100 })
    await post('/sales', { items: [{ productId: tillGoods.id, qty: 1 }], payment: 'cash', clientId: TAG + '-till-sale' })
    eq((await get('/expenses/cash-sources')).filter((s) => s.deviceId === null).map((s) => s.shiftId).join(), tillShift.id, 'касса сайта — в списке касс')

    // Дата расхода из кассы — «сейчас», что бы ни прислали: он принадлежит смене
    tillExpense = await post('/expenses', { category: 'Транспорт', amount: 40, fromCash: true, date: daysFromNow(-10), note: TAG + ' такси' })
    created.expenses.push(tillExpense.id)
    eq(tillExpense.fromCash, true, 'отметка «из кассы»')
    eq(tillExpense.shiftId, tillShift.id, 'привязан к открытой смене сайта')
    assert(Math.abs(new Date(tillExpense.date) - serverNow()) < 5 * 60000, 'дата — сейчас, а не присланная: ' + tillExpense.date)
    eqMoney((await shiftById(tillShift.id)).expenseCash, 40, 'смена знает сумму расходов из кассы')

    const second = await post('/expenses', { category: 'Другое', amount: 10, fromCash: true })
    eqMoney((await shiftById(tillShift.id)).expenseCash, 50, 'два расхода из кассы')
    // Обычный расход смену не трогает
    const plain = await post('/expenses', { category: 'Аренда', amount: 999 })
    created.expenses.push(plain.id)
    eqMoney((await shiftById(tillShift.id)).expenseCash, 50, 'расход не из кассы на смену не влияет')

    // Правка и удаление — пока смена открыта; сумма смены идёт следом
    const edited = await patch('/expenses/' + tillExpense.id, { amount: 30, date: daysFromNow(-5) })
    eqMoney(edited.amount, 30, 'сумма расхода из кассы поправлена')
    eq(edited.date, tillExpense.date, 'а дату ему не переносят: это время в смене')
    eqMoney((await shiftById(tillShift.id)).expenseCash, 40, '30 + 10')
    await del('/expenses/' + second.id)
    eqMoney((await shiftById(tillShift.id)).expenseCash, 30, 'удалённый расход вернулся в кассу')
  })

  await check('закрытие смены: расходы из кассы — отдельной строкой, и смена сходится', async () => {
    // В ящике: 100 на начало + 150 наличными − 30 на такси
    const closed = await post('/shifts/close', { countedCash: 220 })
    eq(closed.id, tillShift.id, 'закрыта смена сайта')
    eqMoney(closed.salesCash, 150, 'наличные продажи')
    eqMoney(closed.expenseCash, 30, 'расходы из кассы за смену')
    eqMoney(closed.expectedCash, 220, '100 + 150 − 30')
    eqMoney(closed.difference, 0, 'сошлось')
    // Прибыль смены расходами не уменьшается: это прибыль от продаж за смену
    eqMoney(closed.profit, 90, 'прибыль смены — от продаж')

    // Расход вошёл в отчёт закрытой смены и больше не меняется
    await rejects(() => patch('/expenses/' + tillExpense.id, { amount: 1 }), /уже закрыта/i, 'правка расхода закрытой смены')
    await rejects(() => del('/expenses/' + tillExpense.id), /уже закрыта/i, 'удаление расхода закрытой смены')
    eqMoney((await expenseById(tillExpense.id)).amount, 30, 'расход остался как был')
    eqMoney((await shiftById(tillShift.id)).expectedCash, 220, 'итоги смены не тронуты')
    await rejects(() => post('/expenses', { category: 'Транспорт', amount: 5, fromCash: true, shiftId: tillShift.id }), /Нет открытой смены/i, 'расход в закрытую смену')
  })

  let regShift
  let regExpense
  await check('касса с программой: расход, внесённый без связи, ложится в её смену', async () => {
    regShift = { id: randomUUID(), openedAt: serverNow().toISOString(), openingCash: 200 }
    eq((await push(KASSA_A, [op('shift.open', { shift: regShift })])).results[0].status, 'ok', 'касса открыла смену')

    regExpense = expenseOp({ fromCash: true, shiftId: regShift.id, date: minutesAgo(3) })
    const sent = await push(KASSA_A, [regExpense])
    eq(sent.results[0].status, 'ok', 'расход принят')
    eq(sent.results[0].docId, regExpense.payload.expense.id, 'под номером, который дала касса')
    const e = await expenseById(regExpense.payload.expense.id)
    assert(e, 'расхода кассы нет на сервере')
    eqMoney(e.amount, 25, 'сумма')
    eq(e.fromCash, true, 'из кассы')
    eq(e.shiftId, regShift.id, 'в смене этой кассы')
    eq(e.date, regExpense.payload.expense.date, 'время — когда внесли, а не когда дошло')
    assert(e.user?.name, 'и кто внёс')

    eq((await push(KASSA_A, [regExpense])).results[0].status, 'duplicate', 'повторная отправка расход не задваивает')
    eq((await get('/expenses?days=0')).filter((x) => x.id === e.id).length, 1, 'расход один')

    // Владелец на сайте видит открытую смену кассы и берёт деньги из её ящика
    const src = (await get('/expenses/cash-sources')).find((s) => s.shiftId === regShift.id)
    assert(src, 'смена кассы — в списке касс')
    eq(src.deviceId, KASSA_A, 'это та самая касса')
    assert(src.deviceName, 'и у неё есть имя, по которому владелец её узнаёт')
    const fromSite = await post('/expenses', { category: 'Другое', amount: 15, fromCash: true, shiftId: regShift.id, note: TAG + ' с сайта' })
    eq(fromSite.shiftId, regShift.id, 'расход с сайта — в смене кассы')
    // Открытая смена кассы в списке смен сайта не показывается — смотрим её глазами кассы
    const seen = (await pull(KASSA_A)).data.shifts.upsert.find((s) => s.id === regShift.id)
    eqMoney(seen.expenseCash, 40, 'касса получает смену с суммой расходов: 25 своих + 15 с сайта')
  })

  await check('расход с кассы присылает только владелец; негодный расход сервер не принимает', async () => {
    const byCashier = await push(KASSA_B, [expenseOp()], kassaCashier.token)
    eq(byCashier.results[0].status, 'rejected', 'расход — только владельцу')
    assert(/прав/i.test(byCashier.results[0].error), byCashier.results[0].error)

    const bad = await push(KASSA_A, [expenseOp({ amount: 0 }), expenseOp({ amount: -3 }), expenseOp({ category: '   ' }), expenseOp({ date: 'когда-то' })])
    eq(bad.results.map((r) => r.status).join(), 'rejected,rejected,rejected,rejected', 'нулевая и отрицательная сумма, пустая статья, негодная дата')

    // Статью за время без связи могли убрать из списка — расход уже случился и остаётся
    const gone = expenseOp({ category: ownArticle.name, amount: 4 })
    eq((await push(KASSA_A, [gone])).results[0].status, 'ok', 'расход по убранной статье')
    eq((await expenseById(gone.payload.expense.id)).category, ownArticle.name, 'с названием статьи, под которым его внесли')

    // Вписать расход в смену соседней кассы нельзя: он принят, но чужую кассу не трогает
    const foreign = expenseOp({ fromCash: true, shiftId: regShift.id, amount: 500 })
    eq((await push(KASSA_B, [foreign])).results[0].status, 'ok', 'расход с другой кассы')
    eq((await expenseById(foreign.payload.expense.id)).shiftId, null, 'в чужую смену он не попал')
    const seen = (await pull(KASSA_A)).data.shifts.upsert.find((s) => s.id === regShift.id)
    eqMoney(seen.expenseCash, 40, 'сумма смены кассы не изменилась')
  })

  await check('кассиру обмен не отдаёт расходы и статьи, а сумму «из кассы» в смене — отдаёт', async () => {
    const full = await pull(KASSA_B, undefined, kassaCashier.token)
    eq('expenses' in full.data, false, 'раздела расходов у кассира нет вовсе')
    eq('expenseCategories' in full.data, false, 'и статей тоже')
    eqMoney(full.data.shifts.upsert.find((s) => s.id === regShift.id).expenseCash, 40, 'сумма расходов из кассы — в самой смене')

    const owner = await pull(KASSA_A)
    assert(owner.data.expenses.upsert.some((e) => e.id === regExpense.payload.expense.id), 'владельцу расходы приходят')
    for (const name of READY) assert(owner.data.expenseCategories.upsert.some((c) => c.name === name), `владельцу приходит статья «${name}»`)

    // Владельца за кассой сменил кассир, и при нём на сайте внесли расход и завели
    // статью. Общая отметка кассы ушла вперёд, а расходов кассир не получал.
    // Владелец, вернувшись, добирает их со своей отметки — без полной загрузки
    const made = await post('/expenses', { category: 'Налоги', amount: 77, note: TAG + ' при кассире' })
    created.expenses.push(made.id)
    const article = await post('/expense-categories', { name: TAG + ' при кассире' })
    created.expenseCategories.push(article.id)
    const atCashier = await pull(KASSA_A, owner.cursor, kassaCashier.token)
    eq('expenses' in atCashier.data, false, 'кассиру раздел не приходит и частично')
    assert(BigInt(atCashier.cursor) > BigInt(owner.cursor), 'отметка кассы ушла вперёд')
    const back = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${atCashier.cursor}&wcursor=${owner.cursor}`)
    eq(back.full, false, 'полная загрузка не нужна')
    assert(back.data.expenses.upsert.some((e) => e.id === made.id), 'расход, внесённый при кассире, дошёл до владельца')
    assert(back.data.expenseCategories.upsert.some((c) => c.id === article.id), 'и новая статья тоже')
    // Удалённое на сайте касса убирает и у себя
    await del('/expenses/' + made.id)
    await del('/expense-categories/' + article.id)
    const after = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${back.cursor}&wcursor=${back.cursor}`)
    assert(after.data.expenses.remove.includes(made.id), 'удалённый расход — в списке на удаление')
    assert(after.data.expenseCategories.remove.includes(article.id), 'удалённая статья — тоже')
  })

  await check('закрытие смены кассы считает расходы из кассы; опоздавший расход попадает в её итоги', async () => {
    const close = op('shift.close', { shift: { ...regShift, closedAt: serverNow().toISOString(), countedCash: 160 } })
    eq((await push(KASSA_A, [close])).results[0].status, 'ok', 'смена закрыта')
    const s = await shiftById(regShift.id)
    eqMoney(s.expenseCash, 40, 'расходы из кассы за смену')
    eqMoney(s.expectedCash, 160, '200 на начало − 40 расходов')
    eqMoney(s.difference, 0, 'сошлось')
    await rejects(() => del('/expenses/' + regExpense.payload.expense.id), /уже закрыта/i, 'расход закрытой смены кассы не удаляется')

    // Расход внесли в той смене без связи, а дошёл он уже после её закрытия
    const late = expenseOp({ fromCash: true, shiftId: regShift.id, amount: 5, date: minutesAgo(2) })
    eq((await push(KASSA_A, [late])).results[0].status, 'ok', 'опоздавший расход принят')
    const after = await shiftById(regShift.id)
    eqMoney(after.expenseCash, 45, 'он вошёл в итоги закрытой смены')
    eqMoney(after.expectedCash, 155, '200 − 45')
    eqMoney(after.difference, 5, 'и разница это показывает')
  })

  await check('расходы и их статьи попадают в резервную копию', async () => {
    const dump = await get('/backup')
    eq(dump.format, 5, 'версия формата копии')
    assert(dump.data.expenses.some((e) => e.id === rent.id), 'расход в копии')
    assert(dump.data.expenses.some((e) => e.id === tillExpense.id && e.fromCash && e.shiftId === tillShift.id), 'расход из кассы — со своей сменой')
    for (const name of READY) assert(dump.data.expenseCategories.some((c) => c.name === name), `статья «${name}» в копии`)
    eq(dump.counts.expenses, dump.data.expenses.length, 'число расходов в сводке копии')
    eqMoney(dump.data.shifts.find((s) => s.id === tillShift.id).expenseCash, 30, 'смена в копии — с расходами из кассы')
  })

  // ────────────────────────────────────────────────────────────
  group('Поставщики, наличные в смене, переводы, история товара')

  const supplierById = async (id) => (await get('/suppliers')).find((s) => s.id === id)
  const arrivalById = async (id) => (await get('/arrivals')).find((a) => a.id === id)
  const closedShift = async (id) => (await get('/shifts')).find((s) => s.id === id)

  // ── Поставщики ──
  let distributor
  await check('поставщики: заводятся с начальным долгом, не задваиваются, кассиру — без долгов', async () => {
    distributor = await post('/suppliers', { name: `  ${TAG} Опт-Маркет  `, phone: '+992 900 11 22 33', note: 'до обеда', openingDebt: 500 })
    created.suppliers.push(distributor.id)
    eq(distributor.name, `${TAG} Опт-Маркет`, 'пробелы по краям обрезаны')
    eqMoney(distributor.openingDebt, 500, 'начальный долг записан')
    eqMoney(distributor.debt, 500, 'и это весь долг на старте')
    await rejects(() => post('/suppliers', { name: `${TAG} Опт-Маркет` }), /уже есть/i, 'второй поставщик с тем же названием')
    await rejects(() => post('/suppliers', { name: '   ' }), /назван|заполн|пуст/i, 'поставщик без названия')

    // Кассир видит список (ему оформлять приход), но не долги; заводит — без долга
    const forCashier = (await get('/suppliers', kassaCashier.token)).find((s) => s.id === distributor.id)
    assert(forCashier && forCashier.name === distributor.name, 'кассиру поставщик виден')
    eq('debt' in forCashier, false, 'долг кассиру не показывается')
    const byCashier = await post('/suppliers', { name: `${TAG} От кассира`, openingDebt: 999 }, kassaCashier.token)
    created.suppliers.push(byCashier.id)
    eqMoney((await supplierById(byCashier.id)).debt, 0, 'начальный долг кассира не учитывается')
    await rejects(() => get('/suppliers/' + distributor.id, kassaCashier.token), /прав/i, 'карточка поставщика кассиру закрыта')
    await rejects(() => patch('/suppliers/' + distributor.id, { name: 'x' }, kassaCashier.token), /прав/i, 'правка кассиру закрыта')

    const renamed = await patch('/suppliers/' + distributor.id, { name: `${TAG} Опт-Маркет 2`, phone: '' })
    eq(renamed.name, `${TAG} Опт-Маркет 2`, 'переименован')
    distributor = renamed
    await rejects(() => del('/suppliers/' + distributor.id), /есть долг/i, 'поставщика с долгом не удалить')
    eq((await del('/suppliers/' + byCashier.id)).ok, true, 'поставщик без долга и оплат удаляется')
  })

  let credit
  let creditGoods
  await check('приход в долг прибавляет долг поставщику; оплаченный приход — нет', async () => {
    creditGoods = await makeProduct({ name: 'В долг', cost: 20, price: 30 })
    credit = await post('/arrivals', {
      supplierId: distributor.id,
      debt: 300,
      items: [{ productId: creditGoods.id, qty: 10, cost: 20, expiryDate: daysFromNow(400) }],
    })
    eq(credit.supplierId, distributor.id, 'приход помнит поставщика')
    eq(credit.supplier, `${TAG} Опт-Маркет 2`, 'и его название — снимком')
    eqMoney(credit.total, 200, 'сумма прихода')
    eqMoney(credit.debt, 200, 'в долг нельзя больше суммы прихода — срезано до неё')
    assert(credit.user?.name || credit.userId, 'кто принял — записано')
    eqMoney((await supplierById(distributor.id)).debt, 700, '500 начальных + 200 прихода')

    // Оплаченный приход долг не трогает; без поставщика долга не бывает, что ни пришли
    const paid = await post('/arrivals', { supplierId: distributor.id, items: [{ productId: creditGoods.id, qty: 1, cost: 20, expiryDate: daysFromNow(400) }] })
    eqMoney(paid.debt, 0, 'приход без отметки долга оплачен полностью')
    const nobody = await post('/arrivals', { supplier: `${TAG} по старинке`, debt: 50, items: [{ productId: creditGoods.id, qty: 1, cost: 20, expiryDate: daysFromNow(400) }] })
    eq(nobody.supplierId, null, 'поставщик не из справочника — ссылки нет')
    eqMoney(nobody.debt, 0, 'и долга нет')
    eqMoney((await supplierById(distributor.id)).debt, 700, 'долг не изменился')
    await rejects(() => post('/arrivals', { supplierId: randomUUID(), debt: 5, items: [{ productId: creditGoods.id, qty: 1, cost: 20, expiryDate: daysFromNow(400) }] }), /Поставщик не найден/i, 'приход на несуществующего поставщика')

    // Карточка поставщика: откуда долг
    const card = await get('/suppliers/' + distributor.id)
    eq(card.arrivals.map((a) => a.id).includes(credit.id), true, 'приход в долг — в карточке')
    eqMoney(card.arrivals.find((a) => a.id === credit.id).debt, 200, 'с неоплаченной частью')
    eq(card.payments.length, 0, 'оплат ещё не было')
  })

  await check('правка и удаление прихода переписывают долг поставщика', async () => {
    const loaded = await get('/arrivals/' + credit.id)
    const line = loaded.items[0]
    // Уменьшили количество: сумма 100, долг срезается до неё
    const less = await patch('/arrivals/' + credit.id, { items: [{ id: line.id, qty: 5, cost: 20, expiryDate: daysFromNow(400) }] })
    eqMoney(less.total, 100, 'сумма после правки')
    eqMoney(less.debt, 100, 'долг не больше новой суммы')
    eqMoney((await supplierById(distributor.id)).debt, 600, '500 + 100')
    // Поправили только долг
    const part = await patch('/arrivals/' + credit.id, { debt: 40, items: [{ id: line.id, qty: 5, cost: 20, expiryDate: daysFromNow(400) }] })
    eqMoney(part.debt, 40, 'оплатили часть при правке')
    eqMoney((await supplierById(distributor.id)).debt, 540, '500 + 40')
    // Перенесли приход на другого поставщика
    const other = await post('/suppliers', { name: `${TAG} Другой опт` })
    created.suppliers.push(other.id)
    const moved = await patch('/arrivals/' + credit.id, { supplierId: other.id, debt: 100, items: [{ id: line.id, qty: 5, cost: 20, expiryDate: daysFromNow(400) }] })
    eq(moved.supplierId, other.id, 'приход у другого поставщика')
    eq(moved.supplier, `${TAG} Другой опт`, 'название тоже его')
    eqMoney((await supplierById(distributor.id)).debt, 500, 'у прежнего остался только начальный долг')
    eqMoney((await supplierById(other.id)).debt, 100, 'у нового — долг прихода')
    // Убрали поставщика вовсе — долг снялся
    const none = await patch('/arrivals/' + credit.id, { supplierId: '', items: [{ id: line.id, qty: 5, cost: 20, expiryDate: daysFromNow(400) }] })
    eq(none.supplierId, null, 'приход без поставщика')
    eqMoney(none.debt, 0, 'и без долга')
    eqMoney((await supplierById(other.id)).debt, 0, 'долг снят')
    // Снова в долг — и удаление прихода снимает долг
    await patch('/arrivals/' + credit.id, { supplierId: other.id, debt: 100, items: [{ id: line.id, qty: 5, cost: 20, expiryDate: daysFromNow(400) }] })
    eqMoney((await supplierById(other.id)).debt, 100, 'долг вернулся')
    await del('/arrivals/' + credit.id)
    eqMoney((await supplierById(other.id)).debt, 0, 'удалённый приход долгом не числится')
    eq((await del('/suppliers/' + other.id)).ok, true, 'поставщик без долга удаляется')
  })

  let payShift
  let cashPayment
  await check('оплата поставщику: не больше долга, из кассы — только в открытую смену, и смена это видит', async () => {
    await rejects(() => post('/suppliers/' + distributor.id + '/pay', { amount: 100 }, kassaCashier.token), /прав/i, 'кассир поставщикам не платит')
    await rejects(() => post('/suppliers/' + distributor.id + '/pay', { amount: 600 }), /больше долга/i, 'переплата')
    await rejects(() => post('/suppliers/' + distributor.id + '/pay', { amount: 0 }), /Сумма/i, 'нулевая оплата')
    const plain = await post('/suppliers/' + distributor.id + '/pay', { amount: 100, note: 'наличными владельца', clientId: TAG + '-sp1' })
    eqMoney(plain.amount, 100, 'оплата записана')
    eq(plain.fromCash, false, 'не из кассы')
    eq(plain.shiftId, null, 'и без смены')
    eqMoney((await supplierById(distributor.id)).debt, 400, '500 − 100')
    eq((await post('/suppliers/' + distributor.id + '/pay', { amount: 100, clientId: TAG + '-sp1' })).id, plain.id, 'повтор запроса — та же оплата')
    eqMoney((await supplierById(distributor.id)).debt, 400, 'долг второй раз не уменьшился')

    assert(!(await get('/shifts')).some((s) => !s.closedAt), 'смена сайта должна быть закрыта перед этой проверкой')
    await rejects(() => post('/suppliers/' + distributor.id + '/pay', { amount: 50, fromCash: true }), /Нет открытой смены/i, 'из кассы без смены')
    payShift = await post('/shifts/open', { openingCash: 1000 })
    cashPayment = await post('/suppliers/' + distributor.id + '/pay', { amount: 150, fromCash: true, note: 'курьеру' })
    eq(cashPayment.fromCash, true, 'из кассы')
    eq(cashPayment.shiftId, payShift.id, 'в открытой смене сайта')
    eqMoney((await supplierById(distributor.id)).debt, 250, '400 − 150')
    eqMoney((await get('/shifts')).find((s) => s.id === payShift.id).supplierCash, 150, 'смена знает, сколько ушло поставщикам из кассы')

    const journal = await get('/supplier-payments')
    assert(journal.some((p) => p.id === cashPayment.id && p.supplier?.name === distributor.name), 'оплата в журнале с именем поставщика')
    await rejects(() => get('/supplier-payments', kassaCashier.token), /прав/i, 'журнал оплат кассиру закрыт')
    // Ошибочную оплату можно отменить, пока смена открыта
    const wrong = await post('/suppliers/' + distributor.id + '/pay', { amount: 10, fromCash: true })
    eqMoney((await get('/shifts')).find((s) => s.id === payShift.id).supplierCash, 160, '150 + 10')
    eq((await del('/supplier-payments/' + wrong.id)).ok, true, 'оплата отменена')
    eqMoney((await supplierById(distributor.id)).debt, 250, 'долг вернулся')
    eqMoney((await get('/shifts')).find((s) => s.id === payShift.id).supplierCash, 150, 'и из кассы она больше не числится')
  })

  // ── Внесение и изъятие наличных ──
  let cashIn
  await check('внесение и изъятие наличных: только в открытую смену, кассиру тоже, и смена сходится', async () => {
    await rejects(() => post('/shifts/cash', { kind: 'in', amount: 0 }), /Сумма/i, 'нулевая сумма')
    await rejects(() => post('/shifts/cash', { kind: 'sideways', amount: 5 }), /Вид операции/i, 'неизвестный вид')
    cashIn = await post('/shifts/cash', { kind: 'in', amount: 200, note: 'размен', clientId: TAG + '-cm1' })
    eq(cashIn.kind, 'in', 'внесение')
    eq(cashIn.shiftId, payShift.id, 'в открытой смене сайта')
    eq((await post('/shifts/cash', { kind: 'in', amount: 200, clientId: TAG + '-cm1' })).id, cashIn.id, 'повтор запроса не задваивает')
    // Кассир отдаёт выручку владельцу — тоже из смены сайта
    const out = await post('/shifts/cash', { kind: 'out', amount: 300, note: 'забрал владелец', shiftId: randomUUID() }, kassaCashier.token)
    eq(out.shiftId, payShift.id, 'кассир — только в смену сайта, что бы ни прислал')
    assert(out.user?.name === kassaCashier.name, 'видно, кто изъял')
    const s = (await get('/shifts')).find((x) => x.id === payShift.id)
    eqMoney(s.cashIn, 200, 'внесено')
    eqMoney(s.cashOut, 300, 'изъято')
    // Список операций и кассы для кассира
    assert((await get('/cash-moves', kassaCashier.token)).some((m) => m.id === out.id), 'журнал движений наличных виден кассиру')
    const sources = await get('/shifts/cash-sources', kassaCashier.token)
    eq(sources.map((x) => x.shiftId).join(), payShift.id, 'кассиру — только смена сайта')
    await rejects(() => del('/cash-moves/' + out.id, kassaCashier.token), /прав/i, 'отменить операцию кассир не может')
    const mistake = await post('/shifts/cash', { kind: 'out', amount: 1 })
    eq((await del('/cash-moves/' + mistake.id)).ok, true, 'владелец отменил ошибочную')
    eqMoney((await get('/shifts')).find((x) => x.id === payShift.id).cashOut, 300, 'изъято — как было')
  })

  // ── Переводы ──
  let transferSale
  await check('оплата переводом: сервис обязателен, в ящик не попадает, в смене — по сервисам', async () => {
    // Запас товара для чеков ниже — приход, оплаченный сразу
    await post('/arrivals', { items: [{ productId: creditGoods.id, qty: 20, cost: 20, expiryDate: daysFromNow(400) }] })
    const services = await get('/pay-services', kassaCashier.token)
    for (const name of ['Alif', 'DC', 'Эсхата', 'Humo', 'Амонат']) assert(services.some((x) => x.name === name), `готового сервиса «${name}» нет`)
    await rejects(() => post('/pay-services', { name: `${TAG} Банк` }, kassaCashier.token), /прав/i, 'сервисы добавляет владелец')
    const mine = await post('/pay-services', { name: `  ${TAG} Банк ` })
    created.payServices.push(mine.id)
    eq(mine.name, `${TAG} Банк`, 'свой сервис добавлен')
    await rejects(() => post('/pay-services', { name: `${TAG} Банк` }), /уже есть/i, 'второй с тем же названием')

    await rejects(() => post('/sales', { items: [{ productId: creditGoods.id, qty: 1 }], payment: 'transfer' }), /сервис перевода/i, 'перевод без сервиса')
    transferSale = await post('/sales', { items: [{ productId: creditGoods.id, qty: 2 }], payment: 'transfer', payVia: 'Alif', clientId: TAG + '-tr1' })
    eq(transferSale.payment, 'transfer', 'оплата переводом')
    eq(transferSale.payVia, 'Alif', 'через Alif')
    const second = await post('/sales', { items: [{ productId: creditGoods.id, qty: 1 }], payment: 'transfer', payVia: `${TAG} Банк`, clientId: TAG + '-tr2' })
    eq(second.payVia, `${TAG} Банк`, 'через свой сервис')
    const cash = await post('/sales', { items: [{ productId: creditGoods.id, qty: 1 }], payment: 'cash', payVia: 'Alif', clientId: TAG + '-tr3' })
    eq(cash.payVia, null, 'у наличных сервиса не бывает')

    // Возврат переводом: сервис — тот, каким платили
    const ret = await post('/returns', { saleId: transferSale.id, items: [{ productId: creditGoods.id, units: 1 }], refund: 'transfer' })
    eq(ret.refund, 'transfer', 'возврат переводом')
    eq(ret.refundVia, 'Alif', 'через тот же сервис')
    const retOther = await post('/returns', { saleId: second.id, items: [{ productId: creditGoods.id, units: 1 }], refund: 'transfer', refundVia: 'DC' })
    eq(retOther.refundVia, 'DC', 'или через названный')

    // Смена: переводы отдельно и по сервисам, в ящик не идут
    const closed = await post('/shifts/close', { countedCash: 930 })
    eq(closed.id, payShift.id, 'закрыта смена сайта')
    eqMoney(closed.salesTransfer, 90, 'переводом: 60 + 30')
    eqMoney(closed.transferBy['Alif'], 60, 'по Alif')
    eqMoney(closed.transferBy[`${TAG} Банк`], 30, 'по своему сервису')
    eqMoney(closed.salesCash, 30, 'наличными')
    eqMoney(closed.totalSales, 120, 'всего продаж')
    eqMoney(closed.refundTotal, 60, 'возвращено')
    eqMoney(closed.refundCash, 0, 'из ящика на возвраты ничего не ушло')
    // 1000 на начало + 30 наличными + 200 внесено − 150 поставщику − 300 изъято
    eqMoney(closed.expectedCash, 780, 'ожидалось в кассе')
    eqMoney(closed.difference, 150, 'насчитали больше')
    // После закрытия операции смены не меняются
    await rejects(() => del('/cash-moves/' + cashIn.id), /уже закрыта/i, 'внесение закрытой смены')
    await rejects(() => del('/supplier-payments/' + cashPayment.id), /уже закрыта/i, 'оплата поставщику закрытой смены')
    eq((await del('/pay-services/' + mine.id)).ok, true, 'свой сервис убран')
    eq((await get('/sales')).find((x) => x.id === second.id).payVia, `${TAG} Банк`, 'чек хранит название убранного сервиса')
  })

  // ── Кассы с программой ──
  let regShift2
  await check('касса с программой: перевод, приход в долг, внесение и изъятие — без связи', async () => {
    regShift2 = { id: randomUUID(), openedAt: serverNow().toISOString(), openingCash: 50 }
    eq((await push(KASSA_A, [op('shift.open', { shift: regShift2 })])).results[0].status, 'ok', 'касса открыла смену')

    const transfer = (over = {}) => {
      const sid = randomUUID()
      return op('sale', {
        sale: {
          id: sid, clientId: 'tmp_' + sid.slice(0, 8), date: serverNow().toISOString(), total: 30, cost: 20, profit: 10,
          payment: 'transfer', payVia: 'DC', customerId: null, shiftId: regShift2.id,
          items: [{ id: randomUUID(), saleId: sid, productId: creditGoods.id, name: creditGoods.name, qty: 1, pieces: 0, unitsPerPack: 1, price: 30, cost: 20, discount: 0 }],
          ...over,
        },
      })
    }
    const sent = await push(KASSA_A, [transfer(), transfer({ payVia: '' })])
    eq(sent.results.map((r) => r.status).join(), 'ok,rejected', 'перевод принят, перевод без сервиса — нет')
    assert(/сервис/i.test(sent.results[1].error), sent.results[1].error)

    const arrId = randomUUID()
    const arr = op('arrival', {
      arrival: {
        id: arrId, date: serverNow().toISOString(), supplier: 'с кассы', supplierId: distributor.id, debt: 25, total: 40,
        items: [{ id: randomUUID(), arrivalId: arrId, productId: creditGoods.id, name: creditGoods.name, qty: 2, cost: 20 }],
      },
      expiry: [daysFromNow(400)],
    })
    const gone = randomUUID()
    const arrGone = op('arrival', {
      arrival: { id: gone, date: serverNow().toISOString(), supplier: 'кого нет', supplierId: randomUUID(), debt: 40, total: 40, items: [{ id: randomUUID(), arrivalId: gone, productId: creditGoods.id, name: creditGoods.name, qty: 2, cost: 20 }] },
      expiry: [daysFromNow(400)],
    })
    const tooMuch = randomUUID()
    const arrTooMuch = op('arrival', {
      arrival: { id: tooMuch, date: serverNow().toISOString(), supplier: 'x', supplierId: distributor.id, debt: 100, total: 40, items: [{ id: randomUUID(), arrivalId: tooMuch, productId: creditGoods.id, name: creditGoods.name, qty: 2, cost: 20 }] },
      expiry: [daysFromNow(400)],
    })
    const r = await push(KASSA_A, [arr, arrGone, arrTooMuch])
    eq(r.results.map((x) => x.status).join(), 'ok,ok,rejected', 'приход в долг принят; на удалённого поставщика — принят без долга; долг больше прихода — отказ')
    const onServer = await arrivalById(arrId)
    eq(onServer.supplierId, distributor.id, 'поставщик записан')
    eq(onServer.supplier, distributor.name, 'с названием из справочника')
    eqMoney(onServer.debt, 25, 'неоплаченная часть')
    eqMoney((await supplierById(distributor.id)).debt, 275, '250 + 25')
    eq((await arrivalById(gone)).supplierId, null, 'приход на удалённого поставщика — без поставщика')
    eqMoney((await arrivalById(gone)).debt, 0, 'и без долга')

    const mv = (kind, amount, over = {}) => op('cash.move', { move: { id: randomUUID(), shiftId: regShift2.id, kind, amount, note: TAG, date: serverNow().toISOString(), ...over } })
    const moves = await push(KASSA_A, [mv('in', 100), mv('out', 20), mv('out', 5, { shiftId: randomUUID() }), mv('in', 0)])
    eq(moves.results.map((x) => x.status).join(), 'ok,ok,rejected,rejected', 'внесение и изъятие приняты; в чужую смену и на ноль — нет')
    const extra = mv('in', 100)
    eq((await push(KASSA_A, [extra])).results[0].status, 'ok', 'ещё одно внесение')
    eq((await push(KASSA_A, [extra])).results[0].status, 'duplicate', 'повтор той же операции не задваивает')
    const seen = (await pull(KASSA_A)).data.shifts.upsert.find((s) => s.id === regShift2.id)
    eqMoney(seen.cashIn, 200, 'касса получает смену с внесённым')
    eqMoney(seen.cashOut, 20, 'и с изъятым')

    const close = op('shift.close', { shift: { ...regShift2, closedAt: serverNow().toISOString(), countedCash: 230 } })
    eq((await push(KASSA_A, [close])).results[0].status, 'ok', 'смена закрыта')
    const s = await closedShift(regShift2.id)
    eqMoney(s.cashIn, 200, 'внесено за смену')
    eqMoney(s.cashOut, 20, 'изъято')
    eqMoney(s.salesTransfer, 30, 'переводом')
    eqMoney(s.transferBy['DC'], 30, 'через DC')
    eqMoney(s.expectedCash, 230, '50 + 200 − 20; перевод в ящик не идёт')
    eqMoney(s.difference, 0, 'сошлось')
    // Внесение в закрытую смену, пришедшее позже, пересчитывает её
    eq((await push(KASSA_A, [mv('in', 10)])).results[0].status, 'ok', 'опоздавшее внесение')
    eqMoney((await closedShift(regShift2.id)).expectedCash, 240, 'итоги закрытой смены пересчитаны')
  })

  await check('обмен: поставщики и сервисы — всем, оплаты поставщикам — только владельцу, с добором после кассира', async () => {
    const full = await pull(KASSA_B, undefined, kassaCashier.token)
    const sup = full.data.suppliers.upsert.find((s) => s.id === distributor.id)
    assert(sup, 'кассир получает поставщиков')
    eq('debt' in sup, false, 'но без долгов')
    assert(full.data.payServices.upsert.some((x) => x.name === 'Alif'), 'и сервисы перевода')
    assert(full.data.cashMoves.upsert.some((m) => m.shiftId === regShift2.id), 'и движения наличных')
    eq('supplierPayments' in full.data, false, 'оплат поставщикам у кассира нет вовсе')

    const owner = await pull(KASSA_A)
    assert(owner.data.supplierPayments.upsert.some((p) => p.id === cashPayment.id), 'владельцу оплаты приходят')
    assert(owner.data.suppliers.upsert.find((s) => s.id === distributor.id).debt !== undefined, 'и долги в поставщиках')

    // При кассире на сайте оплатили поставщику — владелец добирает со своей отметки
    const made = await post('/suppliers/' + distributor.id + '/pay', { amount: 5, note: TAG + ' при кассире' })
    const atCashier = await pull(KASSA_A, owner.cursor, kassaCashier.token)
    eq('supplierPayments' in atCashier.data, false, 'кассиру раздел не приходит и частично')
    const back = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${atCashier.cursor}&wcursor=${owner.cursor}`)
    eq(back.full, false, 'полная загрузка не нужна')
    assert(back.data.supplierPayments.upsert.some((p) => p.id === made.id), 'оплата, сделанная при кассире, дошла до владельца')
    assert(back.data.suppliers.upsert.some((s) => s.id === distributor.id), 'и поставщик с новым долгом')
  })

  // ── История движения товара ──
  await check('история движения товара: все движения одним списком с остатком после каждого', async () => {
    const hist = await makeProduct({ name: 'История', cost: 10, price: 20, stock: 0 })
    await post('/arrivals', { supplierId: distributor.id, items: [{ productId: hist.id, qty: 10, cost: 10, expiryDate: daysFromNow(400) }] })
    const sold = await post('/sales', { items: [{ productId: hist.id, qty: 3 }], payment: 'cash', clientId: TAG + '-h1' })
    await post('/returns', { saleId: sold.id, items: [{ productId: hist.id, units: 1 }] })
    await post('/returns', { saleId: sold.id, items: [{ productId: hist.id, units: 1, restock: false }] })
    await post('/writeoffs', { reason: 'damaged', note: TAG, items: [{ productId: hist.id, units: 2 }] })
    // Правка остатка руками в карточке: было 6, стало 9
    await patch('/products/' + hist.id, { stock: 9 })
    await rejects(() => get('/products/' + hist.id + '/history', kassaCashier.token), /прав/i, 'история — только владельцу')
    await rejects(() => get('/products/' + randomUUID() + '/history'), /не найден/i, 'история товара, которого нет')

    const h = await get('/products/' + hist.id + '/history')
    eq(h.unitsNow, 9, 'нынешний остаток')
    // Возврат без возврата в продажу оставляет две записи: сам возврат и списание
    // при нём. Ни одна остаток не двигает: товар на полку не ложился
    const kinds = h.rows.map((r) => r.kind)
    eq(kinds.join(), 'edit,writeoff,return,writeoff,return,sale,arrival', 'все движения, новые сверху: ' + kinds.join())
    eq(h.rows.map((r) => r.after).join(), '9,6,8,8,8,7,10', 'остаток после каждого движения')
    eq(h.rows.map((r) => r.delta).join(), '3,-2,0,0,1,-3,10', 'и на сколько каждое его изменило')
    const notRestocked = h.rows.find((r) => r.kind === 'return' && !r.restock)
    eq(notRestocked.moves, false, 'возврат без возврата в продажу остаток не двигает')
    eq(h.rows.find((r) => r.kind === 'writeoff' && r.source === 'return').moves, false, 'и списание при нём — тоже')
    eq(h.rows.find((r) => r.kind === 'arrival').supplier, distributor.name, 'у прихода — поставщик')
    eq(h.rows.find((r) => r.kind === 'sale').price, 20, 'у продажи — цена')
    eq(h.rows.find((r) => r.kind === 'writeoff').reason, 'damaged', 'у списания — причина')
    assert(h.rows.every((r) => typeof r.who === 'string'), 'у каждого движения — кто')
    assert(h.rows.filter((r) => r.kind !== 'edit').every((r) => r.who), 'и это имя не пустое')
    // Период: за всё время — те же строки; старый отрезок — пусто
    eq((await get('/products/' + hist.id + '/history?days=0')).rows.length, 7, 'за всё время')
    eq((await get('/products/' + hist.id + '/history?from=2020-01-01&to=2020-02-01')).rows.length, 0, 'давний отрезок пуст')
  })

  await check('поставщики, оплаты, движения наличных и сервисы попадают в резервную копию', async () => {
    const dump = await get('/backup')
    eq(dump.format, 5, 'версия формата копии')
    assert(dump.data.suppliers.some((s) => s.id === distributor.id), 'поставщик в копии')
    assert(dump.data.supplierPayments.some((p) => p.id === cashPayment.id), 'оплата поставщику в копии')
    assert(dump.data.cashMoves.some((m) => m.id === cashIn.id), 'внесение наличных в копии')
    assert(dump.data.payServices.some((s) => s.name === 'Alif'), 'сервисы перевода в копии')
    assert(dump.data.stockEdits.length >= 1, 'правки остатка в копии')
    eq(dump.counts.suppliers, dump.data.suppliers.length, 'число поставщиков в сводке')
    const sh = dump.data.shifts.find((s) => s.id === payShift.id)
    eqMoney(sh.cashIn, 200, 'смена в копии — с внесённым')
    eqMoney(sh.supplierCash, 150, 'и с оплатами поставщикам из кассы')
  })

  // ────────────────────────────────────────────────────────────
  group('Доступ и сессии')

  const cashierName = TAG + '-kassir'
  let cashierId
  let cashierToken

  await check('владелец заводит кассира, тот входит', async () => {
    const u = await post('/users', { name: cashierName, password: 'perviy-parol', role: 'cashier' })
    cashierId = u.id
    created.users.push(u.id)
    eq(u.role, 'cashier', 'роль нового сотрудника')
    cashierToken = await loginAs(cashierName, 'perviy-parol')
    const me = await get('/auth/me', cashierToken)
    eq(me.name, cashierName, 'кассир представился')
  })

  await check('кассиру закрыты хозяйские разделы', async () => {
    await rejects(() => get('/writeoffs', cashierToken), /прав/i, 'журнал списаний')
    await rejects(() => get('/users', cashierToken), /прав/i, 'список сотрудников')
    await rejects(() => get('/backup', cashierToken), /прав/i, 'выгрузка базы')
    await rejects(() => get('/inventory', cashierToken), /прав/i, 'пересчёт остатков')
  })

  await check('кассир при этом работает с кассой', async () => {
    const list = await get('/products', cashierToken)
    assert(Array.isArray(list), 'товары кассиру видны')
    const cats = await get('/categories', cashierToken)
    assert(Array.isArray(cats), 'категории кассиру видны')
  })

  // Раньше списать одну упаковку кассир не мог, а удалить товар целиком — вместе
  // с карточкой, партиями и следами недостачи — мог. Цену тоже: снизить, продать
  // и вернуть обратно. Теперь это за владельцем.
  await check('кассир не переоценивает и не удаляет товары', async () => {
    await rejects(() => patch('/products/' + pill.id, { price: 1 }, cashierToken), /прав/i, 'смена цены')
    await rejects(() => del('/products/' + pill.id, cashierToken), /прав/i, 'удаление товара')
    const untouched = await productById(pill.id)
    eq(untouched.price, 200, 'цена осталась прежней')
  })

  // А вот заводить товар кассиру нужно: приёмку оформляет и он, и привезти могут
  // то, чего в базе ещё нет. Отнять создание — остановить приёмку на первом же
  // новом наименовании.
  await check('кассир заводит товар и оформляет приход', async () => {
    const fresh = await post(
      '/products',
      { name: `${TAG} Кассирский`, barcode: bc(90), category: 'Таблетки', cost: 0, price: 50, stock: 0, unitsPerPack: 1 },
      cashierToken,
    )
    created.products.push(fresh.id)
    await post(
      '/arrivals',
      { supplier: TAG, items: [{ productId: fresh.id, qty: 3, cost: 30, expiryDate: daysFromNow(120) }] },
      cashierToken,
    )
    const after = await productById(fresh.id)
    eq(after.stock, 3, 'приход кассира лёг на склад')
  })

  await check('смена пароля отзывает старые токены', async () => {
    await patch('/users/' + cashierId, { password: 'vtoroy-parol' })
    await rejects(() => get('/auth/me', cashierToken), /Пароль был изменён|Сессия|вход/i, 'старый токен')
    const fresh = await loginAs(cashierName, 'vtoroy-parol')
    const me = await get('/auth/me', fresh)
    eq(me.name, cashierName, 'по новому паролю вход работает')
    cashierToken = fresh
  })

  await check('блокировка сотрудника закрывает доступ немедленно', async () => {
    await patch('/users/' + cashierId, { active: false })
    await rejects(() => get('/products', cashierToken), /Сессия недействительна/, 'токен заблокированного')
    await rejects(() => loginAs(cashierName, 'vtoroy-parol'), /Неверное имя или пароль/, 'вход заблокированного')
    await patch('/users/' + cashierId, { active: true })
  })

  await check('без токена не пускают вовсе', async () => {
    await rejects(() => get('/products', ''), /Требуется вход/, 'запрос без токена')
    // Только латиница: кириллица в HTTP-заголовок не помещается, и упадёт сам запрос,
    // а не проверка доступа
    await rejects(() => get('/products', 'abc.def'), /Требуется вход/, 'мусор вместо токена')
    await rejects(() => get('/products', 'abc'), /Требуется вход/, 'токен без подписи')
  })

  // ────────────────────────────────────────────────────────────
  group('Постоянное соединение')

  await check('с действующим входом соединение принимается', async () => {
    const ok = await socketAccepted(await loginAs(cashierName, 'vtoroy-parol'))
    assert(ok, 'соединение оборвано, хотя доступ действует')
  })

  await check('без токена и с мусором — обрыв', async () => {
    assert(!(await socketAccepted('')), 'пустой токен приняли')
    assert(!(await socketAccepted('abc.def')), 'мусорный токен приняли')
  })

  await check('токен заблокированного сотрудника не подключается', async () => {
    const t = await loginAs(cashierName, 'vtoroy-parol')
    assert(await socketAccepted(t), 'до блокировки соединение должно работать')
    await patch('/users/' + cashierId, { active: false })
    try {
      assert(!(await socketAccepted(t)), 'заблокированного пустили на связь')
    } finally {
      // Разблокируем в любом случае: иначе упавшая проверка утащила бы за собой
      // все следующие — сотрудник остался бы заблокированным
      await patch('/users/' + cashierId, { active: true })
    }
  })

  await check('после смены пароля старый токен на связь не пускают', async () => {
    const t = await loginAs(cashierName, 'vtoroy-parol')
    assert(await socketAccepted(t), 'до смены пароля соединение должно работать')
    await patch('/users/' + cashierId, { password: 'tretiy-parol' })
    assert(!(await socketAccepted(t)), 'старый токен пустили на связь')
  })


  // ────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────
  // Самая важная проверка сервиса. Ошибка здесь ничего не роняет и ничего не пишет
  // в журнал — она просто показывает одному магазину товары, закупочные цены и долги
  // другой. Заметить такое можно только глазами клиента, и одного раза достаточно,
  // чтобы сервису перестали доверять.
  group('Пароли и заголовки')

  await check('короткий пароль сотруднику завести нельзя', async () => {
    await rejects(
      () => post('/users', { name: TAG + '-korotkiy', password: '12345', role: 'cashier' }),
      /не короче|коротк/i,
      'пароль в пять символов',
    )
  })

  await check('очевидный пароль тоже не принимается', async () => {
    // Длину проходит, а защитой не является: кассир наберёт именно такой
    await rejects(
      () => post('/users', { name: TAG + '-ochevidnyy', password: '123456', role: 'cashier' }),
      /перв(ой|ую) попытк/i,
      'пароль 123456',
    )
  })

  await check('пароль из повторяющегося символа не принимается', async () => {
    await rejects(
      () => post('/users', { name: TAG + '-odna-bukva', password: 'zzzzzz', role: 'cashier' }),
      /повторя/i,
      'пароль zzzzzz',
    )
  })

  await check('сервер не рассказывает о себе лишнего и не даёт вложить себя в рамку', async () => {
    const res = await fetch(API + '/health')
    eq(res.headers.get('x-content-type-options'), 'nosniff', 'нет запрета угадывать тип содержимого')
    eq(res.headers.get('x-frame-options'), 'DENY', 'API можно вложить в рамку на чужой странице')
    assert(res.headers.get('strict-transport-security'), 'нет требования защищённого соединения')
    assert(!res.headers.get('x-powered-by'), 'сервер называет свою платформу — подсказка для подбора дыр')
  })

  await check('свой пароль нельзя подбирать бесконечно', async () => {
    // Смена пароля спрашивает текущий, а значит её можно перебирать — причём
    // в обход входа, укравшим токен. Отдельный счётчик, отдельная блокировка.
    let blocked = 0
    for (let i = 1; i <= 10; i++) {
      try {
        await post('/auth/change-password', { oldPassword: 'zavedomo-nevernyy-' + i, newPassword: 'novyy-parol-2026' })
      } catch (e) {
        if (/Слишком много/.test(e.message)) {
          blocked = i
          break
        }
      }
    }
    assert(blocked, 'текущий пароль можно перебирать сколько угодно')
    assert(blocked <= 7, `ограничение сработало слишком поздно: на ${blocked}-й попытке`)
  })

  // ────────────────────────────────────────────────────────────
  group('Магазины не видят друг друга')

  let neighbour = null
  let neighbourToken = ''
  // Штрихкод считаем один раз: bc() берёт текущее время, и второй вызов дал бы
  // другой код — проверка искала бы товар, которого не заводила
  const sharedBarcode = bc(77)

  if (temp) {
    // Владелец сервиса живёт вне магазинов, и это не должно мешать ему быть собой.
    // Первый же живой запуск показал, чем это кончается: раздел «кто я» отвечал
    // отказом, клиент опрашивает его при каждом запуске — и вход срабатывал, а
    // сразу за ним следовал выход.
    await check('владелец сервиса может спросить «кто я»', async () => {
      const me = await get('/auth/me', serviceToken)
      eq(me.role, 'superadmin', 'роль владельца сервиса')
      eq(me.pharmacy, null, 'у владельца сервиса своего магазина нет')
    })

    await check('владелец сервиса в разделы магазина не попадает', async () => {
      await rejects(() => get('/products', serviceToken), /не привязана|прав/i, 'товары магазина')
      await rejects(() => get('/sales', serviceToken), /не привязана|прав/i, 'чеки магазина')
    })

    await check('владелец магазина в панель управления не попадает', async () => {
      await rejects(() => get('/admin/pharmacies'), /прав/i, 'список магазинов')
    })

    await check('второй магазин заводится и начинает с пустого склада', async () => {
      const code = TAG.toLowerCase() + '-2'
      const password = 'e2e-' + Math.random().toString(36).slice(2, 10)
      neighbour = await post('/admin/pharmacies', { code, name: TAG + ' Соседняя', ownerPassword: password }, serviceToken)
      neighbourToken = await loginAs(neighbour.ownerLogin, password)

      const theirs = await get('/products', neighbourToken)
      eq(theirs.length, 0, 'у нового магазина не должно быть ни одного товара')
    })

    await check('соседний магазин не видит наших товаров и продаж', async () => {
      const ours = await get('/products')
      assert(ours.length > 0, 'в нашем магазине товары есть — иначе проверка ничего не значит')

      const theirProducts = await get('/products', neighbourToken)
      const leaked = theirProducts.filter((p) => String(p.name).startsWith(TAG))
      eq(leaked.length, 0, `в соседний магазин протекли товары: ${leaked.map((p) => p.name).join(', ')}`)

      const theirSales = await get('/sales?days=0', neighbourToken)
      eq(theirSales.length, 0, 'в соседний магазин протекли чеки')
    })

    await check('один и тот же штрихкод заводится в обоих магазинах', async () => {
      // Штрихкод уникален внутри магазина. Если бы данные лежали вместе, второй
      // магазине отказали бы: «товар с таким штрихкодом уже существует»
      const shared = sharedBarcode
      await post('/products', { name: TAG + ' Общий', barcode: shared, category: 'Таблетки', price: 10 })
      const mine = (await get('/products')).find((p) => p.barcode === shared)
      assert(mine, 'товар не завёлся у нас')
      created.products.push(mine.id)

      const theirs = await post(
        '/products',
        { name: TAG + ' Общий', barcode: shared, category: 'Таблетки', price: 99 },
        neighbourToken,
      )
      assert(theirs.id !== mine.id, 'вернулась одна и та же запись — значит база общая')
    })

    await check('цена в соседнем магазине своя и на нашу не влияет', async () => {
      const mine = (await get('/products')).find((p) => p.barcode === sharedBarcode)
      const theirs = (await get('/products', neighbourToken)).find((p) => p.barcode === sharedBarcode)
      assert(mine && theirs, 'товар с общим штрихкодом не нашёлся в обоих магазинах')
      eqMoney(mine.price, 10, 'наша цена')
      eqMoney(theirs.price, 99, 'цена соседей')
    })

    await check('сотрудник соседнего магазина не попадает в наши разделы по своему токену', async () => {
      // Один и тот же адрес, разные токены — и каждый обязан остаться у себя
      const theirCustomers = await get('/customers', neighbourToken)
      const leaked = theirCustomers.filter((c) => String(c.name).startsWith(TAG))
      eq(leaked.length, 0, 'в соседний магазин протекли клиенты')
    })

    await check('соседний магазин удалён вместе со схемой', async () => {
      await del(`/admin/pharmacies/${neighbour.id}?confirm=${neighbour.code}`, serviceToken)
      await rejects(() => get('/products', neighbourToken), /.*/, 'токен удалённого магазина')
    })
  }

  // ────────────────────────────────────────────────────────────
  // Само правило подписки — когда предупреждать, когда закрывать продажи —
  // разобрано по дням в отдельных проверках без базы. Здесь смотрим то, что
  // проверяется только вживую: что продление доходит до базы, а приостановка
  // действительно останавливает работу.
  group('Подписка')

  if (temp) {
    let victim = null
    let victimToken = ''

    await check('продление сдвигает срок и заканчивает пробный период', async () => {
      const before = (await get('/admin/pharmacies', serviceToken)).find((p) => p.id === temp.id)
      assert(before.trial, 'новый магазин должен начинаться с пробного периода')

      await post(`/admin/pharmacies/${temp.id}/extend`, { months: 3, amount: 450, method: 'cash' }, serviceToken)

      const after = (await get('/admin/pharmacies', serviceToken)).find((p) => p.id === temp.id)
      assert(new Date(after.paidUntil) > new Date(before.paidUntil), 'срок оплаты не сдвинулся')
      eq(after.trial, false, 'после оплаты пробный период должен закончиться')
    })

    await check('оплата попадает в журнал — иначе спор с клиентом решать нечем', async () => {
      const list = await get(`/admin/pharmacies/${temp.id}/payments`, serviceToken)
      assert(list.length >= 1, 'запись об оплате не появилась')
      eqMoney(list[0].amount, 450, 'сумма оплаты')
      eq(list[0].months, 3, 'число месяцев')
    })

    await check('приостановленный магазин не работает и это ей понятно объясняют', async () => {
      const code = TAG.toLowerCase() + '-3'
      const password = 'e2e-' + Math.random().toString(36).slice(2, 10)
      victim = await post('/admin/pharmacies', { code, name: TAG + ' Должник', ownerPassword: password }, serviceToken)
      victimToken = await loginAs(victim.ownerLogin, password)
      assert(Array.isArray(await get('/products', victimToken)), 'до приостановки магазин работает')

      await post(`/admin/pharmacies/${victim.id}/block`, {}, serviceToken)

      const e = await rejects(() => get('/products', victimToken), /приостановлена/i, 'работа после приостановки')
      assert(/поставщик/i.test(e.message), 'в отказе не сказано, к кому обращаться')
      await rejects(() => loginAs(victim.ownerLogin, password), /приостановлена/i, 'вход в приостановленный магазин')
    })

    await check('возобновление возвращает работу', async () => {
      await post(`/admin/pharmacies/${victim.id}/unblock`, {}, serviceToken)
      const fresh = await loginAs(victim.ownerLogin, victim.ownerPassword)
      assert(Array.isArray(await get('/products', fresh)), 'магазин не заработал после возобновления')
    })

    // ── Срок значит срок ──
    // Прежде здесь было мягко: пять дней отсрочки, потом режим только чтения.
    // Владелец сервиса решил иначе — он назначает точный момент, вплоть до часа,
    // и в этот момент работа прекращается. Мягкость сделала бы назначенное время
    // пустым обещанием.
    await check('срок вышел — закрыта вся работа, а не только продажи', async () => {
      // От часов СЕРВЕРА: наши могут уйти на минуты, и «минуту назад» по ним
      // окажется будущим для сервера — проверка провалилась бы на верном коде
      const past = new Date(serverNow().getTime() - 60 * 1000).toISOString()
      await patch(`/admin/pharmacies/${temp.id}`, { paidUntil: past }, serviceToken)

      const e = await rejects(() => get('/products'), /Подписка закончилась/, 'просмотр товаров')
      eq(e.status, 403, 'отказ по подписке')
      assert(/сохранены/i.test(e.message), 'человек должен знать, что не потерял свой магазин')
      assert(/поставщику программы/i.test(e.message), 'и что делать дальше')

      await rejects(
        () => post('/sales', { items: [{ productId: pill.id, qty: 1 }], payment: 'cash' }),
        /Подписка закончилась/,
        'продажа',
      )
    })

    await check('войти заново тоже нельзя, и отказ объясняет причину', async () => {
      // Сказать «неверный пароль» было бы враньём: пароль верный. Человек набирал бы
      // его снова, пока не упёрся в защиту от подбора, и решил бы, что потерял магазин.
      const e = await rejects(
        () => loginAs(temp.ownerLogin, temp.ownerPassword),
        /Подписка закончилась/,
        'вход с истёкшей подпиской',
      )
      assert(!/Неверное имя или пароль/.test(e.message), 'отказ не должен врать про пароль')
    })

    await check('владелец сервиса всё равно попадает внутрь — это его инструмент', async () => {
      // Клиент отключён, но помогать ему всё ещё надо: посмотреть, снять копию,
      // разобраться. Отказать поддержке значило бы отобрать инструмент у того, кто чинит.
      const support = await post(`/admin/pharmacies/${temp.id}/enter`, {}, serviceToken)
      assert(Array.isArray(await get('/products', support.token)), 'поддержка не попала в отключённую магазин')
    })

    await check('оплата возвращает работу', async () => {
      await post(`/admin/pharmacies/${temp.id}/extend`, { months: 1, amount: 150 }, serviceToken)
      // Токен прежний: отключение не отзывает вход, оно лишь закрывает работу
      const s = await post('/sales', { items: [{ productId: pill.id, qty: 1 }], payment: 'cash' })
      assert(s.id, 'после оплаты продажа не прошла')
      assert(Array.isArray(await get('/products')), 'после оплаты просмотр не вернулся')
    })

    await check('срок задаётся с точностью до часа, а не до суток', async () => {
      // В этом вся затея: «до 17:00» должно означать пять вечера, а не конец дня.
      const inTwoMin = new Date(serverNow().getTime() + 2 * 60 * 1000)
      await patch(`/admin/pharmacies/${temp.id}`, { paidUntil: inTwoMin.toISOString() }, serviceToken)

      const me = await get('/auth/me')
      const back = new Date(me.subscription.paidUntil).getTime()
      assert(Math.abs(back - inTwoMin.getTime()) < 1000, `час срока потерян: ${me.subscription.paidUntil}`)
      eq(me.subscription.status, 'active', 'через две минуты после назначения магазин ещё работает')
      assert(me.subscription.leftMs > 0 && me.subscription.leftMs <= 2 * 60 * 1000, 'осталось не то время')

      // Возвращаем срок обратно, чтобы дальнейшие проверки шли на живом магазине
      await post(`/admin/pharmacies/${temp.id}/extend`, { months: 1, amount: 150 }, serviceToken)
    })

    // ── Сколько касса работает без связи ──
    await check('срок работы кассы без связи: семь дней по умолчанию, владелец сервиса назначает свой', async () => {
      eq((await get('/auth/me')).subscription.offlineDays, 7, 'по умолчанию — неделя')
      const viaSync = await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${kassaCursor}`)
      eq(viaSync.me.subscription.offlineDays, 7, 'касса узнаёт срок при каждом обмене')

      // Горное село: связь пропадает на недели — этому магазину ставят больше
      const saved = await patch(`/admin/pharmacies/${temp.id}`, { offlineDays: 14 }, serviceToken)
      eq(saved.offlineDays, 14, 'число сохранено в карточке магазина')
      eq((await get('/auth/me')).subscription.offlineDays, 14, 'магазин видит новый срок сразу, без перезахода')
      eq((await get(`/sync/pull?deviceId=${KASSA_A}&cursor=${viaSync.cursor}`)).me.subscription.offlineDays, 14, 'и касса тоже')
      const journal = await get('/admin/audit?limit=50', serviceToken)
      assert(journal.some((a) => a.pharmacyCode === temp.code && a.action === 'set-offline-days'), 'смена срока не записана в журнал панели')

      // Ноль запретил бы работу без интернета вовсе, полгода сделали бы проверку формальностью
      for (const bad of [0, 31, -5, 2.5, 'семь']) {
        const e = await rejects(() => patch(`/admin/pharmacies/${temp.id}`, { offlineDays: bad }, serviceToken), /.+/, `срок «${bad}»`)
        eq(e.status, 400, `срок «${bad}» должен быть отвергнут`)
      }
      eq((await get('/auth/me')).subscription.offlineDays, 14, 'негодные значения ничего не поменяли')
      // Владелец магазина сам себе срок не назначит
      await rejects(() => patch(`/admin/pharmacies/${temp.id}`, { offlineDays: 30 }), /прав|доступ/i, 'правка срока владельцем магазина')
      await patch(`/admin/pharmacies/${temp.id}`, { offlineDays: 7 }, serviceToken)
    })

    // ── Вход под владельцем ──
    await check('владелец сервиса может посмотреть магазин глазами владельца', async () => {
      const res = await post(`/admin/pharmacies/${temp.id}/enter`, {}, serviceToken)
      assert(res.token, 'токен не выдан')

      const me = await get('/auth/me', res.token)
      eq(me.role, 'founder', 'вошли не владельцем магазина')
      eq(me.pharmacy.code, temp.code, 'попали не в тот магазин')
      assert(me.impersonatedBy, 'не помечено, что это поддержка, — интерфейс не сможет предупредить')

      assert(Array.isArray(await get('/products', res.token)), 'данные магазина не видны')
    })

    await check('вход под владельцем попадает в журнал', async () => {
      const journal = await get('/admin/audit?limit=50', serviceToken)
      const entry = journal.find((a) => a.pharmacyCode === temp.code && a.action === 'impersonate')
      assert(entry, 'вход под чужим владельцем не записан — а это первое, что должно быть видно')
    })

    await check('приостановка соседнего магазина не задевает нашу', async () => {
      await post(`/admin/pharmacies/${victim.id}/block`, {}, serviceToken)
      assert(Array.isArray(await get('/products')), 'наш магазин перестал работать из-за чужой приостановки')
      await del(`/admin/pharmacies/${victim.id}?confirm=${victim.code}`, serviceToken)
    })
  }

  // ────────────────────────────────────────────────────────────
  // Проверка идёт последней среди всех, где нужен вход, и это не прихоть.
  // Пять промахов подряд закрывают вход НЕ ТОЛЬКО ЭТОМУ ИМЕНИ, но и всему
  // устройству — а весь прогон идёт с одного адреса. Запусти её раньше, и она
  // заблокировала бы сама себя, а заодно всё, что идёт следом.
  //
  // Дальше остаются только разделы, работающие по уже полученным токенам:
  // обслуживание сервиса и уборка. Вход им не нужен.
  group('Подбор пароля')

  await check('сервер видит настоящий адрес магазина, а не прокси хостинга', async () => {
    // От этого зависит вся защита входа: она считает промахи по адресу устройства.
    //
    // Так и было на живом сервере: адресом считался прокси Railway, а их два на весь
    // мир. То есть промахи ВСЕХ клиентов складывались в одну кучу, и порог в пять
    // попыток закрыл бы вход всему сервису разом. Снаружи это невидимо — обычная
    // проверка «после пяти промахов вход закрыт» проходила как ни в чём не бывало.
    //
    // Если Railway когда-нибудь добавит ещё один прокси, всё сломается так же тихо.
    // Поэтому сверяем: адрес, по которому считает сервер, обязан совпадать с тем,
    // что прислал прокси в заголовке настоящего адреса.
    if (!temp) return
    const c = await get('/admin/schema/client', serviceToken)
    assert(c.real, 'прокси не прислал настоящий адрес — сверять не с чем')
    eq(c.ip, c.real, 'сервер считает адресом устройства прокси хостинга, а не магазин')
  })

  const victimName = TAG + '-perebor'

  await check('вход закрывается после нескольких промахов', async () => {
    const u = await post('/users', { name: victimName, password: 'nastoyashiy-parol', role: 'cashier' })
    created.users.push(u.id)
    assert(await loginAs(victimName, 'nastoyashiy-parol'), 'сначала вход работает')

    let blocked = 0
    let attempts = 0
    for (let i = 0; i < 15; i++) {
      attempts++
      try {
        await loginAs(victimName, 'mimo-' + i)
      } catch (e) {
        if (/Слишком много/.test(e.message)) {
          blocked = attempts
          break
        }
      }
    }
    assert(blocked, `после ${attempts} попыток вход всё ещё открыт`)
    // Предел — пять промахов, значит отказ приходит на шестой. Запас в одну
    // попытку на случай, если счётчику что-то помешало; больше — уже послабление
    assert(blocked <= 7, `ограничение сработало слишком поздно: на ${blocked}-й попытке`)
  })

  await check('заблокировано даже с ПРАВИЛЬНЫМ паролем — иначе подбор просто продолжился бы', async () => {
    await rejects(() => loginAs(victimName, 'nastoyashiy-parol'), /Слишком много/, 'вход после блокировки')
  })

  await check('смена имени не обходит защиту — закрыт вход со ВСЕГО устройства', async () => {
    // Дыру нашёл живой человек. Пять раз промахнулся под «admin» — вход под этим
    // именем закрыт, а под соседним пробуй сколько хочешь: строго считалось только
    // имя, а по устройству стоял мягкий порог в тридцать попыток. Имена здесь
    // угадываются легко — логин обычно совпадает с кодом магазина.
    //
    // Проверяем чужим, заведомо существующим именем и ПРАВИЛЬНЫМ паролем: если бы
    // счёт шёл только по имени, такой вход прошёл бы как ни в чём не бывало.
    await rejects(() => loginAs(cashierName, 'tretiy-parol'), /Слишком много/, 'вход другим именем')
    // И совсем незнакомым именем тоже: перебор вслепую должен упираться в ту же стену
    await rejects(() => loginAs(TAG + '-nesushchestvuyushchiy', 'lyuboy-parol'), /Слишком много/, 'вход чужим именем')
  })

  await check('первая блокировка короткая — забывчивый кассир не ждёт четверть часа', async () => {
    // В магазине все устройства выходят в сеть через один адрес: касса, компьютер
    // владельца, телефон. Четверть часа за пять опечаток означала бы, что один
    // кассир закрывает работу всему магазину. Поэтому первая ступень — минута.
    const at = Date.now()
    let opened = 0
    // Ждём до полутора минут, проверяя раз в пять секунд
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        await loginAs(cashierName, 'tretiy-parol')
        opened = Date.now() - at
        break
      } catch (e) {
        if (!/Слишком много/.test(e.message)) throw e
      }
    }
    assert(opened, 'вход не открылся и через полторы минуты — первая ступень слишком длинная')
    assert(opened <= 90_000, `вход открылся через ${Math.round(opened / 1000)} с — первая ступень должна быть около минуты`)
  })

  await check('после разблокировки работа продолжается как обычно', async () => {
    const other = await loginAs(cashierName, 'tretiy-parol')
    const me = await get('/auth/me', other)
    eq(me.name, cashierName, 'другой сотрудник входит как обычно')
    const list = await get('/products')
    assert(Array.isArray(list), 'владелец продолжает работать')
  })

  // ────────────────────────────────────────────────────────────
  // Фоновая работа сервиса: обновление схем и автоматические копии. Проверяем не
  // саму работу (она идёт ночью и по расписанию), а то, что сервис честно
  // рассказывает о своём состоянии. Тихо неработающая фоновая задача опаснее
  // отсутствующей: на неё рассчитывают.
  group('Обслуживание сервиса')

  if (temp) {
    await check('схемы всех магазинов в актуальном состоянии', async () => {
      const st = await get('/admin/schema', serviceToken)
      assert(st.target, 'сервер не знает, какая версия схемы нужна')
      eq(st.outdated, 0, `магазинов со старой схемой: ${st.outdated}`)
      const mine = st.pharmacies.find((p) => p.code === temp.code)
      assert(mine && mine.upToDate, 'наш магазин остался на старой схеме')
    })

    await check('обновление схем можно запустить вручную и оно не ломает работающие', async () => {
      const r = await post('/admin/schema/update', {}, serviceToken)
      eq(r.failed.length, 0, `не обновились: ${r.failed.join(', ')}`)
      assert(Array.isArray(await get('/products')), 'после обновления схем магазин перестал работать')
    })

    await check('сводка для владельца сервиса считается и сходится с базой', async () => {
    // Числа, по которым владелец судит о своём деле. Ошибка здесь ничего не роняет —
    // просто он видит не ту картину и принимает не те решения. Заметить это можно
    // только пересчитав вручную, а вручную никто не пересчитывает.
    const sum = await get('/admin/pharmacies/summary', serviceToken)
    const list = await get('/admin/pharmacies', serviceToken)

    eq(sum.clients.total, list.length, 'всего клиентов')
    const states = sum.clients.paying + sum.clients.trial + sum.clients.expired + sum.clients.blocked
    eq(states, list.length, 'сумма по состояниям должна давать всех клиентов, никого не потеряв и не посчитав дважды')

    eq(sum.byMonth.length, 12, 'график всегда из двенадцати месяцев')
    assert(sum.money.allTime >= sum.money.thisMonth, 'доход за всё время не может быть меньше дохода за месяц')
    assert(sum.money.avgPayment >= 0, 'средний платёж')

    // «Принёс за всё время» у каждого клиента приходит вместе со списком
    assert(list.every((p) => typeof p.paid === 'number'), 'в списке нет суммы платежей клиента')
  })

  await check('отметка о звонке сохраняется и видна в списке', async () => {
    if (!temp) return
    const before = (await get('/admin/pharmacies', serviceToken)).find((p) => p.code === temp.code)
    assert(!before.calledAt, 'отметки о звонке ещё не было')

    await post(`/admin/pharmacies/${temp.id}/called`, { note: 'обещал в пятницу' }, serviceToken)
    const after = (await get('/admin/pharmacies', serviceToken)).find((p) => p.code === temp.code)
    assert(after.calledAt, 'дата звонка не записалась')
    eq(after.callNote, 'обещал в пятницу', 'что обещали')
  })

  await check('сервис честно говорит, снимаются ли автоматические копии', async () => {
      const st = await get('/admin/backups', serviceToken)
      assert(typeof st.enabled === 'boolean', 'состояние копий неизвестно')
      if (st.enabled) {
        assert(st.target, 'копии включены, но неизвестно куда складываются')
      } else {
        eq(st.target, null, 'копии выключены, но куда-то якобы складываются')
      }
    })
  }

  // ────────────────────────────────────────────────────────────
  group('Уборка')

  await check('тестовые товары удалены', async () => {
    for (const id of created.products) {
      await del('/products/' + id).catch(() => {})
    }
    const left = (await get('/products')).filter((p) => p.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых товаров не осталось')
  })

  await check('тестовые клиенты удалены', async () => {
    for (const id of created.customers) {
      await del('/customers/' + id).catch(() => {})
    }
    const left = (await get('/customers')).filter((c) => c.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых клиентов не осталось')
  })

  await check('тестовые категории удалены', async () => {
    for (const id of created.categories) {
      await del('/categories/' + id).catch(() => {})
    }
    const left = (await get('/categories')).filter((c) => c.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых категорий не осталось')
  })

  await check('тестовые расходы и статьи убраны', async () => {
    // Расход из кассы закрытой смены не удаляется — и правильно: он в её отчёте.
    // Такие уходят вместе со схемой магазина прогона
    for (const id of created.expenses) await del('/expenses/' + id).catch(() => {})
    for (const id of created.expenseCategories) await del('/expense-categories/' + id).catch(() => {})
    const left = (await get('/expense-categories')).filter((c) => c.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых статей не осталось')
  })

  await check('тестовые поставщики и сервисы убраны', async () => {
    // Поставщик с долгом не удаляется — и правильно; он уходит вместе со схемой магазина прогона
    for (const id of created.suppliers) await del('/suppliers/' + id).catch(() => {})
    for (const id of created.payServices) await del('/pay-services/' + id).catch(() => {})
    const left = (await get('/pay-services')).filter((c) => c.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых сервисов не осталось')
  })

  await check('тестовые сотрудники удалены', async () => {
    for (const id of created.users) {
      await del('/users/' + id).catch(() => {})
    }
    const left = (await get('/users')).filter((u) => u.name.startsWith(TAG))
    eq(left.length, 0, 'тестовых сотрудников не осталось')
  })

  // Схема прогона удаляется целиком: это единственный способ убрать чеки,
  // возвраты и списания, которые через обычную работу удалить нельзя — и правильно,
  // что нельзя: история магазина не должна стираться по кнопке.
  if (temp) {
    await check('временная магазин удалён вместе со схемой', async () => {
      await del(`/admin/pharmacies/${temp.id}?confirm=${temp.code}`, serviceToken)
      const left = (await get('/admin/pharmacies', serviceToken)).filter((p) => p.code === temp.code)
      eq(left.length, 0, 'магазин прогона не убралась')
    })
  }

  process.exit(summary() ? 1 : 0)
}

main().catch((e) => {
  console.error('\n\x1b[31mПрогон оборвался:\x1b[0m', e.message)
  process.exit(1)
})
