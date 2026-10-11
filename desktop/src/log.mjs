// ── Журнал программы ──
//
// У сайта есть консоль браузера и журнал хостинга. У программы на компьютере аптеки
// нет ничего: если она не запустилась или повела себя странно, узнать причину
// можно только из файла, который она сама о себе пишет. Его и просят прислать.
//
// В журнал не попадают ни ключ входа, ни пароли, ни содержимое запросов — только
// события самой программы и тексты ошибок.

const MAX_BYTES = 1024 * 1024 // больше мегабайта журнал не растёт

export function createLog({ file, fs, now = () => new Date() }) {
  function write(level, parts) {
    const text = parts
      .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : safeJson(p)))
      .join(' ')
    const line = `${now().toISOString()} ${level} ${text}\n`
    try {
      // Дорос до предела — прежний журнал уходит в «.old», начинаем новый.
      // Так на диске всегда не больше двух мегабайт, сколько бы программа ни работала.
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {
        size = 0
      }
      if (size > MAX_BYTES) {
        try {
          fs.renameSync(file, file + '.old')
        } catch {
          /* не переименовался — допишем в прежний */
        }
      }
      fs.appendFileSync(file, line, 'utf8')
    } catch {
      /* журнал не записался — работе программы это мешать не должно */
    }
  }
  return {
    info: (...p) => write('INFO ', p),
    warn: (...p) => write('WARN ', p),
    error: (...p) => write('ERROR', p),
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
