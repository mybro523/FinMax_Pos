// ── Касса и настоящий сервер: продажа без интернета и всё, что бывает потом ──
//
// Здесь нет заглушек. Настоящая основная часть программы (локальная база, очередь,
// обмен) работает с настоящим сервером, а «интернет» между ними выключается и
// портится по команде. Проверяется то, ради чего всё затевалось:
//   • продажа без интернета;
//   • возвращение связи — сделанное без неё уходит на сервер;
//   • повторная отправка не создаёт дубликатов;
//   • обрыв связи посреди обмена ничего не теряет и не задваивает;
//   • две кассы продали один и тот же последний товар;
//   • цену сменили, пока касса была без связи; чек вернули дважды;
//   • приход в долг поставщику, внесение и изъятие наличных, чек переводом — без связи.
//
// Проверка пишет в настоящую аптеку, поэтому запускается только руками и только на
// своей проверочной аптеке (не на рабочей!):
//   APP_USER=<логин владельца> APP_PASS=<пароль> npm run test:sync
// Адрес сервера — из desktop/.env или из переменной API_URL.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../src/gateway.mjs'
import { createClock } from '../src/local/clock.mjs'
import { openDb } from '../src/local/db.mjs'
import { CORE_SCHEMA } from '../src/local/schema.mjs'
import { loadEnv } from '../scripts/env.mjs'
import { fakeSeal, manualTimers, memorySession } from '../test-support/server.mjs'

const env = loadEnv()
const API = (env.API_URL || env.APTEKA_API_URL || '').replace(/\/$/, '')
const USER = env.APP_USER || ''
const PASS = env.APP_PASS || ''
const ready = !!(API && USER && PASS)
const skip = !ready && 'нужны APP_USER и APP_PASS проверочной аптеки'

const TAG = 'SYN-' + Date.now().toString(36)

// ── Сервер напрямую, мимо кассы: подготовить данные и посмотреть, что до него дошло ──
let token = ''
async function srv(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const serverProduct = async (id) => (await srv('GET', '/products')).find((p) => p.id === id)

// ── Касса с интернетом, который можно выключить и испортить ──
function kassa(name) {
  const net = {
    online: true,
    // Запрос дошёл и выполнен, а ответ потерялся: (адрес) → true
    lose: null,
    // Что касса отправляла на сервер
    sent: [],
  }
  // На сколько часы кассы ушли вперёд: так проверка «проживает» несколько минут
  const skew = { ms: 0 }
  const dir = fs.mkdtempSync(join(os.tmpdir(), `apteka-live-${name}-`))
  const core = openDb(join(dir, 'core.db'), CORE_SCHEMA)
  const timers = manualTimers()
  const events = []
  const gw = createGateway({
    apiUrl: API,
    fetchImpl: async (url, init) => {
      if (!net.online) throw new TypeError('нет связи')
      if (init?.method === 'POST' && url.endsWith('/sync/push')) net.sent.push(JSON.parse(init.body).ops.map((o) => o.id))
      const res = await fetch(url, init)
      if (net.lose?.(url)) {
        await res.arrayBuffer()
        throw new TypeError('связь оборвалась на ответе')
      }
      return res
    },
    session: memorySession(),
    core,
    cipher: fakeSeal,
    clock: createClock({ mono: () => performance.now() + skew.ms }),
    dataDir: dir,
    appVersion: 'live-test',
    timers,
    emit: (type, payload) => events.push({ type, payload }),
  })
  const req = (method, path, body) => gw.request({ method, path, body })
  return {
    name,
    gw,
    net,
    skew,
    events,
    req,
    login: (name = USER, password = PASS) => req('POST', '/auth/login', { name, password }),
    sync: () => gw.syncNow(),
    products: async () => (await req('GET', '/products')).data,
    product: async (id) => (await req('GET', '/products')).data.find((p) => p.id === id),
    sell: (productId, qty = 1, extra = {}) => req('POST', '/sales', { payment: 'cash', items: [{ productId, qty }], ...extra }),
    close() {
      gw.close()
      core.close()
    },
  }
}

const card = (p) => ({ stock: p.stock, looseUnits: p.looseUnits, cost: p.cost, price: p.price, expiryDate: p.expiryDate, expiredUnits: p.expiredUnits })

test('касса без интернета и настоящий сервер', { skip, timeout: 600_000 }, async (t) => {
  token = (await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: USER, password: PASS }) })).json()).token
  assert.ok(token, 'вход на сервер не удался')

  const made = { products: [], customers: [], users: [], arrivals: [], suppliers: [] }
  const mk = async (name, extra) => {
    const p = await srv('POST', '/products', { name: `${TAG} ${name}`, barcode: `${TAG}-${name}`, category: 'Таблетки', minStock: 0, ...extra })
    made.products.push(p.id)
    return p
  }
  const A = kassa('a')
  const B = kassa('b')
  t.after(async () => {
    A.close()
    B.close()
    // Долг прихода приводится к оплаченному, чтобы поставщик остался без долга; удалить
    // его сервер не даст — у него есть история оплат, и это правильно. Сначала приходы,
    // потом товары: приход без строк не поправить
    for (const [id, debt] of made.arrivals) {
      const a = await srv('GET', '/arrivals/' + id).catch(() => null)
      if (a) await srv('PATCH', '/arrivals/' + id, { debt, items: a.items.map((i) => ({ id: i.id, qty: i.qty, cost: i.cost, expiryDate: i.expiryDate })) }).catch(() => {})
    }
    for (const id of made.suppliers) await srv('DELETE', '/suppliers/' + id).catch(() => {})
    for (const id of made.products) await srv('DELETE', '/products/' + id).catch(() => {})
    for (const id of made.customers) await srv('DELETE', '/customers/' + id).catch(() => {})
    for (const id of made.users) await srv('DELETE', '/users/' + id).catch(() => {})
  })

  const nur = await mk('Нурофен', { price: 150, cost: 100, stock: 10, expiryDate: '2028-01-31' })
  const par = await mk('Парацетамол', { unitsPerPack: 20, price: 200, cost: 120, stock: 5, expiryDate: '2027-06-30' })
  const last = await mk('Последняя', { price: 30, cost: 10, stock: 1, expiryDate: '2028-01-31' })

  await t.test('вход и первая загрузка: касса знает то же, что сервер', async () => {
    assert.equal((await A.login()).status, 201)
    await A.sync()
    const mine = (await A.products()).filter((p) => p.name.startsWith(TAG))
    assert.equal(mine.length, 3)
    for (const p of [nur, par, last]) {
      assert.deepEqual(card(mine.find((x) => x.id === p.id)), card(await serverProduct(p.id)), p.name)
    }
  })

  let offlineSale
  await t.test('продажа без интернета: чек записан на кассе, сервер о нём не знает', async () => {
    A.net.online = false
    offlineSale = await A.sell(nur.id, 2)
    assert.equal(offlineSale.status, 201)
    assert.equal(offlineSale.data.total, 300)
    assert.equal((await A.product(nur.id)).stock, 8)
    await A.sync()
    assert.equal(A.gw.status().pending, 1)
    assert.equal(A.gw.status().online, false)
    assert.equal((await serverProduct(nur.id)).stock, 10, 'сервер узнал о продаже, хотя связи не было')
  })

  await t.test('интернет вернулся: чек на сервере — тот самый, с тем же номером и временем', async () => {
    A.net.online = true
    const r = await A.sync()
    assert.equal(r.ok, true)
    assert.equal(A.gw.status().pending, 0)
    const onServer = (await srv('GET', '/sales')).find((s) => s.id === offlineSale.data.id)
    assert.ok(onServer, 'чека нет на сервере')
    assert.equal(onServer.total, 300)
    assert.equal(onServer.date, offlineSale.data.date, 'время чека — когда продали, а не когда дошло')
    assert.equal(onServer.user.name, USER)
    assert.equal((await serverProduct(nur.id)).stock, 8)
    // Касса и сервер снова видят одно и то же
    assert.deepEqual(card(await A.product(nur.id)), card(await serverProduct(nur.id)))
    const mine = (await A.req('GET', '/sales?days=60')).data.filter((s) => s.id === offlineSale.data.id)
    assert.equal(mine.length, 1, 'чек в журнале кассы задвоился')
    assert.equal(mine[0].userId, onServer.userId, 'в журнале кассы теперь серверная копия чека')
  })

  await t.test('повторная отправка без дублей: ответ сервера теряется три раза подряд', async () => {
    const before = (await srv('GET', '/sales')).length
    A.net.sent.length = 0
    // Сервер принимает пачку, но ответ до кассы не доходит
    A.net.lose = (url) => url.endsWith('/sync/push')
    const sale = await A.sell(nur.id, 1)
    for (let i = 0; i < 3; i++) await A.sync()
    assert.equal(A.gw.status().pending, 1, 'касса не знает, что сервер уже принял')
    assert.equal((await serverProduct(nur.id)).stock, 7, 'сервер принял продажу с первого раза')
    assert.equal((await A.product(nur.id)).stock, 7, 'касса не должна ни терять, ни задваивать продажу, пока ответа нет')

    A.net.lose = null
    await A.sync()
    assert.equal(A.gw.status().pending, 0)
    assert.ok(A.net.sent.length >= 4, 'операция должна была уйти несколько раз')
    assert.equal(new Set(A.net.sent.flat()).size, 1, 'каждый раз — с одним и тем же номером')
    assert.equal((await srv('GET', '/sales')).length, before + 1, 'на сервере появился ровно один чек')
    assert.equal((await srv('GET', '/sales')).filter((s) => s.id === sale.data.id).length, 1)
    assert.equal((await serverProduct(nur.id)).stock, 7, 'товар списан один раз')
    assert.equal((await A.product(nur.id)).stock, 7)
  })

  await t.test('обрыв связи посреди обмена: длинная очередь доходит целиком и ровно один раз', async () => {
    // День без интернета: смена, продажи, клиент, долг, возврат, приход, списание
    A.net.online = false
    await A.req('POST', '/shifts/open', { openingCash: 100 })
    const s1 = await A.sell(nur.id, 1)
    const customer = await A.req('POST', '/customers', { name: `${TAG} Должник` })
    made.customers.push(customer.data.id)
    await A.req('POST', '/sales', { payment: 'debt', customerId: customer.data.id, items: [{ productId: par.id, qty: 1, pieces: 5, discount: 10 }] })
    await A.req('POST', `/customers/${customer.data.id}/pay`, { amount: 40 })
    await A.req('POST', '/returns', { saleId: s1.data.id, items: [{ productId: nur.id, units: 1 }] })
    await A.req('POST', '/arrivals', { supplier: TAG, items: [{ productId: nur.id, qty: 4, cost: 130, expiryDate: '2029-03-31' }] })
    await A.req('POST', '/writeoffs', { reason: 'damaged', items: [{ productId: par.id, units: 3 }] })
    await A.sell(nur.id, 2)
    const closed = await A.req('POST', '/shifts/close', { countedCash: 400 })
    assert.equal(closed.status, 201)
    const pending = A.gw.status().pending
    assert.equal(pending, 10)
    const local = { nur: card(await A.product(nur.id)), par: card(await A.product(par.id)) }

    // Связь появляется, но рвётся: сервер принял пачку, ответ потерян
    A.net.online = true
    A.net.lose = (url) => url.endsWith('/sync/push')
    await A.sync()
    assert.equal(A.gw.status().pending, pending, 'ответа не было — касса не вправе считать операции принятыми')
    // Потом пропадает совсем
    A.net.lose = null
    A.net.online = false
    await A.sync()
    // И возвращается окончательно
    A.net.online = true
    const r = await A.sync()
    assert.equal(r.ok, true)
    assert.equal(A.gw.status().pending, 0)
    assert.equal(A.gw.status().rejected, 0, 'сервер что-то отверг')

    // Сервер и касса сходятся — до штуки и до дирама
    assert.deepEqual(card(await serverProduct(nur.id)), local.nur, 'остаток и цена «Нурофена» на сервере не такие, как видела касса')
    assert.deepEqual(card(await serverProduct(par.id)), local.par, 'остаток «Парацетамола» разошёлся')
    assert.deepEqual(card(await A.product(nur.id)), local.nur, 'после обмена касса показывает другое')
    assert.deepEqual(card(await A.product(par.id)), local.par)
    const debtor = (await srv('GET', '/customers')).find((c) => c.id === customer.data.id)
    // 200/20 × 25 − 10 = 240 в долг, 40 погашено
    assert.equal(debtor.debt, 200)
    assert.equal((await A.req('GET', '/customers')).data.find((c) => c.id === customer.data.id).debt, 200)

    // Каждый документ — на сервере один раз
    const sales = (await srv('GET', '/sales')).filter((s) => s.items.some((i) => i.name.startsWith(TAG)))
    assert.equal(new Set(sales.map((s) => s.id)).size, sales.length)
    assert.equal(sales.length, 5, 'чеков: 2 прежних + 3 за этот день')
    assert.equal((await srv('GET', '/returns')).filter((x) => x.items.some((i) => i.name.startsWith(TAG))).length, 1)
    assert.equal((await srv('GET', '/arrivals')).filter((x) => x.supplier === TAG).length, 1)
    assert.equal((await srv('GET', '/writeoffs')).filter((x) => x.items.some((i) => i.name.startsWith(TAG))).length, 1)
    assert.equal((await srv('GET', '/payments')).filter((x) => x.customerId === customer.data.id).length, 1)

    // Смена: итоги, посчитанные сервером по пришедшим документам, — те же, что на кассе
    const shift = (await srv('GET', '/shifts')).find((s) => s.id === closed.data.id)
    assert.ok(shift, 'смены кассы нет в истории на сервере')
    for (const k of ['count', 'salesCash', 'salesDebt', 'debtPaid', 'refundCash', 'refundCost', 'profit', 'discount', 'expectedCash', 'difference', 'countedCash']) {
      assert.equal(shift[k], closed.data[k], `итог смены «${k}»`)
    }

    // Остаток по журналу движений на сервере равен остатку в карточке
    for (const p of [nur, par]) {
      const now = await serverProduct(p.id)
      const j = await srv('GET', '/sync/moves/' + p.id)
      assert.equal(j.units, now.stock * now.unitsPerPack + now.looseUnits, `журнал движений «${p.name}» разошёлся с остатком`)
    }
  })

  let stale
  await t.test('цену сменили на сервере, пока касса была без связи: чек — по цене кассы, владелец видит расхождение', async () => {
    A.net.online = false
    await srv('PATCH', '/products/' + nur.id, { price: 175 })
    // Проходит три минуты. Первые две после смены цены сервер считает прежнюю цену
    // ещё верной: часы кассы сверены с ним не до секунды
    A.skew.ms += 3 * 60_000
    stale = await A.sell(nur.id, 1)
    assert.equal(stale.data.total, 150, 'касса продаёт по цене, которую знает: чек уже напечатан')
    A.net.online = true
    await A.sync()
    assert.equal(A.gw.status().rejected, 0, 'чек по прежней цене отвергнут — а товар уже отдан')
    assert.equal((await srv('GET', '/sales')).find((s) => s.id === stale.data.id).total, 150, 'сервер не вправе переписывать напечатанный чек')
    assert.equal((await A.product(nur.id)).price, 175, 'новая цена не дошла до кассы')

    const note = (await srv('GET', '/discrepancies')).find((d) => d.docId === stale.data.id)
    assert.ok(note, 'владелец не узнал, что товар продан не по той цене')
    assert.deepEqual([note.kind, note.checkPrice, note.basePrice, note.units], ['price', 150, 175, 1])
    await srv('POST', `/discrepancies/${note.id}/resolve`, {})

    // А чек по новой цене вопросов не вызывает
    const fresh = await A.sell(nur.id, 1)
    assert.equal(fresh.data.total, 175)
    await A.sync()
    assert.ok(!(await srv('GET', '/discrepancies')).some((d) => d.docId === fresh.data.id), 'чек по верной цене попал в расхождения')
  })

  await t.test('чек вернули на сайте, а касса без связи вернула его ещё раз: оба возврата записаны, владелец видит лишний', async () => {
    A.net.online = false
    const onSite = await srv('POST', '/returns', { saleId: stale.data.id, items: [{ productId: nur.id, units: 1 }] })
    const onKassa = await A.req('POST', '/returns', { saleId: stale.data.id, items: [{ productId: nur.id, units: 1 }] })
    assert.equal(onKassa.status, 201, 'касса о возврате на сайте не знает и вправе оформить свой')
    A.net.online = true
    await A.sync()
    assert.equal(A.gw.status().rejected, 0, 'возврат отвергнут — а деньги покупателю уже отданы')
    const both = (await srv('GET', '/returns')).filter((r) => r.saleId === stale.data.id).map((r) => r.id).sort()
    assert.deepEqual(both, [onSite.id, onKassa.data.id].sort())
    const note = (await srv('GET', '/discrepancies')).find((d) => d.docId === onKassa.data.id)
    assert.ok(note, 'владелец не узнал, что по чеку вернули больше, чем продали')
    assert.deepEqual([note.kind, note.units], ['return', 1])
    await srv('POST', `/discrepancies/${note.id}/resolve`, {})
    // Касса и сервер сходятся и здесь
    assert.deepEqual(card(await A.product(nur.id)), card(await serverProduct(nur.id)))
  })

  await t.test('две кассы продали один и тот же последний товар: оба чека приняты, владелец видит расхождение', async () => {
    assert.equal((await B.login()).status, 201)
    await B.sync()
    await A.sync()
    A.net.online = false
    B.net.online = false
    const a = await A.sell(last.id, 1)
    const b = await B.sell(last.id, 1)
    assert.equal(a.status, 201)
    assert.equal(b.status, 201, 'вторая касса не знает о продаже первой и вправе продать')

    A.net.online = true
    await A.sync()
    B.net.online = true
    const r = await B.sync()
    assert.equal(r.ok, true)
    assert.equal(B.gw.status().rejected, 0, 'второй чек отвергнут — а товар уже отдан покупателю')

    const sold = (await srv('GET', '/sales')).filter((s) => s.items.some((i) => i.productId === last.id))
    assert.equal(sold.length, 2, 'оба чека должны быть на сервере')
    assert.equal((await serverProduct(last.id)).stock, 0, 'остаток — ноль, а не минус')
    const over = (await srv('GET', '/discrepancies')).filter((o) => o.productId === last.id)
    assert.equal(over.length, 1, 'владелец должен увидеть, что продано больше, чем было')
    assert.deepEqual([over[0].kind, over[0].units, over[0].docId], ['sale', 1, b.data.id])

    // Обе кассы сходятся с сервером
    await A.sync()
    for (const k of [A, B]) assert.equal((await k.product(last.id)).stock, 0, `касса ${k.name}`)
    // И вторая касса видит чек первой
    const seen = (await B.req('GET', '/sales?days=60')).data.filter((s) => s.items.some((i) => i.productId === last.id))
    assert.equal(seen.length, 2)
    await srv('POST', `/discrepancies/${over[0].id}/resolve`, {})
  })

  await t.test('у каждой кассы своя смена, и сайт их не путает со своей', async () => {
    const mine = await A.req('POST', '/shifts/open', { openingCash: 0 })
    const other = await B.req('POST', '/shifts/open', { openingCash: 0 })
    await A.sync()
    await B.sync()
    assert.equal(A.gw.status().rejected + B.gw.status().rejected, 0, 'сервер отверг смену одной из касс')
    assert.ok(!(await srv('GET', '/shifts')).some((s) => !s.closedAt && [mine.data.id, other.data.id].includes(s.id)), 'сайт видит смену кассы открытой')
    // Касса А не видит открытую смену кассы Б, и наоборот
    await A.sync()
    assert.deepEqual((await A.req('GET', '/shifts')).data.filter((s) => !s.closedAt).map((s) => s.id), [mine.data.id])
    assert.deepEqual((await B.req('GET', '/shifts')).data.filter((s) => !s.closedAt).map((s) => s.id), [other.data.id])
    await A.req('POST', '/shifts/close', { countedCash: 0 })
    await B.req('POST', '/shifts/close', { countedCash: 0 })
    await A.sync()
    await B.sync()
    await A.sync()
    // Закрытые смены видят все: и сайт, и соседняя касса
    const closedOnSite = (await srv('GET', '/shifts')).filter((s) => [mine.data.id, other.data.id].includes(s.id))
    assert.equal(closedOnSite.length, 2)
    assert.ok((await A.req('GET', '/shifts')).data.some((s) => s.id === other.data.id && s.closedAt))
  })

  await t.test('копеечное округление: приход с дробной закупочной ценой и чек со срезанной скидкой сервер принимает', async () => {
    const frac = await mk('Дробный', { unitsPerPack: 3, price: 10, cost: 6, stock: 5, expiryDate: '2028-01-31' })
    await A.sync()
    A.net.online = false
    // 33,333 за упаковку × 3 = 99,999 → в документе 100.00
    const arrival = await A.req('POST', '/arrivals', { supplier: TAG, items: [{ productId: frac.id, qty: 3, cost: 33.333, expiryDate: '2028-06-30' }] })
    assert.equal(arrival.status, 201)
    assert.equal(arrival.data.total, 100)
    // Таблетка стоит 3,3333…; скидку 5 сомони касса срезает до суммы позиции — первая даром.
    // Вторая — за полную цену. Итог 3.33
    const sale = await A.req('POST', '/sales', {
      payment: 'cash',
      items: [
        { productId: frac.id, qty: 0, pieces: 1, discount: 5 },
        { productId: frac.id, qty: 0, pieces: 1 },
      ],
    })
    assert.equal(sale.status, 201)
    assert.equal(sale.data.total, 3.33)
    A.net.online = true
    await A.sync()
    assert.equal(A.gw.status().rejected, 0, 'сервер отверг настоящий чек или приход из-за копеечного округления')
    const onServer = (await srv('GET', '/sales')).find((x) => x.id === sale.data.id)
    assert.equal(onServer.total, 3.33, 'на сервере — сумма с чека')
    assert.equal((await srv('GET', '/arrivals')).find((x) => x.id === arrival.data.id).total, 100)
    assert.deepEqual(card(await A.product(frac.id)), card(await serverProduct(frac.id)), 'касса и сервер сходятся')
  })

  await t.test('ответ на чек потерялся, а кассиру сменили пароль: чек не посчитан дважды', async () => {
    const name = (TAG + '-kassir').toLowerCase()
    const cashier = await srv('POST', '/users', { name, password: 'kassir-parol-1', role: 'cashier' })
    made.users.push(cashier.id)
    const C = kassa('c')
    try {
      assert.equal((await C.login(name, 'kassir-parol-1')).status, 201)
      await C.sync()
      const before = (await serverProduct(nur.id)).stock

      // Сервер чек принял, а ответ до кассы не дошёл
      C.net.lose = (url) => url.endsWith('/sync/push')
      assert.equal((await C.sell(nur.id, 1)).status, 201)
      await C.sync()
      C.net.lose = null
      assert.equal(C.gw.status().pending, 1)
      assert.equal((await serverProduct(nur.id)).stock, before - 1, 'сервер чек принял')

      // Кассиру сменили пароль — прежний ключ входа больше не действует. За кассу встал владелец
      await srv('PATCH', '/users/' + cashier.id, { password: 'kassir-parol-2' })
      C.gw.logout()
      assert.equal((await C.login()).status, 201)
      await C.sync()
      await C.sync()
      assert.equal(C.gw.status().pending, 0, 'судьба чека выяснена')
      assert.equal(C.gw.status().rejected, 0)
      assert.equal((await C.product(nur.id)).stock, before - 1, 'на кассе чек посчитан дважды')
      assert.equal((await serverProduct(nur.id)).stock, before - 1, 'на сервере чек один')
    } finally {
      C.close()
    }
  })

  await t.test('остаток поправили на сайте, пока касса была без связи: её прежний чек второй раз не вычитается', async () => {
    const cnt = await mk('Пересчитанный', { price: 20, cost: 10, stock: 10, expiryDate: '2028-01-31' })
    await A.sync()
    A.net.online = false
    assert.equal((await A.sell(cnt.id, 3)).status, 201)
    // Касса и сервер живут по одним часам; правка остатка должна оказаться ПОЗЖЕ чека
    await new Promise((r) => setTimeout(r, 2500))
    // Владелец посмотрел на полку (там семь) и поправил число в карточке
    await srv('PATCH', '/products/' + cnt.id, { stock: 7 })
    A.net.online = true
    await A.sync()
    assert.equal((await serverProduct(cnt.id)).stock, 7, 'проданное вычтено второй раз')
    assert.equal((await A.product(cnt.id)).stock, 7, 'касса сходится с сервером')
    const flagged = (await srv('GET', '/discrepancies')).filter((d) => d.productId === cnt.id)
    assert.deepEqual(flagged.map((d) => [d.kind, d.units]), [['counted', 3]], 'владелец видит, что чек пришёл после правки остатка')
    await srv('POST', `/discrepancies/${flagged[0].id}/resolve`, {})
  })

  await t.test('инвентаризация, пока касса была без связи: проданное ею не остаётся в недостаче', async () => {
    const cat = `${TAG}-peresch`
    const inv = await mk('Инвентаризация', { category: cat, price: 20, cost: 10, stock: 10, expiryDate: '2028-01-31' })
    await A.sync()
    A.net.online = false
    assert.equal((await A.sell(inv.id, 3)).status, 201)
    await new Promise((r) => setTimeout(r, 2500))
    // Владелец пересчитал полку: шесть (три продала касса, одной и правда нет). Сервер
    // о продаже не знает и записывает в недостачу четыре
    const sheet = await srv('POST', '/inventory', { scope: cat, note: TAG })
    await srv('PATCH', '/inventory/' + sheet.id, { items: [{ id: sheet.items[0].id, actualUnits: 6 }] })
    await srv('POST', '/inventory/' + sheet.id + '/apply', {})
    const shortage = async () =>
      (await srv('GET', '/writeoffs'))
        .filter((w) => w.source === 'inventory')
        .flatMap((w) => w.items)
        .filter((i) => i.productId === inv.id)
        .reduce((n, i) => n + i.units, 0)
    assert.equal(await shortage(), 4)

    A.net.online = true
    await A.sync()
    assert.equal(A.gw.status().rejected, 0)
    assert.equal(await shortage(), 1, 'недостача должна уменьшиться до настоящей: три упаковки проданы, а не пропали')
    assert.equal((await serverProduct(inv.id)).stock, 6, 'остаток — как насчитали')
    assert.equal((await A.product(inv.id)).stock, 6, 'и касса с ним сходится')
    const line = (await srv('GET', '/inventory')).find((x) => x.id === sheet.id).items[0]
    assert.deepEqual([line.expectedUnits, line.actualUnits], [7, 6], 'лист пересчёта: должно было быть семь')
    for (const d of (await srv('GET', '/discrepancies')).filter((d) => d.productId === inv.id)) await srv('POST', `/discrepancies/${d.id}/resolve`, {})
  })

  await t.test('последнюю упаковку вернули без связи: товар возвращается со сроком — и на кассе, и на сервере', async () => {
    const one = await mk('Возврат со сроком', { price: 20, cost: 10, stock: 1, expiryDate: '2028-03-31' })
    const two = await mk('Срок с коробки', { price: 20, cost: 10, stock: 2, expiryDate: '2028-03-31' })
    await A.sync()
    A.net.online = false
    const s1 = await A.sell(one.id, 1)
    const s2 = await A.sell(two.id, 2)
    assert.deepEqual([s1.status, s2.status], [201, 201])
    assert.deepEqual([(await A.product(one.id)).stock, (await A.product(one.id)).expiryDate], [0, null], 'склад пуст — срока в карточке нет')

    // Кассир срок не вписал — касса ставит его сама, по своим партиям. Раньше товар
    // возвращался на полку без срока и выпадал из контроля сроков
    assert.equal((await A.req('POST', '/returns', { saleId: s1.data.id, items: [{ productId: one.id, units: 1 }] })).status, 201)
    assert.deepEqual([(await A.product(one.id)).stock, (await A.product(one.id)).expiryDate], [1, '2028-03-31T00:00:00.000Z'])
    // Кассир вписал срок с упаковки — берётся он
    assert.equal((await A.req('POST', '/returns', { saleId: s2.data.id, items: [{ productId: two.id, units: 1, expiryDate: '2028-09-30' }] })).status, 201)
    assert.deepEqual([(await A.product(two.id)).stock, (await A.product(two.id)).expiryDate], [1, '2028-09-30T00:00:00.000Z'])
    // Истёкший срок: такой товар в продажу не возвращают — отказ сразу, без сервера
    const old = await A.req('POST', '/returns', { saleId: s2.data.id, items: [{ productId: two.id, units: 1, expiryDate: '2020-01-31' }] })
    assert.equal(old.status, 400)
    assert.match(old.data.message, /Срок на упаковке уже истёк/)

    A.net.online = true
    await A.sync()
    assert.equal(A.gw.status().rejected, 0)
    assert.equal((await serverProduct(one.id)).expiryDate, '2028-03-31T00:00:00.000Z', 'сервер поставил срок по своим партиям — тот же')
    assert.equal((await serverProduct(two.id)).expiryDate, '2028-09-30T00:00:00.000Z', 'срок, вписанный кассиром, дошёл до сервера')
    for (const p of [one, two]) assert.deepEqual(card(await A.product(p.id)), card(await serverProduct(p.id)), p.name)
  })

  await t.test('возврат по чеку, которого на кассе нет: касса берёт его с сервера и оформляет в своей смене', async () => {
    const sale = await A.sell(par.id, 1)
    await A.sync()
    // Так выглядит чек полугодовой давности: на сервере он есть, в журнале кассы — уже нет
    A.gw.pharmacyDb().prepare("DELETE FROM docs WHERE kind = 'sale' AND id = ?").run(sale.data.id)
    const shift = await A.req('POST', '/shifts/open', { openingCash: 0 })
    assert.equal(shift.status, 201)
    const stockBefore = (await A.product(par.id)).stock
    const ret = await A.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: par.id, units: 20 }] })
    assert.equal(ret.status, 201, JSON.stringify(ret.data))
    assert.equal(ret.data.shiftId, shift.data.id, 'возврат лёг в смену этой кассы')
    assert.equal((await A.product(par.id)).stock, stockBefore + 1)
    await A.sync()
    const onServer = (await srv('GET', '/returns')).find((r) => r.id === ret.data.id)
    assert.ok(onServer, 'возврат дошёл до сервера')
    assert.equal(onServer.shiftId, shift.data.id, 'и на сервере он в смене кассы, а не в смене сайта')
    // Больше купленного по давнему чеку не вернуть
    const twice = await A.req('POST', '/returns', { saleId: sale.data.id, items: [{ productId: par.id, units: 1 }] })
    assert.equal(twice.status, 400)
    assert.match(twice.data.message, /уже возвращено 20 из 20/)
    await A.req('POST', '/shifts/close', { countedCash: 0 })
    await A.sync()
  })

  await t.test('смену кассы закрыл владелец с сайта: касса узнаёт об этом и может открыть новую', async () => {
    const shift = await A.req('POST', '/shifts/open', { openingCash: 50 })
    await A.sync()
    const dev = (await srv('GET', '/sync/devices')).find((d) => d.id === A.gw.deviceId)
    assert.equal(dev.openShift?.id, shift.data.id, 'владелец видит открытую смену кассы')
    const closed = await srv('POST', `/sync/devices/${A.gw.deviceId}/close-shift`, { countedCash: 50 })
    assert.ok(closed.closedAt)
    await A.sync()
    assert.equal((await A.req('GET', '/shifts')).data.filter((x) => !x.closedAt).length, 0, 'у кассы смена тоже закрыта')
    const next = await A.req('POST', '/shifts/open', { openingCash: 0 })
    assert.equal(next.status, 201)
    await A.req('POST', '/shifts/close', { countedCash: 0 })
    await A.sync()
    assert.equal(A.gw.status().rejected, 0)
  })

  await t.test('расходы: внесённые без связи доходят до сервера, а расход из кассы считается в смене один раз — и на кассе, и на сервере', async () => {
    const shift = await A.req('POST', '/shifts/open', { openingCash: 100 })
    await A.sync()
    const cashOut = async () => (await A.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id).expenseCash
    const mine = async () => (await srv('GET', '/expenses')).filter((e) => String(e.note).startsWith(TAG))
    const dayAgo = (n) => new Date(Date.now() + 5 * 3600_000 - n * 86400_000).toISOString().slice(0, 10)

    // Интернета нет: статьи и касса, из которой берут деньги, — из локальной базы
    A.net.online = false
    assert.ok((await A.req('GET', '/expense-categories')).data.some((c) => c.name === 'Аренда'), 'готовых статей расходов на кассе нет')
    assert.deepEqual((await A.req('GET', '/expenses/cash-sources')).data.map((s) => s.shiftId), [shift.data.id])
    const taxi = await A.req('POST', '/expenses', { category: 'Транспорт', amount: 40, note: TAG + ' такси', fromCash: true, shiftId: shift.data.id })
    const rent = await A.req('POST', '/expenses', { category: 'Аренда', amount: 1500.456, note: TAG + ' аренда', date: dayAgo(3) })
    assert.deepEqual([taxi.status, rent.status], [201, 201])
    assert.equal(await cashOut(), 40, 'расход из кассы не уменьшил наличные в смене')
    assert.equal((await mine()).length, 0, 'сервер о расходах ещё не знает')

    // Сервер расходы принял, а ответ до кассы не дошёл — повтор ничего не задваивает
    A.net.online = true
    A.net.lose = (url) => url.endsWith('/sync/push')
    await A.sync()
    A.net.lose = null
    assert.equal(await cashOut(), 40, 'судьба расхода неизвестна — он по-прежнему числится за сменой')
    await A.sync()
    await A.sync()
    const onServer = await mine()
    assert.deepEqual(
      onServer.map((e) => [e.category, e.amount, e.fromCash, e.shiftId, e.id]).sort(),
      [['Аренда', 1500.46, false, null, rent.data.id], ['Транспорт', 40, true, shift.data.id, taxi.data.id]],
    )
    assert.equal(onServer.find((e) => e.id === rent.data.id).date, rent.data.date, 'день расхода — тот, что поставил владелец на кассе')
    assert.equal(onServer.find((e) => e.id === taxi.data.id).date, taxi.data.date, 'время расхода из кассы — когда внесли, а не когда дошло')
    assert.ok(onServer.every((e) => e.user?.name === USER), 'расход записан на того, кто его внёс')
    assert.deepEqual([A.gw.status().pending, A.gw.status().rejected], [0, 0])
    assert.equal(await cashOut(), 40, 'принятый расход из кассы посчитан в смене дважды или потерян')

    // Владелец на сайте берёт из ящика этой кассы ещё 15 — касса узнаёт об этом
    const source = (await srv('GET', '/expenses/cash-sources')).find((s) => s.shiftId === shift.data.id)
    assert.equal(source?.deviceId, A.gw.deviceId, 'сайт не предлагает открытую смену кассы как кассу для расхода')
    const fromSite = await srv('POST', '/expenses', { category: 'Другое', amount: 15, note: TAG + ' с сайта', fromCash: true, shiftId: shift.data.id })
    assert.equal(fromSite.shiftId, shift.data.id)
    await A.sync()
    assert.equal(await cashOut(), 55)
    assert.ok((await A.req('GET', '/expenses?days=180')).data.some((e) => e.id === fromSite.id), 'расход с сайта не пришёл на кассу')
    // И соседняя касса владельца видит расходы аптеки
    await B.sync()
    assert.ok((await B.req('GET', '/expenses?days=180')).data.some((e) => e.id === taxi.data.id), 'расход не дошёл до соседней кассы')

    // Правка и удаление — через сервер; наличные в смене идут следом
    assert.equal((await A.req('PATCH', '/expenses/' + taxi.data.id, { amount: 30 })).status, 200)
    assert.equal(await cashOut(), 45)
    assert.equal((await A.req('DELETE', '/expenses/' + fromSite.id)).status, 200)
    assert.equal(await cashOut(), 30)
    assert.equal((await A.req('DELETE', '/expenses/' + rent.data.id)).status, 200)
    assert.deepEqual((await mine()).map((e) => e.id), [taxi.data.id])

    // Ещё один расход из кассы — без связи, прямо перед закрытием смены
    A.net.online = false
    assert.equal((await A.req('POST', '/expenses', { category: 'Другое', amount: 5, note: TAG + ' мелочь', fromCash: true })).status, 201)
    assert.equal(await cashOut(), 35)
    // Закрытие без связи: 100 на начало − 35 расходов
    const closed = await A.req('POST', '/shifts/close', { countedCash: 65 })
    assert.deepEqual([closed.data.expenseCash, closed.data.expectedCash, closed.data.difference], [35, 65, 0])
    A.net.online = true
    await A.sync()
    await A.sync()
    const s = (await srv('GET', '/shifts')).find((x) => x.id === shift.data.id)
    assert.deepEqual([s.expenseCash, s.expectedCash, s.difference], [35, 65, 0], 'сервер посчитал смену иначе, чем касса')
    const here = (await A.req('GET', '/shifts')).data.find((x) => x.id === shift.data.id)
    assert.deepEqual([here.expenseCash, here.expectedCash, here.difference], [35, 65, 0])

    // Смена закрыта — её расход вошёл в отчёт; касса передаёт объяснение сервера как есть
    const late = await A.req('DELETE', '/expenses/' + taxi.data.id)
    assert.equal(late.status, 400)
    assert.match(String(late.data.message), /уже закрыта/)
    assert.equal(A.gw.status().rejected, 0)
  })

  await t.test('кассиру касса расходы не показывает и не принимает, а сумму «из кассы» в его смене — показывает', async () => {
    const name = (TAG + '-kassir2').toLowerCase()
    const cashier = await srv('POST', '/users', { name, password: 'kassir-parol-3', role: 'cashier' })
    made.users.push(cashier.id)
    const C = kassa('d')
    try {
      assert.equal((await C.login(name, 'kassir-parol-3')).status, 201)
      await C.sync()
      for (const [method, path] of [['GET', '/expenses?days=180'], ['GET', '/expense-categories'], ['GET', '/expenses/cash-sources'], ['POST', '/expenses']]) {
        const r = await C.req(method, path, { category: 'Аренда', amount: 10 })
        assert.equal(r.status, 403, `${method} ${path}`)
      }
      assert.equal(C.gw.pharmacyDb().prepare("SELECT COUNT(*) AS n FROM docs WHERE kind = 'expense'").get().n, 0, 'расходы аптеки легли на кассу кассира')
      assert.equal(C.gw.pharmacyDb().prepare('SELECT COUNT(*) AS n FROM expense_categories').get().n, 0)

      // Кассир открыл смену; владелец на сайте взял из его ящика 12
      const shift = await C.req('POST', '/shifts/open', { openingCash: 200 })
      await C.sync()
      await srv('POST', '/expenses', { category: 'Другое', amount: 12, note: TAG + ' из кассы кассира', fromCash: true, shiftId: shift.data.id })
      await C.sync()
      assert.equal((await C.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id).expenseCash, 12)
      const closed = await C.req('POST', '/shifts/close', { countedCash: 188 })
      assert.deepEqual([closed.data.expenseCash, closed.data.expectedCash, closed.data.difference], [12, 188, 0])
      await C.sync()
      const s = (await srv('GET', '/shifts')).find((x) => x.id === shift.data.id)
      assert.deepEqual([s.expenseCash, s.expectedCash, s.difference], [12, 188, 0])
      assert.deepEqual([C.gw.status().pending, C.gw.status().rejected], [0, 0])
    } finally {
      C.close()
    }
  })

  await t.test('поставщики, наличные и переводы: приход в долг и внесение без связи доходят до сервера, оплата из кассы и перевод считаются в смене одинаково', async () => {
    // Поставщик заведён на сайте — касса узнаёт его при обмене. Товар — свежий, с запасом
    const sup = await srv('POST', '/suppliers', { name: `${TAG} Опт`, phone: '900', openingDebt: 0 })
    made.suppliers.push(sup.id)
    const pst = await mk('Поставка', { price: 150, cost: 100, stock: 3, expiryDate: '2028-01-31' })
    await A.sync()
    const shift = await A.req('POST', '/shifts/open', { openingCash: 100 })
    await A.sync()
    const here = async () => (await A.req('GET', '/shifts')).data.find((s) => s.id === shift.data.id)
    const debtHere = async () => (await A.req('GET', '/suppliers')).data.find((s) => s.id === sup.id)?.debt
    const debtSrv = async () => (await srv('GET', '/suppliers')).find((s) => s.id === sup.id).debt

    // Интернета нет: справочники — из локальной базы
    A.net.online = false
    assert.equal(await debtHere(), 0, 'поставщик с сайта не дошёл до кассы')
    assert.ok((await A.req('GET', '/pay-services')).data.some((s) => s.name === 'DC'), 'готовых сервисов перевода на кассе нет')
    // Приход в долг: 2 × 100 = 200, из них 120 — в долг
    const arrival = await A.req('POST', '/arrivals', { supplierId: sup.id, debt: 120, items: [{ productId: pst.id, qty: 2, cost: 100, expiryDate: '2028-01-31' }] })
    assert.equal(arrival.status, 201, JSON.stringify(arrival.data))
    assert.deepEqual([arrival.data.supplier, arrival.data.debt], [`${TAG} Опт`, 120])
    made.arrivals.push([arrival.data.id, 50])
    assert.equal(await debtHere(), 120, 'долг прихода не виден на кассе сразу')
    // Внесение, изъятие и чек переводом
    assert.equal((await A.req('POST', '/shifts/cash', { kind: 'in', amount: 200, note: TAG + ' размен' })).status, 201)
    assert.equal((await A.req('POST', '/shifts/cash', { kind: 'out', amount: 30, note: TAG + ' владельцу' })).status, 201)
    const noVia = await A.req('POST', '/sales', { payment: 'transfer', items: [{ productId: pst.id, qty: 1 }] })
    assert.deepEqual([noVia.status, noVia.data.message], [400, 'Укажите сервис перевода'])
    const viaDc = await A.sell(pst.id, 1, { payment: 'transfer', payVia: 'DC' })
    assert.equal(viaDc.status, 201)
    assert.deepEqual([(await here()).cashIn, (await here()).cashOut], [200, 30])

    // Связь вернулась: всё на сервере по одному разу, долг и смена сошлись
    A.net.online = true
    await A.sync()
    await A.sync()
    assert.deepEqual([A.gw.status().pending, A.gw.status().rejected], [0, 0])
    assert.equal(await debtSrv(), 120, 'долг прихода не дошёл до сервера')
    assert.equal(await debtHere(), 120, 'после обмена долг потерялся или задвоился')
    const srvSale = (await srv('GET', '/sales')).find((s) => s.id === viaDc.data.id)
    assert.deepEqual([srvSale.payment, srvSale.payVia], ['transfer', 'DC'])
    const moves = (await srv('GET', '/cash-moves?days=1')).filter((m) => String(m.note).startsWith(TAG))
    assert.deepEqual(moves.map((m) => [m.kind, m.amount, m.shiftId]).sort(), [['in', 200, shift.data.id], ['out', 30, shift.data.id]])
    assert.ok(moves.every((m) => m.user?.name === USER), 'внесение записано на того, кто его сделал')

    // Оплата поставщику из кассы — через сервер; касса сама называет ему свою смену
    const paid = await A.req('POST', '/suppliers/' + sup.id + '/pay', { amount: 50, fromCash: true, note: TAG + ' из ящика' })
    assert.equal(paid.status, 201, JSON.stringify(paid.data))
    assert.equal(paid.data.shiftId, shift.data.id, 'оплата из кассы должна лечь в смену кассы')
    assert.equal(await debtSrv(), 70)
    assert.equal(await debtHere(), 70)
    assert.equal((await here()).supplierCash, 50, 'сумма оплат поставщикам из кассы не пришла в смену')
    assert.ok((await A.req('GET', '/supplier-payments')).data.some((p) => p.id === paid.data.id), 'оплата не пришла в журнал кассы')
    // Соседняя касса владельца видит того же поставщика с тем же долгом
    await B.sync()
    assert.equal((await B.req('GET', '/suppliers')).data.find((s) => s.id === sup.id)?.debt, 70)

    // Закрытие без связи: 100 + 200 − 30 − 50; перевод в ящик не попадает
    A.net.online = false
    const closed = await A.req('POST', '/shifts/close', { countedCash: 220 })
    assert.deepEqual(
      [closed.data.cashIn, closed.data.cashOut, closed.data.supplierCash, closed.data.salesTransfer, closed.data.transferBy, closed.data.expectedCash, closed.data.difference],
      [200, 30, 50, 150, { DC: 150 }, 220, 0],
    )
    A.net.online = true
    await A.sync()
    await A.sync()
    const s = (await srv('GET', '/shifts')).find((x) => x.id === shift.data.id)
    assert.deepEqual(
      [s.cashIn, s.cashOut, s.supplierCash, s.salesTransfer, s.transferBy, s.expectedCash, s.difference],
      [200, 30, 50, 150, { DC: 150 }, 220, 0],
      'сервер посчитал смену иначе, чем касса',
    )
    // Смена закрыта — внесение в ней больше не отменить; касса передаёт объяснение сервера
    const late = await A.req('DELETE', '/cash-moves/' + moves[0].id)
    assert.equal(late.status, 400)
    assert.match(String(late.data.message), /уже закрыта/)
    assert.equal(A.gw.status().rejected, 0)
  })

  await t.test('чужая касса не может выдать себя за эту: её номер закреплён за ключом', async () => {
    const res = await fetch(API + '/sync/pull?deviceId=' + A.gw.deviceId, { headers: { Authorization: 'Bearer ' + token } })
    assert.equal(res.status, 409, 'сервер отдал данные кассы тому, кто назвал только её номер')
    const forged = await fetch(API + '/sync/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Device-Key': 'x'.repeat(40) },
      body: JSON.stringify({ deviceId: A.gw.deviceId, ops: [{ id: crypto.randomUUID(), type: 'shift.open', createdAt: new Date().toISOString(), payload: { shift: { id: crypto.randomUUID(), openedAt: new Date().toISOString(), openingCash: 0 } } }] }),
    })
    assert.equal(forged.status, 409)
    // А сама касса работает как работала
    await A.sync()
    assert.equal(A.gw.status().online, true)
  })

  await t.test('в очереди не осталось ничего, а сервер ничего не отверг', async () => {
    for (const k of [A, B]) {
      await k.sync()
      const st = k.gw.status()
      assert.deepEqual([st.pending, st.rejected, st.online], [0, 0, true], `касса ${k.name}`)
    }
  })
})
