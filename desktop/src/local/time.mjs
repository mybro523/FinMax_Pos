// ── Время магазина: Таджикистан (UTC+5, без перехода на летнее) ──
//
// Те же правила, что на сервере (server/src/common/time.ts) и в окне
// (client/src/lib/time.js): «сегодня» считается по Душанбе, а не по часовому поясу
// компьютера. Иначе товар, у которого срок вышел, ещё несколько часов считался бы
// годным — или наоборот.

const TJ_OFFSET_MS = 5 * 60 * 60 * 1000
export const DAY_MS = 86400000

const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime())

// Календарный день по Душанбе: «2026-08-22»
export const dayKeyTj = (now) => new Date(ms(now) + TJ_OFFSET_MS).toISOString().slice(0, 10)

// Начало сегодняшних суток по Душанбе — как момент времени
export const startOfTodayTj = (now) => new Date(dayKeyTj(now) + 'T00:00:00.000+05:00')

// Просрочена ли партия. Срок годности — ПОСЛЕДНИЙ день, когда товар годен: «годен
// до 20.08» значит, что 20-го продавать ещё можно, а 21-го уже нет. Пустой срок
// (бинты, вата, приборы) просроченным не считается никогда.
//
// Сроки лежат в базе строками одного вида («2026-08-20T00:00:00.000Z»), поэтому их
// можно сравнивать как текст — так делает и запрос к базе.
export const expiryLimit = (now) => startOfTodayTj(now).toISOString()
export const isExpired = (expiryIso, now) => !!expiryIso && expiryIso < expiryLimit(now)

// Дата из того, что прислало окно или сервер, — в единый вид. Пусто и мусор — null.
export function isoOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const t = ms(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// ── Момент по-душанбински: «23.08.2026 в 17:00» ──
// Нужен в сообщении об окончании подписки. Спорить клиент будет именно про час.
export function tjMoment(v) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Dushanbe',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms(v)))
  const g = (t) => parts.find((x) => x.type === t)?.value || ''
  return `${g('day')}.${g('month')}.${g('year')} в ${g('hour')}:${g('minute')}`
}
