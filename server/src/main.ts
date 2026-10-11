import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { execFileSync } from 'node:child_process'
import compression from 'compression'
import { AppModule } from './app.module'
import { AccountsService } from './admin/accounts.service'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { DecimalInterceptor } from './common/decimal.interceptor'
import { assertSecureConfig, ConfigError } from './common/config'

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e))

// ── Размер тела запроса ──
// Express по умолчанию принимает не больше 100 КБ. Для продаж и приходов этого
// с запасом хватает, но восстановление резервной копии присылает ВСЮ базу аптеки
// одним запросом — а это мегабайты уже на второй год работы. То есть копия
// снималась исправно, а поднять её было нельзя: сервер отвечал «слишком большое
// тело запроса» ровно в тот день, ради которого её и делали.
//
// Значение можно уменьшить переменной BODY_LIMIT, если сервер стеснён по памяти:
// разбор присланного JSON целиком держится в оперативной памяти.
const BODY_LIMIT = process.env.BODY_LIMIT || '100mb'

// Приводим схему базы к текущей версии программы ВНУТРИ процесса — чтобы это
// выполнялось, даже если платформа переопределяет команду запуска из Dockerfile
// (например, Railway Custom Start Command = "node dist/main").
//
// Раньше здесь работал `db push --accept-data-loss`. Теперь — миграции: у каждой
// правки схемы есть свой файл, база помнит применённое, а флага «согласен на
// потерю данных» нет вовсе. Подробности и разбор первого запуска — в
// scripts/migrate.mjs.
//
// Неудача здесь останавливает запуск: работать с несогласованной схемой опаснее,
// чем не работать вовсе — ошибки полезли бы посреди продажи. Railway перезапустит
// сервис сам, а если дело в самой миграции, это будет видно в логах сразу.
function syncSchema() {
  if (process.env.DB_MIGRATE_ON_BOOT === 'false') {
    console.log('[schema] пропущено (DB_MIGRATE_ON_BOOT=false)')
    return
  }
  execFileSync(process.execPath, ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    timeout: 180000,
  })
}

async function bootstrap() {
  const port = process.env.PORT || 3000
  console.log(`[boot] starting Apteka API, PORT=${port}`)

  // Небезопасные настройки — до всего остального. Поднимать сервер, в который
  // можно войти чужим, хуже, чем не поднять его вовсе
  assertSecureConfig()

  syncSchema()

  // Разбор тела отключаем на старте и включаем сами — иначе Nest успевает
  // поставить свой разбор со стандартными 100 КБ, и наш лимит уже ничего не решает
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false })
  app.useBodyParser('json', { limit: BODY_LIMIT })
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true })

  // ── Чей адрес считать адресом устройства ──
  // Railway ставит перед приложением ДВА прокси, и адрес клиента приходит цепочкой:
  //   X-Forwarded-For: 109.75.50.16, 152.233.13.165
  //                    ^ настоящая аптека   ^ прокси Railway
  //
  // Сначала здесь стояла единица — «доверяем одному ближайшему прокси». Она снимала
  // с конца ровно один адрес, и адресом устройства оказывался сам прокси Railway.
  // А их несколько, и они чередуются.
  //
  // Чем это кончалось, видно только на живом сервере. Защита входа считает промахи
  // по адресу — и считала она не по аптекам, а по двум прокси на весь мир. То есть
  // никакой защиты «по устройству» не было вовсе: промахи всех клиентов складывались
  // в общую кучу, а с порогом в пять попыток пятеро промахнувшихся где угодно
  // закрыли бы вход всему сервису разом.
  //
  // Двойка снимает оба прокси и оставляет настоящий адрес аптеки. Подделать его
  // нельзя: свой заголовок клиента Railway не удаляет, но дописывает к нему свои
  // адреса справа, а отсчёт идёт именно справа.
  //
  // Если Railway когда-нибудь добавит третий прокси, это снова сломается молча.
  // Поэтому есть раздел /admin/schema/client и сквозная проверка: они сверяют,
  // совпадает ли адрес, который видит сервер, с тем, что прислал прокси.
  app.set('trust proxy', 2)

  // ── Заголовки безопасности ──
  // Своими руками, без библиотеки: нужны ровно четыре заголовка, а helmet тянет
  // за собой десяток настроек, половина которых к API отношения не имеет.
  //
  // Отдельно про «x-powered-by»: Express представляется в каждом ответе, и это
  // подсказка тому, кто ищет известные дыры в конкретной версии. Пользы от него
  // нет никакой.
  app.set('x-powered-by', false)
  app.use((_req: any, res: any, next: any) => {
    // Не угадывать тип содержимого: иначе ответ, который мы считаем текстом,
    // браузер может исполнить как скрипт
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // API незачем открывать в рамке на чужой странице
    res.setHeader('X-Frame-Options', 'DENY')
    // Не рассказывать чужим сайтам, откуда пришёл запрос
    res.setHeader('Referrer-Policy', 'no-referrer')
    // Только по защищённому соединению, полгода. Аптека работает и с телефона
    // по чужому Wi-Fi, где подменить незащищённый ответ — дело техники.
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
    next()
  })

  // Сжатие ответов. Списки товаров, продаж и журналов — это однотипный JSON,
  // он ужимается в разы. Касса опрашивает сервер постоянно, в том числе с телефона
  // по мобильному интернету, поэтому экономия трафика здесь заметна напрямую.
  app.use(compression())

  // CORS: при заданном CORS_ORIGIN — строгий список + credentials.
  // Без него — разрешаем любой origin, но БЕЗ credentials (мы не используем cookie-сессии),
  // чтобы не отражать произвольный origin вместе с Allow-Credentials.
  const origin = process.env.CORS_ORIGIN
  app.enableCors(
    origin
      ? { origin: origin.split(',').map((s) => s.trim()), credentials: true }
      : { origin: true, credentials: false },
  )

  app.setGlobalPrefix('api')
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
  app.useGlobalFilters(new AllExceptionsFilter())
  app.useGlobalInterceptors(new DecimalInterceptor())

  // Владелец сервиса — тот, кто заводит аптеки. Без него войти в систему нельзя
  // вовсе: аптеки заводит он, а завести его самого некому.
  //
  // Настройки самой аптеки — стартовые категории, запрет на вторую открытую смену,
  // перенос остатков в партии — здесь больше не выполняются. Раньше аптека была
  // одна и лежала в общей схеме, теперь у каждой своя, и настраивается она при
  // заведении (см. PharmaciesService).
  await app.get(AccountsService).ensureSuperadmin()

  await app.listen(port, '0.0.0.0')
  console.log(`Apteka API listening on http://0.0.0.0:${port}/api`)
}

bootstrap().catch((e) => {
  // Ошибку настроек показываем крупно и без стека: её читает не программист,
  // а владелец аптеки в логах Railway, и ему нужно понять, что исправить
  if (e instanceof ConfigError) {
    console.error('\n' + '='.repeat(70))
    console.error(e.message)
    console.error('='.repeat(70) + '\n')
  } else {
    console.error('[boot] fatal', e)
  }
  process.exit(1)
})
