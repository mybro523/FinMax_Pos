// ── Размер окна ──
//
// Программа открывается такой, какой её закрыли: во весь экран или своим размером.
// Положение на экране не запоминаем намеренно: магазин может отключить второй
// монитор, и окно открылось бы за краем — его не достать, пока не догадаешься
// сбросить настройки. Размер такой беды не несёт.

const DEFAULTS = { width: 1366, height: 800, maximized: true }
// Меньше этого интерфейс уже не помещается; больше — скорее мусор в файле, чем экран
const LIMITS = { minWidth: 380, minHeight: 560, maxWidth: 10000, maxHeight: 10000 }

export function sanitizeState(raw) {
  const num = (v, min, max, fallback) => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback
  }
  return {
    width: num(raw?.width, LIMITS.minWidth, LIMITS.maxWidth, DEFAULTS.width),
    height: num(raw?.height, LIMITS.minHeight, LIMITS.maxHeight, DEFAULTS.height),
    maximized: typeof raw?.maximized === 'boolean' ? raw.maximized : DEFAULTS.maximized,
  }
}

export function createWindowState({ file, fs }) {
  return {
    load() {
      try {
        return sanitizeState(JSON.parse(fs.readFileSync(file, 'utf8')))
      } catch {
        return { ...DEFAULTS } // первый запуск или испорченный файл
      }
    },
    save(state) {
      try {
        fs.writeFileSync(file, JSON.stringify(sanitizeState(state)), 'utf8')
      } catch {
        /* не записалось — в следующий раз откроется размером по умолчанию */
      }
    },
  }
}

export const MIN_SIZE = { width: LIMITS.minWidth, height: LIMITS.minHeight }
