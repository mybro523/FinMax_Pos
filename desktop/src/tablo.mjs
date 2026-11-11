// ── Табло покупателя на COM-порту (1.7.6) ──
//
// Маленькое табло сзади моноблока (цифровое на 8 цифр или двухстрочное 2×20) подключено к
// COM-порту. Байты собирает окно (client/src/lib/tablo.js), здесь — настройка этого
// компьютера (вид табло, порт, скорость) и запись в порт: скорость ставит служебная команда
// Windows mode (один раз на порт и скорость), дальше байты пишутся в \.\COMn как в файл.
// Табло не важнее кассы: ошибка — в ответе, касса работает дальше.

export const TABLO_VIDY = Object.freeze(['off', 'led8', 'vfd'])
export const TABLO_SKOROSTI = Object.freeze([2400, 4800, 9600, 19200])
const MAX_BYTES = 512
// Начало пути к порту — две обратные черты, точка, обратная черта (кодами: обратные черты в
// исходнике слишком легко теряются при правках)
export const PORT_PREFIX = String.fromCharCode(92, 92, 46, 92)

export function sanitizeTablo(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const vid = TABLO_VIDY.includes(v.vid) ? v.vid : 'off'
  const n = Number(v.baud)
  const baud = TABLO_SKOROSTI.includes(n) ? n : vid === 'vfd' ? 9600 : 2400
  const port = typeof v.port === 'string' && /^COM\d{1,3}$/i.test(v.port) ? v.port.toUpperCase() : ''
  return { vid, baud, port }
}

// Байты из окна: только числа 0–255 и не больше MAX_BYTES; иначе — null
export function tabloBytesIn(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_BYTES) return null
  for (const b of v) if (!Number.isInteger(b) || b < 0 || b > 255) return null
  return Buffer.from(v)
}

// Список COM-портов Windows (сценарий PowerShell — без переменных частей)
export const PORTS_SCRIPT = "[System.IO.Ports.SerialPort]::GetPortNames() -join ','"
export const portsFrom = (stdout) =>
  [...new Set(String(stdout || '').split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^COM\d{1,3}$/.test(s)))].sort(
    (a, b) => Number(a.slice(3)) - Number(b.slice(3)),
  )

// Запись: run(file, args) — служебная команда (mode.com), open/write/close — файл порта
export function createTabloWriter({ runMode, openPort }) {
  let prepared = ''
  return async function write(cfg, buf) {
    const c = sanitizeTablo(cfg)
    if (c.vid === 'off') return { ok: false, error: 'Табло выключено.' }
    if (!c.port) return { ok: false, error: 'Не выбран COM-порт табло.' }
    const key = c.port + ':' + c.baud
    if (prepared !== key) {
      await runMode(c.port, [c.port + ':', `BAUD=${c.baud}`, 'PARITY=N', 'DATA=8', 'STOP=1'])
      prepared = key
    }
    try {
      // \\.\COMn — так Windows открывает любой COM-порт, и COM10 и дальше тоже
      await openPort(PORT_PREFIX + c.port, buf)
      return { ok: true }
    } catch (e) {
      prepared = '' // порт могли занять или отключить — в следующий раз заново
      return { ok: false, error: `Порт ${c.port} не открылся: ${e?.code || e?.message || 'ошибка'}. Проверьте, что табло подключено и порт не занят.` }
    }
  }
}
