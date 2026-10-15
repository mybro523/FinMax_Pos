// ── Кто отвечает на запрос окна ──
//
// Окно просит данные так же, как на сайте: «/products», «/sales». Здесь решается,
// откуда придёт ответ:
//   • всё, что касса умеет без интернета, — из локальной базы, всегда: и когда
//     связь есть, и когда её нет. Иначе обрыв посреди продажи менял бы поведение
//     кассы, а чек зависел бы от того, успел ли дойти запрос;
//   • вход и «кто я» — через сервер, пока он доступен, и по сохранённому, когда нет;
//   • остальное (товары, сотрудники, пересчёт, настройки) — только сервер.
//
// Модуль не знает про Electron: сеть, диск, шифрование и часы ему передают снаружи.
// Поэтому он целиком проверяется обычными тестами.
import { join } from 'node:path'
import { BUSY_MESSAGE } from './backup.mjs'
import {
  accountById,
  accountByLogin,
  checkVerifier,
  deviceIdOf,
  deviceKeyOf,
  dropVerifier,
  loginSucceeded,
  makeVerifier,
  offlineLogin,
  saveAccount,
  setSubscription,
  subscriptionOf,
  userView,
  hasPerm,
  permissionsOf,
} from './local/accounts.mjs'
import { matchLocal, pendingInPeriod } from './local/api.mjs'
import { confirmLicence, licenceOf, touchLicence } from './local/licence.mjs'
import { ApiError, getMeta, inTx, openDb, q, setMeta } from './local/db.mjs'
import { getDoc, putDoc } from './local/docs.mjs'
import { REJECTED_SALE } from './local/ops/return.mjs'
import {
  ackOp,
  clearAttempts,
  describeOp,
  dismissRejected,
  markAttempt,
  pendingCount,
  pendingOps,
  rejectedCount,
  rejectedOps,
  rejectOp,
  sentOps,
  touchedBy,
} from './local/outbox.mjs'
import { PHARMACY_SCHEMA } from './local/schema.mjs'
import { NO_OPEN_SHIFT } from './local/ops/expense.mjs'
import { myOpenShift } from './local/docs.mjs'
import { applyPull, tenantUserOf } from './local/snapshot.mjs'
import { checkRequest, createRemote, DESKTOP_TOKEN, isLinkFailure } from './net.mjs'
import { createSync } from './sync.mjs'

// Объяснения для человека. Каждое есть в словаре интерфейса (client/src/lib/i18n.js)
// и показывается на выбранном языке — их сверяет проверка.
export const MESSAGES = {
  needLogin: 'Требуется вход в систему',
  onlineOnly: 'Этот раздел работает только с интернетом. Касса, возвраты, приход и списание доступны и без него.',
  notSent: 'Эта запись ещё не отправлена на сервер. Изменить или удалить её можно будет после отправки.',
  // Внести расход можно и без связи, а править и удалять — только через сервер:
  // общее «раздел работает только с интернетом» здесь было бы неправдой
  expenseOnline: 'Изменить или удалить расход можно только с интернетом. Внести новый расход можно и без него.',
  expenseCatsOnline: 'Статьи расходов меняются только с интернетом.',
  supplierOnline: 'Заводить и менять поставщиков, платить им можно только с интернетом. Приход в долг известному поставщику оформляется и без него.',
  cashMoveOnline: 'Отменить внесение или изъятие можно только с интернетом. Внести и изъять наличные можно и без него.',
  payServicesOnline: 'Сервисы перевода меняются только с интернетом.',
  historyOnline: 'История движения товара открывается только с интернетом.',
  noOfflineLogin: 'Нет связи с сервером. Под этим именем на этом компьютере ещё не входили — первый вход возможен только с интернетом.',
  suspended: 'Работа магазина приостановлен. Обратитесь к поставщику программы.',
  broken: 'Программа не смогла выполнить действие. Повторите; если не поможет — перезапустите программу.',
  oldSale: 'Этот чек оформлен давно и на кассе не хранится. Возврат по нему возможен только с интернетом.',
  offlineLimit:
    'Программа слишком долго работала без связи с сервером. Подключите интернет — работа продолжится сразу после проверки подписки. Все чеки сохранены на этом компьютере.',
  offlineTitle: 'Нужна связь с сервером',
  // Файл базы испорчен, а убрать его и поднять копию не даёт другая программа
  dbBusy: BUSY_MESSAGE,
  rejectedSale: REJECTED_SALE,
}

// Записи, у которых есть действие «на сервере»: правка и удаление прихода, удаление
// клиента. Если запись сделана здесь и сервер её ещё не видел, идти к нему незачем
const SERVER_ONLY_ONE = [
  { re: /^\/arrivals\/([^/]+)$/, kind: 'arrival' },
  { re: /^\/customers\/([^/]+)$/, kind: 'customer' },
  { re: /^\/expenses\/([^/]+)$/, kind: 'expense' },
  { re: /^\/cash-moves\/([^/]+)$/, kind: 'cashmove' },
]

// Что сказать, когда связи нет, а действие умеет только сервер. Для большинства
// разделов годится общее объяснение; здесь — те, где оно ввело бы в заблуждение
const OFFLINE_TEXT = [
  { re: /^\/expenses\/[^/]+$/, text: 'expenseOnline' },
  { re: /^\/expense-categories(\/|$)/, text: 'expenseCatsOnline' },
  { re: /^\/suppliers(\/|$)/, text: 'supplierOnline' },
  { re: /^\/supplier-payments(\/|$)/, text: 'supplierOnline' },
  { re: /^\/cash-moves\/[^/]+$/, text: 'cashMoveOnline' },
  { re: /^\/pay-services(\/|$)/, text: 'payServicesOnline' },
  { re: /^\/products\/[^/]+\/history/, text: 'historyOnline' },
]
const offlineText = (route) => MESSAGES[OFFLINE_TEXT.find((x) => x.re.test(route))?.text || 'onlineOnly']

// Разделы, которые лежат в локальной базе и обновляются обменом (см. snapshot.mjs)
const LOCAL_SECTIONS = new Set([
  'products', 'categories', 'customers', 'deferred', 'shifts', 'sales', 'returns', 'arrivals', 'writeoffs', 'payments',
  'expenses', 'expenseCategories', 'suppliers', 'supplierPayments', 'cashMoves', 'payServices',
])

// Имя файла из кода магазина. Код приходит с сервера, но в путь на диске попадает
// только то, что безвредно в имени файла
const fileSafe = (code) => String(code).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'apteka'

export function createGateway({
  apiUrl,
  fetchImpl,
  session,
  core,
  // seal(text) → строка для хранения, open(строка) → text или null. Шифрование Windows
  cipher,
  clock,
  dataDir,
  // Событие для окна: «раздел изменился», «связь есть»
  emit = () => {},
  // Ключ входа сменился — постоянное соединение надо переоткрыть
  onSession = () => {},
  // Версия программы — сервер запоминает её у кассы
  appVersion = '',
  // Открыть файл базы магазина. Основная часть программы передаёт сюда открытие с
  // починкой из копии (backup.mjs): { db, restored }. По умолчанию — просто открыть
  openFile = (file) => ({ db: openDb(file, PHARMACY_SCHEMA), restored: null }),
  log = { info() {}, warn() {}, error() {} },
  timers,
}) {
  const deviceId = deviceIdOf(core)
  // Обмен называет серверу ключ кассы: под её номером сервер слушает только того,
  // кто назвал этот ключ (см. local/accounts.mjs)
  const asDevice = { 'X-Device-Key': deviceKeyOf(core) }
  const remote = createRemote({ apiUrl, fetchImpl, onDate: (d, age) => clock.serverTime(d, age) })

  // Открытая база магазина. Одна: на компьютере работает один магазин
  let pharmacy = null
  // Слушает ли окно события (после входа — да)
  let listening = false

  const httpDate = () => new Date(clock.now()).toUTCString()
  // У срока работы без связи и у подписки — своё время: оно не идёт за часами
  // компьютера, которым нельзя верить (см. local/clock.mjs). В зашифрованную отметку
  // пишется и оно, и «верное» время часов
  const licNow = () => (clock.lic ? clock.lic() : clock.now())
  const floorNow = () => (clock.floor ? clock.floor() : clock.now())
  const reply = (status, data) => ({ status, date: httpDate(), data })
  const refuse = (status, message, extra = {}) => ({ status, date: httpDate(), data: { statusCode: status, message }, ...extra })
  // «Связи нет» с объяснением: окно покажет его вместо общего «проверьте интернет»
  const offline = (message, timedOut = false) => ({ status: 0, date: null, data: { message }, timedOut })
  const send = (type, payload) => {
    if (listening) emit(type, payload)
  }

  const activeAccount = () => {
    const id = session.activeId()
    return id ? accountById(core, id) : null
  }

  // ── База магазина ──
  function closePharmacy() {
    if (!pharmacy) return
    pharmacy.sync.stop()
    try {
      pharmacy.db.close()
    } catch (e) {
      log.warn('локальная база не закрылась', e)
    }
    pharmacy = null
  }

  // Большой обмен (первая загрузка всего магазина) идёт дольше обычного запроса
  const SYNC_TIMEOUT_MS = 120000
  // Отправка — небольшая пачка, сервер принимает её за секунду-две. Ждать дольше
  // незачем: если сеть «зависла», кассир должен увидеть «нет интернета» скоро,
  // а не через две минуты. Пачка при этом не теряется — уйдёт следующей попыткой
  const PUSH_TIMEOUT_MS = 45000

  function openPharmacy(code) {
    if (pharmacy?.code === code) return pharmacy
    closePharmacy()
    const name = `pharmacy-${fileSafe(code)}.db`
    const { db, restored } = openFile(join(dataDir, name), name)
    // Файл базы оказался испорчен, и её подняли из копии (или начали заново, если
    // копии не было). Человек должен об этом узнать: сделанное после копии и не
    // ушедшее на сервер пропало
    if (restored) {
      setMeta(db, 'restored', JSON.stringify({ from: restored.at, at: clock.now() }))
      log.error(`база магазина ${code} была повреждена — ${restored.at ? 'поднята из копии' : 'начата заново'}`)
    }
    const ph = { code, name, db, users: new Map(), sync: null }
    // Чьим ключом ушла пачка — чтобы знать, чей вход отозван, если сервер откажет
    const sentAs = new Map()

    // Каким ключом отправить операцию. Обычно — ключом того, кто её сделал. Если его
    // ключа уже нет (сменили пароль, вышел срок), годится ключ владельца магазина,
    // входившего на этом компьютере: сервер принимает от владельца операции любого
    // сотрудника. Иначе операция ждёт — её автора или владельца.
    function tokenFor(op) {
      const author = op.accountId || session.activeId()
      const own = author ? session.tokenOf(author) : ''
      if (own) {
        sentAs.set(own, author)
        return own
      }
      for (const f of q(core, "SELECT id FROM accounts WHERE pharmacyCode = ? AND role = 'founder'").all(code)) {
        const t = session.tokenOf(f.id)
        if (t) {
          sentAs.set(t, f.id)
          return t
        }
      }
      return ''
    }

    // С какой отметки спрашивать изменения. Журнал списаний сервер отдаёт только
    // владельцу, и у него своя отметка (см. snapshot.mjs). Если её нет вовсе — касса
    // ни разу не получала списаний, и владелец получает всё заново, один раз
    // Широкие разделы (списания, расходы, долги поставщикам) получает не только
    // владелец, а всякий, кому они открыты правами
    const wideHere = () => hasPerm(activeAccount(), 'suppliers.view', 'writeoffs.view', 'expenses.view', 'reports.view', 'dashboard.view')
    function cursor() {
      if (wideHere() && !getMeta(db, 'wcursor')) return ''
      return getMeta(db, 'cursor') || ''
    }

    ph.sync = createSync({
      timers,
      log,
      tokenFor,
      store: {
        pendingOps: (n) => pendingOps(db, n),
        markAttempt: (ops) => markAttempt(db, ops, clock.now()),
        clearAttempts: (ops) => clearAttempts(db, ops),
        ack: (op, fate) => ackOp(db, op, fate),
        reject: (op, error) => {
          log.warn(`сервер отверг операцию ${op.type} ${op.id}: ${error}`)
          rejectOp(db, op, error)
          // Окно держит свои списки в памяти: отвергнутая смена, возврат, клиент
          // должны исчезнуть с экрана сейчас, а не при очередной сверке через минуту
          send('changed', touchedBy(op))
        },
        sentOps: (n) => sentOps(db, n),
        // Нужно всё заново (попросил человек или сервер что-то отверг): обмен не называет
        // отметку, пока полный ответ не ляжет в базу (см. sync.mjs)
        wantsFull: () => getMeta(db, 'needFull') === '1',
        cursor,
        // Ответ сервера — одной записью на диск. Сначала судьба операций, о которых
        // спрашивали: поправка принятой снимается (в данных сервера она уже есть),
        // отвергнутая снимается с учёта. Потом сами данные. Операция, которой в ответе
        // нет, сервером не принята: её поправка остаётся и ляжет поверх новых данных
        applyPull: (res, sent = []) =>
          inTx(db, () => {
            const fates = res.ops && typeof res.ops === 'object' ? res.ops : {}
            const stale = []
            for (const op of sent) {
              const fate = fates[op.id]
              if (fate?.status === 'ok') ackOp(db, op, fate)
              else if (fate?.status === 'rejected') {
                log.warn(`сервер отверг операцию ${op.type} ${op.id}: ${fate.error}`)
                rejectOp(db, op, fate.error)
                stale.push(...touchedBy(op))
              }
            }
            const changed = applyPull(db, res, { now: clock.now() })
            // Сервер отдал магазин целиком — просьба «нужно всё заново» выполнена. Отказ,
            // пришедший в этом же ответе, сюда входит: данные сняты с того же состояния
            if (res.full) setMeta(db, 'needFull', '0')
            return [...new Set([...changed, ...stale])]
          }),
      },
      push: (ops, token) =>
        remote(
          {
            method: 'POST',
            path: '/sync/push',
            timeoutMs: PUSH_TIMEOUT_MS,
            headers: asDevice,
            body: {
              deviceId,
              appVersion,
              ops: ops.map((o) => ({ id: o.id, type: o.type, accountId: o.accountId || undefined, createdAt: o.createdAt, payload: o.payload })),
            },
          },
          token,
        ),
      pull: async (since, asked = []) => {
        const token = session.get()
        // Вошли без интернета, а ключа от прошлого входа нет. Забрать данные нечем;
        // но если сервер уже доступен — просим войти заново, теперь через него
        if (!token) {
          const probe = await remote({ method: 'GET', path: '/health', timeoutMs: 10000 })
          return probe.status === 200 && !probe.foreign ? { status: 401, data: { message: MESSAGES.needLogin } } : { status: 0 }
        }
        const query = new URLSearchParams({
          deviceId,
          ...(appVersion ? { appVersion } : {}),
          ...(since ? { cursor: since } : {}),
          // Списания, изменившиеся, пока за кассой работал кассир
          ...(since && wideHere() ? { wcursor: getMeta(db, 'wcursor') } : {}),
          // Операции, на которые не пришёл ответ: приняты ли они?
          ...(asked.length ? { ops: asked.join(',') } : {}),
        })
        return remote({ method: 'GET', path: '/sync/pull?' + query, timeoutMs: SYNC_TIMEOUT_MS, headers: asDevice }, token)
      },
      onChanged: (keys) => send('changed', keys),
      onDenied: (res, token) => {
        const id = token ? sentAs.get(token) : session.activeId()
        const acc = id ? accountById(core, id) : null
        const working = !!id && id === session.activeId()
        if (acc) denied(acc, res)
        // Учётной записи на этом компьютере уже нет (сотрудника удалили и завели заново
        // под тем же именем), а ключ от неё остался. Сервер его не принимает — выбрасываем:
        // иначе операции этого сотрудника вечно уходили бы негодным ключом, а за ними
        // стояла бы вся очередь. Без ключа автора их отправит владелец
        else if (id && res.status === 401) session.drop(id)
        // Отказано не тому, кто за кассой (его ключом шли чужие операции), и дело
        // в ключе, а не в подписке — обмен продолжится другим ключом
        return !working && res.status === 401 ? 'retry' : 'stop'
      },
      // Каждый обмен — это и проверка подписки: сервер сообщает, кто за кассой,
      // что с оплатой и под каким номером записывать документы этого сотрудника
      onPulled: (data) => {
        if (data.me?.id && data.me.pharmacy?.code) {
          remember(data.me)
          if (data.me.tenantUserId) q(core, 'UPDATE accounts SET tenantUserId = ? WHERE id = ?').run(data.me.tenantUserId, data.me.id)
        }
        ph.users.clear()
      },
      onState: () => send('status', status()),
    })
    pharmacy = ph
    return ph
  }

  // ── Что сейчас с обменом ──
  // Кассир должен видеть, что всё сохранено: есть ли связь, идёт ли обмен, сколько
  // операций ждут отправки и не отверг ли сервер какую-нибудь из них
  function status() {
    const acc = activeAccount()
    if (!pharmacy || !acc) return { online: false, syncing: false, pending: 0, rejected: 0, blocked: false, refused: '', syncedAt: null, licence: null }
    const st = pharmacy.sync.state()
    const lic = licence(acc)
    return {
      online: st.online === true,
      // Первый обмен после запуска ещё идёт: есть ли связь, пока неизвестно. Сказать
      // в эту секунду «нет интернета» было бы враньём
      checking: st.online === null,
      syncing: !!st.syncing,
      // Операции есть, а отправить их нечем: нужен вход их автора или владельца
      blocked: !!st.blocked,
      // Сервер на связи, но операции не принимает (не та версия программы или сервера)
      refused: st.refused || '',
      pending: pendingCount(pharmacy.db),
      rejected: rejectedCount(pharmacy.db),
      syncedAt: getMeta(pharmacy.db, 'syncedAt'),
      // Сколько программе осталось работать без связи с сервером
      licence: { checkedAt: lic.checkedAt, offlineDays: lic.offlineDays, until: lic.until, leftMs: lic.leftMs, warn: lic.warn, expired: lic.expired },
      restored: restoredNote(pharmacy.db),
    }
  }

  // Базу недавно поднимали из копии — напоминаем об этом неделю
  const RESTORED_SHOW_MS = 7 * 86400000
  function restoredNote(db) {
    try {
      const r = JSON.parse(getMeta(db, 'restored') || 'null')
      if (!r || !Number.isFinite(r.at) || clock.now() - r.at > RESTORED_SHOW_MS) return null
      return { at: new Date(r.at).toISOString(), from: Number.isFinite(r.from) ? new Date(r.from).toISOString() : null }
    } catch {
      return null
    }
  }

  // Каким сотрудником магазина подписывать документы (см. snapshot.mjs)
  function docUser(ph, acc) {
    if (!ph.users.has(acc.login)) {
      // Номер сообщает сервер при обмене. Запасной путь — посмотреть в документах,
      // которые этот человек уже оформлял
      let id = accountById(core, acc.id)?.tenantUserId || getMeta(ph.db, 'tenantUser:' + acc.login)
      if (!id) {
        id = tenantUserOf(ph.db, acc.login)
        if (id) setMeta(ph.db, 'tenantUser:' + acc.login, id)
      }
      ph.users.set(acc.login, id || null)
    }
    return { accountId: acc.id, id: ph.users.get(acc.login) || 'acc:' + acc.id, name: acc.login, role: acc.role }
  }

  // ── Сервер отказал ──
  // 401 — ключ входа больше не действует. Просто вышел срок ключа — это одно: пароль
  // прежний, и без интернета под ним входить можно. Всё остальное (сменили пароль,
  // закрыли учётную запись) отзывает и вход без интернета.
  function denied(acc, res) {
    if (res.status === 401) {
      const working = session.activeId() === acc.id
      session.drop(acc.id)
      if (res.data?.message !== MESSAGES.needLogin) dropVerifier(core, acc.id)
      // Отозван вход того, кто сейчас за кассой, — обмен ждёт нового входа. Если же
      // отозван ключ другого сотрудника (его операции ждали отправки), работа и обмен
      // продолжаются: его операции уйдут ключом владельца
      if (working) {
        pharmacy?.sync.stop()
        onSession()
      }
      return
    }
    if (res.status === 403) {
      // Сервер закрыл работу магазина. Запоминаем, чтобы и без связи касса не работала
      const text = String(res.data?.message || '')
      if (/приостановлен/i.test(text)) setSubscription(core, acc.pharmacyCode, { status: 'suspended' })
      else if (/Подписка закончилась/.test(text)) setSubscription(core, acc.pharmacyCode, { status: 'expired' })
    }
  }

  // Что сервер сказал о сотруднике и его магазине — запомнить для работы без связи
  function remember(user, extra = {}) {
    const acc = saveAccount(core, user, { now: clock.now(), ...extra })
    if (acc && user.subscription) {
      setSubscription(core, acc.pharmacyCode, { status: user.subscription.status, paidUntil: user.subscription.paidUntil })
      // Сервер ответил про подписку — это и есть проверка: срок работы без связи
      // отсчитывается заново
      confirmLicence(core, acc.pharmacyCode, { now: clock.now(), days: user.subscription.offlineDays }, sealing)
      watchLicence()
    }
    return acc ? accountById(core, acc.id) : null
  }

  // ── Можно ли работать ──
  // Подписка по словам сервера — и срок, который программа вправе проработать без
  // его слова. Вышел любой из двух — работа закрыта
  const licence = (acc) => licenceOf(core, acc.pharmacyCode, licNow(), sealing)

  function access(acc) {
    const sub = subscriptionOf(acc, licNow())
    if (sub && !sub.canWrite) return sub
    if (!licence(acc).expired) return sub
    return { ...(sub || {}), status: 'offline', canWrite: false, warn: true, message: MESSAGES.offlineLimit }
  }

  // Срок без связи вышел прямо сейчас, посреди смены — кассир должен увидеть причину,
  // а не упереться в отказ на оплате. Проверка прошла — объявление снимается само
  let closedByLicence = false
  function watchLicence() {
    const acc = activeAccount()
    if (!acc) {
      closedByLicence = false
      return
    }
    const sub = subscriptionOf(acc, licNow())
    const expired = (!sub || sub.canWrite) && licence(acc).expired
    if (expired && !closedByLicence) send('suspended', { message: MESSAGES.offlineLimit, title: MESSAGES.offlineTitle })
    if (!expired && closedByLicence) send('resumed')
    closedByLicence = expired
  }

  const seal = (text) => {
    try {
      return cipher.seal(text)
    } catch {
      return null
    }
  }
  const open = (stored) => {
    try {
      return cipher.open(stored)
    } catch {
      return null
    }
  }
  const sealing = { seal, open }

  // ── Вход ──
  async function login(req) {
    const name = String(req.body?.name ?? '')
    const password = String(req.body?.password ?? '')
    const res = await remote(req)

    // Сервер не ответил или ответил бедой по дороге — проверяем пароль сами
    if (isLinkFailure(res)) {
      try {
        // Счёт неудачных попыток и срок подписки — по времени срока: за часами компьютера,
        // которым нельзя верить, оно не идёт, и переводом даты запрет на вход не снять
        const acc = await offlineLogin(core, { name, password }, { now: licNow(), open })
        // Пароль верный, но программа слишком давно не сверялась с сервером
        if (licence(acc).expired) return refuse(401, MESSAGES.offlineLimit)
        session.activate(acc.id)
        onSession()
        enter(acc)
        log.info(`вход без связи: ${acc.login}`)
        return reply(201, { token: DESKTOP_TOKEN, user: userView(acc, licNow()) })
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        // Человека на этом компьютере не знают — отвечаем как «нет связи», но с объяснением
        if (e.status === 503) return offline(MESSAGES.noOfflineLogin, !!res.timedOut)
        return refuse(e.status, e.message)
      }
    }

    const user = res.data?.user
    if (res.status >= 200 && res.status < 300 && typeof res.data?.token === 'string' && res.data.token && user?.id) {
      // Владелец сервиса в программу не входит: она для магазина. Его ключ не храним —
      // окно само покажет объяснение (client/src/db/auth.js)
      if (user.role === 'superadmin' || !user.pharmacy?.code) {
        return { ...res, data: { ...res.data, token: DESKTOP_TOKEN } }
      }
      const verifier = seal(await makeVerifier(password))
      const acc = remember(user, { verifier })
      loginSucceeded(core, name)
      session.setToken(user.id, res.data.token)
      session.activate(user.id)
      onSession()
      if (acc) enter(acc)
      // Настоящий ключ в окно не уходит — только пометка «вход выполнен»
      return { ...res, data: { ...res.data, token: DESKTOP_TOKEN } }
    }

    // Сервер отказал. Если на этом компьютере под этим именем раньше входили ИМЕННО
    // с этим паролем — значит, сервер больше его не принимает: пароль сменили или
    // вход закрыли. Вход без интернета закрываем тоже.
    if (res.status === 401) {
      const acc = accountByLogin(core, name.trim())
      const verifier = acc?.verifier ? open(acc.verifier) : null
      if (verifier && (await checkVerifier(password, verifier))) {
        dropVerifier(core, acc.id)
        denied(acc, { status: 403, data: res.data })
      }
    }
    return res
  }

  // ── «Кто я» ──
  // Окно спрашивает это при запуске и при каждом возвращении к нему. Отказом здесь
  // считается только слово самого сервера: 401 и 403. Сервер недоступен или отвечает
  // ошибкой — отвечаем по сохранённому, и человек продолжает работать.
  async function me(req, acc) {
    const token = session.tokenOf(acc.id)
    if (token) {
      const res = await remote(req, token)
      if (res.status === 200 && res.data?.id) {
        remember(res.data)
        return res
      }
      if (res.status === 401 || res.status === 403) {
        denied(acc, res)
        return res
      }
    }
    const fresh = accountById(core, acc.id)
    const view = { ...userView(fresh, licNow()), subscription: access(fresh) }
    const blocked = closedBySubscription(view.subscription)
    return blocked || reply(200, view)
  }

  // Подписка закончилась или работа приостановлена — отказ теми же словами, что у сервера
  function closedBySubscription(sub) {
    if (!sub || sub.canWrite) return null
    return refuse(403, sub.status === 'suspended' ? MESSAGES.suspended : sub.message)
  }

  // ── Смена пароля ──
  // Только через сервер. Новый ключ прячем, отпечаток для входа без интернета
  // пересчитываем: иначе без связи действовал бы старый пароль.
  async function changePassword(req, acc) {
    const token = session.tokenOf(acc.id)
    if (!token) return offline(MESSAGES.onlineOnly)
    const res = await remote(req, token)
    if (!res.status || res.foreign) return offline(MESSAGES.onlineOnly, !!res.timedOut)
    if (res.status === 401) denied(acc, res)
    if (res.status >= 200 && res.status < 300 && typeof res.data?.token === 'string' && res.data.token) {
      session.setToken(acc.id, res.data.token)
      const verifier = seal(await makeVerifier(String(req.body?.newPassword ?? '')))
      q(core, 'UPDATE accounts SET verifier = ? WHERE id = ?').run(verifier, acc.id)
      onSession()
      return { ...res, data: { ...res.data, token: DESKTOP_TOKEN } }
    }
    return res
  }

  // ── Готова ли локальная база ──
  // До первой полной загрузки отвечать нечем: каталог пуст. Ждём идущий обмен
  // с сервером; не вышло — честно говорим, что связи нет.
  const loaded = (ph) => getMeta(ph.db, 'loaded') === '1'

  async function ready(ph) {
    if (loaded(ph)) return true
    await (ph.sync.current() || ph.sync.run())
    return loaded(ph)
  }

  // ── Возврат по чеку, которого на кассе нет ──
  // Касса хранит чеки за два месяца. Товар могут принести и позже: такой чек окно
  // находит через сервер (отчёт за давний период). Касса забирает с сервера сам чек
  // и прежние возвраты по нему — и оформляет возврат у себя, как любой другой: в своей
  // смене и из своего денежного ящика. (Оформи его сервер, деньги, выданные из ящика
  // этой кассы, в её смену не попали бы — и касса вечером не сошлась бы.)
  // Возвращает ответ для окна, если чек взять не удалось; пусто — можно продолжать.
  async function fetchOldSale(ph, acc, saleId) {
    const token = session.tokenOf(acc.id)
    const res = token ? await remote({ method: 'GET', path: '/sync/sale/' + encodeURIComponent(saleId), timeoutMs: 20000 }, token) : { status: 0 }
    if (isLinkFailure(res)) return offline(MESSAGES.oldSale, !!res.timedOut)
    if (res.status === 401 || res.status === 403) {
      denied(acc, res)
      return res
    }
    // Такого чека нет и на сервере — локальная операция так и ответит: «Чек не найден»
    if (res.status === 404) return null
    if (res.status !== 200 || typeof res.data?.sale?.id !== 'string') return res
    inTx(ph.db, () => {
      putDoc(ph.db, 'sale', res.data.sale, { sync: 'synced' })
      const mine = q(ph.db, "SELECT 1 FROM docs WHERE kind = 'return' AND id = ? AND sync <> 'synced'")
      for (const r of Array.isArray(res.data.returns) ? res.data.returns : []) {
        // Свой возврат, который сервер ещё не подтвердил, его копией не заменяем
        if (typeof r?.id === 'string' && !mine.get(r.id)) putDoc(ph.db, 'return', r, { sync: 'synced' })
      }
    })
    return null
  }

  // ── Запрос к локальной базе ──
  async function local(found, req, acc) {
    const closed = closedBySubscription(access(acc))
    if (closed) return closed

    const ph = openPharmacy(acc.pharmacyCode)
    if (!(await ready(ph))) return { status: 0, date: null, data: null, timedOut: false }

    if (req.method === 'POST' && req.path.split('?')[0] === '/returns') {
      const saleId = req.body?.saleId
      if (typeof saleId === 'string' && saleId && !q(ph.db, "SELECT 1 FROM docs WHERE kind = 'sale' AND id = ?").get(saleId)) {
        const failed = await fetchOldSale(ph, acc, saleId)
        if (failed) return failed
      }
    }

    let data
    try {
      data = found.handler({
        db: ph.db,
        now: clock.now(),
        // Права — из учётной записи: в документы попадают только номер и имя
        user: { ...docUser(ph, acc), permissions: permissionsOf(acc) },
        deviceId,
        query: found.query,
        params: found.params,
        body: req.body,
      })
    } catch (e) {
      if (e instanceof ApiError) return refuse(e.status, e.messages || e.message)
      log.error(`локальный запрос ${req.method} ${req.path.split('?')[0]} не выполнен`, e)
      return refuse(500, MESSAGES.broken)
    }

    // Период глубже того, что хранится на компьютере, — за ним идём на сервер,
    // а своё неотправленное добавляем сами: сервер о нём ещё не знает
    if (data && data.__deep) return deep(req, acc, ph, data.__deep)
    if (req.method !== 'GET') {
      // Записано на диск — теперь это надо отправить. Не дожидаясь ответа сервера:
      // кассир уже может пробивать следующий чек
      ph.sync.kick()
      send('status', status())
    }
    return reply(req.method === 'POST' ? 201 : 200, data)
  }

  async function deep(req, acc, ph, period) {
    const token = session.tokenOf(acc.id)
    const res = token ? await remote(req, token) : { status: 0, date: null, data: null }
    if (res.status === 401) denied(acc, res)
    if (res.foreign) return { status: 0, date: null, data: null, timedOut: false }
    if (res.status !== 200 || !Array.isArray(res.data)) return res
    const mine = pendingInPeriod(ph.db, period.kind, period)
    if (!mine.length) return res
    const have = new Set(res.data.map((d) => d?.id))
    const dateOf = (d) => d.date || d.createdAt || ''
    const data = [...res.data, ...mine.filter((d) => !have.has(d.id))].sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0))
    return { ...res, data }
  }

  // ── Запрос, на который умеет ответить только сервер ──
  async function online(req, acc) {
    const route = req.path.split('?')[0]

    // Запись сделана здесь и на сервер ещё не ушла — он о ней не знает
    if (pharmacy) {
      for (const { re, kind } of SERVER_ONLY_ONE) {
        const m = route.match(re)
        if (!m) continue
        const id = decodeURIComponent(m[1])
        const mine =
          kind === 'customer'
            ? q(pharmacy.db, 'SELECT 1 FROM customers WHERE id = ? AND local = 1').get(id)
            : q(pharmacy.db, "SELECT 1 FROM docs WHERE kind = ? AND id = ? AND sync <> 'synced'").get(kind, id)
        if (mine) return refuse(409, MESSAGES.notSent)
      }
    }

    const token = session.tokenOf(acc.id)
    if (!token) return offline(offlineText(route))

    // Оплата поставщику из кассы: деньги взяты из ящика ЭТОЙ кассы, и смену сервер
    // должен знать по имени — окно её не называет. Сначала уходит всё, что касса
    // ещё не отправила (сама смена могла быть открыта без связи), затем оплата
    if (pharmacy && /^\/suppliers\/[^/]+\/pay$/.test(route) && req.method === 'POST' && req.body?.fromCash === true && !req.body.shiftId) {
      await pharmacy.sync.run().catch(() => {})
      const open = myOpenShift(pharmacy.db, deviceId)
      if (!open) return refuse(400, NO_OPEN_SHIFT)
      req = { ...req, body: { ...req.body, shiftId: open.body.id } }
    }
    const res = await remote(req, token)
    // Связи нет или ответил не наш сервер. Настоящую ошибку сервера (500 с объяснением)
    // отдаём как есть — её текст полезнее общего «нужен интернет»
    if (!res.status || res.foreign) return offline(offlineText(route), !!res.timedOut)
    if (res.status === 401 || res.status === 403) denied(acc, res)

    // Запись на сервере прошла — локальная база должна узнать о ней ДО того, как
    // окно перечитает списки. Иначе только что заведённый товар исчез бы с экрана
    if (res.status >= 200 && res.status < 300 && req.method !== 'GET' && pharmacy) {
      await pharmacy.sync.run().catch(() => {})
    }
    return res
  }

  // Открыть магазин вошедшего и начать обмен. База не открылась — входа нет: работать
  // не с чем, и оставлять человека «за кассой» без базы нельзя
  function enter(acc) {
    try {
      openPharmacy(acc.pharmacyCode).sync.start().catch(() => {})
    } catch (e) {
      session.deactivate()
      onSession()
      throw e
    }
  }

  async function request(raw) {
    let req
    try {
      req = checkRequest(raw)
    } catch (e) {
      return refuse(400, e.message)
    }
    const route = req.path.split('?')[0]

    try {
      if (route === '/auth/login' && req.method === 'POST') return await login(req)

      // Без пометки «сейчас работает такой-то» не выполняется ничего: ни локальный
      // запрос, ни запрос к серверу. Поставить пометку можно только верным паролем
      const acc = activeAccount()
      if (!acc) return refuse(401, MESSAGES.needLogin)

      if (route === '/auth/me' && req.method === 'GET') return await me(req, acc)
      if (route === '/auth/change-password' && req.method === 'POST') return await changePassword(req, acc)

      const found = matchLocal(req.method, req.path)
      if (found) return await local(found, req, acc)
      return await online(req, acc)
    } catch (e) {
      log.error(`запрос ${req.method} ${route} не выполнен`, e)
      return refuse(500, e?.busy ? MESSAGES.dbBusy : MESSAGES.broken)
    }
  }

  return {
    request,
    deviceId,

    // Программа запущена: если кто-то был за кассой — открываем его магазин
    // и начинаем обмен с сервером
    resume() {
      const acc = activeAccount()
      if (!acc) {
        // Пометка есть, а сотрудника в базе нет (базу стёрли) — входа нет
        if (session.activeId()) session.deactivate()
        return false
      }
      try {
        openPharmacy(acc.pharmacyCode).sync.start().catch(() => {})
      } catch (e) {
        // База магазина не открылась: файл занят, диск недоступен, база от более новой
        // версии. Программа всё равно должна запуститься — человек увидит экран входа,
        // а не окно с ошибкой; при входе база откроется ещё раз
        log.error('база магазина не открылась при запуске', e)
        session.deactivate()
        return false
      }
      return true
    },

    // Выход: за кассой больше никого. Ключи остаются (см. session.mjs)
    logout() {
      session.deactivate()
      pharmacy?.sync.stop()
      onSession()
    },

    // Окно начало или перестало слушать события
    listen(on) {
      if (on) {
        listening = true
        // Источник данных окна — локальная база, и она на связи всегда
        emit('connect')
      } else {
        if (listening) emit('disconnect')
        listening = false
      }
    },

    // Событие от сервера (постоянное соединение)
    serverEvent(type, payload) {
      const acc = activeAccount()
      if (!acc || !pharmacy) return
      if (type === 'connect') {
        // Связь вернулась — отправляем накопленное и забираем изменившееся
        pharmacy.sync.run().catch(() => {})
      } else if (type === 'disconnect') {
        // Постоянное соединение оборвалось. Возможно, пропал интернет — выясняем это
        // сейчас, а не при очередной сверке через пять минут: кассир должен увидеть
        // «нет интернета» сразу. Спрашиваем один раз: пока связи нет, соединение
        // будет рваться при каждой попытке восстановиться
        if (pharmacy.sync.isOnline()) pharmacy.sync.kick()
      } else if (type === 'changed') {
        // Разделы, которых касса у себя не держит (сотрудники, расхождения), окно
        // спрашивает прямо у сервера — ему и сообщаем сразу. Об остальных окно узнает
        // после обмена: читает оно их из локальной базы, и раньше там нового нет
        const direct = (Array.isArray(payload) ? payload : [payload]).filter((k) => typeof k === 'string' && !LOCAL_SECTIONS.has(k))
        if (direct.length) send('changed', direct)
        pharmacy.sync.kick()
      } else if (type === 'subscription' || type === 'resumed') {
        send(type, payload)
        pharmacy.sync.run().catch(() => {})
      } else if (type === 'suspended') {
        setSubscription(core, acc.pharmacyCode, { status: 'suspended' })
        send(type, payload)
      }
    },

    // Обмен с сервером прямо сейчас (для проверок и для кнопки «обновить»)
    syncNow: () => (pharmacy ? pharmacy.sync.run() : Promise.resolve({ ok: false, changed: [] })),

    // Загрузить всё заново: забыть отметку «докуда получили» и спросить у сервера
    // весь магазин. Сделанное здесь и не отправленное при этом не теряется — оно, как
    // всегда, сначала уходит на сервер и накладывается поверх свежих данных
    resync() {
      if (!pharmacy || !activeAccount()) return Promise.resolve({ ok: false, changed: [] })
      // Обмен, который идёт прямо сейчас, дописал бы прежнюю отметку обратно — и вместо
      // всего магазина пришли бы одни изменения. Поэтому кроме отметки ставим пометку
      // «нужно всё»: она снимется, только когда полный ответ ляжет в базу
      setMeta(pharmacy.db, 'needFull', '1')
      setMeta(pharmacy.db, 'cursor', '')
      setMeta(pharmacy.db, 'wcursor', '')
      return pharmacy.sync.run()
    },

    // ── Что сервер не принял ──
    // Список для владельца: кассиру он ни к чему, да и суммы чужих чеков не его дело
    rejected() {
      const acc = activeAccount()
      if (!acc || acc.role !== 'founder' || !pharmacy) return []
      return rejectedOps(pharmacy.db).map((op) => ({
        id: op.id,
        type: op.type,
        createdAt: op.createdAt,
        error: op.error || '',
        by: (op.accountId && accountById(core, op.accountId)?.login) || '',
        // Сумма, название и содержимое целиком: в журналах кассы отвергнутой операции
        // уже нет, и разобрать её владелец может только здесь
        ...describeOp(op, (kind, id) => getDoc(pharmacy.db, kind, id)?.body || null),
      }))
    },
    dismissRejected(id) {
      const acc = activeAccount()
      if (!acc || acc.role !== 'founder' || !pharmacy || typeof id !== 'string') return false
      const done = dismissRejected(pharmacy.db, id)
      if (done) send('status', status())
      return done
    },

    // Кто сейчас за кассой: founder | cashier, пусто — никто
    activeRole: () => activeAccount()?.role || '',
    // Есть ли у вошедшего право (любое из перечисленных). Владелец может всё
    activeCan: (...keys) => hasPerm(activeAccount(), ...keys),

    // Открытая база магазина — для резервной копии
    pharmacyFile: () => (pharmacy ? { name: pharmacy.name, db: pharmacy.db } : null),

    // Раз в минуту: не вышел ли срок работы без связи, пока программа просто стояла
    // открытой. Заодно окно получает свежий отсчёт для значка состояния
    tick() {
      // До какого момента программа дожила — в ту же зашифрованную запись, что и
      // проверка подписки: с него часы продолжат после перезапуска (см. licence.mjs)
      const acc = activeAccount()
      if (acc) touchLicence(core, acc.pharmacyCode, licNow(), sealing, floorNow())
      watchLicence()
      if (pharmacy && activeAccount()) send('status', status())
    },
    isOnline: () => !!pharmacy?.sync.isOnline(),
    status,
    pharmacyDb: () => pharmacy?.db || null,

    close() {
      closePharmacy()
    },
  }
}
