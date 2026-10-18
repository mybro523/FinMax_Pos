import { Injectable, Logger } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { AuthService } from '../auth/auth.service'
import { ConfigError, isProd, superadminPasswordProblem } from '../common/config'

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
    // Есть ли уже владелец сервиса. Если база недоступна — не роняем запуск из-за этого:
    // магазины важнее, а владелец заведётся, когда база ответит.
    let already = 0
    try {
      already = await this.admin.account.count({ where: { role: 'superadmin' } })
    } catch (e: any) {
      this.log.error('Не удалось проверить владельца сервиса: ' + (e?.message || e))
      return
    }
    if (already > 0) return

    // ── Заводим впервые — слабый пароль здесь недопустим ──
    // Под владельцем сервиса заводятся ВСЕ магазины и доступны все их данные. Раньше без
    // ADMIN_PASSWORD он заводился с паролем «admin»: на сервере это открытая дверь ко
    // всему. Теперь в проде сервер отказывается это делать — так же, как отказывается
    // стартовать без надёжного AUTH_SECRET. Упавший сервер заметят и починят, а
    // «admin/admin» простоял бы незамеченным. В разработке «admin» допустим: там нет ни
    // живых денег, ни интернета.
    const problem = superadminPasswordProblem()
    if (isProd() && problem) {
      throw new ConfigError(
        'Сервер не запущен — нельзя завести владельца сервиса с таким паролем:\n' +
          `  · ${problem}\n\n` +
          'Задайте надёжный ADMIN_PASSWORD на сервере и запустите снова.\n' +
          'Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"',
      )
    }

    const login = (process.env.ADMIN_NAME || 'admin').trim()
    const password = process.env.ADMIN_PASSWORD || 'admin'
    try {
      await this.admin.account.create({
        data: {
          login,
          role: 'superadmin',
          passwordHash: await AuthService.hashPassword(password),
          pharmacyId: null,
        },
      })

      // Пароль из окружения в журнал НЕ пишем — только стандартный admin/admin
      // (он бывает лишь в разработке и так известен всем)
      if (!process.env.ADMIN_PASSWORD) {
        this.log.warn(
          'Создан владелец сервиса: логин "admin" / пароль "admin" (только для разработки). ' +
            'На сервере задайте ADMIN_PASSWORD — под этим входом заводятся магазины.',
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
