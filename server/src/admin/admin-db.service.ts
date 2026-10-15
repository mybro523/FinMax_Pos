import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/admin-client'
import { adminUrl } from '../common/db-url'

// ── Подключение к базе панели управления ──
// Отдельный клиент Prisma: набор таблиц здесь свой — магазина, учётные записи, оплаты.
// База при этом та же, отличается только схема, поэтому отдельной переменной
// окружения нет: адрес выводится из DATABASE_URL подстановкой схемы «admin».
//
// Почему не падаем при неудачном подключении. Пока панелью никто не пользуется,
// её недоступность не должна ронять магазин: касса работает со своей схемой и про
// панель ничего не знает. Поэтому здесь предупреждение в журнал, а не остановка
// сервера. Когда через панель пойдёт вход сотрудников, молчать станет невозможно
// и без того: вход просто перестанет работать, и это будет видно сразу.
@Injectable()
export class AdminDbService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AdminDb')

  constructor() {
    super({ datasourceUrl: adminUrl(process.env.DATABASE_URL || '') })
  }

  async onModuleInit() {
    try {
      await this.$connect()
      this.log.log('База панели управления на связи')
    } catch (e: any) {
      this.log.error('Нет связи с базой панели управления: ' + (e?.message || e))
    }
  }

  async onModuleDestroy() {
    await this.$disconnect().catch(() => {})
  }
}
