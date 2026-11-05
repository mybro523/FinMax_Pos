// ── Настройки программы ──
//
// Единственное, что программе нужно знать о внешнем мире, — адрес сервера.
// Он задаётся переменной окружения при сборке (APTEKA_API_URL, а если её нет —
// привычная по сайту VITE_API_URL) и записывается в файл build-config.json,
// который кладётся внутрь программы. Секрета в нём нет: это тот же адрес,
// к которому обращается сайт.
import { readFileSync } from 'node:fs'
import { feedFromRepo, normalizeFeed } from './updater.mjs'

// Адрес приводим к одному виду и проверяем. Пустая строка — адрес не годится.
export function normalizeApiUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  // Только защищённое соединение: по нему идут пароли и продажи. Исключение —
  // сервер на этом же компьютере, так его проверяют при разработке.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return ''
  if (u.username || u.password || u.search || u.hash) return ''
  return s
}

export function readBuildConfig(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {} // файла нет — программу запустили из исходников, адрес возьмём из окружения
  }
}

// ── Открытый ключ кодов активации (магазин без интернета, 1.6.0) ──
// Как и адрес сервера: в собранной программе — только зашитый при сборке. Иначе ключ можно
// было бы подменить своим и выпускать коды самому. Из исходников (проверки) — из окружения
export function resolveLicenceKey({ packaged, env = {}, built = {} }) {
  const ok = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : '')
  if (packaged) return ok(built.licenceKey)
  return ok(env.FINMAX_LICENCE_KEY) || ok(built.licenceKey)
}

// ── Откуда брать адрес ──
// В собранной программе — только тот, что зашит при сборке. Переменная окружения
// на компьютере магазина его не меняет, и это намеренно: иначе программу можно было бы
// одной строкой направить на подставной сервер, который на любой вопрос о подписке
// отвечает «оплачено».
//
// При запуске из исходников (разработка, проверки) переменная окружения сильнее:
// так программу направляют на проверочный сервер.
export function resolveApiUrl({ packaged, env = {}, built = {} }) {
  const fromBuild = normalizeApiUrl(built.apiUrl)
  if (packaged) return fromBuild
  return normalizeApiUrl(env.APTEKA_API_URL || env.VITE_API_URL) || fromBuild
}

// ── Запасной адрес сервера (1.6.5) ──
// Тот же сервер под своим именем у OVH. 04.11.2026 у регистратора домена (Navju) отказали DNS:
// api.finmaxpos.tj перестал находиться, и кассы остались без связи, хотя сервер работал. Теперь
// программа спрашивает оба адреса и работает через тот, что ответил (apibase.mjs).
//
// Запасной известен только для боевого адреса и берётся из самой программы: как и основной,
// переменной окружения на компьютере магазина его не подменить. При запуске из исходников
// (проверки) — APTEKA_API_URL_FALLBACK; пустая строка — без запасного.
export const PRIMARY_API = 'https://api.finmaxpos.tj/api'
export const FALLBACK_API = 'https://vps-04688c58.vps.ovh.net/api'

export function resolveApiFallback({ packaged, env = {}, built = {}, apiUrl }) {
  const known = normalizeApiUrl(built.apiFallback) || (apiUrl === PRIMARY_API ? FALLBACK_API : '')
  let out = known
  if (!packaged && typeof env.APTEKA_API_URL_FALLBACK === 'string') out = normalizeApiUrl(env.APTEKA_API_URL_FALLBACK)
  return out && out !== apiUrl ? out : ''
}

// ── Откуда брать обновления ──
// Правило то же, что с адресом сервера: в собранной программе — только зашитое при
// сборке. Иначе одной переменной окружения программу можно было бы заставить скачать
// и поставить чужой установщик. При запуске из исходников переменная сильнее.
export function resolveUpdateFeed({ packaged, env = {}, built = {} }) {
  const fromBuild = normalizeFeed(built.update)
  if (packaged) return fromBuild
  const fromEnv = feedFromRepo(env.APTEKA_UPDATE_REPO) || (env.APTEKA_UPDATE_URL ? normalizeFeed({ provider: 'generic', url: env.APTEKA_UPDATE_URL }) : null)
  return fromEnv || fromBuild
}

// Сервер отдаёт API по адресу …/api, а постоянное соединение живёт в корне
export const serverOrigin = (apiUrl) => String(apiUrl || '').replace(/\/api$/, '')
