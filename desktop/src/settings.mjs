// ── Настройки этого компьютера ──
//
// То немногое, что относится не к магазину, а к самому компьютеру и что человек
// выбирает сам: пока это одно — вторая папка для резервных копий (другой диск,
// флешка). Лежит обычным файлом рядом с данными программы: секретов тут нет.
//
// Чем читать и куда писать, передаётся снаружи — модуль проверяется без диска.
import { isAbsolute } from 'node:path'
import { sanitizePrint } from './print/transport.mjs'

// Папка для копий — только полный путь. Относительный зависел бы от того, откуда
// запустили программу, и копии оказывались бы каждый раз в новом месте
const folder = (v) => (typeof v === 'string' && v.length <= 400 && isAbsolute(v) ? v : '')

// Версия программы, которая последней работала с базами на этом компьютере.
// По ней видно, что программу обновили, — и перед первым запуском новой версии
// снимается копия баз
const version = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : '')

export function sanitizeSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  // print — как печатать чеки на этом компьютере (см. print/transport.mjs)
  return { backupDir: folder(v.backupDir), version: version(v.version), print: sanitizePrint(v.print) }
}

export function createSettings({ file, fs }) {
  let current = sanitizeSettings(null)
  try {
    current = sanitizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    /* файла нет или он испорчен — настройки по умолчанию */
  }
  return {
    get: () => ({ ...current }),
    set(patch) {
      current = sanitizeSettings({ ...current, ...patch })
      try {
        fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf8')
      } catch {
        /* диск недоступен — настройка подействует до перезапуска */
      }
      return { ...current }
    },
  }
}
