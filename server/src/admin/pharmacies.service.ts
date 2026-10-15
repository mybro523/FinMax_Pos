import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/admin-client'
import { AdminDbService } from './admin-db.service'
import { TenantSchemaService } from './tenant-schema.service'
import { schemaNameFor } from '../common/db-url'
import { runInTenant } from '../prisma/tenant-context'
import { SeedService } from '../seed/seed.service'
import { CategoriesService } from '../categories/categories.service'
import { UsersService } from '../users/users.service'
import { TenantPool } from '../prisma/tenant-pool.service'
import { addMonths, extendFrom, offlineDaysOf } from './subscription'
import { TX } from '../common/tx'
import { PrismaService } from '../prisma/prisma.service'
import { AuthService } from '../auth/auth.service'
import { EventsGateway } from '../events/events.gateway'
import { AccountCache } from './account-cache.service'
import { SubscriptionWatchService } from './subscription-watch.service'

export interface NewPharmacy {
  code: string
  name: string
  ownerName?: string
  phone?: string
  city?: string
  note?: string
  trialDays?: number
  // Под каким логином войдёт владелец магазина. По умолчанию — код магазина: его всё
  // равно придётся продиктовать, и два разных слова запоминать незачем.
  ownerLogin?: string
  // Пароль можно задать, а можно не задавать — тогда он придумается и покажется
  // один раз. Хранить его негде: в базе лежит только отпечаток.
  ownerPassword?: string
  // Заполнить демонстрационными товарами и продажами — для показа программы
  demo?: boolean
}

export interface UpdatePharmacy {
  name?: string
  ownerName?: string
  phone?: string
  city?: string
  note?: string
  // Срок оплаты руками: исправить ошибку ввода, дать бесплатное продление
  // или, наоборот, закрыть сразу
  paidUntil?: string
  trial?: boolean
  // Сколько дней касса может работать без связи с сервером
  offlineDays?: number
}

export interface ExtendPharmacy {
  months?: number
  amount?: number | string
  method?: string
  note?: string
}

const DEFAULT_TRIAL_DAYS = 14

// Код магазина виден только владельцу сервиса, но он попадает в имя схемы, в журналы
// и в разговоры по телефону. Поэтому — латиница, цифры и дефис: набрать такое можно
// с любой клавиатуры и продиктовать без ошибок.
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

@Injectable()
export class PharmaciesService {
  private readonly log = new Logger('Pharmacies')

  constructor(
    private admin: AdminDbService,
    private schemas: TenantSchemaService,
    private seed: SeedService,
    private categories: CategoriesService,
    private users: UsersService,
    private pool: TenantPool,
    private prisma: PrismaService,
    private auth: AuthService,
    private events: EventsGateway,
    private accounts: AccountCache,
    private watch: SubscriptionWatchService,
  ) {}

  // ── Список для панели ──
  // К каждому магазину добавляем, сколько он принёс за всё время. Одной свёрткой
  // по платежам, а не запросом на каждый магазин: клиентов будут сотни, и триста
  // запросов ради трёхсот чисел — это секунды на пустом месте.
  async findAll() {
    const [rows, sums] = await Promise.all([
      this.admin.pharmacy.findMany({ orderBy: { createdAt: 'desc' } }),
      this.admin.payment.groupBy({ by: ['pharmacyId'], _sum: { amount: true } }),
    ])
    const paid = new Map(sums.map((s) => [s.pharmacyId, Number(s._sum.amount ?? 0)]))
    return rows.map((p) => ({ ...p, paid: paid.get(p.id) ?? 0 }))
  }

  // ── Все платежи сервиса за период ──
  // Нужны расшифровке в сводке: нажал «Доход за месяц» — увидел, кто и когда
  // заплатил. Список короткий по своей природе: даже у трёх сотен клиентов это
  // три сотни строк в месяц.
  allPayments(days = 31) {
    const from = new Date(Date.now() - Math.max(1, Math.min(400, days)) * 86400000)
    return this.admin.payment.findMany({
      where: { createdAt: { gte: from } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      include: { pharmacy: { select: { id: true, code: true, name: true } } },
    })
  }

  // ── Отметка о звонке ──
  // Продление начинается со звонка, а звонков за день бывает десяток. Без отметки
  // владелец сервиса звонит одному дважды, а другому не звонит вовсе.
  async markCalled(id: string, note: string) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id }, select: { id: true, code: true } })
    if (!ph) throw new NotFoundException('Магазин не найден')
    const updated = await this.admin.pharmacy.update({
      where: { id },
      data: { calledAt: new Date(), callNote: (note || '').trim().slice(0, 300) },
    })
    this.events.toService('pharmacies', { code: ph.code })
    return updated
  }

  async findByCode(code: string) {
    const p = await this.admin.pharmacy.findUnique({ where: { code: (code || '').trim().toLowerCase() } })
    if (!p) throw new NotFoundException('Магазин не найден')
    return p
  }

  // ── Завести новый магазин ──
  // Три шага: запись в панели, своя схема в базе, стартовая настройка внутри неё.
  // Каждый может не получиться, и незавершённое заведение хуже, чем несостоявшееся:
  // магазин числился бы клиентом, а войти в него было бы некуда. Поэтому при неудаче
  // убираем за собой — и схему, и запись.
  async create(dto: NewPharmacy) {
    const code = (dto.code || '').trim().toLowerCase()
    const name = (dto.name || '').trim()
    if (!CODE_RE.test(code)) {
      throw new BadRequestException(
        'Код магазина: латинские буквы, цифры и дефис, от 2 до 31 символа. Например: shifo или apteka-2',
      )
    }
    if (!name) throw new BadRequestException('Укажите название магазина')

    const schemaName = schemaNameFor(code)
    const trialDays = Math.max(1, Math.trunc(dto.trialDays ?? DEFAULT_TRIAL_DAYS))
    const paidUntil = new Date(Date.now() + trialDays * 86400000)

    let created
    try {
      created = await this.admin.pharmacy.create({
        data: {
          code,
          name,
          ownerName: (dto.ownerName || '').trim(),
          phone: (dto.phone || '').trim(),
          city: (dto.city || '').trim(),
          note: (dto.note || '').trim(),
          schemaName,
          paidUntil,
          trial: true,
        },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`Магазин с кодом «${code}» уже заведён`)
      }
      throw e
    }

    // Логин и пароль владельца. Пароль показывается один раз: в базе лежит только
    // отпечаток, и «посмотреть его потом» будет негде — можно лишь задать заново.
    const ownerLogin = (dto.ownerLogin || code).trim()
    const ownerPassword = dto.ownerPassword || randomBytes(4).toString('hex')

    try {
      await this.schemas.ensureSchema(schemaName)
      await this.schemas.migrate(schemaName)
      await this.bootstrap(schemaName, !!dto.demo)

      // Владелец магазина — тем же кодом, что и обычный сотрудник: запись в две базы
      // с бронью логина написана один раз, и второй её копии быть не должно
      await runInTenant(schemaName, () =>
        this.users.create({ name: ownerLogin, password: ownerPassword, role: 'founder' }, created.id),
      )

      const version = this.schemas.latestMigration()
      const ready = await this.admin.pharmacy.update({
        where: { id: created.id },
        data: { schemaVersion: version },
      })
      this.log.log(`Магазин «${name}» (${code}) заведён, схема ${schemaName}, пробный период ${trialDays} дн.`)
      // Панель обновит список сама — владельцу сервиса не надо жать «Обновить»
      this.events.toService('pharmacies', { code })
      // Пароль возвращаем отдельно от самого магазина: он не хранится и в списке
      // магазинов его больше не будет
      return { ...ready, ownerLogin, ownerPassword }
    } catch (e: any) {
      // Убираем за собой в обратном порядке. Ошибку уборки глотаем: показать надо
      // ту, из-за которой всё сорвалось, а не ту, что случилась при отступлении.
      this.log.error(`Магазин «${code}» завести не удалось, убираю за собой: ${e?.message || e}`)
      await this.schemas.dropSchema(schemaName).catch(() => {})
      await this.admin.pharmacy.delete({ where: { id: created.id } }).catch(() => {})
      throw e
    }
  }

  // ── Карточка магазина ──
  // Всё, что нужно знать о клиенте перед разговором с ним: контакты, подписка,
  // история оплат, кто у него работает и живой ли магазин вообще. Последнее видно
  // только заглянув в её схему — оттуда и берём.
  //
  // ── Почему всё сразу, а счётчики отдельно ──
  // Раньше карточка шла по базе лесенкой: сначала сам магазин, потом его оплаты,
  // потом заглядывала в схему магазина считать товары и чеки. Четыре похода подряд,
  // и каждый — сто тридцать пять миллисекунд. Экран показывал «Загрузка…» почти
  // секунду, а на остывшем подключении — две.
  //
  // Теперь всё, что лежит в панели, спрашивается разом, одним походом. А счётчики
  // из схемы магазина уехали в отдельный запрос: они самые дорогие и нужны меньше
  // всего — по ним смотрят, живой ли клиент, а не решают, что нажать.
  async detail(id: string) {
    const [ph, payments, accounts, audit] = await Promise.all([
      this.admin.pharmacy.findUnique({ where: { id } }),
      this.admin.payment.findMany({
        where: { pharmacyId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { byAccount: { select: { login: true } } },
      }),
      this.admin.account.findMany({
        where: { pharmacyId: id },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, login: true, role: true, active: true, createdAt: true },
      }),
      this.admin.auditLog.findMany({ where: { pharmacyId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ])
    if (!ph) throw new NotFoundException('Магазин не найден')

    return { ...ph, payments, accounts, audit }
  }

  // ── Живой ли магазин ──
  // Сколько товаров, сколько чеков и когда был последний. «Последний чек полгода
  // назад» говорит о клиенте больше, чем дата оплаты.
  //
  // Отдельным запросом, потому что это единственная часть карточки, за которой надо
  // идти в схему самого магазина. Если тот магазин давно не работал, подключение к нему
  // ещё и открывается заново — полторы секунды, которые держали бы весь экран.
  async usage(id: string) {
    const ph = await this.admin.pharmacy.findUnique({
      where: { id },
      select: { code: true, schemaName: true },
    })
    if (!ph) throw new NotFoundException('Магазин не найден')

    try {
      return await runInTenant(ph.schemaName, async () => {
        const [products, sales, last] = await Promise.all([
          this.prisma.product.count(),
          this.prisma.sale.count(),
          this.prisma.sale.findFirst({ orderBy: { date: 'desc' }, select: { date: true } }),
        ])
        return { products, sales, lastSale: last?.date.toISOString() ?? null }
      })
    } catch (e: any) {
      // Схема может быть недоступна (идёт обновление) — карточку это ронять не должно
      this.log.error(`«${ph.code}»: не удалось посчитать остатки — ${e?.message || e}`)
      return { products: null, sales: null, lastSale: null }
    }
  }

  // ── Правка карточки ──
  // Телефон меняется, название уточняется, а срок оплаты иногда надо поставить
  // руками: ошиблись при вводе, дали бесплатное продление или, наоборот, решили
  // закрыть сразу. Код и схему не трогаем никогда — на них завязаны данные.
  async update(id: string, dto: UpdatePharmacy, byAccountId?: string) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id } })
    if (!ph) throw new NotFoundException('Магазин не найден')

    const data: any = {}
    for (const key of ['name', 'ownerName', 'phone', 'city', 'note'] as const) {
      if (dto[key] !== undefined) data[key] = String(dto[key]).trim()
    }
    if (dto.name !== undefined && !data.name) throw new BadRequestException('Укажите название магазина')

    if (dto.paidUntil !== undefined) {
      const d = new Date(dto.paidUntil)
      if (isNaN(d.getTime())) throw new BadRequestException('Некорректная дата оплаты')
      data.paidUntil = d
      // Срок выставили руками — значит это уже не пробный период
      data.trial = false
    }
    if (dto.trial !== undefined) data.trial = !!dto.trial
    if (dto.offlineDays !== undefined) data.offlineDays = offlineDaysOf({ offlineDays: dto.offlineDays })

    const updated = await this.admin.pharmacy.update({ where: { id }, data })
    // Срок оплаты правят руками нечасто, но именно тогда касса и должна узнать:
    // либо ей вернули работу, либо закрыли — и то и другое сейчас, а не потом
    // Новое число дней без связи кассы узнают при ближайшем обмене — он и так идёт
    // каждые несколько минут; сбрасываем память сторожа, чтобы ответ был свежим
    if (dto.offlineDays !== undefined && data.offlineDays !== ph.offlineDays) {
      this.accounts.dropPharmacy(id)
      await this.log_(byAccountId, ph, 'set-offline-days', `работа без связи: ${data.offlineDays} дн. (было ${ph.offlineDays})`)
    }
    if (dto.paidUntil !== undefined || dto.trial !== undefined) {
      this.accounts.dropPharmacy(id)
      this.events.subscriptionChanged(ph.schemaName, 'Срок оплаты изменён')
      // Срок мог сдвинуться и вперёд, и назад — например, на десять минут вперёд.
      // Ждать следующего часа значило бы не выполнить обещанное время.
      this.watch.reschedule(id).catch(() => {})
    }
    this.events.toService('pharmacies', { code: ph.code })
    if (dto.paidUntil !== undefined) {
      await this.log_(byAccountId, ph, 'set-paid-until', `срок оплаты выставлен вручную: ${data.paidUntil.toISOString().slice(0, 10)}`)
    }
    return updated
  }

  // ── Войти под владельцем магазина ──
  // Половина поддержки — это «у меня не работает», и объяснять по телефону, куда
  // нажимать, дольше, чем посмотреть самому. Но заходить в чужой магазин — серьёзное
  // действие: там закупочные цены, выручка и долги клиентов.
  //
  // Поэтому три ограничения. Запись в журнал — навсегда. Пометка в самом токене,
  // и интерфейс показывает её крупно: это не «стать владельцем», а «смотреть его
  // глазами». И короткий срок: такой доступ нужен на десять минут, а не на месяц.
  async enter(id: string, byAccountId: string | undefined, hours = 2) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id } })
    if (!ph) throw new NotFoundException('Магазин не найден')
    if (ph.blocked) throw new BadRequestException('Магазин приостановлен — сначала возобновите работу')

    const owner = await this.admin.account.findFirst({
      where: { pharmacyId: id, role: 'founder', active: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!owner) throw new BadRequestException('У магазина нет действующего владельца — некем войти')

    const by = byAccountId
      ? await this.admin.account.findUnique({ where: { id: byAccountId }, select: { login: true } })
      : null

    const token = this.auth.sign({
      sub: owner.id,
      name: owner.login,
      role: owner.role,
      ph: ph.code,
      sch: ph.schemaName,
      imp: by?.login || 'служба поддержки',
      exp: Date.now() + hours * 3600_000,
    })

    await this.log_(byAccountId, ph, 'impersonate', `вход под владельцем «${owner.login}» на ${hours} ч.`)
    this.log.warn(`Вход под владельцем магазина «${ph.code}»: ${by?.login || 'неизвестно кто'}`)
    return { token, pharmacy: { code: ph.code, name: ph.name }, owner: owner.login, until: new Date(Date.now() + hours * 3600_000).toISOString() }
  }

  // Журнал действий по всему сервису — что и с каким магазином делали
  auditAll(limit = 200) {
    return this.admin.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: Math.min(1000, Math.max(1, limit)) })
  }

  // ── Продление подписки ──
  // Деньги принимаются вживую — наличными или переводом, — а здесь остаётся запись
  // о том, за что и на сколько продлили. Без журнала спор с клиентом о том, платил
  // он в марте или нет, решать нечем.
  async extend(id: string, dto: ExtendPharmacy, byAccountId?: string) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id } })
    if (!ph) throw new NotFoundException('Магазин не найден')

    const months = Math.max(1, Math.min(60, Math.trunc(dto.months ?? 1)))
    const paidUntil = addMonths(extendFrom(ph.paidUntil), months)

    // Срок и запись об оплате — вместе или никак: продлённая подписка без следа
    // в журнале превращается в спор с клиентом, а запись без продления — в его
    // законное возмущение
    const updated = await this.admin.$transaction(async (tx) => {
      // Оплатили — значит уже не проба
      const ph2 = await tx.pharmacy.update({ where: { id }, data: { paidUntil, trial: false } })
      await tx.payment.create({
        data: {
          pharmacyId: id,
          // Сумма строкой: через число деньги теряют копейки на ровном месте
          amount: String(dto.amount ?? 0),
          months,
          method: dto.method || 'cash',
          note: (dto.note || '').trim(),
          byAccountId: byAccountId ?? null,
          paidUntilAfter: paidUntil,
        },
      })
      return ph2
    }, TX)

    await this.log_(byAccountId, ph, 'extend', `продлено на ${months} мес. до ${paidUntil.toISOString().slice(0, 10)}`)
    this.log.log(`Магазин «${ph.code}» продлена на ${months} мес. — до ${paidUntil.toISOString().slice(0, 10)}`)

    // ── Клиент заплатил, и его касса должна узнать об этом сейчас ──
    // Иначе он позвонит второй раз со словами «всё равно не работает»: баннер
    // и запрет продажи держатся до перезагрузки страницы, а перезагружать её
    // никто не станет — программа открыта во вкладке весь день.
    // Подписка изменилась — сторож должен считать её новой сразу, иначе касса
    // ещё несколько секунд получала бы отказ, уже будучи оплаченной
    this.accounts.dropPharmacy(id)
    this.events.subscriptionChanged(ph.schemaName, 'Подписка продлена')
    this.events.toService('pharmacies', { code: ph.code })
    // Будильник на момент отключения переставляем сейчас же: клиент только что
    // заплатил, и старый будильник оборвал бы ему работу через минуту
    this.watch.reschedule(id).catch(() => {})
    return updated
  }

  // ── Приостановка ──
  // Обычный способ расстаться с клиентом или надавить на должника. Ничего не
  // стирает: данные ждут его возвращения, и включить обратно — одно нажатие.
  //
  // От оплаты не зависит намеренно. Приостановить могут и оплаченный магазин (нашлось
  // что-то помимо денег), а оплата приостановленной не снимает приостановку сама:
  // раз её ставили руками, руками пусть и снимают, осознанно.
  async setBlocked(id: string, blocked: boolean, byAccountId?: string) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id } })
    if (!ph) throw new NotFoundException('Магазин не найден')
    if (ph.blocked === blocked) return ph

    const updated = await this.admin.pharmacy.update({ where: { id }, data: { blocked } })
    await this.log_(byAccountId, ph, blocked ? 'block' : 'unblock', blocked ? 'работа приостановлена' : 'работа возобновлена')
    this.log.warn(`Магазин «${ph.code}»: ${blocked ? 'работа приостановлена' : 'работа возобновлена'}`)

    this.accounts.dropPharmacy(id)
    if (blocked) {
      // Сначала объяснение, потом обрыв. Наоборот нельзя: кассир увидел бы просто
      // пропавшую связь, решил, что виноват интернет, и упёрся бы в отказ посреди
      // продажи, так и не поняв причины.
      this.events.suspendPharmacy(
        ph.schemaName,
        'Работа магазина приостановлен. Обратитесь к поставщику программы.',
      )
    } else {
      this.events.subscriptionChanged(ph.schemaName, 'Работа возобновлена')
    }
    this.events.toService('pharmacies', { code: ph.code })
    return updated
  }

  // История оплат магазина — для сверки с клиентом
  payments(pharmacyId: string) {
    return this.admin.payment.findMany({
      where: { pharmacyId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { byAccount: { select: { login: true } } },
    })
  }

  // Запись в журнал действий. Не роняет саму операцию: не записался журнал —
  // неприятно, но продление всё равно состоялось, и откатывать его из-за этого хуже.
  private async log_(accountId: string | undefined, ph: { id: string; code: string }, action: string, detail: string) {
    try {
      const who = accountId ? await this.admin.account.findUnique({ where: { id: accountId }, select: { login: true } }) : null
      await this.admin.auditLog.create({
        data: {
          accountId: accountId ?? null,
          accountName: who?.login || '',
          pharmacyId: ph.id,
          pharmacyCode: ph.code,
          action,
          detail,
        },
      })
    } catch (e: any) {
      this.log.error('журнал действий не записан: ' + (e?.message || e))
    }
  }

  // ── Удаление магазина ──
  // Стирает схему со всем содержимым: товарами, продажами, долгами, историей.
  // Восстановить это можно только из резервной копии, а её делает сам владелец
  // магазина и хранит у себя — то есть у нас её может не быть вовсе.
  //
  // Поэтому здесь требуется набрать код магазина: перепутать строку в списке легко,
  // а набрать чужой код руками — уже нет. Обычный способ расстаться с клиентом
  // другой: приостановка. Она ничего не стирает, и данные ждут его возвращения.
  async remove(id: string, confirmCode: string, byAccountId?: string) {
    const ph = await this.admin.pharmacy.findUnique({ where: { id } })
    if (!ph) throw new NotFoundException('Магазин не найден')
    if ((confirmCode || '').trim().toLowerCase() !== ph.code) {
      throw new BadRequestException(`Удаление не подтверждено: наберите код магазина «${ph.code}»`)
    }

    // ── Запись в журнал ДО удаления ──
    // Самое разрушительное действие в системе не оставляло следа вовсе: продление
    // записывалось, приостановка записывалась, а стирание всех данных клиента — нет.
    // Обнаружилось это буквально так: пропал магазин, и ответить, кто и когда его
    // убрал, было нечем. Клиенту на вопрос «где мои данные» так не ответишь.
    //
    // Пишем заранее и с цифрами: после удаления считать будет уже негде, а «удалили
    // магазин с двумя тысячами чеков» и «удалили пустую» — разные разговоры.
    let scale = 'размер неизвестен'
    try {
      scale = await runInTenant(ph.schemaName, async () => {
        const [products, sales] = await Promise.all([this.prisma.product.count(), this.prisma.sale.count()])
        return `товаров ${products}, чеков ${sales}`
      })
    } catch {
      /* схема могла быть уже недоступна — удалению это не мешает */
    }
    await this.log_(byAccountId, ph, 'delete', `магазин удалён вместе со всеми данными (${scale})`)

    this.accounts.dropPharmacy(id)
    // Прощаемся с теми, кто ещё на связи: дальше их схемы просто не станет,
    // и молчаливый обрыв они приняли бы за поломку связи
    this.events.suspendPharmacy(ph.schemaName, 'Магазин удалён. Обратитесь к поставщику программы.')

    // Сначала отпускаем подключение: удалять схему, к которой открыт клиент,
    // Postgres не даст
    await this.pool.close(ph.schemaName)
    await this.schemas.dropSchema(ph.schemaName)
    // Учётные записи уходят вместе с магазином (onDelete: Cascade) — доступа не остаётся
    await this.admin.pharmacy.delete({ where: { id } })

    this.log.warn(`Магазин «${ph.name}» (${ph.code}) удалена вместе со схемой ${ph.schemaName}: ${scale}`)
    this.events.toService('pharmacies', { code: ph.code })
    return { ok: true }
  }

  // ── Стартовая настройка чистого магазина ──
  // Ровно то же, что сервер делал при первом запуске на пустой базе, — просто теперь
  // выполняется в схеме конкретного магазина. Отдельный запрет на вторую открытую смену
  // Prisma в схеме описать не умеет, поэтому индекс создаётся кодом; стартовые
  // категории нужны, чтобы приёмка сразу знала, у чего не спрашивать срок годности.
  private async bootstrap(schema: string, demo = false): Promise<void> {
    await runInTenant(schema, async () => {
      await this.seed.ensureOneOpenShift()
      await this.categories.ensureSeeded()
      // Показательный магазин: товары и продажи за десять дней, чтобы отчёты и
      // панель управления не выглядели пустыми на первом же показе
      if (demo) await this.seed.run(true)
    })
  }
}
