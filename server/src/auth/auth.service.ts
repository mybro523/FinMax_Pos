import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { AdminDbService } from '../admin/admin-db.service'
import { LoginThrottle } from './throttle'
import { AUTH_SECRET as SECRET } from '../common/config'
import { hashPassword, verifyPassword, passwordProblem, isOutdatedHash } from './password'
import { offlineDaysOf, subscriptionOf, subscriptionMessage } from '../admin/subscription'
import { permissionsOf } from './permissions'
import { AccountCache } from '../admin/account-cache.service'

// Неделя, а не месяц: украденный токен должен умирать быстро. Кассе без
// интернета недели хватает с запасом, а на сайте вход и так живёт только
// до закрытия вкладки (sessionStorage)
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000 // 7 дней

// ── Что лежит в токене ──
// Кроме самого сотрудника — аптека, которую он обслуживает: её код (для журналов
// и интерфейса) и схема с её данными. Схему кладём прямо сюда, чтобы на каждый
// запрос не ходить за ней в базу: токен подписан нами, подделать его нельзя, а
// схема у аптеки не меняется никогда.
export interface TokenPayload {
  sub: string // учётная запись
  name: string // логин
  role: string // founder | cashier | superadmin
  ph?: string // код аптеки (у владельца сервиса аптеки нет)
  sch?: string // схема с данными аптеки
  iat?: number
  // ── Вход под владельцем аптеки ──
  // Владелец сервиса иногда должен посмотреть на аптеку глазами её владельца:
  // половина поддержки — это «у меня не работает». Такой токен помечен и живёт
  // недолго: зайти в чужую аптеку — не то действие, которое должно длиться месяц.
  imp?: string // кто вошёл (логин владельца сервиса)
  exp?: number // до какого момента действует, если срок особый
}

@Injectable()
export class AuthService {
  // ── Счётчики неудачных входов ──
  // По логину — строго: пять промахов подряд, и вход к этому человеку закрыт.
  // Логин уникален на весь сервис, поэтому счёт по нему теперь и правда про одного
  // человека: раньше «admin» из разных аптек считался бы вместе.
  //
  // По адресу — намного мягче. В аптеке все устройства выходят в интернет через
  // один адрес, и строгий счёт по нему означал бы: кассир восемь раз промахнулся
  // мимо своего пароля — вход закрыт всей аптеке, включая владельца. Поэтому по
  // адресу ловим только машинный перебор, до которого живой человек не доберётся.
  // Два счётчика ловят разное, и оба строгие.
  //
  // По имени — подбор пароля к одному человеку сразу с многих устройств.
  // По устройству — подбор вперемешку по разным именам с одного места. Раньше
  // здесь стоял мягкий порог в тридцать попыток, и это была дыра: пять промахов
  // под одним логином закрывали вход только под ним, а под соседним можно было
  // пробовать дальше. Имена в системе угадываются легко — логин обычно совпадает
  // с кодом аптеки, — так что строгий порог обходился одной сменой буквы.
  //
  // Ступени (минута, пять, пятнадцать) — в самом счётчике, и они не случайны:
  // в аптеке все устройства выходят в сеть через один адрес, и четверть часа
  // за пять опечаток закрыла бы вход всей аптеке разом.
  private readonly byName = new LoginThrottle({ limit: 5 })
  private readonly byIp = new LoginThrottle({ limit: 5 })

  // ── Смена пароля — тоже вход ──
  // Она спрашивает текущий пароль, а значит её можно перебирать: укравший токен
  // подбирал бы пароль без всякого ограничения и в обход входа. Считаем отдельно
  // и строже: своих паролей человек не забывает по пять раз подряд.
  private readonly byChange = new LoginThrottle({ limit: 5, windowMs: 15 * 60_000, blockMs: 15 * 60_000 })

  constructor(private admin: AdminDbService, private accounts: AccountCache) {}

  // ── Пароли ──
  // Правила и хранение живут в password.ts, здесь только привычные имена:
  // ими пользуется половина проекта, и менять их вызовы незачем
  static hashPassword = hashPassword
  static verifyPassword = verifyPassword

  // ── Токен (HMAC-SHA256, без cookie/сессий) ──
  // iat можно задать явно: после смены пароля новый токен обязан быть «моложе»
  // отметки о смене, иначе guard отвергнет его сразу же
  sign(payload: TokenPayload, iat = Date.now()) {
    const body = Buffer.from(JSON.stringify({ ...payload, iat })).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
    return `${body}.${sig}`
  }
  verify(token: string): TokenPayload | null {
    if (!token) return null
    const [body, sig] = token.split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', SECRET).update(body).digest('base64url')
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload
      if (!p.iat || Date.now() - p.iat > TOKEN_TTL_MS) return null
      // Особый срок сильнее общего: у входа под владельцем он короткий
      if (p.exp && Date.now() > p.exp) return null
      return p
    } catch {
      return null
    }
  }

  // Что показать про вошедшего: себя, свою аптеку и состояние её подписки.
  // Подписку отдаём вместе с остальным, чтобы интерфейс мог предупредить заранее,
  // а не встретить кассира отказом посреди продажи.
  private view(acc: {
    id: string
    login: string
    role: string
    roleId?: string | null
    roleRef?: { id: string; name: string; permissions: string[] } | null
    pharmacy?: { code: string; name: string; paidUntil: Date; trial: boolean; blocked: boolean; offlineDays?: number } | null
  }) {
    const ph = acc.pharmacy
    const sub = ph ? subscriptionOf(ph) : null
    return {
      id: acc.id,
      name: acc.login,
      role: acc.role,
      // Роль и её права: по ним интерфейс прячет лишнее, а программа для Windows
      // проверяет действия и без связи
      roleId: acc.role === 'founder' ? 'owner' : acc.roleId ?? null,
      roleName: acc.role === 'founder' ? 'Владелец' : acc.roleRef?.name || 'Кассир',
      permissions: permissionsOf(acc),
      pharmacy: ph ? { code: ph.code, name: ph.name } : null,
      subscription: sub && {
        status: sub.status,
        daysLeft: sub.daysLeft,
        // Сколько осталось до точного момента отключения. Программа заводит по нему
        // свой отсчёт: сервер оборвёт связь сам, но экран должен успеть объяснить.
        leftMs: sub.leftMs,
        paidUntil: sub.paidUntil,
        canWrite: sub.canWrite,
        warn: sub.warn,
        message: subscriptionMessage(sub, ph!.name),
        // Сколько дней программа для Windows может работать без связи с сервером.
        // Сайту это число ни к чему: он без связи не работает вовсе
        offlineDays: offlineDaysOf(ph!),
      },
    }
  }

  // ── Вход ──
  // Логин и пароль, без кода аптеки: логин уникален на весь сервис, и по нему
  // система сама понимает, в какую аптеку пускать.
  async login(name: string, password: string, ip = '') {
    const login = (name || '').trim()
    const nameKey = login.toLowerCase()

    // Закрыто хотя бы одним счётчиком — значит закрыто
    const nameWait = this.byName.retryAfterMs(nameKey)
    const ipWait = ip ? this.byIp.retryAfterMs(ip) : 0
    const waitMs = Math.max(nameWait, ipWait)
    if (waitMs > 0) {
      // Говорим, что именно закрыто. Кассир, промахнувшийся под своим именем,
      // первым делом попробует соседнее — и должен сразу понять, что дело не
      // в имени, а в устройстве. Иначе он будет перебирать логины и злиться,
      // а от каждой попытки блокировка только растёт.
      const where = ipWait >= nameWait ? 'с этого устройства' : 'под этим именем'
      throw new HttpException(
        `Слишком много неудачных попыток. Вход ${where} закрыт на ${LoginThrottle.humanWait(waitMs)}`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const acc = await this.admin.account.findUnique({
      where: { login },
      include: { pharmacy: true, roleRef: true },
    })
    if (!acc || !acc.active || !(await AuthService.verifyPassword(password, acc.passwordHash))) {
      this.byName.fail(nameKey)
      if (ip) this.byIp.fail(ip)
      throw new UnauthorizedException('Неверное имя или пароль')
    }

    // Приостановленная аптека не работает вовсе. Говорим об этом прямо: кассир
    // должен понять, что дело не в его пароле, и позвонить владельцу, а не
    // перебирать буквы, пока вход не закроется совсем.
    if (acc.pharmacy?.blocked) {
      throw new UnauthorizedException('Работа аптеки приостановлена. Обратитесь к поставщику программы.')
    }

    // ── Срок вышел — внутрь не пускаем ──
    // Сказать «неверный пароль» здесь было бы враньём: пароль верный, и человек
    // будет набирать его снова, пока не упрётся в защиту от подбора. Говорим прямо,
    // что случилось и что данные целы, — иначе он решит, что потерял всю аптеку.
    if (acc.pharmacy) {
      const sub = subscriptionOf(acc.pharmacy)
      if (sub.status === 'expired') {
        throw new UnauthorizedException(subscriptionMessage(sub, acc.pharmacy.name))
      }
    }

    // Вошли — снимаем подозрения: кассир, который дважды опечатался, ничего не заметит.
    // Счётчик адреса тоже обнуляем: за этим адресом сидит своя же аптека.
    this.byName.success([nameKey])
    if (ip) this.byIp.success([ip])

    // Пароль верный, а отпечаток сделан по старым, более слабым правилам —
    // переписываем прямо сейчас. Человек ничего не заметит, а хранится его
    // пароль с этого момента надёжнее. Неудача здесь ничего не меняет:
    // войти он всё равно должен.
    if (isOutdatedHash(acc.passwordHash)) {
      AuthService.hashPassword(password)
        .then((passwordHash) => this.admin.account.update({ where: { id: acc.id }, data: { passwordHash } }))
        .catch(() => {})
    }

    const token = this.sign({
      sub: acc.id,
      name: acc.login,
      role: acc.role,
      ph: acc.pharmacy?.code,
      sch: acc.pharmacy?.schemaName,
    })
    return { token, user: this.view(acc) }
  }

  // «Кто я» — самый частый запрос после самих данных: программа спрашивает его при
  // запуске, при каждом возвращении на вкладку и после каждого изменения подписки.
  // Сторож минуту назад уже спросил то же самое у базы — второй раз незачем.
  async me(accountId: string, impersonatedBy?: string | null) {
    const acc = await this.accounts.get(accountId)
    if (!acc || !acc.active) throw new UnauthorizedException()
    return { ...this.view(acc), impersonatedBy: impersonatedBy || null }
  }

  async changePassword(accountId: string, oldPw: string, newPw: string) {
    const waitMs = this.byChange.retryAfterMs(accountId)
    if (waitMs > 0) {
      throw new HttpException(
        `Слишком много попыток. Попробуйте через ${LoginThrottle.humanWait(waitMs)}`,
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const acc = await this.admin.account.findUnique({
      where: { id: accountId },
      include: { pharmacy: true, roleRef: true },
    })
    if (!acc || !(await AuthService.verifyPassword(oldPw, acc.passwordHash))) {
      this.byChange.fail(accountId)
      throw new BadRequestException('Текущий пароль неверный')
    }
    this.byChange.success([accountId])

    const problem = passwordProblem(newPw)
    if (problem) throw new BadRequestException(problem)
    if (newPw === oldPw) throw new BadRequestException('Новый пароль совпадает со старым')

    // Момент смены отзывает все ранее выданные токены — в том числе тот, которым
    // прямо сейчас пользуется этот же человек. Поэтому сразу выдаём ему новый:
    // сменить свой пароль и вылететь из системы — плохая благодарность.
    const changedAt = new Date()
    await this.admin.account.update({
      where: { id: accountId },
      data: { passwordHash: await AuthService.hashPassword(newPw), passwordChangedAt: changedAt },
    })
    // Смена пароля отзывает прежние токены — сторож обязан узнать об этом сейчас,
    // а не через несколько секунд: иначе старый токен ещё немного поработал бы
    this.accounts.drop(accountId)
    const token = this.sign(
      {
        sub: acc.id,
        name: acc.login,
        role: acc.role,
        ph: acc.pharmacy?.code,
        sch: acc.pharmacy?.schemaName,
      },
      changedAt.getTime() + 1,
    )
    return { ok: true, token, user: this.view(acc) }
  }
}
