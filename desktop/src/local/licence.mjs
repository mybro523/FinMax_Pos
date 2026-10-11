// ── Срок работы без связи ──
//
// Программа продаёт и без интернета — но не бесконечно. Подписку проверяет сервер,
// при каждом обмене. Если связи с ним нет дольше разрешённого (по умолчанию семь
// дней; число назначает владелец сервиса для каждой аптеки), программа закрывает
// работу до первой удачной проверки. Иначе аптека, переставшая платить, просто
// выдернула бы провод и работала дальше.
//
// Отметка «когда сервер последний раз подтвердил подписку» лежит на диске
// зашифрованной средствами Windows — так же, как ключи входа. Поправить её в файле
// базы руками нельзя: не расшифровалась — значит, проверки не было. Время берётся
// с часов программы (clock.mjs): у срока там свой отсчёт (lic), который не идёт назад
// и не зависит от перевода часов компьютера, — перевести дату и получить ещё неделю
// не выйдет, а опечатка в дате не запрёт кассу.
import { q } from './db.mjs'
import { DAY_MS } from './time.mjs'

export const OFFLINE_DAYS_DEFAULT = 7
const OFFLINE_DAYS_MIN = 1
const OFFLINE_DAYS_MAX = 30
// За сколько дней до остановки начинаем предупреждать
export const OFFLINE_WARN_DAYS = 2
// Часы программы назад не идут. Если «сейчас» оказалось раньше последней проверки
// больше, чем на эту погрешность, — данные о времени стёрты или подменены
const CLOCK_SLACK_MS = 10 * 60 * 1000

// Число дней — в тех же границах, что на сервере (server/src/admin/subscription.ts)
export function offlineDaysOf(n) {
  const v = Math.trunc(Number(n))
  if (!Number.isFinite(v) || v <= 0) return OFFLINE_DAYS_DEFAULT
  return Math.min(OFFLINE_DAYS_MAX, Math.max(OFFLINE_DAYS_MIN, v))
}

// Запись без шифрования допустима только там, где шифрования нет вовсе. Иначе её
// можно было бы подложить вместо зашифрованной
const PLAIN = 'plain:'

function pack(record, cipher) {
  const text = JSON.stringify(record)
  let sealed = null
  try {
    sealed = cipher.seal(text)
  } catch {
    sealed = null
  }
  return sealed || PLAIN + text
}

function unpack(stored, cipher) {
  try {
    if (String(stored).startsWith(PLAIN)) {
      // Шифрование на этом компьютере работает — значит, открытая запись подложена
      let works = false
      try {
        works = !!cipher.seal('проверка')
      } catch {
        works = false
      }
      return works ? null : JSON.parse(String(stored).slice(PLAIN.length))
    }
    return JSON.parse(cipher.open(stored))
  } catch {
    return null
  }
}

// ── Сервер только что подтвердил подписку ──
// days — сколько дней он разрешает этой аптеке работать без связи. Не сказал
// (ответ на вход у прежней версии сервера) — остаётся прежнее число.
export function confirmLicence(db, code, { now, days }, cipher) {
  const before = readLicence(db, code, cipher)
  const record = {
    code,
    checkedAt: now,
    // Сервер только что сказал, который час: отсчёт «до какого момента программа
    // дожила» начинается с его слова — и по сроку, и по часам
    seenAt: now,
    floorAt: now,
    offlineDays: days === undefined || days === null ? before?.offlineDays ?? OFFLINE_DAYS_DEFAULT : offlineDaysOf(days),
  }
  write(db, record, cipher)
  return record
}

function write(db, record, cipher) {
  q(db, 'INSERT INTO licences (pharmacyCode, sealed) VALUES (?, ?) ON CONFLICT(pharmacyCode) DO UPDATE SET sealed = excluded.sealed').run(
    record.code,
    pack(record, cipher),
  )
}

// ── Программа работает: запомнить, до какого момента она дожила ──
// Часы программы помнят последний увиденный момент и раньше него время не покажут
// (clock.mjs). Но помнят они его в обычной строке базы: её можно стереть, перевести
// дату компьютера на день проверки — и получить неделю заново. Поэтому тот же момент
// записывается ещё и сюда, в зашифрованную запись: стереть её — значит остаться без
// проверки вовсе, а поправить нельзя.
//
// Моментов два (см. clock.mjs): now — время срока работы без связи, floor — «верное»
// время часов. Обычно они совпадают. Расходятся они на компьютере со сбитыми часами:
// срок там уменьшается ещё и за неизвестные простои, а часам эти простои не приписать —
// иначе выдуманное время попало бы в чеки.
export function touchLicence(db, code, now, cipher, floor = now) {
  const r = readLicence(db, code, cipher)
  if (!r || !(now > r.seenAt || floor > r.floorAt)) return
  write(db, { ...r, seenAt: Math.max(r.seenAt, now), floorAt: Math.max(r.floorAt, floor) }, cipher)
}

// Самый поздний момент, до которого дожил срок работы без связи, — по всем аптекам
// этого компьютера. С него время срока продолжается после запуска
export function lastSeen(db, cipher) {
  return top(db, cipher, (r) => r.seenAt)
}

// То же для «верного» времени часов: раньше него программа время не покажет
export function lastFloor(db, cipher) {
  return top(db, cipher, (r) => r.floorAt)
}

function top(db, cipher, pick) {
  let max = 0
  for (const row of q(db, 'SELECT pharmacyCode FROM licences').all()) {
    const r = readLicence(db, row.pharmacyCode, cipher)
    if (r) max = Math.max(max, pick(r))
  }
  return max
}

function readLicence(db, code, cipher) {
  const row = q(db, 'SELECT sealed FROM licences WHERE pharmacyCode = ?').get(code)
  if (!row) return null
  const r = unpack(row.sealed, cipher)
  // Запись другой аптеки, переложенная в эту строку, не годится
  if (!r || r.code !== code || !Number.isFinite(r.checkedAt)) return null
  // У записи прежней версии программы этой отметки нет — считаем от самой проверки
  const seenAt = Number.isFinite(r.seenAt) ? Math.max(r.seenAt, r.checkedAt) : r.checkedAt
  return {
    code,
    checkedAt: r.checkedAt,
    offlineDays: offlineDaysOf(r.offlineDays),
    seenAt,
    // Отдельной отметки часов у прежних записей тоже нет: тогда это был один момент
    floorAt: Number.isFinite(r.floorAt) ? Math.max(r.floorAt, r.checkedAt) : seenAt,
  }
}

// ── Что сейчас со сроком ──
//   checkedAt   — когда сервер последний раз подтвердил подписку (пусто — никогда);
//   offlineDays — сколько дней разрешено без связи;
//   until       — момент, когда работа остановится;
//   expired     — срок вышел: работать нельзя до проверки;
//   warn        — до остановки меньше двух дней.
export function licenceOf(db, code, now, cipher) {
  const r = readLicence(db, code, cipher)
  if (!r) return { checkedAt: null, offlineDays: OFFLINE_DAYS_DEFAULT, until: null, leftMs: 0, expired: true, warn: true }
  const until = r.checkedAt + r.offlineDays * DAY_MS
  // «Сейчас» не раньше момента, до которого программа уже дожила: перевод часов
  // назад (и стёртая память часов) срока не возвращает
  const leftMs = until - Math.max(now, r.seenAt)
  const clockBack = now < r.checkedAt - CLOCK_SLACK_MS
  return {
    checkedAt: new Date(r.checkedAt).toISOString(),
    offlineDays: r.offlineDays,
    until: new Date(until).toISOString(),
    leftMs,
    expired: leftMs <= 0 || clockBack,
    warn: leftMs <= OFFLINE_WARN_DAYS * DAY_MS,
  }
}
