// ── Печать: чековый принтер программы или обычное окно печати ──
//
// На сайте печать одна — окно печати браузера. В программе для Windows владелец
// может настроить чековый принтер: тогда чек уходит в него сразу, строками, без
// окна печати. Не настроил — всё как на сайте.
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { bridge } from './desktop.js'

// Настройки печати спрашиваем у программы один раз и помним: они меняются редко,
// а чек печатается после каждой продажи
let config = null

export async function printConfig(fresh = false) {
  if (!bridge?.print) return null
  if (!config || fresh) {
    try {
      config = await bridge.print.config()
    } catch {
      config = null
    }
  }
  return config
}

export function forgetPrintConfig() {
  config = null
}

// Печатать ли чек сразу после продажи, не дожидаясь нажатия «Печать»
export async function autoPrint() {
  const c = await printConfig()
  return !!c && c.mode !== 'system' && c.auto === true
}

// Напечатать. ticket — строки для чекового принтера (lib/ticket.js).
// system — что делать, если чековый принтер не настроен (обычно window.print).
// Возвращает, куда ушло: 'system' или 'printer'. Не вышло — бросает ошибку
// с объяснением для человека.
export async function printTicket(ticket, system = () => window.print()) {
  if (!bridge?.print) {
    system()
    return 'system'
  }
  let r = null
  try {
    r = await bridge.print.ticket(ticket)
  } catch {
    r = null
  }
  if (!r || r.mode === 'system') {
    system()
    return 'system'
  }
  if (!r.ok) throw new Error(r.error || 'Не удалось отправить задание на принтер.')
  return 'printer'
}

// ── Принтер этикеток (программа для Windows) ──
// Какой принтер и какой размер наклейки выбраны на этом компьютере. Спрашиваем один раз
// и помним, как настройки чекового принтера; настройки поменяли — забыть
let labels = null

export async function labelConfig(fresh = false) {
  if (!bridge?.labels) return null
  if (!labels || fresh) {
    try {
      labels = await bridge.labels.config()
    } catch {
      labels = null
    }
  }
  return labels
}

export function forgetLabelConfig() {
  labels = null
}

// Принтер этикеток, на который можно печатать сразу: выбран в настройках и есть в Windows.
// Пропал из Windows (отключили, переустановили под другим именем) — как не выбран: окно
// печатает через экран печати, а не упирается в «принтер не найден»
export function labelPrinterOf(cfg) {
  const name = typeof cfg?.printer === 'string' ? cfg.printer : ''
  if (!name) return ''
  return !Array.isArray(cfg.printers) || cfg.printers.includes(name) ? name : ''
}
