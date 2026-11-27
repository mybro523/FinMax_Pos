// ── Эмулятор фискального принтера Fiscat ──
//
// Притворяется настоящим прибором: отвечает по http на том же API (протокол v2.9), что
// ждёт программа. Нужен, чтобы проверить фискализацию ВЖИВУЮ, пока нет железа: настрой в
// программе адрес 127.0.0.1 (порт 8002), и продажа/смена пойдут через эмулятор.
//
// Что он проверяет САМ (как настоящий прибор): чек должен сойтись до дирама —
// Σ products.sum == receiptSum == receiptCash + receiptNonCash, и price*quantity == sum
// у каждой позиции. Если программа соберёт чек криво — эмулятор его отвергнет (INVALID_DOC),
// и ты это увидишь. Он печатает в терминал всё, что прислала программа.
//
// Чего он НЕ заменяет: приёмку реальным прибором и ОФД (имена полей у настоящего железа,
// РРН при безналичной оплате, срок ФН и т.п.). Это подтверждает только живое устройство.
//
// Запуск:  node scripts/fiskal-emulator.mjs     (или: npm run fiskal:emu)
// Порт:    PORT=8002 по умолчанию
//
// Команды в терминале (введи и нажми Enter), чтобы проверить отказы:
//   paper  — «нет бумаги» вкл/выкл   busy — «занято» (503) вкл/выкл
//   block  — «устройство заблокировано» вкл/выкл      close — закрыть смену на приборе
//   state  — показать состояние      reset — сбросить счётчики и смену
//   help   — эта подсказка           quit  — выход
import http from 'node:http'
import readline from 'node:readline'

const PORT = Number(process.env.PORT) || 8002
const HOST = process.env.HOST || '0.0.0.0'

const st = {
  shiftOpen: false,
  fdNumber: 100,
  shiftNumber: 7,
  receiptNumber: 0,
  paper: true,
  busy: false,
  blocked: false,
  seenExternalIds: new Set(),
  cashInDrawer: 0,
}

const fpd = () =>
  Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0')
const now = () => Math.floor(Date.now() / 1000)
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
const money = (c) => (Number(c) / 100).toFixed(2)

// Ответы
const ok = (data = {}) => ({ http: 200, body: { rc: 'SUCCESS', data } })
const err = (code, message = '') => ({ http: 200, body: message ? { rc: code, message } : { rc: code } })
const busy503 = () => ({ http: 503, body: { rc: 'PRINTER_IS_BUSY' } })

// Общие проверки перед печатным документом
function guard() {
  if (st.busy) return busy503()
  if (st.blocked) return err('CORE_IS_BLOCKED')
  if (!st.paper) return err('OUT_OF_PAPER')
  return null
}

function deviceStatus() {
  console.log(`${C.d}  ▸ проверка связи (состояние устройства)${C.x}`)
  return ok({
    timestamp: now(),
    localTime: new Date().toUTCString(),
    blocked: st.blocked,
    reasonForBlocking: st.blocked ? 'Эмулятор: заблокировано вручную' : '',
    registered: true,
    shiftStatus: st.shiftOpen,
    serialNumber: '00000EMU-0000',
    fdNumber: st.fdNumber,
    shiftNumber: st.shiftNumber,
    fnNumber: 'EMULATORFN000001',
    queueCount: 0,
    onlineStatus: true,
    exchangeBalance: st.cashInDrawer,
    isCoverOpenned: false,
    isPaperPresent: st.paper,
    model: 'TP809-EMU',
    revision: 'V0001',
    terminalName: 'Эмулятор Fiscat',
  })
}

function openShift(req) {
  const g = guard()
  if (g) return g
  if (st.shiftOpen) return err('SHIFT_MUST_BE_CLOSED')
  st.shiftOpen = true
  st.shiftNumber += 1
  st.receiptNumber = 0
  st.fdNumber += 1
  st.seenExternalIds.clear()
  console.log(`${C.g}  ▸ смена ОТКРЫТА${C.x}  кассир: ${req.cashier || '—'}  (смена №${st.shiftNumber})`)
  return ok({ fdNumber: st.fdNumber, fpd: fpd(), onlineStatus: true })
}

function closeShift(req) {
  const g = guard()
  if (g) return g
  if (!st.shiftOpen) return err('SHIFT_MUST_BE_OPENED')
  st.shiftOpen = false
  st.fdNumber += 1
  console.log(`${C.y}  ▸ смена ЗАКРЫТА${C.x}  кассир: ${req.cashier || '—'}  (Z-отчёт, смена №${st.shiftNumber})`)
  return ok({ fdNumber: st.fdNumber, fpd: fpd(), onlineStatus: true, report: { shiftNumber: st.shiftNumber, cashier: req.cashier || '', totalReceiptCount: st.receiptNumber } })
}

// Самая важная проверка — как у настоящего прибора: чек обязан сойтись до дирама
function checkReceipt(req) {
  const products = Array.isArray(req.products) ? req.products : []
  if (!products.length) return 'нет позиций (products пуст)'
  for (const [i, p] of products.entries()) {
    if (!p || typeof p.name !== 'string' || !p.name) return `позиция ${i + 1}: пустое name`
    if (!Number.isInteger(p.price) || p.price < 1) return `позиция ${i + 1}: price должен быть целым ≥ 1 (пришло ${p.price})`
    if (!(p.quantity > 0)) return `позиция ${i + 1}: quantity должен быть > 0 (пришло ${p.quantity})`
    if (!Number.isInteger(p.sum)) return `позиция ${i + 1}: sum должен быть целым (пришло ${p.sum})`
    // price * quantity == sum ТОЧНО (как считает устройство)
    const calc = Math.round(p.price * p.quantity * 1000) / 1000
    if (calc !== p.sum) return `позиция ${i + 1}: price*quantity=${calc} ≠ sum=${p.sum}`
  }
  const sumLines = products.reduce((s, p) => s + p.sum, 0)
  if (sumLines !== req.receiptSum) return `Σ sum строк = ${sumLines} ≠ receiptSum = ${req.receiptSum}`
  const pay = (req.receiptCash || 0) + (req.receiptNonCash || 0)
  if (pay !== req.receiptSum) return `receiptCash+receiptNonCash = ${pay} ≠ receiptSum = ${req.receiptSum}`
  if (!req.taxType) return 'нет taxType (СНО)'
  if (!req.taxes || !Array.isArray(req.taxes.vats) || !req.taxes.vats.length) return 'нет taxes.vats'
  return null
}

function formReceipt(req) {
  const g = guard()
  if (g) return g
  if (!st.shiftOpen) return err('SHIFT_MUST_BE_OPENED')
  const eid = String(req.externalId || '')
  if (eid && st.seenExternalIds.has(eid)) {
    console.log(`${C.y}  ▸ повторный externalId ${eid} → DUPLICATED_EXTERNAL_ID${C.x}`)
    return err('DUPLICATED_EXTERNAL_ID')
  }
  // Показать, что прислала программа
  console.log(`${C.b}  ▸ ЧЕК ПРИХОДА${C.x}  ${req.operationType}  СНО:${req.taxType}`)
  for (const p of req.products || []) {
    console.log(`     ${p.quantity} × ${money(p.price)} = ${money(p.sum)}  ${C.d}${p.vatCode}${C.x}  ${p.name}`)
  }
  console.log(`     ИТОГО ${C.b}${money(req.receiptSum)}${C.x}  (нал ${money(req.receiptCash || 0)} / безнал ${money(req.receiptNonCash || 0)})  НДС ${money(req.taxes?.vats?.[0]?.vatSum || 0)}`)

  const problem = checkReceipt(req)
  if (problem) {
    console.log(`${C.r}  ✗ ЧЕК НЕ СОШЁЛСЯ → INVALID_DOC: ${problem}${C.x}`)
    return err('INVALID_DOC', problem)
  }
  if (eid) st.seenExternalIds.add(eid)
  st.fdNumber += 1
  st.receiptNumber += 1
  st.cashInDrawer += req.receiptCash || 0
  console.log(`${C.g}  ✓ чек пробит${C.x}  ФД №${st.fdNumber}, чек №${st.receiptNumber} в смене`)
  return ok({ fdNumber: st.fdNumber, fpd: fpd(), onlineStatus: true, shiftNumber: st.shiftNumber, receiptNumber: st.receiptNumber })
}

const HANDLERS = {
  deviceStatus,
  openShift,
  closeShift,
  formReceipt,
  // На всякий случай — методы, которых нет в v1 программы, но прибор их знает
  openDrawer: () => ok({}),
  getXReport: () => (guard() || ok({ data: {} })),
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || !request.url.startsWith('/api/')) {
    response.writeHead(404).end('not found')
    return
  }
  const endpoint = request.url.replace('/api/', '').split('?')[0]
  let raw = ''
  request.on('data', (c) => (raw += c))
  request.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      body = {}
    }
    const handler = HANDLERS[endpoint]
    const res = handler ? handler(body) : err('UNKNOWN_ERROR', `эмулятор не знает метод ${endpoint}`)
    response.writeHead(res.http, { 'content-type': 'application/json' })
    response.end(JSON.stringify(res.body))
  })
})

server.listen(PORT, HOST, () => {
  console.log(`${C.b}Эмулятор фискального принтера Fiscat${C.x}`)
  console.log(`Слушает http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (в программе укажи этот адрес и порт)`)
  console.log(`${C.d}Команды: paper · busy · block · close · state · reset · help · quit${C.x}\n`)
})
server.on('error', (e) => {
  console.error(`${C.r}Не удалось запустить на порту ${PORT}: ${e.message}${C.x}`)
  if (e.code === 'EADDRINUSE') console.error('Порт занят. Запусти с другим: PORT=8010 node scripts/fiskal-emulator.mjs')
  process.exit(1)
})

// Команды из терминала
const rl = readline.createInterface({ input: process.stdin })
const showState = () =>
  console.log(
    `${C.d}состояние:${C.x} смена ${st.shiftOpen ? C.g + 'открыта' + C.x : C.y + 'закрыта' + C.x} №${st.shiftNumber}, ФД ${st.fdNumber}, чеков в смене ${st.receiptNumber}, ` +
      `бумага ${st.paper ? 'есть' : C.r + 'НЕТ' + C.x}, занято ${st.busy ? C.r + 'ДА' + C.x : 'нет'}, блокировка ${st.blocked ? C.r + 'ДА' + C.x : 'нет'}, нал в кассе ${money(st.cashInDrawer)}`,
  )
rl.on('line', (line) => {
  const cmd = line.trim().toLowerCase()
  if (cmd === 'paper') (st.paper = !st.paper), console.log(`бумага: ${st.paper ? 'есть' : C.r + 'НЕТ (чеки не пройдут)' + C.x}`)
  else if (cmd === 'busy') (st.busy = !st.busy), console.log(`занято (503): ${st.busy ? C.r + 'ДА' + C.x : 'нет'}`)
  else if (cmd === 'block') (st.blocked = !st.blocked), console.log(`блокировка: ${st.blocked ? C.r + 'ДА' + C.x : 'нет'}`)
  else if (cmd === 'close') (st.shiftOpen = false), console.log('смена на приборе помечена закрытой')
  else if (cmd === 'reset') (Object.assign(st, { shiftOpen: false, receiptNumber: 0, cashInDrawer: 0 }), st.seenExternalIds.clear(), console.log('сброшено'))
  else if (cmd === 'state') showState()
  else if (cmd === 'help') console.log('paper · busy · block · close · state · reset · quit')
  else if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') (console.log('выход'), process.exit(0))
  else if (cmd) console.log(`${C.d}неизвестная команда «${cmd}» — help для списка${C.x}`)
})
