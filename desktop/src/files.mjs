// ── Файлы, которые собирает страница ──
//
// Выгрузку в Excel собирает окно, а сохраняет основная часть: в программе страница
// живёт по своему адресу (app://), и обычное скачивание с неё обрывается, не записав
// ни байта. Окно передаёт готовый файл и имя, основная часть спрашивает человека,
// куда сохранить, — путь выбирает он, а не страница.
//
// Поэтому здесь только то, что можно проверить без Electron: имя файла и сам файл.

// Excel больше 25 МБ из кассы не бывает — это уже ошибка, а не таблица
export const MAX_XLSX_BYTES = 25 * 1024 * 1024

// Знаки, которые Windows не пускает в имя файла (обратная черта — по коду: так её не
// спутать с началом особого знака в строке)
const ZAPRET = '<>:"/|?*' + String.fromCharCode(92)

// Имя для окна «Сохранить как»: без путей, этих знаков и невидимых управляющих, не
// длиннее 120 знаков и всегда с расширением .xlsx
export function safeXlsxName(raw) {
  const base = String(raw ?? '')
    .replace(/\.xlsx$/i, '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ZAPRET.includes(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120)
    .trim()
  return (base || 'FinMax') + '.xlsx'
}

// Похоже ли на настоящий .xlsx: байты, разумный размер и подпись zip («PK») в начале.
// Возвращает Buffer для записи или null
export function xlsxBytes(raw) {
  if (!raw || !ArrayBuffer.isView(raw)) return null
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (buf.length < 4 || buf.length > MAX_XLSX_BYTES) return null
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return null
  return buf
}
