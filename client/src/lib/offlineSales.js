// ── Сайт продаёт без интернета (14.11.2026) ──
//
// Касса на сайте раньше отправляла чек на сервер сразу и без связи не продавала: два
// повтора — и окно «Продажа не записана». Теперь чек, который не ушёл из-за связи,
// встаёт в очередь в хранилище браузера (IndexedDB — не localStorage: там кэш товаров,
// и место кончается) и уходит на сервер сам, когда связь вернётся. Уходит тем же путём,
// что и чеки программы для Windows, сделанные без связи (POST /sales/offline → sync
// applySale на сервере): со своим временем продажи, без задвоения (номер операции и
// clientId), нехватку товара сервер записывает в «Расхождения», а не отказывает.
//
// Пока чек в очереди, он виден в списках так, будто уже записан: продажа — в продажах
// и в смене, остаток уменьшен, долг клиента вырос. Это «наложение» поверх данных
// сервера (store.js: base → apply). Оно переживает перезагрузку страницы и каждый
// новый опрос сервера и снимается, когда чек принят.
//
// В программе для Windows ничего этого нет: там касса и так работает без интернета
// (своя база и своя очередь), и весь код здесь выключен.
//
// Расширения в путях — чтобы файл грузился и проверками без сборщика.
import { useSyncExternalStore } from 'react'
import { api } from '../db/api.js'
import { bridge } from './desktop.js'
import { lineGross, stockUnits, splitUnits } from './units.js'

const OFF = !!bridge
// Ключ очереди и ключ кэша — по коду магазина: на одном компьютере бывают разные
export const OFFLINE_KEYS = ['products', 'sales', 'customers']

// ── Хранилище очереди ──
// По умолчанию IndexedDB; нет её (старый браузер, запрет) — localStorage; в проверках —
// память (setOfflineStorage). Запись: { opId, shop, createdAt, accountId, cashier,
// payload: { sale }, status: 'pending' | 'rejected', error }
const DB_NAME = 'finmax_offline'
const DB_STORE = 'sales'
const LS_QUEUE = 'finmax_offline_sales'

function idbStorage() {
  let opened = null
  const open = () =>
    (opened ||= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE, { keyPath: 'opId' })
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => {
        opened = null
        reject(r.error)
      }
    }))
  const run = async (mode, fn) => {
    const d = await open()
    return new Promise((resolve, reject) => {
      const t = d.transaction(DB_STORE, mode)
      const req = fn(t.objectStore(DB_STORE))
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error || new Error('Запись прервана'))
    })
  }
  return {
    all: () => run('readonly', (s) => s.getAll()).then((x) => (Array.isArray(x) ? x : [])),
    put: (rec) => run('readwrite', (s) => s.put(rec)),
    del: (opId) => run('readwrite', (s) => s.delete(opId)),
  }
}

function lsStorage() {
  const read = () => {
    try {
      const x = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]')
      return Array.isArray(x) ? x : []
    } catch {
      return []
    }
  }
  const write = (list) => localStorage.setItem(LS_QUEUE, JSON.stringify(list))
  return {
    all: async () => read(),
    put: async (rec) => write([...read().filter((r) => r.opId !== rec.opId), rec]),
    del: async (opId) => write(read().filter((r) => r.opId !== opId)),
  }
}

export function memoryStorage(initial = []) {
  const map = new Map(initial.map((r) => [r.opId, r]))
  return {
    all: async () => [...map.values()].map((r) => ({ ...r })),
    put: async (rec) => void map.set(rec.opId, JSON.parse(JSON.stringify(rec))),
    del: async (opId) => void map.delete(opId),
    _map: map,
  }
}

function defaultStorage() {
  if (typeof indexedDB !== 'undefined') return idbStorage()
  if (typeof localStorage !== 'undefined') return lsStorage()
  return memoryStorage()
}

let storage = null
const store = () => (storage ||= defaultStorage())

// ── Связь с остальным приложением ──
// Слой данных (store.js) импортирует этот файл ради наложения и сам передаёт сюда свои
// функции через connectStore — обратного импорта нет, кольца нет
let hooks = {
  render: () => {}, // наложение изменилось — пересчитать списки (store.overlayRender)
  freeze: () => {}, // запомнить текущие списки как «данные сервера» (store.overlayFreeze)
  refresh: () => {}, // перезапросить разделы с сервера
  online: () => true, // известна ли связь (store: последний запрос прошёл)
  noteOffline: () => {}, // запросы не проходят — касса дальше кладёт чеки сразу в очередь
}
export function connectStore(h) {
  hooks = { ...hooks, ...h }
}

// Отправка (подменяется в проверках)
let transport = (body) => api.post('/sales/offline', body)
export function setOfflineTransport(fn) {
  transport = fn
}

// Кто вошёл — прямо из хранилища вкладки, как это делает api.js (без импорта auth)
function currentUser() {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('apteka_user') : null
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function hasToken() {
  try {
    return typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem('apteka_token')
  } catch {
    return false
  }
}
const shopOf = (u) => u?.pharmacy?.code || ''

// ── Очередь в памяти ──
let queue = []
let ready = false
let sending = false
let version = 0
const listeners = new Set()
function emit() {
  version++
  listeners.forEach((l) => l())
}
const subscribe = (cb) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Другие вкладки того же браузера узнают об изменениях очереди и перечитывают её
let channel = null
try {
  if (!OFF && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('finmax-offline-sales')
    channel.onmessage = () => reload()
    // Сам по себе канал не должен держать процесс (проверки без браузера)
    channel.unref?.()
  }
} catch {
  channel = null
}
const tellTabs = () => {
  try {
    channel?.postMessage('changed')
  } catch {
    /* вкладка закрывается */
  }
}

// Чеки текущего магазина, которые ещё не приняты сервером (их видно в списках)
export function activeItems(shop = shopOf(currentUser())) {
  return queue.filter((r) => r.shop === shop && r.status !== 'rejected')
}

// ── Наложение очереди на данные сервера ──
// apply — к спискам сервера добавить то, что сделали чеки очереди; strip — обратное
// (из того, что на экране, получить «данные сервера»). Чек, который сервер уже знает
// (в его продажах есть тот же номер или clientId), не накладывается: значит, он уже
// записан и вот-вот уйдёт из очереди
const unitsOf = (it) => (Number(it.qty) || 0) * Math.max(1, Number(it.unitsPerPack) || 1) + (Number(it.pieces) || 0)

export function saleView(rec) {
  const s = rec.payload.sale
  return {
    id: s.id,
    clientId: s.clientId,
    date: s.date,
    total: s.total,
    cost: s.cost,
    profit: s.profit,
    payment: s.payment,
    payVia: s.payVia,
    shiftId: s.shiftId,
    customerId: s.customerId,
    customer: s.customerId ? { id: s.customerId, name: rec.customerName || '' } : null,
    userId: rec.tenantUserId || null,
    user: { id: rec.tenantUserId || null, name: rec.cashier || '' },
    items: s.items.map((i) => ({ ...i, saleId: s.id })),
    _offline: true,
  }
}

function effects(items) {
  const units = new Map()
  const debt = new Map()
  for (const r of items) {
    const s = r.payload.sale
    for (const it of s.items) units.set(it.productId, (units.get(it.productId) || 0) + unitsOf(it))
    if (s.payment === 'debt' && s.customerId) debt.set(s.customerId, (debt.get(s.customerId) || 0) + Number(s.total || 0))
  }
  return { units, debt }
}

// Знает ли сервер этот чек: в его продажах тот же номер или clientId
function knownTo(serverSales, rec) {
  if (!Array.isArray(serverSales) || !serverSales.length) return false
  const s = rec.payload.sale
  // Временная запись кассы (tmp_…) — не запись сервера: её номер и есть clientId чека
  return serverSales.some(
    (x) => x && !x._offline && !String(x.id).startsWith('tmp_') && (x.id === s.id || (s.clientId && (x.clientId === s.clientId || x.id === s.clientId))),
  )
}

const kop = (x) => Math.round(x * 100) / 100

function shift(key, arr, items, sign) {
  if (!Array.isArray(arr) || !items.length) return arr
  const { units, debt } = effects(items)
  if (key === 'products') {
    if (!units.size) return arr
    return arr.map((p) => {
      const need = units.get(p.id)
      if (!need) return p
      return { ...p, ...splitUnits(stockUnits(p) - sign * need, p) }
    })
  }
  if (key === 'customers') {
    if (!debt.size) return arr
    return arr.map((c) => (debt.has(c.id) ? { ...c, debt: kop((Number(c.debt) || 0) + sign * debt.get(c.id)) } : c))
  }
  return arr
}

// serverSales — продажи сервера, по которым видно, какие чеки он уже записал
export function applyOverlay(key, arr, items, serverSales) {
  const live = items.filter((r) => !knownTo(serverSales, r))
  if (key === 'sales') {
    if (!Array.isArray(arr)) return arr
    const views = live.map(saleView)
    if (!views.length) return arr
    // Новые — сверху, как у сервера (по дате, свежие первыми)
    return [...views, ...arr].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }
  // Остаток — меньше на проданное, долг клиента — больше на сумму чека в долг
  return shift(key, arr, live, 1)
}

export function stripOverlay(key, arr, items, serverSales) {
  const live = items.filter((r) => !knownTo(serverSales, r))
  if (key === 'sales') {
    if (!Array.isArray(arr) || !items.length) return arr
    const ids = new Set()
    for (const r of items) {
      const s = r.payload.sale
      ids.add(s.id)
      if (s.clientId) ids.add(s.clientId)
    }
    // Убираем и запись из очереди, и временную запись кассы (её номер — clientId чека)
    return arr.filter((x) => !(x && (x._offline || String(x.id).startsWith('tmp_')) && ids.has(x.id)))
  }
  return shift(key, arr, live, -1)
}

// ── Сборка чека для отправки ──
// Тот же вид, что у чека программы без связи (desktop/src/local/ops/sale.mjs) и что
// разбирает сервер (server/src/sync/payload.ts parseSale): суммы считаются точными и
// округляются один раз, скидка позиции — до дирама. Сервер пересчитывает итог по
// позициям той же формулой (piece.ts grossOf) и сверяет с допуском дирам на позицию
const ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export function buildOfflineSale({ lines, payment, payVia, customerId, shiftId, date, clientId }) {
  let total = 0
  let cost = 0
  const items = lines.map((l) => {
    const qty = Math.max(0, Math.round(Number(l.qty) || 0))
    const pieces = Math.max(0, Math.round(Number(l.pieces) || 0))
    const unitsPerPack = Math.max(1, Math.round(Number(l.unitsPerPack) || 1))
    const price = Math.max(0, Number(l.price) || 0)
    const piecePrice = l.piecePrice === null || l.piecePrice === undefined || l.piecePrice === '' ? null : Number(l.piecePrice)
    const unit = String(l.unit || '')
    const line = { qty, pieces, unitsPerPack, price, piecePrice: Number.isFinite(piecePrice) && piecePrice > 0 ? piecePrice : null, unit }
    const gross = lineGross(line)
    const discount = Math.min(Math.max(0, Number(l.discount) || 0), gross)
    const lineCost = Math.max(0, Number(l.cost) || 0)
    total += gross - discount
    cost += (lineCost / unitsPerPack) * (qty * unitsPerPack + pieces)
    return {
      id: newId('wi'),
      productId: String(l.productId),
      name: String(l.name || '').slice(0, 300),
      qty,
      pieces,
      unitsPerPack,
      price: kop(price),
      piecePrice: line.piecePrice === null ? null : kop(line.piecePrice),
      unit,
      cost: kop(lineCost),
      discount: kop(discount),
    }
  })
  const t = Math.max(0, kop(total))
  const c = Math.max(0, kop(cost))
  return {
    id: newId('ws'),
    clientId: clientId && ID_RE.test(clientId) ? clientId : null,
    date,
    payment,
    payVia: payment === 'transfer' ? String(payVia || '').trim().slice(0, 40) || null : null,
    customerId: payment === 'debt' ? customerId || null : null,
    shiftId: shiftId || null,
    total: t,
    cost: c,
    profit: kop(t - c),
    items,
  }
}

// ── Нет связи? ──
// Связь уже известна как потерянная — касса не ждёт повторов, а сразу кладёт чек в очередь
export function offlineNow() {
  if (OFF) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return !hooks.online()
}
export const offlineEnabled = () => !OFF
// Запрос кассы не прошёл из-за связи — дальше чеки сразу в очередь, пока опрос не дойдёт
export const markOffline = () => hooks.noteOffline()

// Сетевой сбой, а не отказ сервера по существу: тогда чек — в очередь
export const isNetworkFailure = (e) => !e?.status || e.status >= 500 || e.status === 408

// ── Положить чек в очередь ──
// sale — собранный чек (buildOfflineSale), customerName — для показа в списках.
// Возвращает запись очереди, когда она уже надёжно лежит в хранилище браузера
export async function enqueueSale(sale, { customerName = '' } = {}) {
  if (OFF) throw new Error('Программа для Windows продаёт без связи сама')
  const u = currentUser()
  if (!u) throw new Error('Войдите заново, чтобы продать')
  const rec = {
    opId: newId('wo'),
    shop: shopOf(u),
    createdAt: sale.date,
    accountId: u.id || null,
    tenantUserId: u.tenantUserId || null,
    cashier: u.name || '',
    customerName,
    payload: { sale },
    status: 'pending',
    error: '',
  }
  queue = [...queue, rec]
  // Чек лёг в очередь — его следы на экране теперь даёт наложение, а не временная запись
  hooks.freeze()
  hooks.render()
  emit()
  try {
    await store().put(rec)
    askPersist()
  } catch (e) {
    // Не удалось сохранить — чек снимается целиком, касса вернёт корзину
    hooks.freeze()
    queue = queue.filter((r) => r.opId !== rec.opId)
    hooks.render()
    emit()
    throw new Error('Продажа не записана: в браузере нет места для чека без связи (' + (e?.message || e) + ')')
  }
  tellTabs()
  return rec
}

// Браузер может сам стереть данные сайта, когда мало места. Просим так не делать
let persistAsked = false
function askPersist() {
  if (persistAsked) return
  persistAsked = true
  try {
    navigator?.storage?.persist?.().catch(() => {})
  } catch {
    /* нет такой возможности — ничего */
  }
}

// ── Отменить чек, который ещё не ушёл ──
// «Отмена» в окне чека: пока чек в очереди, отменять его возвратом незачем (и без связи
// нельзя) — он просто снимается, как будто его не было. true — снят; false — его уже нет
// в очереди (ушёл на сервер — отменять возвратом)
export async function cancelQueued(saleId) {
  const rec = queue.find((r) => r.payload.sale.id === saleId && r.status !== 'rejected')
  if (!rec) return false
  if (rec.sending) throw new Error('Чек как раз отправляется на сервер — отмените его возвратом через минуту')
  hooks.freeze()
  queue = queue.filter((r) => r !== rec)
  hooks.render()
  emit()
  await store().del(rec.opId).catch(() => {})
  tellTabs()
  return true
}

// Чек, который сервер не принял, показан кассиру; «Понятно» — убрать
export async function dismissRejected(opId) {
  queue = queue.filter((r) => r.opId !== opId)
  emit()
  await store().del(opId).catch(() => {})
  tellTabs()
}

// ── Отправка ──
// По порядку, только свои чеки (чужие уходят, когда войдёт их кассир; владелец
// отправляет все). ok — убрать; rejected — оставить с причиной; связь пропала,
// сервер не готов (404 — старая версия, 5xx), вход истёк — стоп до следующего раза
export async function flushOffline() {
  if (OFF || sending || !ready) return { sent: 0 }
  const u = currentUser()
  if (!u || !hasToken()) return { sent: 0 }
  const shop = shopOf(u)
  const mine = queue
    .filter((r) => r.shop === shop && r.status === 'pending' && (r.accountId === u.id || u.role === 'founder'))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  if (!mine.length) return { sent: 0 }
  sending = true
  emit()
  let sent = 0
  let rejected = 0
  try {
    for (const rec of mine) {
      if (!queue.includes(rec)) continue // отменили, пока шла отправка
      rec.sending = true
      emit()
      let res
      try {
        res = await transport({ id: rec.opId, createdAt: rec.createdAt, ...(rec.accountId ? { accountId: rec.accountId } : {}), payload: rec.payload })
      } catch (e) {
        rec.sending = false
        // Отказ самого запроса (400 — чек испорчен) не пройдёт и потом: показать кассиру,
        // чтобы очередь не стояла. Остальное (сеть, вход, 403, 404, 5xx) — попробуем позже
        if (e?.status === 400 || e?.status === 422) {
          await markRejected(rec, e.message || 'Сервер не принял чек')
          rejected++
          continue
        }
        if (isNetworkFailure(e)) hooks.noteOffline()
        break
      }
      rec.sending = false
      // duplicate — этот чек сервер уже принял раньше (ответ тогда потерялся): то же, что ok
      if (res?.status === 'ok' || res?.status === 'duplicate') {
        queue = queue.filter((r) => r !== rec)
        // Сервер записал чек — его следы остаются в списках уже как данные сервера
        hooks.freeze()
        await store().del(rec.opId).catch(() => {})
        sent++
      } else if (res?.status === 'rejected') {
        await markRejected(rec, res.error || 'Сервер не принял чек')
        rejected++
      } else break // retry — сервер просит прислать позже
    }
  } finally {
    sending = false
    for (const r of queue) r.sending = false
    if (sent || rejected) {
      hooks.render()
      tellTabs()
      hooks.refresh('products', 'sales', 'customers', 'shifts')
    }
    emit()
  }
  return { sent, rejected }
}

async function markRejected(rec, error) {
  // Сервер чек не записал — его следы снимаются со списков: верно то, что у сервера
  hooks.freeze()
  rec.status = 'rejected'
  rec.error = String(error || '').slice(0, 300)
  hooks.render()
  await store().put({ ...rec, sending: undefined }).catch(() => {})
}

// ── Загрузка очереди из хранилища ──
export async function reload() {
  if (OFF) return
  let list = []
  try {
    list = await store().all()
  } catch {
    list = []
  }
  hooks.freeze()
  queue = list.filter((r) => r && r.opId && r.payload?.sale).map((r) => ({ ...r, sending: false }))
  ready = true
  hooks.render()
  emit()
}

// Для проверок: начать с чистого листа с заданным хранилищем
export async function setOfflineStorage(s) {
  storage = s
  queue = []
  ready = false
  sending = false
  await reload()
}

// ── Подписка для экрана ──
// { pending: мои+чужие ждут, others: чужие, sending, rejected: [...] } — текущего магазина
let snap = null
let snapVer = -1
function snapshot() {
  if (snapVer === version && snap) return snap
  const u = currentUser()
  const shop = shopOf(u)
  const here = queue.filter((r) => r.shop === shop)
  const waiting = here.filter((r) => r.status !== 'rejected')
  snap = {
    pending: waiting.length,
    others: waiting.filter((r) => u && r.accountId !== u.id && u.role !== 'founder').length,
    sending,
    rejected: here.filter((r) => r.status === 'rejected'),
  }
  snapVer = version
  return snap
}
const EMPTY_SNAP = { pending: 0, others: 0, sending: false, rejected: [] }
export function useOfflineSales() {
  return useSyncExternalStore(subscribe, OFF ? () => EMPTY_SNAP : snapshot, () => EMPTY_SNAP)
}
export const offlineSnapshot = () => (OFF ? EMPTY_SNAP : snapshot())
export const subscribeOffline = subscribe

// ── Запуск ──
// Очередь читается сразу; отправка — когда связь есть: при каждом удачном запросе
// (store зовёт kick), при событии online и раз в 15 секунд, пока есть что слать
let timer = null
export function kickOffline() {
  if (OFF || sending || !ready) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  if (!activeItems().some((r) => r.status === 'pending')) return
  flushOffline().catch(() => {})
}
export function startOffline() {
  if (OFF || timer) return
  reload().then(() => kickOffline())
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => kickOffline())
    timer = setInterval(() => kickOffline(), 15000)
    // В проверках без браузера таймер не держит процесс
    timer.unref?.()
  }
}
