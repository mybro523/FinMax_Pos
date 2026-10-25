// ── Облегчённый вид для слабых компьютеров ──
//
// На старом компьютере (часто это и есть Windows 7) тормозит не касса, а красота: тени,
// плавные переходы, анимации. Облегчённый вид их убирает — окно рисуется быстрее,
// кнопки откликаются сразу, а внешне почти ничего не меняется.
//
// По умолчанию программа решает сама: слабый компьютер — мало памяти, два ядра или
// видеокарта, которая не ускоряет отрисовку. Владелец может включить или выключить вид
// вручную («Настройки» → «Кассы и устройства»). Настройка — этого компьютера.
//
// Модуль ни от чего не зависит: сведения о компьютере передаются снаружи.

export const LITE_MODES = ['auto', 'on', 'off']
export const sanitizeLite = (v) => (LITE_MODES.includes(v) ? v : 'auto')

// Окно узнаёт о виде при запуске из своей командной строки: так вид действует с первого
// кадра, без вспышки теней и анимаций до ответа основной части
export const LITE_ARG = '--finmax-lite'

// Меньше 3,5 ГБ памяти. У компьютера с 4 ГБ Windows показывает около 3,9 ГБ, а у
// 32-разрядной Windows с теми же 4 ГБ — 3–3,5 ГБ: такой компьютер и есть слабый
const LOW_MEMORY = 3.5 * 1024 ** 3

// Почему компьютер слабый: memory — мало памяти, cpu — не больше двух ядер, gpu —
// видеокарта не ускоряет отрисовку (gpu — ответ app.getGPUFeatureStatus())
export function weakReasons({ totalmem = 0, cpus = 0, gpu = null } = {}) {
  const out = []
  if (totalmem > 0 && totalmem < LOW_MEMORY) out.push('memory')
  if (cpus > 0 && cpus <= 2) out.push('cpu')
  if (gpu && typeof gpu === 'object' && !String(gpu.gpu_compositing || '').startsWith('enabled')) out.push('gpu')
  return out
}

export function liteState(mode, machine = {}) {
  const m = sanitizeLite(mode)
  const reasons = weakReasons(machine)
  return {
    mode: m,
    active: m === 'on' || (m === 'auto' && reasons.length > 0),
    reasons,
    // Для подписи в «Настройках»: «2 ГБ памяти, 2 ядра»
    memoryGb: machine.totalmem > 0 ? Math.round((machine.totalmem / 1024 ** 3) * 10) / 10 : 0,
    cpus: machine.cpus > 0 ? machine.cpus : 0,
  }
}
