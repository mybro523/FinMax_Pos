// ── Что сайт держит у себя для работы без интернета (14.11.2026) ──
//
// Service worker (lib/sw-worker.js) при установке складывает в кэш браузера всё, что нужно,
// чтобы сайт открылся без сети: страницу, код, стили, шрифты, картинки меню. Список
// собирается при сборке (плагин в vite.config.js) из готовой папки dist — эти функции
// чистые, без файлов и сети, и проверяются отдельно (test/sw-files.test.js).
//
// У файлов из dist/assets в имени уже стоит отпечаток содержимого: изменился файл —
// изменилось имя. У остальных (страница, шрифты, картинки меню) имя постоянное, поэтому к
// ним приписывается свой отпечаток (rev): по нему service worker узнаёт, что файл новый.

// Тяжёлое и ненужное кассе без связи: просмотр PDF (только программа для Windows) и
// выгрузка в Excel. С интернетом они качаются как обычно
export const HEAVY = [/^assets\/pdf\.worker/, /^assets\/pdf-/, /^assets\/exceljs/]

// files: [{ path: 'assets/index-abc.js' (относительно dist, через «/»), hash: 'отпечаток содержимого' }]
// → [{ url: '/assets/index-abc.js', rev: '' }, { url: '/index.html', rev: '1a2b…' }], по алфавиту
export function swEntries(files) {
  const out = []
  for (const f of files || []) {
    const path = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path === 'sw.js' || path.endsWith('.map')) continue
    if (path.split('/').some((part) => part.startsWith('.'))) continue
    if (HEAVY.some((re) => re.test(path))) continue
    out.push({ url: '/' + path, rev: path.startsWith('assets/') ? '' : String(f.hash || '') })
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
}

// Номер версии кэша: меняется, только когда изменился хоть один файл списка. Тот же номер —
// тот же sw.js байт в байт, и браузер ничего заново не качает
export function swVersion(entries) {
  const text = JSON.stringify(entries || [])
  // FNV-1a, два прохода с разной затравкой: для номера версии этого с запасом
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// Готовый sw.js: список и номер версии — первой строкой, дальше сам service worker
export function swScript(template, entries) {
  const manifest = { version: swVersion(entries), entries }
  return `self.__FINMAX_SW__ = ${JSON.stringify(manifest)};\n` + String(template || '')
}
