// ── Период выборки для журналов ──
// Продажи, возвраты, списания, приходы и погашения долгов копятся годами. Отдавать
// их целиком при каждом обращении нельзя: касса опрашивает сервер постоянно, в том
// числе с телефона по мобильному интернету, и через пару лет работы один такой
// ответ весил бы десятки мегабайт.
//
// Поэтому у каждого журнала есть период. Без параметров отдаётся недавнее — то,
// что нужно в работе. Отчёты за давние даты спрашивают конкретный отрезок и
// получают его целиком.
//
//   ?days=90            — за последние 90 дней
//   ?from=…&to=…        — за отрезок (даты в ISO)
//   ?days=0             — за всё время (для выгрузок и разбора истории)

export interface PeriodQuery {
  days?: string
  from?: string
  to?: string
}

const MAX_DAYS = 3650 // десять лет — дальше уже «всё время»

// Предохранитель от выгрузки всей базы одним запросом. Не ограничение по смыслу,
// а защита от случайной нагрузки: столько записей магазин накопит очень нескоро.
export const MAX_ROWS = 100000

// Возвращает условие по дате для Prisma. undefined — без ограничения (всё время).
export function periodWhere(q: PeriodQuery = {}, defaultDays = 90) {
  if (q.from || q.to) {
    const range: { gte?: Date; lte?: Date } = {}
    const from = q.from ? new Date(q.from) : null
    const to = q.to ? new Date(q.to) : null
    if (from && !isNaN(from.getTime())) range.gte = from
    if (to && !isNaN(to.getTime())) range.lte = to
    return Object.keys(range).length ? range : undefined
  }

  // Явный ноль означает «всё время» — так выгружают историю целиком
  const asked = q.days === undefined || q.days === '' ? defaultDays : Number(q.days)
  if (!Number.isFinite(asked) || asked <= 0) return undefined

  const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(asked)))
  return { gte: new Date(Date.now() - days * 86400000) }
}

// Готовый кусок where для запроса: { date: {...} } либо пусто
export function periodFilter(q: PeriodQuery = {}, defaultDays = 90, field = 'date') {
  const range = periodWhere(q, defaultDays)
  return range ? { [field]: range } : {}
}
