import { Logger, OnModuleDestroy } from '@nestjs/common'
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets'
import { Server, Socket } from 'socket.io'
import { AuthService } from '../auth/auth.service'
import { AdminDbService } from '../admin/admin-db.service'
import { currentTenantSchema } from '../prisma/tenant-context'
import { TenantPool } from '../prisma/tenant-pool.service'
import { ChangeStamp } from './change-stamp.service'

// ── Постоянная связь с устройствами ──
// Устройства держат соединение и узнают об изменениях сразу, а не через опрос.
// По сети идёт только НАЗВАНИЕ изменившегося раздела — сами данные устройство
// забирает обычным запросом. Так на экране всегда то же, что в базе: потерянное
// событие не оставит после себя выдуманную запись, а лишь отложит обновление.
//
// ── Две комнаты ──
// Аптека слышит только своё: комната по имени её схемы. Раньше сигнал уходил всем
// подключённым сразу — чужих данных это не открывало, но продажа в одной аптеке
// заставляла перезапрашивать данные все остальные.
//
// Владелец сервиса слышит своё: комната «service». Ему нужно другое — что аптеку
// завели, продлили, приостановили, и кто из клиентов сейчас за кассой.
//
// ── Что ходит по связи ──
//   changed      — раздел устарел, перезапроси (в аптеку)
//   subscription — состояние подписки изменилось, переспроси «кто я» (в аптеку)
//   suspended    — работа приостановлена, вот объяснение (в аптеку, перед обрывом)
//   service      — в панели что-то изменилось (владельцу сервиса)
//   presence     — кто из аптек сейчас на связи (владельцу сервиса)

const RECHECK_MS = 60_000
const SERVICE_ROOM = 'service'
// Между сообщением и обрывом связи нужен зазор: иначе объяснение не успевает уйти,
// и кассир видит просто пропавшую связь вместо понятной причины
const GOODBYE_MS = 400

interface Live {
  socket: Socket
  token: string
  iat: number
}

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : true },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly log = new Logger('Events')
  @WebSocketServer() server: Server

  // Кто сейчас на связи: сотрудник -> его открытые соединения (ПК кассы и телефон)
  private readonly live = new Map<string, Set<Live>>()
  // Сколько устройств у каждой аптеки — из этого складывается «кто сейчас работает»
  private readonly online = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private auth: AuthService,
    private admin: AdminDbService,
    private pool: TenantPool,
    private stamp: ChangeStamp,
  ) {
    this.timer = setInterval(() => {
      this.recheckAll().catch((e) => this.log.error('перепроверка соединений: ' + (e?.message || e)))
    }, RECHECK_MS)
    this.timer.unref?.()
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
  }

  // Подключение без действующего входа обрываем: раздел, который прислали,
  // сам по себе секрета не несёт, но и слушать его посторонним незачем
  async handleConnection(client: Socket) {
    const token = String(client.handshake?.auth?.token || client.handshake?.query?.token || '')
    const payload = this.auth.verify(token)
    if (!payload) return void client.disconnect(true)

    // Сверяемся с базой сразу: токен мог остаться от уволенного сотрудника
    if (!(await this.stillAllowed(payload.sub, payload.iat || 0))) return void client.disconnect(true)

    if (payload.sch) {
      client.join(payload.sch)
      client.data.schema = payload.sch
      // Поддержка, зашедшая под владельцем, за кассой не стоит. Иначе владелец
      // сервиса сам зажигал бы отметку «сейчас работают» — и по ней потом решал,
      // живой у него клиент или молчит вторую неделю.
      if (!payload.imp) {
        client.data.code = payload.ph || payload.sch
        client.data.warm = payload.sch
        this.markOnline(client.data.code, payload.sch, +1)
      }
      // Мы дошли до сюда — значит доступ действует и аптека не приостановлена.
      // Для того, у кого на экране висит объявление о приостановке, это и есть
      // разрешение работать дальше: он заплатил, пока смотрел на объявление.
      client.emit('resumed')
    } else {
      // Своей аптеки нет — это владелец сервиса
      client.join(SERVICE_ROOM)
      client.data.service = true
      // Сразу рассказываем, кто на связи: панель открылась и должна это увидеть,
      // не дожидаясь, пока кто-нибудь подключится или отключится
      client.emit('presence', { online: [...this.online.keys()] })
    }

    const entry: Live = { socket: client, token, iat: payload.iat || 0 }
    if (!this.live.has(payload.sub)) this.live.set(payload.sub, new Set())
    this.live.get(payload.sub)!.add(entry)
    client.data.userId = payload.sub
    client.data.entry = entry
  }

  handleDisconnect(client: Socket) {
    if (client.data?.code) this.markOnline(client.data.code, client.data.warm, -1)

    const userId = client.data?.userId
    const entry = client.data?.entry
    if (!userId || !entry) return
    const set = this.live.get(userId)
    if (!set) return
    set.delete(entry)
    if (set.size === 0) this.live.delete(userId)
  }

  // ── Кто сейчас работает ──
  // Считаем устройства, а не людей: у аптеки бывает ПК кассы и телефон, и уход
  // одного не означает, что аптека закрылась.
  private markOnline(code: string, schema: string | undefined, delta: number) {
    const was = this.online.get(code) || 0
    const now = was + delta
    if (now > 0) this.online.set(code, now)
    else this.online.delete(code)
    // Пока за кассой кто-то есть, подключение к её данным держим наготове:
    // первый покупатель после затишья не должен ждать пробуждения базы
    if (schema && (was === 0) !== (now === 0)) {
      if (now > 0) this.pool.keepWarm(schema)
      else this.pool.letCool(schema)
    }
    // Панель обновляем, только когда аптека появилась или пропала целиком:
    // переподключение телефона её дёргать не должно
    if ((was === 0) !== (now === 0)) this.toService('presence', { online: [...this.online.keys()] })
  }

  onlinePharmacies(): string[] {
    return [...this.online.keys()]
  }

  // Действует ли ещё доступ. Учётные записи живут в панели управления, там же
  // видно и состояние аптеки: приостановленная не должна оставаться на связи.
  private async stillAllowed(accountId: string, tokenIat: number): Promise<boolean> {
    const acc = await this.admin.account.findUnique({
      where: { id: accountId },
      select: { active: true, passwordChangedAt: true, pharmacy: { select: { blocked: true } } },
    })
    if (!acc || !acc.active) return false
    if (acc.passwordChangedAt && tokenIat < acc.passwordChangedAt.getTime()) return false
    if (acc.pharmacy?.blocked) return false
    return true
  }

  // Оборвать все соединения сотрудника — при блокировке, удалении и сбросе пароля
  dropUser(accountId: string, reason = 'доступ отозван') {
    const set = this.live.get(accountId)
    if (!set || set.size === 0) return
    this.log.log(`Соединения сотрудника оборваны (${reason}): ${set.size}`)
    for (const e of [...set]) e.socket.disconnect(true)
    this.live.delete(accountId)
  }

  // ── Приостановка аптеки ──
  // Сначала объяснение, потом обрыв. Наоборот нельзя: кассир увидел бы просто
  // пропавшую связь и решил, что виноват интернет, — а через минуту упёрся бы
  // в отказ посреди продажи, так и не поняв причины.
  suspendPharmacy(schema: string, message: string) {
    if (!this.server || !schema) return
    this.server.to(schema).emit('suspended', { message })
    setTimeout(() => {
      try {
        this.server.in(schema).disconnectSockets(true)
      } catch {
        /* соединений уже нет — тем лучше */
      }
    }, GOODBYE_MS).unref?.()
    this.log.log(`Аптека «${schema}»: соединения закрыты после приостановки`)
  }

  // Подписка изменилась: продлили, возобновили, поправили срок. Устройство
  // переспросит своё состояние само — баннер и кнопка продажи оживут без перезагрузки.
  subscriptionChanged(schema: string, note = '') {
    if (!this.server || !schema) return
    this.server.to(schema).emit('subscription', { note })
  }

  // ── Владельцу сервиса ──
  // what: 'pharmacies' — список изменился; 'activity' — в аптеке шла работа
  toService(what: string, payload: any = {}) {
    if (!this.server) return
    this.server.to(SERVICE_ROOM).emit(what === 'presence' ? 'presence' : 'service', { what, ...payload })
  }

  // Раз в минуту: истёкшие токены и отобранный доступ
  private async recheckAll() {
    for (const [accountId, set] of [...this.live]) {
      let allowed: boolean
      try {
        allowed = await this.stillAllowed(accountId, Math.min(...[...set].map((e) => e.iat)))
      } catch {
        continue // база недоступна — рвать связь из-за этого не будем
      }
      for (const e of [...set]) {
        // Токен мог просто истечь по сроку
        const alive = allowed && !!this.auth.verify(e.token)
        if (!alive) e.socket.disconnect(true)
      }
      if (!allowed) this.live.delete(accountId)
    }
  }

  // Вызывается после успешной записи в базу. Аптеку берём из контекста запроса —
  // того же, по которому запрос ходил в её схему.
  changed(...keys: string[]) {
    this.changedIn(currentTenantSchema(), ...keys)
  }

  // То же, но с явно указанной аптекой — для работы вне запроса: почасового
  // пересчёта просрочки и прочих обходов всех аптек подряд
  changedIn(schema: string | undefined, ...keys: string[]) {
    if (!schema) return
    if (!this.server) {
      // Соединений ещё нет — рассылать некому, но отметить изменение обязаны:
      // браузер спросит о нём обычным запросом
      this.stamp.bump(schema, [...new Set(keys.filter(Boolean))])
      return
    }
    const list = [...new Set(keys.filter(Boolean))]
    if (!list.length) return
    // Здесь же отмечаем, что раздел изменился: по этой отметке браузер узнаёт,
    // надо ли забирать список заново. Место одно на оба дела намеренно —
    // разъехаться оповещению и отметке негде.
    this.stamp.bump(schema, list)
    this.server.to(schema).emit('changed', list)
  }
}
