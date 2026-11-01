// ── Логотип магазина: подготовка картинки в панели (1.6.4) ──
//
// Владелец сервиса выбирает файл — здесь он превращается в то, что уйдёт на сервер и в кассы:
//   • выбрать можно PNG, JPG и WebP до 2 МБ (что и обещано владельцу);
//   • пустые поля вокруг — прозрачные или белые — обрезаются: иначе логотип на чеке
//     выходил бы мелким пятном посреди пустоты;
//   • уменьшается до 720×360 точек (не увеличивается): для чека и шапки листа этого с запасом;
//   • сохраняется в PNG (прозрачность остаётся); тяжёлую картинку (фото) — в JPG на белом.
//     Только PNG и JPG: WebP программа для Windows не раскрывает (Electron, nativeImage) —
//     на ленте такой логотип молча не напечатался бы. Сервер принимает до 300 КБ
//     (server/src/admin/logo.ts). Выбрать можно и WebP: браузер раскроет его, а сохранится PNG/JPG.
//
// Расчёты (размер, поля, заголовок файла) — отдельными функциями без браузера: их проверяют
// тесты (client/test/logoImage.test.js). Расширение в пути указано намеренно.

export const LOGO_FILE_MAX = 2 * 1024 * 1024 // что можно выбрать
export const LOGO_MAX_BYTES = 300 * 1024 // что принимает сервер
export const LOGO_BOX = { width: 720, height: 360 } // во что вписывается картинка
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
// Больше этого по стороне файл даже не раскрываем: развёрнутый в памяти, он занял бы сотни
// мегабайт (картинка из одних белых точек сжимается в килобайты)
const SOURCE_MAX_SIDE = 6000

// Тексты ошибок — по-русски; окно переводит их t()
export const LOGO_ERR = {
  type: 'Нужна картинка PNG, JPG или WebP',
  size: 'Файл больше 2 МБ — выберите картинку поменьше',
  side: 'Картинка слишком большая по размеру — выберите поменьше',
  broken: 'Картинку не удалось открыть — возможно, файл повреждён',
  heavy: 'Картинка слишком сложная — выберите логотип попроще',
}

// Вписать картинку в рамку, сохранив пропорции. Только уменьшение: мелкий логотип не
// растягиваем — расплылся бы
export function fitBox(width, height, maxW = LOGO_BOX.width, maxH = LOGO_BOX.height) {
  const w = Math.max(1, Math.round(width) || 1)
  const h = Math.max(1, Math.round(height) || 1)
  const k = Math.min(1, maxW / w, maxH / h)
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

// ── Пустые поля вокруг ──
// rgba — точки картинки подряд (r, g, b, a). Фон — то, чем залиты углы: прозрачное или почти
// белое (хватает трёх углов из четырёх — логотип может упираться в один угол). Ответ — рамка
// того, что не фон, с небольшим запасом ({ x, y, width, height }); фон не понять или картинка
// пустая — вся картинка
const isClear = (rgba, i) => rgba[i + 3] < 16
const isWhite = (rgba, i) => rgba[i + 3] >= 16 && rgba[i] > 244 && rgba[i + 1] > 244 && rgba[i + 2] > 244
const isPaper = (rgba, i) => isClear(rgba, i) || isWhite(rgba, i)

export function trimBox(rgba, width, height) {
  const whole = { x: 0, y: 0, width, height }
  if (!width || !height || rgba.length < width * height * 4) return whole
  const at = (x, y) => (y * width + x) * 4
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  const count = (test) => corners.filter((i) => test(rgba, i)).length
  let bg = null
  if (count(isClear) >= 3) bg = isClear
  else if (count(isPaper) >= 3) bg = isPaper
  if (!bg) return whole
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bg(rgba, at(x, y))) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return whole
  // Запас — 2 % большей стороны, но не меньше точки: края букв не прилипают к краю чека
  const pad = Math.max(1, Math.round(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 0.02))
  const x = Math.max(0, x0 - pad)
  const y = Math.max(0, y0 - pad)
  return { x, y, width: Math.min(width, x1 + 1 + pad) - x, height: Math.min(height, y1 + 1 + pad) - y }
}

// ── Размер картинки по заголовку файла ──
// Как на сервере (src/admin/logo.ts), но по байтам из браузера. null — не разобрать
export function headerSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const u16be = (i) => (b[i] << 8) | b[i + 1]
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
  const u16le = (i) => b[i] | (b[i + 1] << 8)
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const text = (i, n) => String.fromCharCode(...b.slice(i, i + n))
  if (b.length >= 24 && b[0] === 0x89 && text(1, 3) === 'PNG' && text(12, 4) === 'IHDR') return { width: u32be(16), height: u32be(20) }
  if (b.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4)
    if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) }
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) {
        i++
        continue
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
        i += 2
        continue
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16be(i + 5), width: u16be(i + 7) }
      i += 2 + u16be(i + 2)
    }
  }
  return null
}

// Сколько байт в картинке data URL (без приставки, по длине base64)
export function dataUrlBytes(url) {
  const comma = String(url || '').indexOf(',')
  if (comma < 0) return 0
  const b64 = url.slice(comma + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

// ── Подготовить файл (браузер) ──
// Ответ: { dataUrl, width, height, bytes }. Не вышло — Error с текстом из LOGO_ERR
export async function prepareLogo(file) {
  if (!file || !LOGO_TYPES.includes(file.type)) throw new Error(LOGO_ERR.type)
  if (file.size > LOGO_FILE_MAX) throw new Error(LOGO_ERR.size)
  // Файл целиком (он не больше 2 МБ): у JPG из фоторедактора метка размера бывает дальше
  // первых десятков килобайт — за большими метаданными и цветовым профилем
  const head = headerSize(new Uint8Array(await file.arrayBuffer()))
  if (!head || head.width < 1 || head.height < 1) throw new Error(LOGO_ERR.broken)
  if (head.width > SOURCE_MAX_SIDE || head.height > SOURCE_MAX_SIDE) throw new Error(LOGO_ERR.side)

  // Раскрываем как есть: браузер сам поворачивает снимок по метке ориентации (фото с
  // телефона), поэтому размеры берутся у раскрытой картинки, а не из заголовка
  let source
  try {
    source = await createImageBitmap(file)
  } catch {
    throw new Error(LOGO_ERR.broken)
  }
  try {
    // Дальше — не больше 2000 точек по стороне (памяти немного, а для поиска полей и для
    // итоговых 720×360 точности с запасом), на ней ищем пустые поля
    const stage = fitBox(source.width, source.height, 2000, 2000)
    const full = document.createElement('canvas')
    full.width = stage.width
    full.height = stage.height
    const fctx = full.getContext('2d', { willReadFrequently: true })
    fctx.imageSmoothingEnabled = true
    fctx.imageSmoothingQuality = 'high'
    fctx.drawImage(source, 0, 0, stage.width, stage.height)
    const crop = trimBox(fctx.getImageData(0, 0, full.width, full.height).data, full.width, full.height)
    const size = fitBox(crop.width, crop.height)

    const out = document.createElement('canvas')
    out.width = size.width
    out.height = size.height
    const ctx = out.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height)

    const fits = (url) => typeof url === 'string' && /^data:image\/(png|jpeg);base64,/.test(url) && dataUrlBytes(url) <= LOGO_MAX_BYTES
    // PNG — прозрачность остаётся. Тяжёлый (фото, плавные переходы) — JPG: прозрачность заливаем
    // белым (на чеке фон и так белый), качество — пока не войдёт в 300 КБ
    let url = out.toDataURL('image/png')
    if (!fits(url)) {
      const flat = document.createElement('canvas')
      flat.width = size.width
      flat.height = size.height
      const g = flat.getContext('2d')
      g.fillStyle = '#fff'
      g.fillRect(0, 0, size.width, size.height)
      g.drawImage(out, 0, 0)
      for (const q of [0.92, 0.85, 0.75, 0.6]) {
        url = flat.toDataURL('image/jpeg', q)
        if (fits(url)) break
      }
    }
    if (!fits(url)) throw new Error(LOGO_ERR.heavy)
    return { dataUrl: url, width: size.width, height: size.height, bytes: dataUrlBytes(url) }
  } finally {
    source.close?.()
  }
}
