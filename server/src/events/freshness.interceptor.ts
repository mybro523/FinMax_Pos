import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable, of } from 'rxjs'
import { tap } from 'rxjs/operators'
import { ChangeStamp } from './change-stamp.service'
import { currentTenantSchema } from '../prisma/tenant-context'

// ── Не отдавать одно и то же дважды ──
//
// Список товаров у настоящего магазина — тысячи наименований, и меняется он редко:
// приход бывает раз в день. А забирался заново при каждом обновлении экрана и при
// каждом восстановлении связи. Для магазина на восемь тысяч позиций это мегабайты
// по сети, их разбор в браузере кассы — и всё ради того же самого списка.
//
// Теперь браузер присылает отметку прошлого ответа. Совпала — отвечаем «то же
// самое» и не делаем ничего: ни запроса в базу, ни сборки ответа. Не совпала —
// работаем как обычно.
//
// ── Только там, где ответ не зависит от времени ──
// Журналы отдаются за последние дни, и окно это едет само собой: вчерашний ответ
// сегодня уже другой, даже если в базе ничего не менялось. Для них такая отметка
// была бы враньём. Поэтому здесь только те разделы, где ответ меняется
// исключительно от записи в базу.
const WATCHED: { test: RegExp; key: string }[] = [
  { test: /^\/products(\/|$|\?)/, key: 'products' },
  { test: /^\/customers(\/|$|\?)/, key: 'customers' },
  { test: /^\/categories(\/|$|\?)/, key: 'categories' },
  { test: /^\/product-types(\/|$|\?)/, key: 'productTypes' },
  { test: /^\/users(\/|$|\?)/, key: 'users' },
]

export function watchedCollection(method: string, url: string): string | null {
  if (!method || method.toUpperCase() !== 'GET') return null
  const path = String(url || '').replace(/^\/api/, '')
  return WATCHED.find((r) => r.test.test(path))?.key || null
}

@Injectable()
export class FreshnessInterceptor implements NestInterceptor {
  constructor(private stamp: ChangeStamp) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest()
    const key = watchedCollection(req?.method, req?.originalUrl || req?.url)
    if (!key) return next.handle()

    const schema = currentTenantSchema()
    if (!schema) return next.handle() // вне магазина отмечать нечего

    const res = ctx.switchToHttp().getResponse()
    const tag = this.stamp.tag(schema, key, req.originalUrl || req.url)

    // Разным сотрудникам — разные ответы. Без этого браузер, в котором работали
    // двое, мог бы показать второму то, что сохранил для первого.
    res.setHeader('Vary', 'Authorization')
    // Спрашивать разрешено, брать без спроса — нет. Иначе изменения доходили бы
    // с опозданием, а вся затея была ради обратного.
    res.setHeader('Cache-Control', 'no-cache, private')

    if (req.headers['if-none-match'] === tag) {
      res.status(304)
      return of(null) // до обработчика дело не доходит: ни базы, ни сборки ответа
    }

    return next.handle().pipe(tap(() => res.setHeader('ETag', tag)))
  }
}
