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
