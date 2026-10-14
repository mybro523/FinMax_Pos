import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { ruValidationList } from './validation-ru'

// Человеческие объяснения для кодов базы, которые реально могут случиться в работе.
// Кассир должен понимать, что делать, а не читать «ошибка запроса к базе данных».
const HUMAN_DB_ERRORS: Record<string, string> = {
  P2028: 'Операция не уложилась во время — база отвечала слишком долго. Повторите ещё раз.',
  P2034: 'Одновременно шла другая операция с этим товаром. Повторите ещё раз.',
  P2024: 'Сервер занят, не хватило свободных подключений к базе. Повторите через несколько секунд.',
  P2021: 'В базе нет нужной таблицы — обновление сервера не завершилось. Сообщите разработчику.',
  P2022: 'В базе нет нужного поля — обновление сервера не завершилось. Сообщите разработчику.',
  P1001: 'Нет связи с базой данных. Проверьте интернет и повторите.',
  P1008: 'База не ответила вовремя. Повторите ещё раз.',
  P1017: 'Соединение с базой было разорвано. Повторите ещё раз.',
}

// Единый формат ошибок + понятный маппинг Prisma-исключений
// (иначе они «протекают» как 500). Валидация/HttpException проходят как есть.
// Ошибки разбора тела (body-parser) — не HttpException: это обычный Error со
// своим статусом 4xx в поле status и типом в поле type. Узнаём их по этим полям
function bodyParserError(e: unknown): boolean {
  const x = e as { status?: unknown; type?: unknown }
  return (
    !!x &&
    typeof x.status === 'number' &&
    x.status >= 400 &&
    x.status < 500 &&
    typeof x.type === 'string' &&
    x.type.startsWith('entity.')
  )
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions')

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse()
    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message: any = 'Внутренняя ошибка сервера'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const r = exception.getResponse() as any
      message = typeof r === 'string' ? r : r?.message ?? r
      // Проверка полей запроса отвечает по-английски, а программа целиком
      // на русском и таджикском. Переводим здесь, в одном месте: дописывать
      // текст к каждому правилу — сорок мест, и новое поле про это забудет.
      if (status === HttpStatus.BAD_REQUEST) message = ruValidationList(message)
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT
        message = 'Запись с такими данными уже существует'
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND
        message = 'Запись не найдена'
      } else if (exception.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST
        message = 'Ссылка на несуществующую запись'
      } else {
        // Прочие коды Prisma — пишем в журнал и показываем ПОНЯТНУЮ причину.
        // Раньше здесь была общая фраза «Ошибка запроса к базе данных», и по ней
        // нельзя было понять, что случилось.
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`)
        status = HttpStatus.BAD_REQUEST
        message = HUMAN_DB_ERRORS[exception.code] || `Не удалось выполнить операцию (код базы ${exception.code}). Повторите ещё раз.`
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      // Такой отказ почти всегда означает ошибку в самом сервере (неверно собран
      // запрос к базе), а не в данных клиента — без записи в журнал её не найти
      this.logger.error(`Prisma validation: ${exception.message}`)
      status = HttpStatus.BAD_REQUEST
      message = 'Некорректные данные запроса'
    } else if (bodyParserError(exception)) {
      // Отказ разбора тела (слишком большое, битый JSON) — ошибка присланного
      // запроса, а не сервера. Раньше такой отказ уходил наружу как 500
      // «внутренняя ошибка», хотя сервер жив и всё сделал правильно
      const e = exception as { status: number; type?: string }
      status = e.status
      message =
        e.type === 'entity.too.large'
          ? 'Запрос слишком большой'
          : e.type === 'entity.parse.failed'
            ? 'Некорректные данные запроса'
            : 'Некорректный запрос'
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack)
    }

    res.status(status).json({ statusCode: status, message })
  }
}
