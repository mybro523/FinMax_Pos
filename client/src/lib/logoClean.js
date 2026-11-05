// ── Логотип магазина: что пускать на чек и на печать (1.6.4) ──
// Только картинка data URL тех видов, что хранит сервер (server/src/admin/logo.ts): PNG и JPEG.
// WebP сервер не хранит — программа для Windows не смогла бы напечатать его на ленте. Всё
// остальное (ссылка на чужой сайт, SVG, текст) — как «логотипа нет».
// Отдельным файлом без зависимостей: им пользуются окно (lib/logo.js) и проверки.
const DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/

export function cleanLogo(v) {
  return typeof v === 'string' && DATA_URL.test(v) ? v : ''
}
