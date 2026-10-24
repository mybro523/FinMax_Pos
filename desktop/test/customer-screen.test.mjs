// ── Экран покупателя (второй экран моноблока) ──
//
// Покупатель видит на своей стороне товары в корзине и итог, после оплаты — «Спасибо за
// покупку!» и сдачу. Окно открывается само, если у компьютера есть второй экран, и никогда
// не встаёт на экран кассира. Окно кассы присылает готовые строки — окно покупателя только
// показывает их: моста к базе и серверу у него нет.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { MAX_ITEMS, pickDisplay, sanitizeCustomer, sanitizeScreenState } from '../src/customer-screen.mjs'
import { createCustomerScreen, CUSTOMER_TITLE, MOVE_MS, TEST_MS } from '../src/customer-window.mjs'
import { ORIGIN, resolveAsset, SCREEN_URL } from '../src/protocol.mjs'

const KASSA = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 } }
const POKUPATEL = { id: 2, bounds: { x: 1920, y: 0, width: 1024, height: 600 }, size: { width: 1024, height: 600 } }
const TRETIY = { id: 3, bounds: { x: -1366, y: 0, width: 1366, height: 768 }, size: { width: 1366, height: 768 } }

test('экран покупателя — второй экран; экран кассы ему не отдаётся никогда', () => {
  assert.equal(pickDisplay({ mode: 'auto' }, [KASSA, POKUPATEL], 1), POKUPATEL)
  // Касса открыта на втором экране — покупателю достаётся первый
  assert.equal(pickDisplay({ mode: 'auto' }, [KASSA, POKUPATEL], 2), KASSA)
  // Экран один — экрана покупателя нет (иначе он закрыл бы кассу)
  assert.equal(pickDisplay({ mode: 'auto' }, [KASSA], 1), null)
  assert.equal(pickDisplay({ mode: 'pick', display: '1' }, [KASSA], 1), null, 'выбран экран кассы — всё равно нет')
  assert.equal(pickDisplay({ mode: 'off' }, [KASSA, POKUPATEL], 1), null, 'выключен — нет')
  assert.equal(pickDisplay(null, [], 1), null)
})

test('выбранный экран — он; отключили — берётся другой свободный', () => {
  assert.equal(pickDisplay({ mode: 'pick', display: '3' }, [KASSA, POKUPATEL, TRETIY], 1), TRETIY)
  assert.equal(pickDisplay({ mode: 'pick', display: '3' }, [KASSA, POKUPATEL], 1), POKUPATEL)
  assert.equal(pickDisplay({ mode: 'pick', display: '1' }, [KASSA, POKUPATEL], 1), POKUPATEL, 'экран кассы выбрать нельзя')
})

test('настройка из файла — только известные значения', () => {
  assert.deepEqual(sanitizeCustomer(null), { mode: 'auto', display: '' })
  assert.deepEqual(sanitizeCustomer({ mode: 'pick', display: '2528732444' }), { mode: 'pick', display: '2528732444' })
  assert.deepEqual(sanitizeCustomer({ mode: 'всегда', display: '../2' }), { mode: 'auto', display: '' })
  assert.deepEqual(sanitizeCustomer({ mode: 'off', display: 7 }), { mode: 'off', display: '' })
})

test('что показать: только строки и только с пределами — окно покупателя ничего не разбирает', () => {
  const s = sanitizeScreenState({
    mode: 'cart',
    lang: 'tj',
    shop: 'Магазин «Шифо»',
    labels: { total: 'Ҷамъ', welcome: 42, lishnee: 'x' },
    items: [{ name: 'Нурофен 200 мг', sub: '2 уп × 15', sum: '30 сомони', price: 15 }, null, { name: 'x'.repeat(500) }],
    discount: '−2 сомони',
    total: '28 сомони',
    change: '12 сомони',
  })
  assert.equal(s.mode, 'cart')
  assert.equal(s.lang, 'tj')
  assert.equal(s.labels.total, 'Ҷамъ')
  assert.equal(s.labels.welcome, '', 'не строка — пусто (страница возьмёт свою подпись)')
  assert.equal(s.labels.lishnee, undefined)
  assert.deepEqual(s.items[0], { name: 'Нурофен 200 мг', sub: '2 уп × 15', sum: '30 сомони' })
  assert.deepEqual(s.items[1], { name: '', sub: '', sum: '' })
  assert.equal(s.items[2].name.length, 200)
  assert.equal(s.change, '', 'сдача — только после оплаты')
  assert.equal(sanitizeScreenState({ mode: 'cart', items: Array.from({ length: 1000 }, () => ({ name: 'a' })) }).items.length, MAX_ITEMS)
  // Ожидание покупателя: ни строк, ни сумм
  const idle = sanitizeScreenState({ mode: 'idle', items: [{ name: 'a' }], total: '5' })
  assert.deepEqual([idle.items, idle.total], [[], ''])
  // После оплаты — итог и сдача
  const thanks = sanitizeScreenState({ mode: 'thanks', total: '28 сомони', change: '12 сомони', items: [{ name: 'a' }] })
  assert.deepEqual([thanks.items, thanks.total, thanks.change], [[], '28 сомони', '12 сомони'])
  assert.equal(sanitizeScreenState({ mode: '<script>' }).mode, 'idle')
  assert.equal(sanitizeScreenState('мусор').mode, 'idle')
})

test('страница экрана покупателя отдаётся из своей папки — и только из неё', () => {
  const root = resolve('/prog/renderer')
  const fonts = resolve('/prog/assets/fonts')
  const screen = resolve('/prog/src/screen')
  const at = (url) => resolveAsset({ root, fonts, screen }, url)
  assert.deepEqual(at(SCREEN_URL), { file: join(screen, 'customer.html'), type: 'text/html; charset=utf-8', html: true })
  assert.equal(at(ORIGIN + '/_screen/customer.js').file, join(screen, 'customer.js'))
  assert.equal(at(ORIGIN + '/_screen/customer.css').type, 'text/css; charset=utf-8')
  // «..» в адресе схлопывается ещё до программы — выходит обычная сборка интерфейса, а не
  // папка программы. Закодированный путь из папки экрана не выпускается
  assert.equal(at(ORIGIN + '/_screen/../../main.mjs').file, join(root, 'main.mjs'))
  assert.equal(at(ORIGIN + '/_screen/..%2f..%2fmain.mjs'), null)
  assert.equal(at(ORIGIN + '/_screen/%2e%2e/customer-preload.cjs'), null)
  // Без папки экрана (старая сборка) — адрес ведёт в обычную сборку интерфейса, не наружу
  assert.equal(resolveAsset({ root, fonts }, SCREEN_URL).file, join(root, '_screen', 'customer.html'))
})

// ── Окно: на заглушках Электрона ──
function harness({ displays = [KASSA, POKUPATEL], cfg = { mode: 'auto', display: '' }, trustedOk = true, can = true } = {}) {
  const windows = []
  const handlers = new Map()
  const listeners = new Map()
  const screenEvents = new Map()
  const timers = []
  let current = displays
  let settingsValue = { customer: cfg }
  class FakeWindow {
    constructor(opts) {
      this.opts = opts
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height }
      this.destroyed = false
      this.shown = false
      this.sent = []
      this.events = new Map()
      this.webContents = {
        send: (ch, s) => this.sent.push([ch, s]),
        on: () => {},
        setWindowOpenHandler: () => {},
      }
      windows.push(this)
    }
    setAlwaysOnTop(on, level) {
      this.top = [on, level]
    }
    once(ev, fn) {
      this.events.set(ev, fn)
    }
    on(ev, fn) {
      this.events.set(ev, fn)
    }
    loadURL(url) {
      this.url = url
      return Promise.resolve()
    }
    showInactive() {
      this.shown = true
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.events.get('closed')?.()
    }
    getBounds() {
      return this.bounds
    }
    setBounds(b) {
      this.bounds = { ...b }
    }
  }
  // Окно кассы: можно перенести на другой экран, свернуть, закрыть
  let mainBounds = KASSA.bounds
  let mainMinimized = false
  let mainClosed = false
  const main = { isDestroyed: () => mainClosed, getBounds: () => mainBounds, isMinimized: () => mainMinimized }
  const cs = createCustomerScreen({
    BrowserWindow: FakeWindow,
    screen: {
      getAllDisplays: () => current,
      getPrimaryDisplay: () => current[0],
      getDisplayMatching: (b) => current.find((d) => d.bounds.x === b.x) || current[0],
      on: (ev, fn) => screenEvents.set(ev, fn),
    },
    ipcMain: { handle: (ch, fn) => (handlers.set(ch, fn), listeners.set(ch, fn)), on: (ch, fn) => listeners.set(ch, fn) },
    ses: {},
    settings: { get: () => settingsValue, set: (p) => (settingsValue = { ...settingsValue, ...p }) },
    mainWindow: () => main,
    trusted: () => trustedOk,
    allowed: () => can,
    activeRole: () => 'founder',
    preload: 'customer-preload.cjs',
    url: SCREEN_URL,
    isOurs: (u) => u.startsWith(ORIGIN),
    timers: { set: (fn, ms) => (timers.push({ fn, ms }), timers.length), clear: () => {} },
  })
  return {
    cs,
    windows,
    handlers,
    listeners,
    timers,
    setDisplays: (d) => (current = d),
    moveMain: (b) => (mainBounds = b),
    minimizeMain: (on) => (mainMinimized = on),
    closeMain: () => (mainClosed = true),
    fire: (ev) => screenEvents.get(ev)?.(),
    fromKassa: { sender: {} },
  }
}

test('второй экран есть — окно покупателя встаёт на него целиком, без фокуса и поверх панели задач', () => {
  const h = harness()
  const target = h.cs.place()
  assert.equal(target, POKUPATEL)
  const w = h.windows[0]
  assert.deepEqual(w.bounds, POKUPATEL.bounds)
  assert.equal(w.opts.focusable, false, 'фокус у кассира не забирает')
  assert.equal(w.opts.frame, false)
  assert.equal(w.opts.title, CUSTOMER_TITLE)
  assert.deepEqual(w.top, [true, 'screen-saver'])
  assert.equal(w.opts.webPreferences.preload, 'customer-preload.cjs')
  assert.equal(w.opts.webPreferences.contextIsolation, true)
  assert.equal(w.opts.webPreferences.sandbox, true)
  assert.equal(w.opts.webPreferences.nodeIntegration, false)
  assert.equal(w.url, SCREEN_URL)
  w.events.get('ready-to-show')()
  assert.equal(w.shown, true)
  // Второй раз — то же окно, не новое
  h.cs.place()
  assert.equal(h.windows.length, 1)
})

test('экран отключили — окно закрылось; подключили снова или поменяли разрешение — встало заново', () => {
  const h = harness()
  h.cs.place()
  h.setDisplays([KASSA])
  h.fire('display-removed')
  assert.equal(h.windows[0].destroyed, true)
  assert.equal(h.cs.window(), null)
  h.setDisplays([KASSA, POKUPATEL])
  h.fire('display-added')
  assert.equal(h.windows.length, 2)
  assert.deepEqual(h.windows[1].bounds, POKUPATEL.bounds)
  // Разрешение второго экрана поменяли — то же окно, новые границы
  const bigger = { ...POKUPATEL, bounds: { x: 1920, y: 0, width: 1366, height: 768 } }
  h.setDisplays([KASSA, bigger])
  h.fire('display-metrics-changed')
  assert.equal(h.windows.length, 2)
  assert.deepEqual(h.windows[1].bounds, bigger.bounds)
})

test('корзина от окна кассы доходит до покупателя; от чужого — нет', () => {
  const h = harness()
  h.cs.place()
  const w = h.windows[0]
  h.listeners.get('customer:update')(h.fromKassa, { mode: 'cart', items: [{ name: 'Нурофен', sub: '1 уп × 15', sum: '15' }], total: '15 сомони' })
  assert.equal(w.sent.at(-1)[0], 'customer:state')
  assert.equal(w.sent.at(-1)[1].total, '15 сомони')
  assert.equal(w.sent.at(-1)[1].items[0].name, 'Нурофен')
  // Страница покупателя спрашивает «что показать» — получает последнее
  const asked = h.handlers.get('customer:ready')({ sender: w.webContents, senderFrame: { url: SCREEN_URL } })
  assert.equal(asked.total, '15 сомони')
  // Кто-то другой спрашивает — ничего
  assert.equal(h.handlers.get('customer:ready')({ sender: {}, senderFrame: { url: SCREEN_URL } }), null)
  // Не окно кассы — не принимается
  const g = harness({ trustedOk: false })
  g.cs.place()
  g.listeners.get('customer:update')(g.fromKassa, { mode: 'cart', total: '999' })
  assert.equal(g.windows[0].sent.length, 0)
})

test('настройка «где показывать» и проба — только с правом на печать; проба держится и уходит сама', () => {
  const h = harness()
  h.cs.place()
  const off = h.handlers.get('customer:setConfig')(h.fromKassa, { mode: 'off' })
  assert.equal(off.mode, 'off')
  assert.equal(off.showing, '')
  assert.equal(h.windows[0].destroyed, true, 'выключили — окно закрылось')
  const on = h.handlers.get('customer:setConfig')(h.fromKassa, { mode: 'auto' })
  assert.equal(on.showing, '2')
  assert.deepEqual(on.displays.map((d) => [d.id, d.main]), [['1', true], ['2', false]])
  // Проба: показывается, через TEST_MS — снова то, что было
  const w = h.windows[1]
  h.listeners.get('customer:update')(h.fromKassa, { mode: 'idle', shop: 'Шифо' })
  assert.deepEqual(h.handlers.get('customer:test')(h.fromKassa, { items: [{ name: 'Проба' }], total: '38' }), { ok: true })
  assert.equal(w.sent.at(-1)[1].mode, 'test')
  // Пока идёт проба, корзина не перебивает её — но запоминается
  h.listeners.get('customer:update')(h.fromKassa, { mode: 'cart', items: [{ name: 'Нурофен' }], total: '15' })
  assert.equal(w.sent.at(-1)[1].mode, 'test')
  assert.equal(h.timers.at(-1).ms, TEST_MS)
  h.timers.at(-1).fn()
  assert.equal(w.sent.at(-1)[1].mode, 'cart')
  // Без права — ни настройки, ни пробы
  const n = harness({ can: false })
  n.cs.place()
  assert.equal(n.handlers.get('customer:setConfig')(n.fromKassa, { mode: 'off' }), null)
  assert.deepEqual(n.handlers.get('customer:test')(n.fromKassa, {}), { ok: false })
})

test('кассу перенесли на другой экран — покупатель уступает ей место; свернули кассу — покупатель на месте', () => {
  const h = harness()
  h.cs.place()
  const w = h.windows[0]
  assert.deepEqual(w.bounds, POKUPATEL.bounds)
  // Win+Shift+стрелка: касса переехала на экран покупателя. Переставляем, когда перенос закончился
  h.moveMain(POKUPATEL.bounds)
  h.cs.mainMoved()
  assert.equal(h.timers.at(-1).ms, MOVE_MS)
  h.timers.at(-1).fn()
  assert.equal(h.windows.length, 1, 'то же окно')
  assert.deepEqual(w.bounds, KASSA.bounds, 'покупатель ушёл на освободившийся экран')

  // Свёрнутое окно Windows держит за краем экрана — по нему экран кассы не узнать
  const g = harness({ displays: [POKUPATEL, KASSA] })
  g.cs.place()
  assert.deepEqual(g.windows[0].bounds, POKUPATEL.bounds)
  g.minimizeMain(true)
  g.moveMain({ x: -32000, y: -32000, width: 160, height: 28 })
  g.fire('display-metrics-changed')
  assert.deepEqual(g.windows[0].bounds, POKUPATEL.bounds, 'покупатель не ушёл на место кассы')
  // Развернули — касса на своём экране, покупатель там же, где был
  g.minimizeMain(false)
  g.moveMain(KASSA.bounds)
  g.cs.mainMoved()
  g.timers.at(-1).fn()
  assert.deepEqual(g.windows[0].bounds, POKUPATEL.bounds)
  assert.equal(g.windows.length, 1)

  // Программа закрывается — запоздалый перенос окно покупателя заново не открывает
  h.cs.mainMoved()
  h.closeMain()
  h.timers.at(-1).fn()
  assert.equal(h.cs.window(), null)
  assert.equal(h.windows.length, 1, 'нового окна нет')
})
