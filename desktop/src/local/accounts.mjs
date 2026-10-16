// ── Кто может войти на этом компьютере без интернета ──
//
// Первый вход всегда идёт через сервер: только он знает, верен ли пароль. После
// удачного входа программа запоминает сотрудника здесь и дальше может проверить его
// пароль сама, без связи. Запоминается не пароль, а его необратимый отпечаток —
// тем же способом и той же стойкости, что на сервере (server/src/auth/password.ts).
//
// Блокировка сотрудника и смена пароля приходят с сервера при первой же связи:
// сервер отказывает во входе — отпечаток стирается, и без интернета под этим
// именем больше не войти.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { ApiError, getMeta, newId, q, setMeta } from './db.mjs'
import { DAY_MS, tjMoment } from './time.mjs'

// ── Отпечаток пароля ──
// scrypt с теми же настройками, что на сервере. Дорогая проверка — это намеренно:
// она делает перебор бессмысленным. Считается в отдельном потоке, окно не замирает.
const N = 16384
const R = 8
const P = 4
const KEYLEN = 64
const MAXMEM = 96 * 1024 * 1024

const derive = (pw, salt, n, r, p) =>
  new Promise((ok, fail) => {
    scrypt(String(pw), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, key) => (e ? fail(e) : ok(key.toString('hex'))))
  })

export async function makeVerifier(password) {
  const salt = randomBytes(16).toString('hex')
  return `s3$${N}$${R}$${P}$${salt}$${await derive(password, salt, N, R, P)}`
}

export async function checkVerifier(password, stored) {
  try {
    const [tag, n, r, p, salt, hash] = String(stored || '').split('$')
    if (tag !== 's3' || !salt || !hash) return false
    const [nn, rr, pp] = [Number(n), Number(r), Number(p)]
    if (!(nn >= 1024 && rr >= 1 && pp >= 1 && 128 * nn * rr * pp <= MAXMEM)) return false
    const a = Buffer.from(hash, 'hex')
    const b = Buffer.from(await derive(password, salt, nn, rr, pp), 'hex')
    // Сравнение за одинаковое время: обычное выдаёт длину совпадения по времени ответа
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ── Номер этого компьютера ──
// Создаётся один раз. По нему сервер отличает одну кассу от другой: у каждой своя
// смена и своя очередь неотправленных операций.
export function deviceIdOf(db) {
  let id = getMeta(db, 'deviceId')
  if (!id) {
    id = newId()
    setMeta(db, 'deviceId', id)
  }
  return id
}

// ── Ключ этого компьютера ──
// Номер кассы знают все сотрудники магазина: он стоит в сменах, а смены получает каждая
// касса. Чтобы под этим номером не мог заговорить кто-то другой, касса при первом
// обмене называет серверу ещё и ключ; дальше сервер принимает под этим номером только
// его. Ключ создаётся вместе с номером и лежит рядом: потерять одно без другого нельзя.
export function deviceKeyOf(db) {
  let key = getMeta(db, 'deviceKey')
  if (!key) {
    key = randomBytes(32).toString('base64url')
    setMeta(db, 'deviceKey', key)
  }
  return key
}

// ── Учётные записи ──
export const accountById = (db, id) => q(db, 'SELECT * FROM accounts WHERE id = ?').get(id) || null
export const accountByLogin = (db, login) => q(db, 'SELECT * FROM accounts WHERE login = ?').get(login) || null

// Запомнить то, что сервер сказал о сотруднике: кто он, из какого магазина, что с подпиской.
// user — ответ сервера на вход или на «кто я». verifier — уже зашифрованный отпечаток;
// undefined означает «прежний не трогать» (при «кто я» пароля у нас нет).
export function saveAccount(db, user, { verifier, now }) {
  if (!user?.id || !user?.pharmacy?.code) return null
  const sub = user.subscription || {}
  const seenAt = new Date(now).toISOString()
  // Логин уникален. Если его раньше носила другая учётная запись (сотрудника
  // удалили и завели заново) — прежнюю запись убираем, иначе новая не запишется
  q(db, 'DELETE FROM accounts WHERE login = ? AND id <> ?').run(user.name, user.id)
  q(
    db,
    `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, seenAt, permissions, roleName)
     VALUES (@id, @login, @role, @code, @name, @verifier, @subStatus, @paidUntil, @seenAt, @permissions, @roleName)
     ON CONFLICT(id) DO UPDATE SET
       login = excluded.login, role = excluded.role, pharmacyCode = excluded.pharmacyCode,
       pharmacyName = excluded.pharmacyName, subStatus = excluded.subStatus, paidUntil = excluded.paidUntil,
       seenAt = excluded.seenAt, permissions = excluded.permissions, roleName = excluded.roleName,
       verifier = CASE WHEN @keep = 1 THEN accounts.verifier ELSE excluded.verifier END`,
  ).run({
    id: user.id,
    login: user.name,
    role: user.role,
    code: user.pharmacy.code,
    name: user.pharmacy.name || '',
    verifier: verifier ?? null,
    keep: verifier === undefined ? 1 : 0,
    subStatus: sub.status || 'active',
    paidUntil: sub.paidUntil || null,
    seenAt,
    // Права приходят с сервера вместе с «кто я». Нет списка — сервер прежней версии,
    // тогда права кассира по умолчанию (пустая строка, см. permissionsOf)
    permissions: Array.isArray(user.permissions) ? JSON.stringify(user.permissions) : '',
    roleName: user.roleName || '',
  })
  return accountById(db, user.id)
}

// Сервер отказал этому сотруднику: пароль сменили, учётную запись закрыли.
// Без интернета под ним больше не войти — до следующего удачного входа через сервер.
export const dropVerifier = (db, id) => q(db, 'UPDATE accounts SET verifier = NULL WHERE id = ?').run(id)

// Что сервер сказал о подписке этого магазина. Касается всех её сотрудников сразу
export function setSubscription(db, pharmacyCode, { status, paidUntil }) {
  q(db, 'UPDATE accounts SET subStatus = COALESCE(?, subStatus), paidUntil = COALESCE(?, paidUntil) WHERE pharmacyCode = ?').run(
    status ?? null,
    paidUntil ?? null,
    pharmacyCode,
  )
}

// ── Подписка без связи ──
// Тот же расчёт, что на сервере (server/src/admin/subscription.ts): состояние не
// хранится, а выводится из срока оплаты и текущего момента. Срок вышел, пока
// компьютер был без интернета, — программа закрывается сама, в назначенный час.
const WARN_DAYS = 5

export function subscriptionOf(acc, now) {
  if (!acc?.paidUntil) return null
  const until = Date.parse(acc.paidUntil)
  if (!Number.isFinite(until)) return null
  const leftMs = until - now
  const daysLeft = Math.ceil(leftMs / DAY_MS)
  const base = { daysLeft, leftMs, paidUntil: new Date(until).toISOString() }
  let view
  if (acc.subStatus === 'suspended') view = { status: 'suspended', ...base, canWrite: false, warn: true }
  else if (leftMs <= 0 || acc.subStatus === 'expired') view = { status: 'expired', ...base, canWrite: false, warn: true }
  else {
    const trial = acc.subStatus === 'trial'
    view = { status: trial ? 'trial' : 'active', ...base, canWrite: true, warn: trial || daysLeft <= WARN_DAYS }
  }
  return { ...view, message: subscriptionMessage(view) }
}

export function subscriptionMessage(v) {
  switch (v.status) {
    case 'suspended':
      return 'Работа приостановлена. Обратитесь к поставщику программы.'
    case 'expired':
      return (
        'Подписка закончилась ' + tjMoment(v.paidUntil) + '. Данные магазина сохранены — ' +
        'работа продолжится сразу после оплаты. Обратитесь к поставщику программы.'
      )
    case 'trial':
      return v.daysLeft <= 1 ? 'Пробный период заканчивается ' + tjMoment(v.paidUntil) + '.' : 'Пробный период: осталось ' + v.daysLeft + ' дн.'
    default:
      return v.daysLeft <= WARN_DAYS ? 'Подписка заканчивается ' + tjMoment(v.paidUntil) + '.' : ''
  }
}

// ── Права учётной записи ──
// Тот же минимум кассира, что на сервере и на сайте: для записей без списка прав
export const CASHIER_DEFAULT = [
  'pos.sell', 'pos.discount', 'pos.debt', 'pos.defer', 'customers.create',
  'returns.view', 'returns.create', 'shift.view', 'shift.open', 'shift.cash',
]
export function permissionsOf(acc) {
  if (!acc) return []
  const raw = acc.permissions
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw) {
    try {
      const p = JSON.parse(raw)
      if (Array.isArray(p)) return p
    } catch {
      /* испорченная запись — как без списка */
    }
  }
  return acc.role === 'cashier' ? CASHIER_DEFAULT : []
}
// Владелец может всё; остальным — любое из перечисленных прав
export function hasPerm(acc, ...keys) {
  if (!acc) return false
  if (acc.role === 'founder') return true
  const own = permissionsOf(acc)
  return keys.some((k) => own.includes(k))
}

// «Кто я» — в том же виде, что отдаёт сервер
export const userView = (acc, now) => ({
  id: acc.id,
  name: acc.login,
  role: acc.role,
  roleId: acc.role === 'founder' ? 'owner' : null,
  roleName: acc.role === 'founder' ? 'Владелец' : acc.roleName || 'Кассир',
  permissions: permissionsOf(acc),
  pharmacy: { code: acc.pharmacyCode, name: acc.pharmacyName },
  subscription: subscriptionOf(acc, now),
  impersonatedBy: null,
  // Сотрудник в базе магазина: по нему окно узнаёт «свою» смену
  tenantUserId: acc.tenantUserId || null,
})

// ── Защита входа без интернета от подбора ──
// Тот же счёт, что на сервере (server/src/auth/throttle.ts): пять промахов подряд —
// вход закрыт на минуту, следующая серия — на пять, дальше на пятнадцать. Удачный
// вход стирает всё. Отличие одно: счёт лежит в базе, а не в памяти — иначе его
// обнулял бы перезапуск программы.
const LIMIT = 5
const MIN = 60_000
const STEPS = [MIN, 5 * MIN, 15 * MIN]
const WINDOW_MS = 15 * MIN
const FORGET_MS = 60 * MIN

const failRow = (db, key) => q(db, 'SELECT * FROM login_fails WHERE key = ?').get(key) || null
const saveFail = (db, e) =>
  q(
    db,
    `INSERT INTO login_fails (key, fails, firstFailAt, lastFailAt, blockedUntil, step)
     VALUES (@key, @fails, @firstFailAt, @lastFailAt, @blockedUntil, @step)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, firstFailAt = excluded.firstFailAt,
       lastFailAt = excluded.lastFailAt, blockedUntil = excluded.blockedUntil, step = excluded.step`,
  ).run(e)

export const throttle = {
  // Сколько миллисекунд осталось ждать. 0 — вход разрешён
  retryAfterMs(db, key, now) {
    const e = failRow(db, key)
    if (!e) return 0
    if (e.blockedUntil > now) return e.blockedUntil - now
    // Запись держим и после снятия блокировки: в ней помнится ступенька, иначе
    // вторая серия промахов стоила бы столько же, сколько первая
    if (now - e.lastFailAt > FORGET_MS) q(db, 'DELETE FROM login_fails WHERE key = ?').run(key)
    return 0
  },

  fail(db, key, now) {
    const e = failRow(db, key)
    // Давно ничего не путал — забываем и промахи, и ступеньку
    if (!e || now - e.lastFailAt > FORGET_MS) {
      return saveFail(db, { key, fails: 1, firstFailAt: now, lastFailAt: now, blockedUntil: 0, step: 0 })
    }
    // Прошлая серия оборвалась давно — начинаем новую, но ступеньку помним
    if (now - e.firstFailAt > WINDOW_MS && e.blockedUntil <= now) {
      return saveFail(db, { ...e, fails: 1, firstFailAt: now, lastFailAt: now })
    }
    e.fails += 1
    e.lastFailAt = now
    if (e.fails >= LIMIT) {
      e.blockedUntil = now + STEPS[Math.min(e.step, STEPS.length - 1)]
      e.step += 1
      // Следующая серия считается с нуля — иначе каждая новая ошибка после
      // блокировки удлиняла бы её заново
      e.fails = 0
      e.firstFailAt = now
    }
    return saveFail(db, e)
  },

  success(db, keys) {
    for (const key of keys) q(db, 'DELETE FROM login_fails WHERE key = ?').run(key)
  },

  humanWait(ms) {
    const sec = Math.ceil(ms / 1000)
    return sec < 60 ? `${sec} сек.` : `${Math.ceil(sec / 60)} мин.`
  },
}

const nameKey = (login) => 'name:' + login.toLowerCase()
const DEVICE_KEY = 'device'

// Удачный вход через сервер снимает подозрения и здесь
export const loginSucceeded = (db, login) => throttle.success(db, [nameKey(String(login || '').trim()), DEVICE_KEY])

// ── Вход без интернета ──
// open — расшифровать отпечаток (средствами Windows). Возвращает учётную запись
// или бросает отказ в том же виде, в каком его дал бы сервер.
export async function offlineLogin(db, { name, password }, { now, open }) {
  const login = String(name || '').trim()
  const nameWait = throttle.retryAfterMs(db, nameKey(login), now)
  const deviceWait = throttle.retryAfterMs(db, DEVICE_KEY, now)
  const waitMs = Math.max(nameWait, deviceWait)
  if (waitMs > 0) {
    const where = deviceWait >= nameWait ? 'с этого устройства' : 'под этим именем'
    throw new ApiError(429, `Слишком много неудачных попыток. Вход ${where} закрыт на ${throttle.humanWait(waitMs)}`)
  }

  const acc = accountByLogin(db, login)
  const verifier = acc?.verifier ? open(acc.verifier) : null
  // Проверить пароль не по чему: человек на этом компьютере ещё не входил (или
  // сервер отозвал его вход). Это не «неверный пароль» — попытку не считаем
  if (!acc || !verifier) {
    throw new ApiError(503, 'Нет связи с сервером. Первый вход на этом компьютере возможен только с интернетом.')
  }

  if (!(await checkVerifier(String(password ?? ''), verifier))) {
    throttle.fail(db, nameKey(login), now)
    throttle.fail(db, DEVICE_KEY, now)
    throw new ApiError(401, 'Неверное имя или пароль')
  }

  // Пароль верный, но работать магазину нельзя — говорим прямо, как сервер: человек
  // должен понять, что дело не в пароле
  const sub = subscriptionOf(acc, now)
  if (sub?.status === 'suspended') throw new ApiError(401, 'Работа магазина приостановлен. Обратитесь к поставщику программы.')
  if (sub?.status === 'expired') throw new ApiError(401, sub.message)

  throttle.success(db, [nameKey(login), DEVICE_KEY])
  return acc
}
