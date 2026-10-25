// ── Единое время проекта: Таджикистан (Asia/Dushanbe, UTC+5, без переходов) ──
// Все «сегодня», границы периодов и отображение дат/времени считаются по Душанбе,
// независимо от часового пояса устройства. В БД метки хранятся в UTC (стандарт),
// а здесь приводятся к таджикскому времени.
export const TJ_TZ = 'Asia/Dushanbe'
const TJ_OFFSET_MS = 5 * 60 * 60 * 1000 // +05:00

// ── Часы: за истину берём сервер ──
// Часы кассового компьютера или телефона могут спешить и отставать — на живой
// магазине встречалось расхождение в несколько минут. Тогда мгновенно созданный чек
// показывал одно время, а сохранённый на сервере — другое, и время на экране
// «прыгало». Хуже того, при сбитой ДАТЕ выручка за сегодня считалась не за тот день.
// Расхождение узнаём из заголовка каждого ответа сервера — отдельный запрос не нужен.
let skewMs = 0
export function setServerTime(dateHeader) {
  const t = Date.parse(dateHeader || '')
  if (!Number.isFinite(t)) return
  skewMs = t - Date.now()
}
// Текущий момент по часам сервера
export const serverNow = () => new Date(Date.now() + skewMs)
// Насколько часы устройства расходятся с сервером, миллисекунды (для проверок)
export const serverSkew = () => skewMs

// Календарная дата в Душанбе в формате YYYY-MM-DD
export function dayKey(d = serverNow()) {
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return new Date(t + TJ_OFFSET_MS).toISOString().slice(0, 10)
}

// Момент начала суток (Душанбе) для даты d — как абсолютный Date (UTC-инстант)
export function startOfDay(d = serverNow()) {
  return new Date(dayKey(d) + 'T00:00:00.000+05:00')
}

// Начало суток N дней назад от сегодняшнего дня по Душанбе (N=0 → начало сегодня)
export function startOfDaysAgo(n) {
  return startOfDay(new Date(serverNow().getTime() - n * 86400000))
}

// Последние n дневных ключей (Душанбе), от старых к новым
export function lastNDayKeys(n) {
  const out = []
  const now = serverNow().getTime()
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(now - i * 86400000)))
  return out
}

// ── Отображение (всегда в таджикском поясе) ──
const opt = (o) => ({ timeZone: TJ_TZ, ...o })

// ── Форматтеры дат: каждый создаётся один раз ──
// Date.toLocaleString(…, параметры) на каждый вызов заново собирает форматтер — дорого:
// в списках чеков и продаж это тысячи вызовов, а на старом компьютере (программа для
// Windows 7) — заметные доли секунды. Здесь те же форматтеры, но каждый — один раз.
// Поля по умолчанию — те же, что подставил бы сам toLocaleString (дата и время) или
// toLocaleDateString (дата), если их не назвали
const DATE_FIELDS = { year: 'numeric', month: 'numeric', day: 'numeric' }
const TIME_FIELDS = { hour: 'numeric', minute: 'numeric', second: 'numeric' }
const hasDate = (o) => ['weekday', 'year', 'month', 'day'].some((k) => o[k] !== undefined)
const hasTime = (o) => ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'].some((k) => o[k] !== undefined)
const formatters = new Map()
function formatter(kind, o) {
  const key = kind + JSON.stringify(o)
  let f = formatters.get(key)
  if (!f) {
    let full = o
    if (kind === 'any' && !hasDate(o) && !hasTime(o)) full = { ...DATE_FIELDS, ...TIME_FIELDS, ...o }
    if (kind === 'date' && !hasDate(o)) full = { ...DATE_FIELDS, ...o }
    f = new Intl.DateTimeFormat('ru-RU', full)
    formatters.set(key, f)
  }
  return f
}
// Как toLocaleString / toLocaleDateString: и неверная дата — «Invalid Date», а не ошибка
function show(kind, d, o) {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  return formatter(kind, opt(o)).format(date)
}

// Полные дата и время
// Номер чека — из даты и времени продажи по таджикским часам: ММДД-ЧЧММСС.
// Он всегда уникален в пределах кассы, не требует ни интернета, ни счётчика,
// и один и тот же при повторной печати — потому что время продажи не меняется
const CHEK_DTF = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TJ_TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
export function chekNomer(d) {
  const p = CHEK_DTF.formatToParts(new Date(d))
  const at = (type) => p.find((x) => x.type === type)?.value || '00'
  return `${at('month')}${at('day')}-${at('hour')}${at('minute')}${at('second')}`
}

export function fmtDateTime(d) {
  if (!d) return '—'
  return show('any', d, {})
}
// Короткие дата+время: дд.мм чч:мм
export function fmtShort(d) {
  if (!d) return '—'
  return show('any', d, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
// Только время чч:мм
export function fmtTime(d) {
  if (!d) return '—'
  return show('any', d, { hour: '2-digit', minute: '2-digit' })
}
// Только дата дд.мм
export function fmtDayMonth(d) {
  if (!d) return '—'
  return show('date', d, { day: '2-digit', month: '2-digit' })
}
// Дата дд.мм.гггг
export function fmtDate(d) {
  if (!d) return '—'
  return show('date', d, {})
}

// ── Момент подписки ──
// Владелец сервиса назначает срок с точностью до часа: «23.08.2026 в 17:00».
// Всё это — по душанбинскому времени. Сервер живёт по всемирному, и назвать
// клиенту не тот час значит поссориться на пустом месте: спорить он будет
// именно про час.
export function tjMoment(d) {
  if (!d) return '—'
  return show('any', d, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(', ', ' в ')
}

// Дата и час порознь — для полей ввода, которые понимают только «гггг-мм-дд» и «чч:мм»
const tjParts = (d) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', opt({
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }))
      .formatToParts(new Date(d))
      .map((p) => [p.type, p.value]),
  )

export function tjDate(d) {
  if (!d) return ''
  const p = tjParts(d)
  return `${p.year}-${p.month}-${p.day}`
}

export function tjTime(d) {
  if (!d) return ''
  const p = tjParts(d)
  // Полночь Intl отдаёт как «24», а поле ввода понимает только «00»
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}
