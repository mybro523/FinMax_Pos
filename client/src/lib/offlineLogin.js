// ── Вход на сайте без интернета (14.11.2026) ──
//
// Касса на сайте продаёт и без связи, но страницу могут обновить или закрыть — и тогда
// без интернета вход по паролю не дошёл бы до сервера. Поэтому при каждом удачном входе
// с интернетом сайт оставляет в этом браузере запись: ключ входа и «кто я», ЗАШИФРОВАННЫЕ
// паролем (PBKDF2-SHA256 → AES-GCM, встроенная криптография браузера). Без пароля ключ
// из записи не достать: пароль по-прежнему вводится при каждом входе, как просил владелец
// («касса стоит в общем зале, открытый вход на чужом компьютере опаснее»).
//
// Без интернета войти может только тот, кто уже входил в этом браузере с интернетом, и не
// позже RECORD_DAYS назад (столько живёт ключ входа на сервере). Записей — не больше
// MAX_RECORDS, лишние — самые давние. Владелец сервиса записи не оставляет.
//
// Модуль ни от чего не зависит: хранилище, криптография и часы передаются снаружи —
// так он проверяется без браузера (test/offline-login.test.js).

export const STORE_KEY = 'finmax_offline_login_v1'
export const MAX_RECORDS = 10
export const ITERATIONS = 120000
export const RECORD_DAYS = 30
const DAY = 86400000

const enc = new TextEncoder()
const dec = new TextDecoder()

const defaults = () => ({
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
  subtle: globalThis.crypto?.subtle || null,
  random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  now: () => Date.now(),
})

// Логин, как его вводят: регистр и пробелы по краям не в счёт
export const loginKey = (login) => String(login ?? '').trim().toLowerCase()

function b64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
function unb64(text) {
  const s = atob(String(text))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function readAll(storage) {
  try {
    const raw = storage?.getItem(STORE_KEY)
    const all = raw ? JSON.parse(raw) : {}
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    return {}
  }
}
function writeAll(storage, all) {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(all))
    return true
  } catch {
    return false // хранилище переполнено или закрыто (приватный режим)
  }
}

async function keyOf(subtle, password, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(String(password ?? '')), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// Запомнить вход: после удачного входа с интернетом. Возвращает true, если запись легла
export async function saveOfflineLogin({ login, password, token, user }, deps = {}) {
  const { storage, subtle, random, now } = { ...defaults(), ...deps }
  const key = loginKey(login)
  if (!storage || !subtle || !key || !token || !user || !password) return false
  // Владельцу сервиса касса не нужна — и его ключ входа нигде не оставляем
  if (user.role === 'superadmin') return false
  const salt = random(16)
  const iv = random(12)
  const k = await keyOf(subtle, password, salt, ITERATIONS)
  const plain = enc.encode(JSON.stringify({ login: key, token, user }))
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, plain))
  const all = readAll(storage)
  all[key] = { v: 1, salt: b64(salt), iv: b64(iv), iter: ITERATIONS, data: b64(data), at: now(), shop: String(user.pharmacy?.code || '') }
  // Не больше MAX_RECORDS: убираем самые давние
  const names = Object.keys(all).sort((a, b) => (Number(all[b]?.at) || 0) - (Number(all[a]?.at) || 0))
  for (const n of names.slice(MAX_RECORDS)) delete all[n]
  return writeAll(storage, all)
}

// Есть ли запись для этого логина (и не устарела ли она)
export function hasOfflineLogin(login, deps = {}) {
  const { storage, now } = { ...defaults(), ...deps }
  const r = readAll(storage)[loginKey(login)]
  return !!r && now() - (Number(r.at) || 0) <= RECORD_DAYS * DAY
}

// Войти по записи: { token, user } — пароль верный; { error } — почему нельзя.
//   'none'    — записи нет (в этом браузере не входили) или она устарела;
//   'password'— пароль не подошёл;
//   'broken'  — запись испорчена (её убираем)
export async function openOfflineLogin({ login, password }, deps = {}) {
  const { storage, subtle, now } = { ...defaults(), ...deps }
  const key = loginKey(login)
  const all = readAll(storage)
  const r = all[key]
  if (!r || !subtle) return { error: 'none' }
  if (now() - (Number(r.at) || 0) > RECORD_DAYS * DAY) return { error: 'none' }
  let salt, iv, data
  try {
    salt = unb64(r.salt)
    iv = unb64(r.iv)
    data = unb64(r.data)
    if (salt.length < 8 || iv.length !== 12 || !data.length || !(Number(r.iter) >= 10000)) throw new Error('запись')
  } catch {
    delete all[key]
    writeAll(storage, all)
    return { error: 'broken' }
  }
  let plain
  try {
    const k = await keyOf(subtle, password, salt, Number(r.iter))
    plain = await subtle.decrypt({ name: 'AES-GCM', iv }, k, data)
  } catch {
    // AES-GCM проверяет целостность: неверный пароль и порча данных выглядят одинаково
    return { error: 'password' }
  }
  try {
    const obj = JSON.parse(dec.decode(plain))
    if (!obj || obj.login !== key || typeof obj.token !== 'string' || !obj.token || !obj.user || typeof obj.user !== 'object') throw new Error('запись')
    return { token: obj.token, user: obj.user }
  } catch {
    delete all[key]
    writeAll(storage, all)
    return { error: 'broken' }
  }
}

// Забыть запись (например, сотрудник сменил пароль на другом компьютере — старая не нужна)
export function forgetOfflineLogin(login, deps = {}) {
  const { storage } = { ...defaults(), ...deps }
  const all = readAll(storage)
  const key = loginKey(login)
  if (!(key in all)) return
  delete all[key]
  writeAll(storage, all)
}
