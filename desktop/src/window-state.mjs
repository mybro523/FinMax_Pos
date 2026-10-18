// ── Размер окна ──
//
// Программа всегда открывается на весь экран — без заголовка окна и без панели задач
// Windows (см. main.mjs). Здесь запоминается окно, в которое она выходит по F11:
// развёрнутое или своего размера — каким его закрыли в прошлый раз.
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

// Windows на экране с дробным масштабом (125%, 150%) округляет размер окна: просили
// 700 — вышло 702, а то и 703. Записать это как новый размер — и окно подрастало бы
// на пару точек от запуска к запуску. Разница в несколько точек — не решение
// человека, а округление: остаётся прежний размер
const ROUNDING = 3
export function settleSize(now, before) {
  const keep = (a, b) => (Number.isFinite(b) && Math.abs(a - b) <= ROUNDING ? b : a)
  return { ...now, width: keep(now.width, before?.width), height: keep(now.height, before?.height) }
}

// ── Клавиши окна ──
// F11 — выйти из полноэкранного режима и вернуться в него, как в браузере. Меню у
// программы нет (Menu.setApplicationMenu(null)), а с ним пропала и встроенная F11 —
// поэтому клавишу ловит сама программа. Удержанная клавиша повторяется, но окно
// переключается один раз: иначе оно мигало бы туда-сюда. С Ctrl, Alt или Win это уже
// чужое сочетание — не трогаем. F12 — инструменты разработчика, только из исходников.
export function windowKey(input, { dev = false } = {}) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null
  if (input.control || input.alt || input.meta) return null
  if (input.key === 'F11') return 'fullscreen'
  if (input.key === 'F12' && dev) return 'devtools'
  return null
}
