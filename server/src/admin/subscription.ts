import { startOfTodayTj } from '../common/time'

// ── Состояние подписки магазина ──
// Считается из трёх полей — даты оплаты, признака пробного периода и ручной
// приостановки, — а не хранится отдельным столбцом. Хранимое «состояние» пришлось
// бы обновлять по расписанию, и в первый же день, когда задача не отработала, оно
// разошлось бы с датой. Здесь расхождению взяться неоткуда.
//
// ── Срок значит срок ──
// Сначала отключение было мягким: пять дней отсрочки, потом режим только чтения.
// Владелец сервиса решил иначе — и это его право: он назначает точный момент,
// вплоть до часа, и в этот момент работа прекращается. Отсрочка сверху сделала бы
// назначенное время бессмысленным: зачем указывать 17:00, если отключит через
// пять дней. Нужна отсрочка — срок просто ставится дальше, это одно движение.
//
// Данные при этом не удаляются никогда. Даже у магазина, ушедшего год назад:
// вернётся и заплатит — включим. Стирать чужой учёт мы права не имеем.
// Но до оплаты она к ним не доберётся, и владелец сервиса об этом предупреждён.

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'suspended'

// За сколько дней до окончания начинаем предупреждать заранее
export const WARN_DAYS = Math.max(0, Number(process.env.SUBSCRIPTION_WARN_DAYS ?? 5))

const DAY = 86400000

export interface PharmacySubscription {
  paidUntil: Date | string
  trial?: boolean
  blocked?: boolean
}

export interface SubscriptionView {
  status: SubscriptionStatus
  // Дней до конца оплаченного периода, с округлением вверх. Отрицательное — просрочено
  daysLeft: number
  // Сколько миллисекунд осталось. По нему ставится будильник на точный момент
  // отключения — «до конца дня» здесь не годится
  leftMs: number
  paidUntil: string
  canWrite: boolean
  // Показывать ли предупреждение в интерфейсе: оплата на исходе или уже просрочена
  warn: boolean
}


export function subscriptionOf(ph: PharmacySubscription, now: Date = new Date()): SubscriptionView {
  const paidUntil = ph.paidUntil instanceof Date ? ph.paidUntil : new Date(ph.paidUntil)
  // Сравниваем МОМЕНТЫ, а не календарные дни: владелец сервиса назначает срок
  // с точностью до часа, и «до конца дня» превратило бы 17:00 в 23:59
  const leftMs = paidUntil.getTime() - now.getTime()
  // Дней осталось — для показа человеку. Округляем вверх: пока идёт последний
  // день, честнее сказать «остался 1 день», чем «осталось 0».
  const daysLeft = Math.ceil(leftMs / DAY)

  const base = {
    daysLeft,
    leftMs,
    paidUntil: paidUntil.toISOString(),
  }

  // Приостановлена вручную — разговор особый, и срок оплаты тут ни при чём
  if (ph.blocked) {
    return { ...base, status: 'suspended', canWrite: false, warn: true }
  }
  // Срок вышел. Ни продать, ни посмотреть: вход закрыт до оплаты.
  if (leftMs <= 0) {
    return { ...base, status: 'expired', canWrite: false, warn: true }
  }
  return {
    ...base,
    status: ph.trial ? 'trial' : 'active',
    canWrite: true,
    // Пробный период предупреждает всегда: он на то и пробный
    warn: !!ph.trial || daysLeft <= WARN_DAYS,
  }
}

// ── Сколько дней касса работает без связи ──
// Число назначает владелец сервиса для каждого магазина. Границы — от одного дня до
// месяца: ноль запретил бы работу без интернета вовсе, а полгода сделали бы
// проверку подписки пустой формальностью.
export const OFFLINE_DAYS_DEFAULT = 7
export const OFFLINE_DAYS_MIN = 1
export const OFFLINE_DAYS_MAX = 30

export function offlineDaysOf(ph: { offlineDays?: number | null }): number {
  const n = Math.trunc(Number(ph?.offlineDays))
  if (!Number.isFinite(n) || n <= 0) return OFFLINE_DAYS_DEFAULT
  return Math.min(OFFLINE_DAYS_MAX, Math.max(OFFLINE_DAYS_MIN, n))
}

// ── Прибавить месяцы к дате ──
// Календарные месяцы разной длины, и наивное «плюс тридцать дней» за год набирает
// почти неделю в пользу клиента. Но у прибавления месяцев есть ловушка: 31 января
// плюс месяц — это не 3 марта. Такой день просто прижимаем к концу месяца.
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1) // чтобы перескок месяца не случился раньше времени
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

// ── От какой даты продлевать ──
// Если оплата ещё действует — от её конца: клиент не теряет уже оплаченное.
// Если просрочена — от сегодня, а не от старой даты: иначе магазин платил бы
// за месяцы, когда не работала, и первый же платёж уходил бы в пустоту.
export function extendFrom(paidUntil: Date | string, now: Date = new Date()): Date {
  const until = paidUntil instanceof Date ? paidUntil : new Date(paidUntil)
  return until.getTime() > now.getTime() ? until : now
}

// Текст для человека за кассой. Он должен понять, что делать, и не решить, что
// программа сломалась: причина в оплате, а не в его действиях.
export function subscriptionMessage(v: SubscriptionView, pharmacyName = 'Магазин'): string {
  switch (v.status) {
    case 'suspended':
      return 'Работа приостановлена. Обратитесь к поставщику программы.'
    case 'expired':
      // Человек должен понять три вещи: программа не сломалась, данные целы,
      // и что делать дальше. Иначе он будет искать причину в себе.
      return (
        'Подписка закончилась ' + tjMoment(v.paidUntil) + '. Данные магазина сохранены — ' +
        'работа продолжится сразу после оплаты. Обратитесь к поставщику программы.'
      )
    case 'trial':
      return v.daysLeft <= 1
        ? 'Пробный период заканчивается ' + tjMoment(v.paidUntil) + '.'
        : 'Пробный период: осталось ' + v.daysLeft + ' дн.'
    default:
      return v.daysLeft <= WARN_DAYS ? 'Подписка заканчивается ' + tjMoment(v.paidUntil) + '.' : ''
  }
}

// ── Момент по-душанбински ──
// «23.08.2026 в 17:00». Сервер живёт по всемирному времени, а спорить клиент будет
// именно про час: назвать ему не тот час — значит поссориться на пустом месте.
export function tjMoment(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso)
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Dushanbe',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find((x) => x.type === t)?.value || ''
  return g('day') + '.' + g('month') + '.' + g('year') + ' в ' + g('hour') + ':' + g('minute')
}
