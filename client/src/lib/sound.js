// ── Звук сканера («бип») через Web Audio API (без аудиофайлов) ──
// Браузеры блокируют звук до первого «жеста» пользователя, поэтому
// аудио-контекст нужно разблокировать на первом касании/клике (unlockAudio).
let ctx
let unlocked = false

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

// Разблокировка звука — вызывать из обработчика пользовательского жеста
export function unlockAudio() {
  const c = ac()
  if (!c) return
  if (!unlocked) {
    try {
      // короткий «тихий» буфер разблокирует аудио на iOS/Android
      const buf = c.createBuffer(1, 1, 22050)
      const src = c.createBufferSource()
      src.buffer = buf
      src.connect(c.destination)
      src.start(0)
      unlocked = true
    } catch {}
  }
}

function tone(freq, ms, when = 0, volume = 0.08) {
  const c = ac()
  if (!c) return
  const t0 = c.currentTime + when
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(volume, t0)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + ms / 1000)
}

// Короткий высокий «бип» — успешное считывание штрихкода
export function beepOk() {
  try {
    tone(2300, 120)
    if (navigator.vibrate) navigator.vibrate(60)
  } catch {}
}

// Двойной низкий сигнал — ошибка / товар не найден
export function beepError() {
  try {
    tone(440, 130, 0)
    tone(330, 150, 0.14)
    if (navigator.vibrate) navigator.vibrate([60, 40, 60])
  } catch {}
}
