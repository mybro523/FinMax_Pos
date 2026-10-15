import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { Prisma as AdminPrisma } from '@prisma/admin-client'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'

// ── Деньги на границе ответа ──
// Prisma отдаёт денежные поля как объекты точной десятичной арифметики. В JSON они
// превращаются не в число, а в структуру с внутренними полями — клиент получил бы
// «[object Object]» вместо суммы. Поэтому здесь они рекурсивно приводятся к числу.
// Точность в базе при этом сохраняется: Decimal(12,2) как лежал, так и лежит.
//
// ── Почему проверок несколько ──
// Клиентов Prisma в проекте два: магазина и панели управления. Классы у них разные,
// хотя называются одинаково, поэтому проверка «этот объект — из того класса» проходит
// только для своего клиента. Сумма оплаты приходила объектом ровно из-за этого.
//
// Была и запасная проверка — по имени класса, — но она не спасала: в собранном
// клиенте имя сжато до одной буквы, и совпасть с «Decimal» оно не могло никогда.
// То есть страховка существовала только на бумаге. Теперь запасная проверка смотрит
// на набор методов: у денежного объекта они одни и те же в любой сборке.
function isDecimal(v: any): boolean {
  if (v instanceof Prisma.Decimal || v instanceof AdminPrisma.Decimal) return true
  return (
    typeof v.toNumber === 'function' &&
    typeof v.toFixed === 'function' &&
    typeof v.dividedBy === 'function' &&
    typeof v.times === 'function'
  )
}

function toPlain(value: any): any {
  if (value == null) return value
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(toPlain)
  if (typeof value === 'object') {
    if (isDecimal(value)) return value.toNumber()
    const out: Record<string, any> = {}
    for (const key of Object.keys(value)) out[key] = toPlain(value[key])
    return out
  }
  return value
}

@Injectable()
export class DecimalInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => toPlain(data)))
  }
}
