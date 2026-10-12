// ── Сервер-заглушка для проверок ──
//
// Отвечает так же, как настоящий, но живёт в памяти: без сети, без базы. Умеет
// главное для проверок работы без интернета — «пропадать» и «возвращаться» по команде,
// принимать пачки операций (и помнить принятые) и отдавать изменения с прошлого раза.
//
// Считать он не умеет: настоящие правила продажи и возврата проверяются на настоящем
// сервере (test-live/). Здесь важен только порядок разговора между кассой и сервером.
import { createSessionStore } from '../src/session.mjs'

export const API = 'https://server.example/api'

const json = (status, body, date) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => (k.toLowerCase() === 'date' ? date : null) },
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
})

const KEYS = [
  'products', 'batches', 'categories', 'customers', 'deferred', 'shifts', 'sales', 'returns', 'arrivals', 'writeoffs', 'payments',
  'expenses', 'expenseCategories', 'suppliers', 'supplierPayments', 'cashMoves', 'payServices',
]
// Разделы, которые сервер отдаёт только владельцу
const FOUNDER_KEYS = new Set(['writeoffs', 'expenses', 'expenseCategories', 'supplierPayments'])
// Кассиру поставщики отдаются без долгов
const supplierFor = (s, u) => (u.role === 'founder' ? s : { id: s.id, name: s.name, phone: s.phone, note: s.note, createdAt: s.createdAt })

export function fakeServer({ now = () => Date.parse('2026-10-04T10:00:00.000Z') } = {}) {
  const s = {
    online: true,
    // Что вернуть вместо обычного ответа: (method, route, body) → { status, body } или ничего
    override: null,
    calls: [],
    users: new Map(),
    tokens: new Map(),
    pharmacy: { code: 'apteka-1', name: 'Аптека №1', paidUntil: '2026-11-01T12:00:00.000Z', status: 'active' },
    data: Object.fromEntries(KEYS.map((k) => [k, []])),
    seq: 0,
    // Журнал изменений: что и когда менялось — по нему отдаётся «с прошлого раза»
    version: 1,
    log: [],
    // Принятые операции: номер → ответ. Повтор получает тот же ответ
    ops: new Map(),
    // Все пришедшие операции по порядку, с повторами — для проверок
    received: [],
    // Отвергнуть операцию: (op) → текст отказа или ничего
    rejectIf: null,
    // «Не смог записать, пришлите ещё раз»: (op) → true
    retryIf: null,
    // Сервер всё сделал, а ответ по дороге потерялся: (route) → true
    loseResponse: null,
    // Операцию принял, а документа не завёл (списывать было нечего): (op) → true
    noDoc: null,
    devices: new Map(),
    oldSales: new Map(),
  }

  const view = (u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    roleId: u.roleId ?? null,
    roleName: u.roleName ?? null,
    ...(Array.isArray(u.permissions) ? { permissions: u.permissions } : {}),
    pharmacy: u.role === 'superadmin' ? null : { code: s.pharmacy.code, name: s.pharmacy.name },
    subscription:
      u.role === 'superadmin'
        ? null
        : {
            status: s.pharmacy.status,
            daysLeft: 28,
            leftMs: 1,
            paidUntil: s.pharmacy.paidUntil,
            canWrite: true,
            warn: false,
            message: '',
            // Сколько дней касса может работать без связи. Не задано — сервер прежней версии
            ...(s.pharmacy.offlineDays === undefined ? {} : { offlineDays: s.pharmacy.offlineDays }),
          },
  })

  // id — когда сотрудника «удалили и завели заново»: имя то же, учётная запись другая
  // extra — права роли (permissions, roleId, roleName), как их отдаёт настоящий сервер
  function addUser(name, password, role = 'founder', id = 'acc-' + name, extra = {}) {
    const u = { id, name, password, role, active: true, tenantUserId: 'tenant-' + name, ...extra }
    s.users.set(name, u)
    return u
  }

  // ── Изменить данные «на сервере» ──
  // Раздел целиком: чего в новом списке нет — считается удалённым
  function set(key, rows) {
    const next = new Set(rows.map((r) => r.id))
    s.version++
    for (const old of s.data[key]) if (!next.has(old.id)) s.log.push({ v: s.version, key, id: old.id })
    for (const r of rows) s.log.push({ v: s.version, key, id: r.id })
    s.data[key] = rows
  }
  // Одна запись: добавить или заменить
  function put(key, row) {
    s.version++
    s.log.push({ v: s.version, key, id: row.id })
    s.data[key] = [...s.data[key].filter((r) => r.id !== row.id), row]
  }
  function remove(key, id) {
    s.version++
    s.log.push({ v: s.version, key, id })
    s.data[key] = s.data[key].filter((r) => r.id !== id)
  }

  const visible = (key, u) => !FOUNDER_KEYS.has(key) || u.role === 'founder'

  // Расход из кассы: сумму таких расходов сервер ведёт в самой смене
  function recountShift(shiftId) {
    const shift = s.data.shifts.find((x) => x.id === shiftId)
    if (!shift) return
    const sum = s.data.expenses.filter((e) => e.shiftId === shiftId && e.fromCash).reduce((a, e) => a + Number(e.amount || 0), 0)
    put('shifts', { ...shift, expenseCash: Math.round(sum * 100) / 100 })
  }

  function pull(query, u) {
    const since = /^\d+$/.test(query.cursor || '') ? Number(query.cursor) : null
    const full = since === null || since > s.version
    const data = {}
    for (const key of KEYS) {
      if (!visible(key, u)) continue
      if (full) {
        data[key] = { upsert: key === 'suppliers' ? s.data[key].map((x) => supplierFor(x, u)) : s.data[key], remove: [] }
        continue
      }
      // У разделов владельца своя отметка: кассиру их не отдают, и владелец добирает пропущенное
      const w = FOUNDER_KEYS.has(key) && /^\d+$/.test(query.wcursor || '') ? Number(query.wcursor) : since
      const from = Math.min(since, w)
      const ids = new Set(s.log.filter((e) => e.key === key && e.v > from).map((e) => e.id))
      const have = new Map(s.data[key].map((r) => [r.id, r]))
      data[key] = {
        upsert: [...ids].filter((id) => have.has(id)).map((id) => (key === 'suppliers' ? supplierFor(have.get(id), u) : have.get(id))),
        remove: [...ids].filter((id) => !have.has(id)),
      }
    }
    if (!s.devices.has(query.deviceId)) s.devices.set(query.deviceId, { id: query.deviceId, name: 'Касса ' + (s.devices.size + 1) })
    // Судьба операций, о которых спросила касса: чего в ответе нет — того сервер не принимал
    const ops = {}
    for (const id of String(query.ops || '').split(',').filter(Boolean)) {
      const was = s.ops.get(id)
      if (was) ops[id] = was.status === 'ok' ? { status: 'ok', docId: was.docId } : { status: 'rejected', error: was.error }
    }
    return {
      full,
      cursor: String(s.version),
      serverTime: new Date(now()).toISOString(),
      device: s.devices.get(query.deviceId),
      me: { ...view(u), impersonatedBy: null, tenantUserId: u.tenantUserId },
      ops,
      data,
    }
  }

  // Записать принятую операцию в данные — ровно настолько, чтобы следующий обмен
  // вернул её серверной копией и с новым остатком
  function apply(op) {
    const p = op.payload || {}
    if (op.type === 'sale') {
      put('sales', { ...p.sale, server: true })
      for (const it of p.sale.items) {
        const prod = s.data.products.find((x) => x.id === it.productId)
        if (prod) put('products', { ...prod, stock: Math.max(0, prod.stock - it.qty) })
      }
      const debtor = p.sale.payment === 'debt' ? s.data.customers.find((c) => c.id === p.sale.customerId) : null
      if (debtor) put('customers', { ...debtor, debt: debtor.debt + p.sale.total })
    } else if (op.type === 'return') {
      put('returns', { ...p.ret, server: true })
      if (p.writeOff) put('writeoffs', { ...p.writeOff, server: true })
    } else if (op.type === 'writeoff') {
      // Списывать оказалось нечего — документа сервер не заводит (см. noDoc)
      if (!s.noDoc?.(op)) put('writeoffs', { ...p.writeOff, server: true })
    }
    else if (op.type === 'arrival') {
      put('arrivals', { ...p.arrival, server: true })
      // Приход в долг — к долгу поставщика
      const sup = p.arrival.supplierId ? s.data.suppliers.find((x) => x.id === p.arrival.supplierId) : null
      if (sup && Number(p.arrival.debt) > 0) put('suppliers', { ...sup, debt: Math.round((Number(sup.debt) + Number(p.arrival.debt)) * 100) / 100 })
    }
    else if (op.type === 'cash.move') {
      put('cashMoves', { ...p.move, user: { id: 'tenant-' + op.by, name: op.by }, server: true })
      const shift = s.data.shifts.find((x) => x.id === p.move.shiftId)
      if (shift) {
        const moves = s.data.cashMoves.filter((m) => m.shiftId === shift.id)
        const sum = (kind) => Math.round(moves.filter((m) => m.kind === kind).reduce((a, m) => a + Number(m.amount || 0), 0) * 100) / 100
        put('shifts', { ...shift, cashIn: sum('in'), cashOut: sum('out') })
      }
    }
    else if (op.type === 'shift.open' || op.type === 'shift.close') put('shifts', { ...p.shift, deviceId: op.deviceId, server: true })
    else if (op.type === 'debt.pay') put('payments', { ...p.payment, server: true })
    else if (op.type === 'customer.create') put('customers', p.customer)
    else if (op.type === 'deferred.add') put('deferred', p.deferred)
    else if (op.type === 'deferred.remove') remove('deferred', p.id)
    else if (op.type === 'expense') {
      // Вписать расход можно только в смену своей кассы — в чужую он не попадает
      const own = p.expense.fromCash && s.data.shifts.some((x) => x.id === p.expense.shiftId && x.deviceId === op.deviceId)
      put('expenses', { ...p.expense, shiftId: own ? p.expense.shiftId : null, clientId: null, user: { id: 'tenant-' + op.by, name: op.by }, server: true })
      if (own) recountShift(p.expense.shiftId)
    }
  }

  // Каким документом стала операция — как у настоящего сервера
  function docIdOf(op) {
    const p = op.payload || {}
    const map = { sale: p.sale, return: p.ret, writeoff: p.writeOff, arrival: p.arrival, 'shift.open': p.shift, 'shift.close': p.shift, 'debt.pay': p.payment, 'customer.create': p.customer, 'deferred.add': p.deferred, expense: p.expense, 'cash.move': p.move }
    return map[op.type]?.id ?? null
  }

  function push(body, u) {
    const results = []
    for (const op of body.ops || []) {
      s.received.push({ ...op, deviceId: body.deviceId, by: u.name })
      if (s.ops.has(op.id)) {
        const was = s.ops.get(op.id)
        results.push(was.status === 'ok' ? { id: op.id, status: 'duplicate', docId: was.docId } : was)
        continue
      }
      if (s.retryIf?.(op)) {
        results.push({ id: op.id, status: 'retry', error: 'Сервер не смог записать операцию.' })
        break
      }
      // Чужую операцию может прислать только владелец
      const foreign = op.accountId && op.accountId !== u.id && u.role !== 'founder'
      const error = foreign ? 'Операцию другого сотрудника может отправить только он сам или владелец' : s.rejectIf?.(op)
      if (error) {
        const r = { id: op.id, status: 'rejected', error }
        s.ops.set(op.id, r)
        results.push(r)
        continue
      }
      apply({ ...op, deviceId: body.deviceId, by: u.name })
      const r = { id: op.id, status: 'ok', docId: s.noDoc?.(op) ? null : docIdOf(op) }
      s.ops.set(op.id, r)
      results.push(r)
    }
    return { results }
  }

  async function fetchImpl(url, init = {}) {
    const path = url.slice(API.length)
    const route = path.split('?')[0]
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    s.calls.push({ method, path, route, body, auth: init.headers?.Authorization || '', deviceKey: init.headers?.['X-Device-Key'] || '' })
    if (!s.online) throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
    const date = new Date(now()).toUTCString()
    const forced = await s.override?.(method, route, body)
    if (forced) {
      if (forced.throw) throw new TypeError('net::ERR_CONNECTION_RESET')
      return json(forced.status, forced.body, date)
    }

    if (route === '/health') return json(200, { status: 'ok' }, date)

    if (route === '/auth/login' && method === 'POST') {
      const u = s.users.get(String(body?.name || '').trim())
      if (!u || !u.active || u.password !== body?.password) return json(401, { statusCode: 401, message: 'Неверное имя или пароль' }, date)
      const token = `ключ-${u.name}-${++s.seq}`
      s.tokens.set(token, u.name)
      return json(201, { token, user: view(u) }, date)
    }

    const token = (init.headers?.Authorization || '').replace(/^Bearer /, '')
    const u = s.users.get(s.tokens.get(token))
    if (!u) return json(401, { statusCode: 401, message: 'Требуется вход в систему' }, date)
    if (!u.active) return json(401, { statusCode: 401, message: 'Сессия недействительна' }, date)
    if (s.pharmacy.status === 'suspended') {
      return json(403, { statusCode: 403, message: 'Работа аптеки приостановлена. Обратитесь к поставщику программы.' }, date)
    }

    if (route === '/auth/me') return json(200, { ...view(u), impersonatedBy: null }, date)

    if (route === '/auth/change-password' && method === 'POST') {
      if (body?.oldPassword !== u.password) return json(400, { statusCode: 400, message: 'Текущий пароль неверный' }, date)
      u.password = body.newPassword
      // Смена пароля отзывает все прежние ключи
      for (const [t, name] of s.tokens) if (name === u.name) s.tokens.delete(t)
      const fresh = `ключ-${u.name}-${++s.seq}`
      s.tokens.set(fresh, u.name)
      return json(201, { ok: true, token: fresh, user: view(u) }, date)
    }

    // Давний чек — для возврата на кассе. Чеки, которых в двухмесячном журнале уже нет,
    // проверка кладёт в state.oldSales
    const oldSale = route.match(/^\/sync\/sale\/([^/]+)$/)
    if (oldSale && method === 'GET') {
      const id = decodeURIComponent(oldSale[1])
      const sale = s.oldSales.get(id) || s.data.sales.find((x) => x.id === id)
      if (!sale) return json(404, { statusCode: 404, message: 'Чек не найден' }, date)
      return json(200, { sale, returns: s.data.returns.filter((r) => r.saleId === id) }, date)
    }

    if (route === '/sync/pull' && method === 'GET') {
      return json(200, pull(Object.fromEntries(new URLSearchParams(path.split('?')[1] || '')), u), date)
    }
    if (route === '/sync/push' && method === 'POST') {
      const answer = push(body, u)
      if (s.loseResponse?.(route)) throw new TypeError('net::ERR_CONNECTION_RESET')
      return json(201, answer, date)
    }

    const key = route.slice(1)
    if (method === 'GET' && s.data[key]) {
      if (!visible(key, u)) return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      return json(200, s.data[key], date)
    }

    if (route === '/products' && method === 'POST') {
      const p = { id: 'srv-' + ++s.seq, stock: 0, looseUnits: 0, unitsPerPack: 1, expiredUnits: 0, expiryDate: null, analogIds: [], createdAt: new Date(now()).toISOString(), ...body }
      put('products', p)
      return json(201, p, date)
    }
    if (route === '/users' && method === 'GET') return json(200, [...s.users.values()].map((x) => ({ id: x.id, name: x.name, role: x.role })), date)
    if (/^\/arrivals\/[^/]+$/.test(route) && method === 'DELETE') return json(200, { ok: true }, date)

    // Расходы и их статьи — правка и удаление: это умеет только сервер
    const expense = route.match(/^\/expenses\/([^/]+)$/)
    if (expense && (method === 'PATCH' || method === 'DELETE')) {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      const was = s.data.expenses.find((e) => e.id === decodeURIComponent(expense[1]))
      if (!was) return json(404, { statusCode: 404, message: 'Расход не найден' }, date)
      const shift = was.fromCash && was.shiftId ? s.data.shifts.find((x) => x.id === was.shiftId) : null
      if (shift?.closedAt) return json(400, { statusCode: 400, message: 'Смена этого расхода уже закрыта: он вошёл в её отчёт и больше не меняется.' }, date)
      if (method === 'DELETE') remove('expenses', was.id)
      else put('expenses', { ...was, ...body })
      if (shift) recountShift(shift.id)
      return json(200, method === 'DELETE' ? { ok: true } : s.data.expenses.find((e) => e.id === was.id), date)
    }
    if (route === '/expense-categories' && method === 'POST') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      const cat = { id: 'srv-' + ++s.seq, name: String(body?.name || '').trim(), createdAt: new Date(now()).toISOString() }
      put('expenseCategories', cat)
      return json(201, cat, date)
    }
    // Поставщики: карточка, заведение, оплата — дело сервера
    if (route === '/suppliers' && method === 'POST') {
      const sup = { id: 'srv-' + ++s.seq, name: String(body?.name || '').trim(), phone: String(body?.phone || ''), note: String(body?.note || ''), openingDebt: u.role === 'founder' ? Number(body?.openingDebt) || 0 : 0, debt: u.role === 'founder' ? Number(body?.openingDebt) || 0 : 0, createdAt: new Date(now()).toISOString() }
      put('suppliers', sup)
      return json(201, sup, date)
    }
    const supPay = route.match(/^\/suppliers\/([^/]+)\/pay$/)
    if (supPay && method === 'POST') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      const sup = s.data.suppliers.find((x) => x.id === decodeURIComponent(supPay[1]))
      if (!sup) return json(404, { statusCode: 404, message: 'Поставщик не найден' }, date)
      if (Number(body?.amount) > Number(sup.debt)) return json(400, { statusCode: 400, message: `Сумма больше долга поставщика (${Number(sup.debt).toFixed(2)})` }, date)
      let shiftId = null
      if (body?.fromCash === true) {
        const shift = s.data.shifts.find((x) => x.id === body.shiftId && !x.closedAt)
        if (!shift) return json(400, { statusCode: 400, message: 'Нет открытой смены — расход из кассы привязать не к чему. Откройте смену или снимите отметку «из кассы».' }, date)
        shiftId = shift.id
        put('shifts', { ...shift, supplierCash: Math.round((Number(shift.supplierCash || 0) + Number(body.amount)) * 100) / 100 })
      }
      const payment = { id: 'srv-' + ++s.seq, supplierId: sup.id, amount: Number(body.amount), date: new Date(now()).toISOString(), note: String(body?.note || ''), fromCash: body?.fromCash === true, shiftId, user: { id: u.id, name: u.name }, supplier: { id: sup.id, name: sup.name } }
      put('supplierPayments', payment)
      put('suppliers', { ...sup, debt: Math.round((Number(sup.debt) - Number(body.amount)) * 100) / 100 })
      return json(201, payment, date)
    }
    const supOne = route.match(/^\/suppliers\/([^/]+)$/)
    if (supOne && method === 'GET') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      const sup = s.data.suppliers.find((x) => x.id === decodeURIComponent(supOne[1]))
      if (!sup) return json(404, { statusCode: 404, message: 'Поставщик не найден' }, date)
      return json(200, { ...sup, arrivals: s.data.arrivals.filter((a) => a.supplierId === sup.id), payments: s.data.supplierPayments.filter((p) => p.supplierId === sup.id) }, date)
    }
    const cashMove = route.match(/^\/cash-moves\/([^/]+)$/)
    if (cashMove && method === 'DELETE') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      remove('cashMoves', decodeURIComponent(cashMove[1]))
      return json(200, { ok: true }, date)
    }
    const history = route.match(/^\/products\/([^/]+)\/history$/)
    if (history && method === 'GET') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      return json(200, { productId: decodeURIComponent(history[1]), unitsNow: 0, unitsPerPack: 1, rows: [] }, date)
    }
    if (route === '/pay-services' && method === 'POST') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      const svc = { id: 'srv-' + ++s.seq, name: String(body?.name || '').trim(), ord: 99, createdAt: new Date(now()).toISOString() }
      put('payServices', svc)
      return json(201, svc, date)
    }
    const paySvc = route.match(/^\/pay-services\/([^/]+)$/)
    if (paySvc && method === 'DELETE') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      remove('payServices', decodeURIComponent(paySvc[1]))
      return json(200, { ok: true }, date)
    }
    const expenseCat = route.match(/^\/expense-categories\/([^/]+)$/)
    if (expenseCat && method === 'DELETE') {
      if (u.role !== 'founder') return json(403, { statusCode: 403, message: 'Недостаточно прав' }, date)
      remove('expenseCategories', decodeURIComponent(expenseCat[1]))
      return json(200, { ok: true }, date)
    }

    return json(404, { statusCode: 404, message: 'Cannot ' + method + ' ' + route }, date)
  }

  return {
    state: s,
    fetchImpl,
    addUser,
    set,
    put,
    remove,
    // Сколько раз обращались к этому адресу
    count: (method, route) => s.calls.filter((c) => c.method === method && c.route === route).length,
    reset: () => (s.calls.length = 0),
  }
}

// Шифрование Windows — заглушкой: важно лишь, что в базе лежит не сам отпечаток
export const fakeSeal = {
  seal: (text) => 'dpapi:' + Buffer.from(text).toString('base64'),
  open: (stored) => {
    if (!String(stored).startsWith('dpapi:')) throw new Error('не расшифровалось')
    return Buffer.from(String(stored).slice(6), 'base64').toString()
  },
}

// Хранилище ключей в памяти (настоящее проверяется отдельно — session.test.mjs)
export function memorySession() {
  const files = new Map()
  const fs = {
    readFileSync: (f) => {
      if (!files.has(f)) throw new Error('ENOENT')
      return files.get(f)
    },
    writeFileSync: (f, text) => files.set(f, text),
    renameSync: (a, b) => {
      files.set(b, files.get(a))
      files.delete(a)
    },
    rmSync: (f) => files.delete(f),
  }
  const cipher = { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }
  const store = createSessionStore({ file: 'session.json', fs, cipher })
  store.load()
  return store
}

// Таймеры под управлением проверки: ничего не срабатывает само
export function manualTimers() {
  const pending = new Set()
  return {
    set: (fn, ms) => {
      const t = { fn, ms }
      pending.add(t)
      return t
    },
    clear: (t) => pending.delete(t),
    pending,
    // Сработать всем, что ждёт (в порядке постановки)
    async fire() {
      const list = [...pending]
      pending.clear()
      for (const t of list) await t.fn()
    },
  }
}
