// ── Последняя связь с сервером (бывший «срок работы без связи») ──
//
// До 1.6.5 программа без интернета работала не дольше разрешённого (по умолчанию семь дней)
// и потом закрывалась до первой проверки подписки. С 1.6.5 срока нет (решение владельца
// сервиса, 05.11.2026): касса без связи работает сколько угодно, а закрыть её может только
// слово сервера — блокировка магазина или конец оплаты. Здесь осталась отметка «когда сервер
// последний раз подтвердил подписку» и память часов, которая держится на ней.
//
// Отметка «когда сервер последний раз подтвердил подписку» лежит на диске
// зашифрованной средствами Windows — так же, как ключи входа. Поправить её в файле
// базы руками нельзя: не расшифровалась — значит, проверки не было. Время берётся
// с часов программы (clock.mjs): у срока там свой отсчёт (lic), который не идёт назад
// и не зависит от перевода часов компьютера, — перевести дату и получить ещё неделю
// не выйдет, а опечатка в дате не запрёт кассу.
import { q } from './db.mjs'

// Число дней без связи, которое прежние версии сервера присылали магазину. С 1.6.5 оно ни на
// что не влияет, но остаётся в записи — её читают и прежние версии программы
export const OFFLINE_DAYS_DEFAULT = 7
const OFFLINE_DAYS_MIN = 1
const OFFLINE_DAYS_MAX = 30

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
// days — сколько дней он разрешает этому магазину работать без связи (с 1.6.5 ни на что не
// влияет). paidUntil и status — до какого момента оплачено и что с подпиской, со слова сервера
// (1.6.5). Те же значения лежат и в обычных столбцах базы (accounts), но их можно поправить
// руками, а эту запись — нет: касса сверяет одно с другим (gateway.mjs, withTerms). Не сказал
// (ответ прежней версии сервера) — остаётся прежнее.
export function confirmLicence(db, code, { now, days, paidUntil, status }, cipher) {
  const before = readLicence(db, code, cipher)
  const record = {
    code,
    checkedAt: now,
    // Сервер только что сказал, который час: отсчёт «до какого момента программа
    // дожила» начинается с его слова — и по сроку, и по часам
    seenAt: now,
    floorAt: now,
    offlineDays: days === undefined || days === null ? before?.offlineDays ?? OFFLINE_DAYS_DEFAULT : offlineDaysOf(days),
    paidUntil: paidUntil === undefined ? before?.paidUntil ?? null : paidUntil || null,
    status: status === undefined ? before?.status ?? null : status || null,
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

// ── Срок оплаты и состояние подписки из зашифрованной записи (1.6.5) ──
// null — записи нет: проверки на этом компьютере не было, или запись стёрли
export function licenceTerms(db, code, cipher) {
  const r = readLicence(db, code, cipher)
  return r ? { paidUntil: r.paidUntil, status: r.status } : null
}

// Сервер закрыл работу магазина (ответ 403) — запомнить и в зашифрованной записи: иначе
// обычный столбец можно было бы вернуть руками
export function sealStatus(db, code, status, cipher) {
  const r = readLicence(db, code, cipher)
  if (r) write(db, { ...r, status }, cipher)
}

// Самый поздний момент, до которого дожил срок работы без связи, — по всем магазинам
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
  // Запись другого магазина, переложенная в эту строку, не годится
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
    // У записи прежней версии программы их нет — до первой проверки сервером
    paidUntil: typeof r.paidUntil === 'string' ? r.paidUntil : null,
    status: typeof r.status === 'string' ? r.status : null,
  }
}

// ── Что сейчас со сроком ──
// С 1.6.5 срока работы без связи нет (решение владельца сервиса, 05.11.2026): касса без связи
// работает сколько угодно. Остановить её может только слово сервера — магазин заблокирован или
// кончилась оплата; дату окончания оплаты касса знает заранее (local/accounts.mjs). Запись о
// последней проверке остаётся: по ней видно, когда касса последний раз была на связи, и на ней
// держится память часов (lastSeen, lastFloor).
//   checkedAt — когда сервер последний раз подтвердил подписку (пусто — никогда);
//   expired, warn — всегда false: срок больше ничего не закрывает.
export function licenceOf(db, code, now, cipher) {
  const r = readLicence(db, code, cipher)
  return {
    checkedAt: r ? new Date(r.checkedAt).toISOString() : null,
    unlimited: true,
    expired: false,
    warn: false,
  }
}
