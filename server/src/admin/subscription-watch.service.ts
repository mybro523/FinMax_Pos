import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AdminDbService } from './admin-db.service'
import { AccountCache } from './account-cache.service'
import { EventsGateway } from '../events/events.gateway'
import { subscriptionOf, subscriptionMessage, SubscriptionStatus } from './subscription'

// ── Подписка кончается сама, в назначенную секунду ──
//
// Владелец сервиса назначает момент вплоть до часа: «до 23.08 в 17:00». В 17:00
// работа обязана прекратиться — не «когда-нибудь в течение часа», а именно тогда.
// Иначе указывать время незачем.
//
// Поэтому здесь два механизма, и они дополняют друг друга:
//
//   · раз в час — общий обход. Он замечает всё, что изменилось само по себе
//     (наступил новый день, кончился пробный период), и заводит будильники;
//   · будильник — точный setTimeout на тех, у кого срок истекает в ближайший час.
//     Он и обрывает работу секунда в секунду.
//
// Одного обхода не хватило бы: он опоздал бы на час. Одних будильников — тоже:
// сервер перезапускается, а будильники живут в памяти, и после перезапуска их
// расставляет заново тот же обход.
//
// Будильник, сработав, ПЕРЕЧИТЫВАЕТ аптеку. За час до срока клиент вполне может
// заплатить, и отключать его тогда нельзя ни в коем случае.
const EVERY_MS = 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

@Injectable()
export class SubscriptionWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Subscription')
  private timer: NodeJS.Timeout | null = null
  // Что мы в прошлый раз видели у каждой аптеки. Только в памяти: после перезапуска
  // первый проход просто запомнит нынешнее, ничего не разослав, — и это правильно,
  // потому что устройства при переподключении спрашивают своё состояние сами.
  private seen = new Map<string, SubscriptionStatus>()
  // Будильники на точный момент отключения
  private readonly alarms = new Map<string, NodeJS.Timeout>()

  constructor(
    private admin: AdminDbService,
    private events: EventsGateway,
    private accounts: AccountCache,
  ) {}

  onModuleInit() {
    this.tick().catch((e) => this.log.error('первая сверка подписок не удалась: ' + (e?.message || e)))
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log.error('сверка подписок не удалась: ' + (e?.message || e)))
    }, EVERY_MS)
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
    for (const t of this.alarms.values()) clearTimeout(t)
    this.alarms.clear()
  }

  // Возвращает, сколько аптек сменили состояние
  async tick(now: Date = new Date()): Promise<number> {
    const list = await this.admin.pharmacy.findMany({
      select: { id: true, code: true, name: true, schemaName: true, paidUntil: true, trial: true, blocked: true },
    })

    // Аптеки могли и удалить — иначе память тихо росла бы вместе с забытыми кодами
    const alive = new Set(list.map((p) => p.id))
    for (const id of [...this.seen.keys()]) if (!alive.has(id)) this.seen.delete(id)
    for (const id of [...this.alarms.keys()]) if (!alive.has(id)) this.forget(id)

    let changed = 0
    for (const ph of list) {
      const view = subscriptionOf(ph, now)
      this.arm(ph.id, view.leftMs)

      const was = this.seen.get(ph.id)
      this.seen.set(ph.id, view.status)
      if (was === undefined || was === view.status) continue

      changed++
      this.log.log(`Аптека «${ph.code}»: подписка ${was} → ${view.status}`)

      if (view.status === 'expired') {
        // Срок вышел между обходами — например, пока сервер был выключен.
        // Отключаем сейчас же, а не ждём следующего часа.
        this.cutOff(ph, view.status, now)
      } else {
        this.events.subscriptionChanged(ph.schemaName, subscriptionMessage(view))
      }
      this.accounts.dropPharmacy(ph.id)
      // Владельцу сервиса это важнее всех: список «кому звонить сегодня»
      // пересобирается сам, без нажатия «Обновить»
      this.events.toService('pharmacies', { code: ph.code })
    }
    return changed
  }

  // ── Срок изменился прямо сейчас ──
  // Продлили, поправили руками, приостановили. Ждать следующего часа нельзя:
  // клиент только что заплатил и хочет работать, или наоборот — время назначено
  // на десять минут вперёд.
  async reschedule(pharmacyId: string) {
    const ph = await this.admin.pharmacy.findUnique({
      where: { id: pharmacyId },
      select: { id: true, paidUntil: true, trial: true, blocked: true },
    })
    if (!ph) return this.forget(pharmacyId)
    const view = subscriptionOf(ph)
    this.seen.set(ph.id, view.status)
    this.arm(ph.id, view.leftMs)
  }

  private forget(id: string) {
    const t = this.alarms.get(id)
    if (t) clearTimeout(t)
    this.alarms.delete(id)
    this.seen.delete(id)
  }

  // Завести будильник, если момент наступает в ближайший час
  private arm(id: string, leftMs: number) {
    const old = this.alarms.get(id)
    if (old) clearTimeout(old)
    this.alarms.delete(id)
    if (leftMs <= 0 || leftMs > HOUR) return

    // Полсекунды сверху: таймеры срабатывают «не раньше», и без запаса можно
    // проснуться за миллисекунду ДО срока — тогда аптека ещё считается оплаченной,
    // и отключение пришлось бы ждать следующего часа
    const t = setTimeout(() => {
      this.fire(id).catch((e) => this.log.error('отключение по сроку не удалось: ' + (e?.message || e)))
    }, leftMs + 500)
    t.unref?.()
    this.alarms.set(id, t)
  }

  // ── Будильник сработал ──
  private async fire(id: string) {
    this.alarms.delete(id)
    const ph = await this.admin.pharmacy.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, schemaName: true, paidUntil: true, trial: true, blocked: true },
    })
    if (!ph) return

    const view = subscriptionOf(ph)
    // За час клиент вполне мог заплатить — тогда тревога отменяется, а будильник
    // ставится на новый срок
    if (view.status !== 'expired') return this.arm(id, view.leftMs)

    this.seen.set(ph.id, view.status)
    this.cutOff(ph, view.status)
    this.accounts.dropPharmacy(ph.id)
    this.events.toService('pharmacies', { code: ph.code })
  }

  // Оборвать работу: сначала объяснение на весь экран, потом обрыв связи.
  // Наоборот нельзя — кассир увидел бы просто пропавший интернет.
  private cutOff(
    ph: { id: string; code: string; name: string; schemaName: string; paidUntil: Date; trial: boolean; blocked: boolean },
    status: SubscriptionStatus,
    now: Date = new Date(),
  ) {
    const view = subscriptionOf(ph, now)
    this.log.warn(`Аптека «${ph.code}»: срок вышел — работа остановлена (${status})`)
    this.events.suspendPharmacy(ph.schemaName, subscriptionMessage(view, ph.name))
  }
}
