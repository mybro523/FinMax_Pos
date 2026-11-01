// ── Активация магазина без интернета (версия 1.6.0) ──
//
// Код активации выпускает владелец сервиса под «код компьютера» (licence-code.mjs). Здесь —
// что программа с ним делает: принимает (проверяет подпись, вид, срок), помнит в общей базе
// программы и отвечает, можно ли работать. Подпись проверяется при каждом ответе заново: код,
// подложенный в базу руками, без подписи сервиса не пройдёт, а с другого компьютера — тоже
// (подпись покрывает код компьютера).
//
// «Сегодня» берётся по времени срока программы (clock.mjs, lic): оно не идёт назад, и перевод
// даты на компьютере срока не продлевает.
import { q } from './db.mjs'
import { dateOfDay, endOfDayMs, FOREVER, readCode, todayDay, validKey } from './licence-code.mjs'

// За сколько дней до конца срока предупреждать
export const WARN_DAYS = 7

export const ACTIVATION_TEXT = {
  noKey: 'Программа собрана без ключа активации — обратитесь к поставщику программы.',
  noComputer: 'Не удалось прочитать номер этого компьютера — обратитесь к поставщику программы.',
  typo: 'В коде опечатка — сверьте каждую группу знаков.',
  bad: 'Этот код не подходит к этому компьютеру. Проверьте, тот ли код компьютера вы сообщили.',
  resetHere: 'Это код сброса пароля, а не код активации.',
  activateHere: 'Это код активации, а не код сброса пароля.',
  old: 'Срок этого кода уже прошёл — попросите новый.',
  older: 'У этого компьютера уже есть код с более поздним сроком.',
  olderSame: 'Этот код выдан раньше уже введённого — введите последний выданный код.',
  resetUsed: 'Этот код сброса уже использован — попросите новый.',
  expired: (date) => `Срок работы программы закончился ${date}. Данные магазина сохранены — введите новый код активации.`,
  ends: (date) => `Срок работы программы заканчивается ${date}. Попросите новый код активации у поставщика программы.`,
}

// Дата для человека: «01.11.2027»
const human = (day) => {
  const [y, m, d] = dateOfDay(day).split('-')
  return `${d}.${m}.${y}`
}

const row = (core) => q(core, 'SELECT * FROM activation WHERE id = 1').get() || null

// Проверка подписи — несколько миллисекунд, а состояние спрашивают при каждом действии: прочитанный
// код помним по точному тексту (ключ, компьютер и сам код) — подменённый код в базе прочтётся заново
let lastRead = { key: '', read: null }
function readStored(publicKey, computerRaw, code) {
  const key = publicKey + '|' + computerRaw.toString('hex') + '|' + code
  if (lastRead.key !== key) lastRead = { key, read: readCode(publicKey, computerRaw, code) }
  return lastRead.read
}

// ── Что сейчас с активацией ──
// publicKey — открытый ключ сервиса; computerRaw — 5 байт кода этого компьютера; now — время срока
export function activationState(core, { publicKey, computerRaw, now }) {
  const r = row(core)
  if (!r || !computerRaw || !validKey(publicKey)) return { active: false, activated: false, expired: false, warn: false }
  const read = readStored(publicKey, computerRaw, r.code)
  // Код в базе есть, но к этому компьютеру не подходит (базу перенесли) или подделан
  if (!read.ok || read.fields.kind !== 'activate') return { active: false, activated: false, expired: false, warn: false, foreign: true }
  const f = read.fields
  const forever = f.until === FOREVER
  const today = todayDay(now)
  const daysLeft = forever ? null : f.until - today + 1
  const expired = !forever && today > f.until
  const warn = !forever && !expired && daysLeft <= WARN_DAYS
  return {
    active: !expired,
    activated: true,
    expired,
    warn,
    forever,
    until: forever ? null : dateOfDay(f.until),
    untilHuman: forever ? null : human(f.until),
    // Конец срока — момент: последний день действует целиком (по Душанбе)
    endsAt: forever ? null : new Date(endOfDayMs(f.until)).toISOString(),
    daysLeft,
    registers: f.registers,
    serial: f.serial,
    message: expired ? ACTIVATION_TEXT.expired(human(f.until)) : warn ? ACTIVATION_TEXT.ends(human(f.until)) : '',
  }
}

// ── Принять код активации ──
// Возвращает новое состояние; отказ — { error }
export function activate(core, { publicKey, computerRaw, code, now }) {
  if (!validKey(publicKey)) return { error: ACTIVATION_TEXT.noKey }
  if (!computerRaw) return { error: ACTIVATION_TEXT.noComputer }
  const read = readCode(publicKey, computerRaw, code)
  if (!read.ok) return { error: read.why === 'typo' ? ACTIVATION_TEXT.typo : ACTIVATION_TEXT.bad }
  const f = read.fields
  if (f.kind !== 'activate') return { error: ACTIVATION_TEXT.resetHere }
  if (f.until !== FOREVER && todayDay(now) > f.until) return { error: ACTIVATION_TEXT.old }
  // Новый код с более ранним сроком, чем уже введённый, не нужен: по ошибке введённый старый
  // код не должен укоротить оплаченный срок
  const r = row(core)
  const cur = r ? readCode(publicKey, computerRaw, r.code) : null
  if (cur?.ok && cur.fields.kind === 'activate' && f.until < cur.fields.until) return { error: ACTIVATION_TEXT.older }
  // Срок тот же — новее тот, что выдан позже (номер больше): поставщик мог уменьшить число касс,
  // и прежний код с тем же сроком не должен вернуть их обратно
  if (cur?.ok && cur.fields.kind === 'activate' && f.until === cur.fields.until && f.serial < cur.fields.serial) return { error: ACTIVATION_TEXT.olderSame }
  q(core, 'INSERT INTO activation (id, code, activatedAt) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET code = excluded.code, activatedAt = excluded.activatedAt').run(
    String(code).trim(),
    new Date(now).toISOString(),
  )
  return activationState(core, { publicKey, computerRaw, now })
}

// ── Код сброса пароля владельца ──
// Действует до своего дня включительно и только один раз
export function useResetCode(core, { publicKey, computerRaw, code, now }) {
  if (!validKey(publicKey)) return { error: ACTIVATION_TEXT.noKey }
  if (!computerRaw) return { error: ACTIVATION_TEXT.noComputer }
  const read = readCode(publicKey, computerRaw, code)
  if (!read.ok) return { error: read.why === 'typo' ? ACTIVATION_TEXT.typo : ACTIVATION_TEXT.bad }
  const f = read.fields
  if (f.kind !== 'reset') return { error: ACTIVATION_TEXT.activateHere }
  if (todayDay(now) > f.until) return { error: ACTIVATION_TEXT.old }
  if (q(core, 'SELECT 1 FROM reset_used WHERE serial = ? AND until = ?').get(f.serial, f.until)) return { error: ACTIVATION_TEXT.resetUsed }
  return { ok: true, mark: () => q(core, 'INSERT OR IGNORE INTO reset_used (serial, until, usedAt) VALUES (?, ?, ?)').run(f.serial, f.until, new Date(now).toISOString()) }
}
