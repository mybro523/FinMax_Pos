import { BadRequestException } from '@nestjs/common'

// ── Логотип магазина: что принимаем ──
//
// Картинку выбирает владелец сервиса в панели («Новый магазин», «Изменить магазин»).
// Панель сама уменьшает её и присылает готовую строку data URL. Сервер на слово не верит
// и проверяет ещё раз: тип картинки — по первым байтам файла, а не по подписи; размер
// файла и размер самой картинки в точках. Логотип печатается на чеках всех касс магазина
// и лежит в каждой программе для Windows, поэтому он маленький: панель отдаёт картинку
// не больше 720×360 точек, а сервер с запасом пропускает до 300 КБ и 2000 точек по стороне.
// Огромная по точкам картинка в малом файле (тысячи точек одного цвета сжимаются в
// килобайты) при печати развернулась бы в сотни мегабайт памяти — её не принимаем.
//
// Хранится только PNG или JPEG: программа для Windows печатает логотип на ленте через Electron
// (nativeImage), а он WebP не раскрывает — такой логотип молча пропал бы с чеков. Выбрать в
// панели можно и WebP: панель сама переводит его в PNG или JPG (client/src/lib/logoImage.js).

export const LOGO_MAX_BYTES = 300 * 1024
// Строка data URL: base64 длиннее файла на треть, плюс приставка «data:image/…;base64,»
export const LOGO_MAX_CHARS = Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 64
export const LOGO_MAX_SIDE = 2000

const MIME: Partial<Record<Kind, string>> = { png: 'image/png', jpeg: 'image/jpeg' }
type Kind = 'png' | 'jpeg' | 'webp'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Что это за картинка — по первым байтам
export function sniffImage(buf: Buffer): Kind | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

// Ширина и высота картинки в точках — из заголовка файла, без распаковки.
// null — заголовок не разобрать (испорченный файл)
export function imageSize(buf: Buffer, kind: Kind): { width: number; height: number } | null {
  try {
    if (kind === 'png') {
      // Первый блок файла — IHDR: ширина и высота по 4 байта
      if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (kind === 'webp') {
      const chunk = buf.toString('latin1', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') {
        // Кадр с потерями: после трёх байт метки — 9D 01 2A и два раза по 14 бит размера
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        // Без потерь: байт 0x2F, затем ширина−1 и высота−1 по 14 бит подряд
        if (buf[20] !== 0x2f) return null
        const bits = buf.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
      }
      return null
    }
    // JPEG: идём по меткам до заголовка кадра (SOF) — в нём высота и ширина
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const m = buf[i + 1]
      if (m === 0xff) {
        i++ // заполнитель между метками
        continue
      }
      // Метки без длины
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
        i += 2
        continue
      }
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
      if (sof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    return null
  } catch {
    return null
  }
}

const NOT_IMAGE = 'Логотип: нужна картинка PNG или JPG'

// undefined — логотип не трогаем; '' — убрать; иначе — проверенная строка data URL.
// Негодное — отказ с объяснением для человека
export function checkLogo(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequestException(NOT_IMAGE)
  const s = v.trim()
  if (!s) return ''
  if (s.length > LOGO_MAX_CHARS) throw new BadRequestException('Логотип слишком большой: нужен файл до 300 КБ')
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(s)
  if (!m) throw new BadRequestException(NOT_IMAGE)
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > LOGO_MAX_BYTES) throw new BadRequestException('Логотип слишком большой: нужен файл до 300 КБ')
  const kind = sniffImage(buf)
  // Подпись и содержимое должны совпадать: «PNG», внутри которого не PNG, — не картинка
  if (!kind || !MIME[kind] || MIME[kind] !== m[1]) throw new BadRequestException(NOT_IMAGE)
  const size = imageSize(buf, kind)
  if (!size || size.width < 1 || size.height < 1) throw new BadRequestException(NOT_IMAGE)
  if (size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE) {
    throw new BadRequestException(`Логотип слишком большой по размеру: не больше ${LOGO_MAX_SIDE} точек по стороне`)
  }
  return `data:${m[1]};base64,${m[2]}`
}
