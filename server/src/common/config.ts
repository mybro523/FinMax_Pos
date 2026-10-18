import { Logger } from '@nestjs/common'
import { passwordProblem } from '../auth/password'

// ── Проверка настроек перед запуском ──
// Раньше сервер молча стартовал с ключом подписи по умолчанию, если AUTH_SECRET
// не задали. Ключ этот лежит в открытом репозитории, поэтому любой мог подписать
// себе токен владельца и получить доступ ко всему магазину — к закупочным ценам,
// прибыли, долгам клиентов и выгрузке всей базы.
//
// Снаружи такую настройку не видно: сервер работает как обычно. Поэтому в проде
// он теперь отказывается стартовать. Упавший сервер заметят и починят за минуты,
// а открытый вход может простоять месяцами.
//
// В разработке ключ по умолчанию допустим — там нет ни живых денег, ни интернета,
// но предупреждение выводится, чтобы это не уехало на сервер незамеченным.

export const DEV_SECRET = 'apteka-dev-secret-CHANGE-ME'
const MIN_SECRET_LEN = 24

export const AUTH_SECRET = (process.env.AUTH_SECRET || '').trim() || DEV_SECRET
export const isProd = () => process.env.NODE_ENV === 'production'

export class ConfigError extends Error {}

// Что не так с настройками. Пустой список — всё в порядке.
export function configProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const secret = (env.AUTH_SECRET || '').trim()

  if (!secret) {
    out.push(
      'AUTH_SECRET не задан. Сервер подписывал бы токены входа ключом по умолчанию — ' +
        'он лежит в открытом репозитории, и вход владельца можно подделать.',
    )
  } else if (secret === DEV_SECRET) {
    out.push('AUTH_SECRET совпадает с ключом по умолчанию из репозитория — задайте свой.')
  } else if (secret.length < MIN_SECRET_LEN) {
    out.push(
      `AUTH_SECRET слишком короткий (${secret.length} символов). ` +
        `Нужно не меньше ${MIN_SECRET_LEN}: короткий ключ подбирается.`,
    )
  }

  if (!env.DATABASE_URL) {
    out.push('DATABASE_URL не задан — серверу негде хранить данные магазина.')
  }

  return out
}

// ── Пароль владельца сервиса ──
// Проверяется НЕ при каждом запуске, а только когда владельца сервиса заводят впервые
// (accounts.service.ts): под ним заводятся все магазины, поэтому слабый или стандартный
// пароль здесь — то же самое, что открытая дверь ко всем данным. Отдельно от
// configProblems, чтобы не требовать ADMIN_PASSWORD там, где владелец уже есть и пароль
// давно сменён, а переменную окружения убрали.
// Пусто — пароль годится.
export function superadminPasswordProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const pw = env.ADMIN_PASSWORD || ''
  if (!pw) {
    return 'ADMIN_PASSWORD не задан — владелец сервиса завёлся бы с паролем «admin», а под ним заводятся все магазины.'
  }
  if (pw.toLowerCase() === 'admin') {
    return 'ADMIN_PASSWORD равен «admin» — это общеизвестный пароль. Задайте свой.'
  }
  const weak = passwordProblem(pw)
  if (weak) return `ADMIN_PASSWORD не годится для владельца сервиса: ${weak.charAt(0).toLowerCase()}${weak.slice(1)}`
  return null
}

// Как получить хороший ключ — подсказка прямо в логе, чтобы не искать
const HOW_TO_FIX =
  'Сгенерировать ключ: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\n' +
  'и записать его в переменную AUTH_SECRET на сервере.'

// Вызывается при старте. В проде бросает исключение, в разработке предупреждает.
export function assertSecureConfig(log = new Logger('Config'), env: NodeJS.ProcessEnv = process.env): void {
  const problems = configProblems(env)
  if (!problems.length) {
    log.log('Настройки в порядке')
    return
  }
  const text = problems.map((p) => '  · ' + p).join('\n')
  if (isProd()) {
    throw new ConfigError(`Сервер не запущен — небезопасные настройки:\n${text}\n\n${HOW_TO_FIX}`)
  }
  log.warn(`Небезопасные настройки (в разработке это допустимо, на сервере — нет):\n${text}\n${HOW_TO_FIX}`)
}
