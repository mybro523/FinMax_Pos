import { Injectable, Logger } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { AuthService } from '../auth/auth.service'

// ── Владелец сервиса ──
// Тот, кто продаёт программу магазинам. У него нет своего магазина: он заводит чужие,
// продлевает подписку и приостанавливает работу за неоплату.
//
// Заводится при первом запуске, когда учётных записей нет вовсе. Иначе получилась
// бы система, в которую нельзя войти: магазины заводит владелец сервиса, а завести
// его самого некому.
@Injectable()
export class AccountsService {
  private readonly log = new Logger('Accounts')

  constructor(private admin: AdminDbService) {}

  async ensureSuperadmin(): Promise<void> {
    try {
      const already = await this.admin.account.count({ where: { role: 'superadmin' } })
      if (already > 0) return

      const login = (process.env.ADMIN_NAME || 'admin').trim()
      const password = process.env.ADMIN_PASSWORD || 'admin'

      await this.admin.account.create({
        data: {
          login,
          role: 'superadmin',
          passwordHash: await AuthService.hashPassword(password),
          pharmacyId: null,
        },
      })

      // Пароль из окружения в журнал НЕ пишем — только стандартный admin/admin,
      // который и так известен всем
      if (!process.env.ADMIN_PASSWORD) {
        this.log.warn(
          'Создан владелец сервиса: логин "admin" / пароль "admin". Смените пароль сразу — под ним заводятся магазины.',
        )
      } else {
        this.log.log(`Создан владелец сервиса «${login}» — пароль из ADMIN_PASSWORD`)
      }
    } catch (e: any) {
      // Чаще всего это занятый логин: сотрудник какого-то магазина уже назвался так же.
      // Роняет сервер это зря — магазины продолжат работать, а владелец сервиса
      // заведётся под другим логином через ADMIN_NAME.
      this.log.error('Не удалось завести владельца сервиса: ' + (e?.message || e))
    }
  }
}
