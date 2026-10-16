import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { Observable } from 'rxjs'
import { tap } from 'rxjs/operators'
import { EventsGateway } from './events.gateway'

// ── Кто кого задевает ──
// Одна операция меняет сразу несколько разделов: продажа — это и чек, и остаток
// на складе, и долг клиента. Поэтому здесь описано, какие списки устарели после
// какого запроса. Перехватчик один на всё приложение: добавится новый раздел —
// достаточно дописать строку сюда, а не искать все места записи.
const RULES: { test: RegExp; keys: string[] }[] = [
  { test: /^\/products/, keys: ['products'] },
  { test: /^\/sales/, keys: ['sales', 'products', 'customers'] },
  // Приход в долг меняет и долг поставщика
  { test: /^\/arrivals/, keys: ['arrivals', 'products', 'suppliers'] },
  // Оплата поставщику из кассы меняет и ожидаемые наличные в смене
  { test: /^\/suppliers/, keys: ['suppliers', 'supplierPayments', 'shifts'] },
  { test: /^\/supplier-payments/, keys: ['supplierPayments', 'suppliers', 'shifts'] },
  { test: /^\/shifts\/cash/, keys: ['cashMoves', 'shifts'] },
  { test: /^\/cash-moves/, keys: ['cashMoves', 'shifts'] },
  { test: /^\/pay-services/, keys: ['payServices'] },
  { test: /^\/returns/, keys: ['returns', 'products', 'sales', 'customers'] },
  { test: /^\/writeoffs/, keys: ['writeoffs', 'products'] },
  // Пересчёт остатков применяется целиком: меняются и остатки, и недостача
  { test: /^\/inventory/, keys: ['products', 'writeoffs'] },
  { test: /^\/customers/, keys: ['customers', 'payments'] },
  { test: /^\/deferred/, keys: ['deferred'] },
  // Переименование категории переносит товары, поэтому обновляем и их
  { test: /^\/categories/, keys: ['categories', 'products'] },
  // Тип товара тоже переносит товары при переименовании
  { test: /^\/product-types/, keys: ['productTypes', 'products'] },
  { test: /^\/shifts/, keys: ['shifts', 'sales'] },
  // Расход из кассы меняет и ожидаемые наличные в смене
  { test: /^\/expenses/, keys: ['expenses', 'shifts'] },
  { test: /^\/expense-categories/, keys: ['expenseCategories'] },
  // Доходы вне продаж: смену не трогают, меняется только их журнал
  { test: /^\/incomes/, keys: ['incomes'] },
  { test: /^\/income-categories/, keys: ['incomeCategories'] },
  // Сотрудники: завели кассира, сбросили пароль, заблокировали. Раньше второе
  // устройство узнавало об этом только после перезагрузки страницы.
  { test: /^\/users/, keys: ['users'] },
  // Владелец разобрал расхождение — список у него на других устройствах устарел
  { test: /^\/discrepancies/, keys: ['discrepancies'] },
  // Восстановление из копии переписывает всё
  {
    test: /^\/backup/,
    keys: [
      'products', 'sales', 'arrivals', 'customers', 'deferred', 'shifts', 'payments', 'returns', 'writeoffs', 'expenses', 'expenseCategories',
      'suppliers', 'supplierPayments', 'cashMoves', 'payServices', 'productTypes', 'incomes', 'incomeCategories',
    ],
  },
]

// Какие списки устарели после запроса. Чтение ничего не меняет — для него пусто.
export function collectionsFor(method: string, url: string): string[] {
  if (!method || method.toUpperCase() === 'GET') return []
  const path = String(url || '').split('?')[0].replace(/^\/api/, '')
  const rule = RULES.find((r) => r.test.test(path))
  return rule ? rule.keys : []
}

@Injectable()
export class ChangeEventsInterceptor implements NestInterceptor {
  constructor(private events: EventsGateway) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest()
    const keys = collectionsFor(req?.method, req?.originalUrl || req?.url)
    if (!keys.length) return next.handle()
    // Оповещаем только после успешной записи: если операция упала,
    // на других устройствах ничего не изменилось
    return next.handle().pipe(
      tap(() => {
        this.events.changed(...keys)
        // Владельцу сервиса — что в этом магазине шла работа. Если у него открыта
        // её карточка, счётчики обновятся сами; в списке видно, что клиент живой.
        const code = req?.user?.code
        if (code) this.events.toService('activity', { code })
      }),
    )
  }
}
