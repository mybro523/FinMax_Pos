// ── Распознавание штрихкода в фоновом потоке (1.8.1) ──
// Раньше ZXing разбирал кадры в потоке страницы: пока он считал, видео стояло —
// при движении телефона камера «дёргалась». Теперь страница только снимает
// маленький кадр (серый, ≤ 640 точек) и отдаёт его сюда; видео и кнопки не ждут.
//
// Сообщение: { id, rgba: ArrayBuffer (кадр холста, RGBA), w, h, mode }
//   mode 'fast' — обычные штрихкоды магазина (EAN/UPC/Code 128/39): дёшево, каждый кадр;
//   mode 'all'  — плюс QR, DataMatrix, Aztec: каждый третий кадр;
//   mode 'hard' — всё и дотошно (кнопка «Сфотографировать и распознать»).
// Ответ: { id, code } — code: строка или null.
import { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, DecodeHintType, BarcodeFormat } from '@zxing/library'

const LINEAR = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39]
const ALL = [...LINEAR, BarcodeFormat.DATA_MATRIX, BarcodeFormat.QR_CODE, BarcodeFormat.AZTEC]

function reader(formats, tryHarder) {
  const r = new MultiFormatReader()
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, formats)
  if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true)
  r.setHints(hints)
  return r
}
const readers = { fast: reader(LINEAR, false), all: reader(ALL, false), hard: reader(ALL, true) }

// RGBA холста → яркость (по байту на точку), как считает сам ZXing
export function grayOf(rgba, w, h) {
  const n = w * h
  const out = new Uint8ClampedArray(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] + 2 * rgba[j + 1] + rgba[j + 2]) >> 2
  return out
}

export function decodeGray(gray, w, h, mode = 'fast') {
  const r = readers[mode] || readers.fast
  try {
    const src = new RGBLuminanceSource(gray, w, h)
    const res = r.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)))
    return res ? String(res.getText()) : null
  } catch {
    return null // NotFound / Checksum / Format — в этом кадре кода нет
  } finally {
    try { r.reset() } catch { /* */ }
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { id, rgba, w, h, mode } = e.data || {}
    const code = rgba ? decodeGray(grayOf(new Uint8ClampedArray(rgba), w, h), w, h, mode) : null
    self.postMessage({ id, code })
  }
}
