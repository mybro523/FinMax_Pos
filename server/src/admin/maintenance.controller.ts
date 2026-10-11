import { Controller, Get, Post, Req } from '@nestjs/common'
import { SchemaUpdaterService } from './schema-updater.service'
import { TenantPool } from '../prisma/tenant-pool.service'
import { AccountCache } from './account-cache.service'
import { DbProbe } from './db-probe.service'
import { Roles, ServiceWide } from '../auth/decorators'

// ── Обслуживание сервиса ──
// Не про конкретную аптеку, а про все сразу: в каком состоянии их схемы и не пора
// ли догнать отставших. Обновление идёт само при старте, но кнопка нужна: после
// выкладки правки схемы её результат хочется увидеть сразу, а не гадать.
@Controller('admin/schema')
@ServiceWide()
@Roles('superadmin')
export class MaintenanceController {
  constructor(
    private readonly updater: SchemaUpdaterService,
    private readonly pool: TenantPool,
    private readonly accounts: AccountCache,
    private readonly probe: DbProbe,
  ) {}

  // Сколько подключений к базе занято сейчас. Предел Postgres — то, во что этот
  // сервис упрётся раньше всего остального, и узнать об этом лучше заранее,
  // а не из отказов посреди рабочего дня.
  // ── Сколько стоит один поход в базу ──
  // Снаружи причину медленной работы не различить: то ли база далеко, то ли имя
  // долго разрешается. Отсюда, изнутри, видно точно.
  @Get('db')
  db() {
    return this.probe.check()
  }

  // ── Каким сервер видит устройство, с которого пришёл запрос ──
  // От этого зависит защита входа: она считает неудачные попытки по адресу.
  // Если за прокси хостинга адрес определяется неверно, счётчик либо считает
  // всех вместе (и пятеро промахнувшихся закрывают вход всему сервису), либо
  // размазывается по нескольким ключам — и защита слабее, чем кажется.
  // Проверить это снаружи невозможно, поэтому спрашиваем сам сервер.
  @Get('client')
  client(@Req() req: any) {
    return {
      ip: req.ip,
      ips: req.ips,
      xff: req.headers['x-forwarded-for'] || null,
      real: req.headers['x-real-ip'] || null,
    }
  }

  @Get('pool')
  poolStats() {
    // Заодно и память сторожа: доля запросов, обошедшихся без похода в базу.
    // Если она вдруг упадёт до нуля — значит где-то сбрасываем её слишком часто,
    // и вся система снова платит сто тридцать пять миллисекунд за каждый запрос.
    return { ...this.pool.stats(), accounts: this.accounts.stats() }
  }

  @Get()
  status() {
    return this.updater.status()
  }

  @Post('update')
  update() {
    return this.updater.updateAll()
  }
}
