import { Injectable, NestMiddleware } from '@nestjs/common'
import { NextFunction, Request, Response } from 'express'
import { AuthService } from './auth.service'
import { runInTenant } from '../prisma/tenant-context'

// ── С какой аптекой работает этот запрос ──
// Схему надо объявить до того, как начнёт работать код, который ходит в базу.
// Guard для этого не годится: он отвечает «пропустить или нет», а обработчик
// запускается уже после него и вне его области видимости. Промежуточный слой —
// единственное место, которое оборачивает собой всю дальнейшую обработку целиком,
// включая продолжения после await.
//
// Схему берём из токена, но только после проверки подписи: подписываем токены мы
// сами, поэтому подставить туда чужую схему нельзя. Всё остальное — жив ли
// сотрудник, не приостановлена ли аптека, та ли это схема — проверяет guard,
// и он же отклонит запрос раньше, чем случится хоть одно обращение к данным.
//
// Токен негодный или его нет вовсе — просто идём дальше без схемы: отказ выдаст
// guard, и он сформулирует его понятнее, чем это сделал бы промежуточный слой.
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private auth: AuthService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const header = String(req.headers['authorization'] || '')
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const schema = token ? this.auth.verify(token)?.sch : undefined
    if (!schema) return next()
    return runInTenant(schema, next)
  }
}
