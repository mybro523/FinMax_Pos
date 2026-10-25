// ── Откуда окно берёт свои файлы ──
//
// Интерфейс программы — это страница, собранная из тех же исходников, что и сайт.
// Открыть её можно было бы прямо с диска (file://), но у такого адреса нет своего
// «сайта»: хранилище общее со всеми файлами компьютера, а правила безопасности
// страницы задать нечем. Поэтому у программы свой адрес — app://apteka — и отдаёт
// по нему файлы она сама. Для окна это обычный защищённый сайт: со своим хранилищем
// и с правилами, которые мы ставим в заголовке ответа.
import { extname, join, normalize, resolve, sep } from 'node:path'

export const SCHEME = 'app'
export const HOST = 'apteka'
export const ORIGIN = `${SCHEME}://${HOST}`
export const START_URL = `${ORIGIN}/index.html`

// Шрифты лежат отдельно от сборки интерфейса и отдаются под этим адресом
const FONTS_PREFIX = '/_fonts/'
// Страница экрана покупателя (второй экран моноблока) — своя маленькая папка программы:
// на сайте её нет, в сборку интерфейса она не входит
const SCREEN_PREFIX = '/_screen/'
export const SCREEN_URL = `${ORIGIN}${SCREEN_PREFIX}customer.html`

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // Логотип FinMax на экране входа лежит в WebP: он втрое легче PNG
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

// ── Что странице разрешено ──
// Главное здесь — connect-src 'self': окно не может обратиться в интернет вообще.
// Все запросы к серверу идут через основную часть программы, поэтому странице сеть
// не нужна, а значит и подменённый сценарий не сможет никуда отправить данные магазина.
// Сценарии — только свои файлы: ни встроенных в страницу, ни собранных из строки.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Интерфейс задаёт часть оформления прямо в разметке (style=…) — как и на сайте
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  // Распознавание штрихкода камерой работает в отдельном потоке
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

// Свой ли это адрес — адрес самой программы
export function isAppUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === SCHEME + ':' && u.host === HOST
  } catch {
    return false
  }
}

// Какой файл отдать по адресу. null — такого у программы нет.
// Выйти за пределы своих папок нельзя ни через «..», ни через хитрый путь: итоговое
// имя файла обязано остаться внутри папки, иначе окно могло бы прочитать с диска
// что угодно — включая файл с ключом входа.
export function resolveAsset({ root, fonts, screen }, url) {
  if (!isAppUrl(url)) return null
  let path
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
  if (path.includes('\0')) return null
  if (path === '' || path === '/') path = '/index.html'

  const inFonts = path.startsWith(FONTS_PREFIX)
  const inScreen = !inFonts && !!screen && path.startsWith(SCREEN_PREFIX)
  const base = resolve(inFonts ? fonts : inScreen ? screen : root)
  const rel = inFonts ? path.slice(FONTS_PREFIX.length) : inScreen ? path.slice(SCREEN_PREFIX.length) : path.slice(1)
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep)) return null

  const type = TYPES[extname(file).toLowerCase()]
  if (!type) return null
  return { file, type, html: type.startsWith('text/html') }
}

// Адрес надо объявить «полноценным» ещё до запуска программы: тогда у него есть
// своё хранилище, относительные пути считаются как на сайте, а страница считается
// защищённой (без этого не работает камера)
export function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

const NOT_FOUND = { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' }

// Что ответить окну на запрос файла: { status, headers, body }
export async function serveAsset({ readFile, root, fonts, screen }, request) {
  const hit = request.method === 'GET' ? resolveAsset({ root, fonts, screen }, request.url) : null
  if (!hit) return NOT_FOUND
  try {
    const body = await readFile(hit.file)
    const headers = { 'Content-Type': hit.type, 'X-Content-Type-Options': 'nosniff' }
    if (hit.html) {
      headers['Content-Security-Policy'] = CSP
      // Страницу всегда берём свежую: после обновления программы имена её файлов другие
      headers['Cache-Control'] = 'no-cache'
    }
    return { status: 200, headers, body }
  } catch {
    return NOT_FOUND
  }
}

// Возвращает, как подключено: 'handle' (Electron 25 и новее) или 'buffer' (Electron 22 —
// на нём программа работает в Windows 7 и 8: protocol.handle там ещё нет)
export function registerAppProtocol({ protocol, readFile, root, fonts, screen }) {
  const where = { readFile, root, fonts, screen }
  if (typeof protocol.handle === 'function') {
    protocol.handle(SCHEME, async (request) => {
      const r = await serveAsset(where, request)
      return new Response(r.body, { status: r.status, headers: r.headers })
    })
    return 'handle'
  }
  protocol.registerBufferProtocol(SCHEME, (request, callback) => {
    serveAsset(where, request).then(
      (r) => callback({ statusCode: r.status, headers: r.headers, data: Buffer.from(r.body) }),
      () => callback({ statusCode: NOT_FOUND.status, headers: NOT_FOUND.headers, data: Buffer.from(NOT_FOUND.body) }),
    )
  })
  return 'buffer'
}
