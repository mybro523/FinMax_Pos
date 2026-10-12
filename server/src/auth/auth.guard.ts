import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthService } from './auth.service'
import { AccountCache } from '../admin/account-cache.service'
import { subscriptionOf, subscriptionMessage } from '../admin/subscription'
import { PERM_KEY, PUBLIC_KEY, ROLES_KEY, SERVICE_WIDE_KEY } from './decorators'
import { hasPerm, permissionsOf } from './permissions'

// Глобальный guard: все эндпоинты требуют валидный токен, кроме помеченных @Public().
// @Roles('founder') на методе/классе дополнительно ограничивает по роли.
//
// Учётная запись живёт в панели управления, а не в схеме аптеки. Поэтому проверка —
// один запрос к небольшой таблице, и вместе с сотрудником оттуда же приходит его
// аптека: активна ли, не приостановлена ли. Раньше за этим пришлось бы идти в две
// разные базы.
//
// Актуальность берём из базы на каждый запрос, а не из токена: блокировка сотрудника
// и приостановка аптеки должны отбирать доступ сразу, а не через тридцать дней, когда
// истечёт токен. Там же сверяем возраст токена со сменой пароля — если он утёк, сменить
// пароль было единственным разумным действием, а оно ничего не давало бы.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private auth: AuthService, private accounts: AccountCache) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])
    if (isPublic) return true

    const req = ctx.switchToHttp().getRequest()
    const header: string = req.headers['authorization'] || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const payload = this.auth.verify(token)
    if (!payload) throw new UnauthorizedException('Требуется вход в систему')

    // Ответ на несколько секунд остаётся в памяти. Раньше здесь был поход в базу
    // на каждый запрос — сто тридцать пять миллисекунд, которые платили все разделы
    // без исключения, включая те, что возвращают пустой список.
    // Подробности и причины сброса — в account-cache.service.ts.
    //
    // tenantUserId нужен документам: чек, возврат, списание и смена ссылаются
    // на сотрудника В СХЕМЕ АПТЕКИ, а не на учётную запись сервиса
    const acc = await this.accounts.get(payload.sub)
    if (!acc || !acc.active) throw new UnauthorizedException('Сессия недействительна')

    // Токен выдан до последней смены пароля — значит он от старого пароля
    if (acc.passwordChangedAt && (payload.iat || 0) < acc.passwordChangedAt.getTime()) {
      throw new UnauthorizedException('Пароль был изменён — войдите заново')
    }

    // Схема из токена обязана совпадать с тем, что записано у сотрудника сейчас.
    // Именно по ней подставлена схема для этого запроса (см. TenantContextMiddleware),
    // и разойтись они не должны ни при каких обстоятельствах: расхождение означало бы,
    // что запрос уже идёт не в ту аптеку.
    if ((payload.sch || '') !== (acc.pharmacy?.schemaName || '')) {
      throw new UnauthorizedException('Сессия недействительна — войдите заново')
    }

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()])
    // Разделы про саму учётную запись работают всегда: сменить пароль и узнать,
    // кто ты, должно быть можно и у аптеки с просроченной подпиской
    const serviceWide = this.reflector.getAllAndOverride<boolean>(SERVICE_WIDE_KEY, [ctx.getHandler(), ctx.getClass()])

    // ── Подписка ──
    // Отключение мягкое, в три ступени: предупреждение — отсрочка — только чтение.
    // Отрубать кассу разом за вчерашнюю просрочку нельзя: за ней стоит покупатель,
    // а владелец аптеки узнал бы о долге в самый неподходящий момент.
    if (acc.pharmacy) {
      const sub = subscriptionOf(acc.pharmacy)
      req.subscription = sub

      // ── Поддержка проходит всегда ──
      // Владелец сервиса, зашедший под клиентом, обязан попасть внутрь даже
      // к неплательщику: он для того и заходит — посмотреть, помочь, снять копию.
      // Отказать ему значило бы отобрать инструмент у того, кто чинит.
      const support = !!payload.imp

      if (!support && sub.status === 'suspended') {
        throw new ForbiddenException('Работа аптеки приостановлена. Обратитесь к поставщику программы.')
      }

      // ── Срок вышел — закрыто всё ──
      // Раньше здесь оставался просмотр: данные клиента, а не наши. Владелец
      // сервиса решил иначе, назначив точный момент отключения, и мягкость сделала
      // бы этот момент пустым обещанием. Данные при этом целы и ждут оплаты.
      if (!support && sub.status === 'expired') {
        throw new ForbiddenException(subscriptionMessage(sub, acc.pharmacy.name))
      }
    }

    // Учётная запись без аптеки — это владелец сервиса. В разделах самой аптеки ему
    // делать нечего: схемы у него нет, и запрос ушёл бы в схему по умолчанию, то есть
    // мимо всех аптек.
    //
    // Исключение помечено на самом разделе, а не выведено из роли. Сначала здесь
    // стояла проверка «пропускаем, если раздел требует роль superadmin» — и владелец
    // сервиса не мог спросить даже «кто я»: этот раздел нужен всем и никакой роли не
    // требует. Клиент опрашивает его при каждом запуске, так что вход срабатывал
    // и тут же отменялся.
    if (!acc.pharmacyId && !serviceWide) {
      throw new ForbiddenException('Этот раздел относится к аптеке, а учётная запись к аптеке не привязана')
    }

    // Два разных идентификатора, и путать их нельзя:
    //   sub          — учётная запись сервиса (панель: логин, пароль, доступ);
    //   tenantUserId — сотрудник в схеме аптеки, на него ссылаются чеки, смены,
    //                  возвраты и списания.
    // Живой сервер показал это сразу: подпись документа учётной записью роняла
    // продажу отказом «ссылка на несуществующую запись» — в схеме аптеки такой
    // строки нет и быть не может.
    req.user = {
      sub: acc.id,
      tenantUserId: acc.tenantUserId,
      // Кто вошёл под этим владельцем, если это поддержка, а не сам владелец.
      // Интерфейс обязан показать это крупно: смотреть чужую аптеку можно,
      // делать вид, что ты её хозяин, — нет.
      impersonatedBy: payload.imp || null,
      name: acc.login,
      role: acc.role,
      // Права из роли (владелец — все). По ним проверяются разделы и действия
      permissions: permissionsOf(acc),
      roleId: acc.role === 'founder' ? 'owner' : acc.roleId ?? null,
      roleName: acc.role === 'founder' ? 'Владелец' : acc.roleRef?.name || 'Кассир',
      pharmacyId: acc.pharmacyId,
      code: acc.pharmacy?.code,
      schema: acc.pharmacy?.schemaName,
    }
    if (roles && roles.length && !roles.includes(acc.role)) {
      throw new ForbiddenException('Недостаточно прав')
    }
    const perms = this.reflector.getAllAndOverride<string[]>(PERM_KEY, [ctx.getHandler(), ctx.getClass()])
    if (perms && perms.length && !hasPerm(req.user, ...perms)) {
      throw new ForbiddenException('Недостаточно прав для этого действия')
    }
    return true
  }
}
