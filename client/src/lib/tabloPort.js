// ── Табло покупателя: куда слать байты (1.7.6) ──
// Сайт — Web Serial (Chrome и Edge): порт выбирают один раз кнопкой «Выбрать порт», дальше
// браузер помнит разрешение и открывает его сам. Программа для Windows — её основная часть
// пишет в COM-порт из своей настройки (desktop/src/tablo.mjs). Что слать — lib/tablo.js.
// Табло не важнее кассы: не вышло — касса работает дальше, ошибка — только в «Проверить».
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { bridge } from './desktop.js'
import { tabloBytes, tabloKadr, tabloSkorost, tabloVid, TABLO_PROBA } from './tablo.js'

const KEY = 'finmax_tablo'
const desk = () => (bridge?.tablo ? bridge.tablo : null)
export const tabloWebMozhno = () => typeof navigator !== 'undefined' && !!navigator.serial

// ── Настройка ──
// Сайт — в этом браузере; программа — у себя (здесь её копия, чтобы знать вид табло)
let deskCfg = null
export function tabloNastroyka() {
  if (desk()) return deskCfg || { vid: 'off', baud: 2400, port: '' }
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null') || {}
    const vid = tabloVid(v.vid)
    return { vid, baud: tabloSkorost(v.baud, vid), usb: v.usb && typeof v.usb === 'object' ? v.usb : null }
  } catch {
    return { vid: 'off', baud: 2400, usb: null }
  }
}
export async function tabloZagruzit() {
  if (desk()) {
    try {
      deskCfg = await desk().config()
    } catch {
      deskCfg = null
    }
  }
  return tabloNastroyka()
}
export async function tabloSohranit(cfg) {
  last = ''
  if (desk()) {
    deskCfg = await desk().setConfig(cfg)
    return deskCfg
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ vid: tabloVid(cfg.vid), baud: tabloSkorost(cfg.baud, cfg.vid), usb: cfg.usb || null }))
  } catch {
    /* не запомнилось */
  }
  await zakryt()
  return tabloNastroyka()
}
if (desk()) tabloZagruzit()

// ── Порт сайта ──
let port = null
let writer = null
async function zakryt() {
  try {
    writer?.releaseLock()
  } catch {
    /* уже отпущен */
  }
  try {
    await port?.close()
  } catch {
    /* уже закрыт */
  }
  port = null
  writer = null
}
async function otkryt(cfg) {
  if (writer) return writer
  if (!tabloWebMozhno()) throw new Error('Этот браузер не работает с COM-портами. Откройте сайт в Chrome или Edge.')
  const ports = await navigator.serial.getPorts()
  const u = cfg.usb
  const p =
    (u && ports.find((x) => {
      const i = x.getInfo?.() || {}
      return i.usbVendorId === u.usbVendorId && i.usbProductId === u.usbProductId
    })) || ports[0]
  if (!p) throw new Error('Порт табло не выбран. Нажмите «Выбрать порт».')
  await p.open({ baudRate: cfg.baud, dataBits: 8, stopBits: 1, parity: 'none' })
  port = p
  writer = p.writable.getWriter()
  return writer
}
// Выбрать порт (окно браузера со списком). Возвращает, что запомнить о порту
export async function tabloVybratPort() {
  if (!tabloWebMozhno()) throw new Error('Этот браузер не работает с COM-портами. Откройте сайт в Chrome или Edge.')
  const p = await navigator.serial.requestPort()
  await zakryt()
  const i = p.getInfo?.() || {}
  return i.usbVendorId ? { usbVendorId: i.usbVendorId, usbProductId: i.usbProductId } : null
}

// ── Отправка ──
// По очереди и только последнее: пока идёт запись, новые кадры не копятся
let busy = false
let next = null
async function poslat(bytes) {
  if (desk()) return desk().write(bytes)
  const w = await otkryt(tabloNastroyka())
  await w.write(new Uint8Array(bytes))
  return { ok: true }
}
function vOchered(bytes) {
  next = bytes
  if (busy) return
  busy = true
  ;(async () => {
    while (next) {
      const b = next
      next = null
      try {
        await poslat(b)
      } catch {
        await zakryt() // в следующий раз — заново
      }
    }
    busy = false
  })()
}

// То же самое второй раз не шлём: касса перерисовывается часто
let last = ''
export function tabloOut(state) {
  const cfg = tabloNastroyka()
  if (cfg.vid === 'off' || (!desk() && !tabloWebMozhno())) return
  const bytes = tabloBytes(cfg.vid, tabloKadr(state))
  const key = cfg.vid + ':' + bytes.join(',')
  if (key === last) return
  last = key
  vOchered(bytes)
}

// «Проверить»: 1234.56 на табло; ошибка — словами
export async function tabloProba(cfg) {
  const bytes = tabloBytes(tabloVid(cfg.vid), tabloKadr(TABLO_PROBA))
  last = ''
  if (desk()) {
    const r = await desk().write(bytes)
    if (!r?.ok) throw new Error(r?.error || 'Табло не ответило.')
    return
  }
  await zakryt()
  const w = await otkryt({ ...tabloNastroyka(), ...cfg })
  await w.write(new Uint8Array(bytes))
}
