// ── Кто отвечает на запрос окна ──
//
// Окно просит данные так же, как на сайте: «/products», «/sales». Здесь решается,
// откуда придёт ответ:
//   • всё, что касса умеет без интернета, — из локальной базы, всегда: и когда
//     связь есть, и когда её нет. Иначе обрыв посреди продажи менял бы поведение
//     кассы, а чек зависел бы от того, успел ли дойти запрос. С версии 1.4.14 это и
//     справочники (товары, поставщики, категории, статьи), и правка документов;
//   • история товара и карточка поставщика — сначала сервер (у него всё за всё время),
//     без связи — по журналам кассы;
//   • вход и «кто я» — через сервер, пока он доступен, и по сохранённому, когда нет;
//   • остальное (сотрудники, пересчёт остатков, резервная копия) — только сервер.
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
  passwordProblem,
  saveAccount,
  setSubscription,
  subscriptionOf,
  userView,
  hasPerm,
  permissionsOf,
} from './local/accounts.mjs'
import { matchFallback, matchLocal, pendingInPeriod } from './local/api.mjs'
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
import { applyPull, tenantUserOf } from './local/snapshot.mjs'
import {
  lanAddManual,
  lanAppliedCount,
  lanAskFull,
  lanBeforePull,
  lanCatchUp,
  lanEntriesSince,
  lanFate,
  lanForgetPeer,
  lanGen,
  lanManual,
  lanNextGen,
  lanPeer,
  lanPeerProgress,
  lanPeers,
  lanPeerSeen,
  lanPrune,
  lanReceive,
  lanRemoveManual,
  lanWideHere,
  waitsForPeer,
} from './local/lan.mjs'
import { checkRequest, createRemote, DESKTOP_TOKEN, isLinkFailure } from './net.mjs'
import { parseAddress } from './lan.mjs'
import { createSync } from './sync.mjs'

// Объяснения для человека. Каждое есть в словаре интерфейса (client/src/lib/i18n.js)
// и показывается на выбранном языке — их сверяет проверка.
export const MESSAGES = {
  needLogin: 'Требуется вход в систему',
  noSealing: 'Пароль на этом компьютере сохранить не удалось — задайте его, когда будет интернет.',
  onlineOnly: 'Этот раздел работает только с интернетом. Касса, склад, инвентаризация, товары, поставщики, расходы, доходы и сотрудники доступны и без него.',
  notSent: 'Эта запись ещё не отправлена на сервер. Изменить или удалить её можно будет после отправки.',
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

// Записи, у которых осталось действие «только на сервере»: удаление клиента. Если клиент
// заведён здесь и сервер его ещё не видел, идти к нему незачем
const SERVER_ONLY_ONE = [{ re: /^\/customers\/([^/]+)$/, kind: 'customer' }]

// Что сказать, когда связи нет, а действие умеет только сервер
const offlineText = () => MESSAGES.onlineOnly

// Товар (история) или поставщик (карточка), заведённые без связи и ещё не отправленные:
// строку положила неотправленная поправка «завести» (edits.mjs)
function madeOffline(db, route, id) {
  const tbl = route.startsWith('/products/') ? 'products' : route.startsWith('/suppliers/') ? 'suppliers' : null
  if (!tbl || typeof id !== 'string') return false
  return !!q(db, "SELECT 1 FROM row_edits WHERE synced = 0 AND tbl = ? AND rowId = ? AND action = 'put' AND json_extract(data, '$.row') IS NOT NULL LIMIT 1").get(tbl, id)
}

// Разделы, которые лежат в локальной базе и обновляются обменом (см. snapshot.mjs)
const LOCAL_SECTIONS = new Set([
  'products', 'categories', 'customers', 'deferred', 'shifts', 'sales', 'returns', 'arrivals', 'writeoffs', 'payments',
  'expenses', 'expenseCategories', 'suppliers', 'supplierPayments', 'cashMoves', 'payServices', 'productTypes',
  'incomes', 'incomeCategories', 'supplierReturns', 'inventories',
  // Сотрудники и роли (1.4.16) — тоже из локальной базы: окно узнает о них после обмена
  'users', 'roles', 'staff',
])
// Адреса, после записи по которым список сотрудников надо перенести во вход без интернета
const TEAM_ROUTE = /^\/(users|roles)(\/[^/]+)?$/

// Запись, названная в отвергнутой операции, — по ней список «не принято» называет её
const ROW_TABLES = {
  product: 'products', category: 'categories', productType: 'product_types', payService: 'pay_services',
  expenseCategory: 'expense_categories', incomeCategory: 'income_categories', supplier: 'suppliers',
  user: 'team_accounts', role: 'team_roles',
}
function findForRejected(db, kind, id) {
  if (typeof id !== 'string') return null
  if (ROW_TABLES[kind]) return q(db, `SELECT * FROM ${ROW_TABLES[kind]} WHERE id = ?`).get(id) || null
  return getDoc(db, kind, id)?.body || null
}

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
  // Обмен кассами по местной сети (lan.mjs в корне программы). Сеть подключает основная
  // часть программы (attachLan); здесь — то, что знает о ней база магазина
  let lanNet = null
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
  // а не через две минуты. Пачка при этом не теряется — уйдёт следующей попыткой.
  // Тяжёлая пачка (лист пересчёта на весь склад — мегабайты) по слабой связи идёт дольше:
  // ей срок — по размеру, из расчёта ~24 КБ в секунду. Иначе она обрывалась бы на полпути
  // каждый раз, и за ней стояла бы вся очередь
  const PUSH_TIMEOUT_MS = 45000
  const pushTimeout = (ops) => {
    const bytes = ops.reduce((n, o) => n + Buffer.byteLength(JSON.stringify(o.payload ?? {})), 0)
    return Math.max(PUSH_TIMEOUT_MS, 30000 + Math.ceil(bytes / 24000) * 1000)
  }

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

    // Что уходит на сервер: отпечаток пароля сотрудника лежит в очереди зашифрованным — серверу
    // он нужен как есть. Не расшифровался (базу перенесли с другого компьютера) — уходит пустым,
    // и сервер откажет («Недопустимый пароль»): владелец увидит это в «Не принято сервером»,
    // а не получит молча принятую правку без пароля
    function outgoing(o) {
      const p = o.payload || {}
      if (o.type === 'user.create' && p.user?.passwordSealed) {
        const { passwordSealed, ...u } = p.user
        return { ...p, user: { ...u, passwordHash: open(passwordSealed) || '' } }
      }
      if (o.type === 'user.update' && p.set?.passwordSealed) {
        const { passwordSealed, ...set } = p.set
        return { ...p, set: { ...set, passwordHash: open(passwordSealed) || '' } }
      }
      return p
    }

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
    const wideHere = () => hasPerm(activeAccount(), 'suppliers.view', 'writeoffs.view', 'expenses.view', 'incomes.view', 'reports.view', 'dashboard.view')
    // Сотрудников с окладами получает тот, кто выдаёт зарплату, — со своей отметкой (как
    // у сервера: GET /expenses/staff)
    const staffHere = () => hasPerm(activeAccount(), 'expenses.create', 'expenses.edit')
    function cursor() {
      if (wideHere() && !getMeta(db, 'wcursor')) return ''
      if (staffHere() && !getMeta(db, 'scursor')) return ''
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
        ack: (op, fate) => {
          ackOp(db, op, fate)
          // Соседние кассы снимут поправку этой операции (обмен по местной сети)
          if (lanFate(db, op.id, 'ok', null, { deviceId, now: clock.now() })) lanNet?.kick()
        },
        reject: (op, error) => {
          log.warn(`сервер отверг операцию ${op.type} ${op.id}: ${error}`)
          rejectOp(db, op, error)
          if (lanFate(db, op.id, 'rejected', error, { deviceId, now: clock.now() })) lanNet?.kick()
          // Окно держит свои списки в памяти: отвергнутая смена, возврат, клиент
          // должны исчезнуть с экрана сейчас, а не при очередной сверке через минуту
          send('changed', touchedBy(op))
        },
        sentOps: (n) => sentOps(db, n),
        // Операция ссылается на чек или клиента соседней кассы, которых сервер ещё не
        // знает (пришли по местной сети), — ждёт, пока сосед отправит своё (lan.mjs)
        waitsForPeer: (op) => waitsForPeer(db, op),
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
            let toPeers = false
            for (const op of sent) {
              const fate = fates[op.id]
              if (fate?.status === 'ok') {
                ackOp(db, op, fate)
                if (lanFate(db, op.id, 'ok', null, { deviceId, now: clock.now() })) toPeers = true
              } else if (fate?.status === 'rejected') {
                log.warn(`сервер отверг операцию ${op.type} ${op.id}: ${fate.error}`)
                rejectOp(db, op, fate.error)
                if (lanFate(db, op.id, 'rejected', fate.error, { deviceId, now: clock.now() })) toPeers = true
                stale.push(...touchedBy(op))
              }
            }
            if (toPeers) lanNet?.kick()
            // Операции соседних касс, которые в этих данных уже есть, — их поправка
            // снимается до того, как данные лягут (см. local/lan.mjs)
            lanBeforePull(db, res.data, { startedGen: ph.pullGen || 0, now: clock.now() })
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
            timeoutMs: pushTimeout(ops),
            headers: asDevice,
            body: {
              deviceId,
              appVersion,
              ops: ops.map((o) => ({ id: o.id, type: o.type, accountId: o.accountId || undefined, createdAt: o.createdAt, payload: outgoing(o) })),
            },
          },
          token,
        ),
      pull: async (since, asked = []) => {
        // Номер этого обмена: по нему видно, начат ли он после известия соседа «сервер
        // принял мою операцию» (local/lan.mjs)
        ph.pullGen = lanNextGen(db)
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
          // Сотрудники с окладами, изменившиеся, пока за кассой был тот, кому они не видны
          ...(since && staffHere() ? { scursor: getMeta(db, 'scursor') } : {}),
          // Операции, на которые не пришёл ответ: приняты ли они?
          ...(asked.length ? { ops: asked.join(',') } : {}),
          // Отпечаток списка сотрудников и ролей с прошлого раза: неизменившийся не придёт. Когда
          // касса просит всё заново (сервер принял правку, но сделал не так), — без него: список
          // придёт целиком и ляжет основой
          ...(getMeta(db, 'teamv') && getMeta(db, 'needFull') !== '1' ? { teamv: getMeta(db, 'teamv') } : {}),
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
        // Обмен кассами по местной сети: общий ключ магазина, сколько у него касс и как
        // называется эта касса — всё это сообщает сервер
        rememberLan(ph, data)
        // Сотрудники магазина — во вход без интернета (блокировка, роль, новый пароль)
        teamToCore(ph)
      },
      onState: () => send('status', status()),
    })
    pharmacy = ph
    // Ключ магазина мог быть известен с прошлого раза — обмен по сети начинается сразу
    lanNet?.sync().catch(() => {})
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
      // Операция ждёт, пока соседняя касса отправит своё (её чек или клиента)
      waiting: !!st.waiting,
      // Сколько операций соседних касс лежит здесь, а сервер их ещё не видел
      fromPeers: lanAppliedCount(pharmacy.db),
      syncedAt: getMeta(pharmacy.db, 'syncedAt'),
      // Сколько программе осталось работать без связи с сервером
      licence: { checkedAt: lic.checkedAt, offlineDays: lic.offlineDays, until: lic.until, leftMs: lic.leftMs, warn: lic.warn, expired: lic.expired },
      restored: restoredNote(pharmacy.db),
    }
  }

  // Базу недавно поднимали из копии — напоминаем об этом неделю. manual — копию загрузил
  // владелец сам (restore.mjs), а не программа после поломки файла; foreign — копия
  // другого компьютера, и эта касса теперь работает под его номером
  const RESTORED_SHOW_MS = 7 * 86400000
  function restoredNote(db) {
    try {
      const r = JSON.parse(getMeta(db, 'restored') || 'null')
      if (!r || !Number.isFinite(r.at) || clock.now() - r.at > RESTORED_SHOW_MS) return null
      return { at: new Date(r.at).toISOString(), from: Number.isFinite(r.from) ? new Date(r.from).toISOString() : null, manual: r.manual === true, foreign: r.foreign === true }
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

  // ── Сотрудники магазина → вход без интернета (версия 1.4.16) ──
  // Владелец завёл сотрудника, заблокировал его, сменил ему пароль или роль — здесь или на
  // соседней кассе, без связи. Вход без интернета проверяется по общей базе программы
  // (core.accounts), и она узнаёт об этом сразу:
  //   • новый сотрудник с паролем от владельца — может войти и здесь;
  //   • заблокированный — не может («неверное имя или пароль», как у сервера);
  //   • новый пароль — действует сразу; прежний ключ сотрудника больше не годится (сервер
  //     его отзовёт), его операции уйдут ключом владельца. Сервер смену отверг — прежний
  //     отпечаток возвращается;
  //   • роль и права — новые; удалённый сотрудник — больше не входит.
  function teamToCore(ph) {
    const db = ph.db
    const code = ph.code
    let byId, roles, peerRoles, per, known, teamAt, outcome
    try {
      byId = new Map(q(db, 'SELECT * FROM team_accounts').all().map((a) => [a.id, a]))
      roles = new Map(q(db, 'SELECT id, permissions FROM team_roles').all().map((r) => [r.id, r.permissions]))
      // Роли, права которых поменяла соседняя касса, а сервер ещё не подтвердил: такие права
      // сюда не переносятся (кроме урезания) — расширить права может только своя правка или сервер
      peerRoles = new Set(
        q(
          db,
          `SELECT DISTINCT e.rowId FROM row_edits e JOIN lan_log l ON l.id = e.opId
           WHERE e.tbl = 'team_roles' AND e.synced = 0 AND l.kind = 'op' AND l.state = 'applied'`,
        )
          .all()
          .map((r) => r.rowId),
      )
      outcome = (opId) => opOutcome(db, opId)
      per = teamEdits(db)
      teamAt = getMeta(db, 'teamAt') || ''
      known = getMeta(db, 'teamLoaded') === '1'
    } catch (e) {
      log.warn('сотрудники магазина не перенеслись во вход без интернета', e)
      return
    }
    const active = session.activeId()
    // Права роли — список строк. Испорченная запись (её мог принести чужой обмен или сбой диска)
    // — без прав: она не должна ни открыть лишнего, ни сорвать перенос остальных сотрудников
    const permsList = (v) => {
      try {
        const list = JSON.parse(v || '[]')
        return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []
      } catch {
        return []
      }
    }
    const permsJson = (v) => JSON.stringify(permsList(v))
    const sameSet = (a, b) => {
      const y = new Set(permsList(b))
      return permsList(a).every((k) => y.has(k))
    }

    // ── Шаг 1: кто может войти — удаление, блокировка, роль и права, пароль ──
    // Логины и новые сотрудники — отдельными шагами: их сбой (два сотрудника с одним логином,
    // пока кассы и сервер не договорились) не должен отменить блокировку или смену пароля
    const settled = []
    try {
      inTx(core, () => {
        for (const row of q(core, 'SELECT * FROM accounts WHERE pharmacyCode = ?').all(code)) {
          const a = byId.get(row.id)
          const x = per.get(row.id) || blankEdits()
          if (!a) {
            // Сотрудника нет в списке. Удаление ещё ждёт ответа сервера — вход закрыт, но
            // обратимо: сервер может его не провести, и сотрудник вернётся в список
            if (x.delPending && !x.del) {
              if (!row.blocked) q(core, 'UPDATE accounts SET blocked = 1 WHERE id = ?').run(row.id)
              if (row.id !== active) session.drop(row.id)
              continue
            }
            // Входа без интернета больше нет, если удаление провели, если его заведение здесь не
            // принял сервер, или он пропал из списка сервера (кто вошёл через сервер позже, чем
            // пришёл список, — остаётся)
            const failedCreation = !!row.localPw && ['rejected', 'unknown', 'noop'].includes(outcome(row.localPw))
            if (x.del || failedCreation || (known && (!teamAt || row.seenAt < teamAt))) {
              // За кассой он сам — после выхода не войдёт, а запись уберётся следующим разом
              if (row.id === active) q(core, 'UPDATE accounts SET blocked = 1 WHERE id = ?').run(row.id)
              else {
                q(core, 'DELETE FROM accounts WHERE id = ?').run(row.id)
                session.drop(row.id)
              }
            }
            continue
          }
          const set = {}
          // Роль и права. Последнюю (ещё не подтверждённую) правку роли сделала соседняя касса,
          // или сосед поменял права самой роли — только урезание: стать владельцем или получить
          // новые права здесь можно по своей правке или по данным сервера
          const founder = a.role === 'founder'
          const perms = founder ? '' : roles.has(a.roleId) ? permsJson(roles.get(a.roleId)) : row.permissions
          const fromPeer = x.roleBy === 'peer' || (!founder && peerRoles.has(a.roleId))
          const narrower = row.role === 'founder' ? !founder : !founder && sameSet(perms, row.permissions)
          if (!fromPeer || narrower) {
            if (row.role !== a.role) set.role = a.role
            if ((perms ?? '') !== (row.permissions ?? '')) set.permissions = perms ?? ''
            const roleName = founder ? 'Владелец' : a.roleName || row.roleName
            if (roleName !== row.roleName) set.roleName = roleName
          }
          if (a.userId && a.userId !== row.tenantUserId) set.tenantUserId = a.userId
          // Блокировка действует сразу, от кого бы ни пришла. Снять её может своя правка или
          // сервер, но не неподтверждённая правка соседа
          const blocked = a.active ? 0 : 1
          if (blocked && !row.blocked) {
            set.blocked = 1
            if (row.id !== active) session.drop(row.id)
          } else if (!blocked && row.blocked && x.activeBy !== 'peer') set.blocked = 0

          // ── Пароль ──
          const last = x.pw[x.pw.length - 1] || null
          const lastPending = !!last && last.state === 'pending'
          const liveOwn = [...x.pw].reverse().find((p) => p.state === 'pending' || p.state === 'applied') || null
          if (lastPending) {
            if (row.localPw !== last.opId) {
              Object.assign(set, { verifier: last.sealed, localPw: last.opId, prevVerifier: row.localPw ? row.prevVerifier : row.verifier })
              // Прежний ключ сотрудника сервер отзовёт, как только примет пароль. Ключ того, кто
              // сейчас за кассой, оставляем: им и уйдёт смена пароля
              if (row.id !== active) session.drop(row.id)
            }
          } else if (row.localPw) {
            // Свои смены пароля решены сервером. Какой пароль теперь — по порядку событий с той
            // минуты, когда касса последний раз узнала нынешний пароль (pwLearned), начиная с него
            // (prevVerifier): принятая смена — её отпечаток; отказ — пароль прежний; сервер оставил
            // более поздний пароль — это узнанный, если тот задан позже смены (свой пароль сменили
            // через сервер), иначе какой — неизвестно; сосед сменил пароль — тоже неизвестно.
            // Неизвестно — входа без интернета нет, до входа с ним
            const from = pwFrom(db, row.id)
            const counts = (p) => p.seq > from.b || (from.p !== null && p.seq >= from.p)
            const peerCounts = (m) => m.seq > from.b || (from.q !== null && m.seq >= from.q)
            const events = [
              ...x.pw.filter(counts).map((p) => ({ seq: p.seq, own: p })),
              ...x.peerPw.filter(peerCounts).map((m) => ({ seq: m.seq, own: null })),
            ].sort((p, r) => p.seq - r.seq)
            // Поправки самой смены уже нет (давно убрана) — судьба по очереди отправки
            if (!x.pw.some((p) => p.opId === row.localPw)) events.push({ seq: Infinity, own: { state: outcome(row.localPw), sealed: null, seq: Infinity } })
            let verifier = row.prevVerifier ?? null
            let took = false
            for (const ev of events) {
              if (!ev.own) verifier = null
              else if (ev.own.state === 'applied') {
                verifier = ev.own.sealed
                took = true
              } else if (ev.own.state === 'rejected') continue
              else if (!(ev.own.state === 'noop' && from.n && ev.own.seq <= from.b)) verifier = null
            }
            Object.assign(set, { verifier, localPw: null, prevVerifier: null })
            // Сервер принял новый пароль — прежние ключи сотрудника он отозвал. Ключ убираем, не
            // выводя из программы того, кто за кассой: иначе его операции ушли бы негодным ключом,
            // и отказ сервера стёр бы и верный отпечаток
            if (took) session.setToken(row.id, '')
            settled.push(row.id)
          }
          // Соседняя касса сменила пароль (сервер ещё не подтвердил), и это позже своей последней
          // смены: какой он теперь, здесь неизвестно (отпечаток по сети не ходит). Прежний больше
          // не подходит — до входа с интернетом входа без него нет. Своя смена, ещё не ушедшая,
          // действует здесь до ответа сервера
          if (!lastPending && x.peerPw.some((m) => !m.synced && m.seq > (liveOwn ? liveOwn.seq : -1))) {
            if (row.verifier || set.verifier) set.verifier = null
            if (row.id !== active) session.drop(row.id)
          }
          const keys = Object.keys(set)
          if (keys.length) q(core, `UPDATE accounts SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), row.id)
        }
      })
    } catch (e) {
      log.warn('сотрудники магазина не перенеслись во вход без интернета', e)
      settled.length = 0
    }
    // Решённое по паролю — отметка в базе магазина: следующие решения смотрят только на то, что
    // было после
    for (const id of settled) pwLearned(db, id)

    // ── Шаг 2: логины ──
    // В два прохода: логины могли поменяться местами, а логин в общей базе уникален. Прежняя
    // запись с тем же логином уходит, только если её нет в списке. Логин занят другим
    // сотрудником из списка — остаётся прежний (если свободен), до ответа сервера
    try {
      inTx(core, () => {
        const want = []
        for (const row of q(core, 'SELECT id, login FROM accounts WHERE pharmacyCode = ?').all(code)) {
          const a = byId.get(row.id)
          if (a?.login && a.login !== row.login) want.push({ id: row.id, from: row.login, to: a.login })
        }
        if (!want.length) return
        const holders = (login, id) => q(core, 'SELECT id FROM accounts WHERE login = ? AND id <> ?').all(login, id)
        for (const r of want) q(core, 'UPDATE accounts SET login = ? WHERE id = ?').run('\u0001' + r.id, r.id)
        for (const r of want) {
          for (const other of holders(r.to, r.id)) if (!byId.has(other.id)) q(core, 'DELETE FROM accounts WHERE id = ?').run(other.id)
          if (!holders(r.to, r.id).length) q(core, 'UPDATE accounts SET login = ? WHERE id = ?').run(r.to, r.id)
        }
        for (const r of want) {
          if (q(core, 'SELECT login FROM accounts WHERE id = ?').get(r.id)?.login !== '\u0001' + r.id) continue
          if (!holders(r.from, r.id).length) q(core, 'UPDATE accounts SET login = ? WHERE id = ?').run(r.from, r.id)
        }
      })
    } catch (e) {
      log.warn('логины сотрудников не перенеслись во вход без интернета', e)
    }

    // ── Шаг 3: новый сотрудник, которого завели ЗДЕСЬ (или кому здесь задали пароль) ──
    // С паролем от владельца он может войти и без связи. Заведённого на соседней кассе здесь
    // пустят после входа с интернетом
    try {
      inTx(core, () => {
        const rows = q(core, 'SELECT * FROM accounts WHERE pharmacyCode = ?').all(code)
        const tmpl = rows.find((r) => r.id === active) || rows[0] || null
        if (!tmpl) return
        for (const [id, x] of per) {
          const a = byId.get(id)
          if (!a || !x.pw.length || q(core, 'SELECT 1 FROM accounts WHERE id = ?').get(id)) continue
          const p = x.pw[x.pw.length - 1]
          if (p.state !== 'pending' && p.state !== 'applied') continue
          // Пароль после этого сменила соседняя касса — какой он, здесь неизвестно
          if (x.peerPw.some((m) => m.seq > p.seq)) continue
          const founder = a.role === 'founder'
          // Заведённого соседней кассой сервер ещё не знает, а роль от неподтверждённой правки
          // соседа — не основание пускать без связи (пустят после подтверждения или входа с интернетом)
          if (x.peerMade || x.roleBy === 'peer' || (!founder && peerRoles.has(a.roleId))) continue
          for (const other of q(core, 'SELECT id FROM accounts WHERE login = ? AND id <> ?').all(a.login, id)) {
            if (!byId.has(other.id)) q(core, 'DELETE FROM accounts WHERE id = ?').run(other.id)
          }
          if (q(core, 'SELECT 1 FROM accounts WHERE login = ?').get(a.login)) continue
          q(
            core,
            `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, tenantUserId, seenAt, permissions, roleName, blocked, localPw)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id, a.login, a.role, code, tmpl.pharmacyName || '', p.sealed, tmpl.subStatus || 'active', tmpl.paidUntil ?? null, a.userId ?? null,
            new Date(clock.now()).toISOString(), founder ? '' : roles.has(a.roleId) ? permsJson(roles.get(a.roleId)) : '', founder ? 'Владелец' : a.roleName || '',
            a.active && x.activeBy !== 'peer' ? 0 : 1, p.state === 'pending' ? p.opId : null,
          )
        }
      })
    } catch (e) {
      log.warn('новые сотрудники не перенеслись во вход без интернета', e)
    }
  }

  // Судьба своей операции по очереди отправки
  function opOutcome(db, opId) {
    const o = q(db, 'SELECT state, error FROM outbox WHERE id = ?').get(opId)
    if (!o) return 'unknown'
    if (o.state === 'pending') return 'pending'
    if (o.state === 'done') return o.error === 'noop' ? 'noop' : 'applied'
    return 'rejected'
  }

  // Что известно о сотрудниках по поправкам: свои смены пароля (отпечаток — зашифрованный) и
  // пометки соседей «пароль сменили», удаление, кто последним (без подтверждения сервера)
  // менял блокировку и роль — своя касса или соседняя
  const blankEdits = () => ({ pw: [], peerPw: [], del: false, delPending: false, activeBy: '', roleBy: '', peerMade: false })
  function teamEdits(db) {
    const per = new Map()
    for (const e of q(db, "SELECT opId, rowId, action, data, synced, seq FROM row_edits WHERE tbl = 'team_accounts' ORDER BY seq").all()) {
      let d = {}
      try {
        d = JSON.parse(e.data) || {}
      } catch {
        continue
      }
      if (!per.has(e.rowId)) per.set(e.rowId, blankEdits())
      const x = per.get(e.rowId)
      const mine = !!q(db, 'SELECT 1 FROM outbox WHERE id = ?').get(e.opId)
      // Удаление: ещё не подтверждено — вход закрыт, но обратимо (сервер может удаление не
      // провести — сотрудника тогда правили позже); подтверждено и проведено — запись уходит
      if (e.action === 'del') {
        if (!e.synced) x.delPending = true
        else if (!mine || opOutcome(db, e.opId) === 'applied') x.del = true
      }
      if (mine && typeof d.pw === 'string' && d.pw) x.pw.push({ opId: e.opId, sealed: d.pw, state: opOutcome(db, e.opId), seq: e.seq })
      if (!mine && d.pwChanged) x.peerPw.push({ seq: e.seq, synced: !!e.synced })
      if (!e.synced) {
        // Заведение: роль и блокировку задал тот, кто завёл; заведённого соседом сервер ещё не знает
        if (e.action === 'put' && d.row && typeof d.row === 'object') {
          x.activeBy = x.roleBy = mine ? 'own' : 'peer'
          if (!mine) x.peerMade = true
        }
        if (d.set && typeof d.set === 'object') {
          if ('active' in d.set) x.activeBy = mine ? 'own' : 'peer'
          if ('role' in d.set || 'roleId' in d.set) x.roleBy = mine ? 'own' : 'peer'
        }
      }
    }
    return per
  }

  // Касса узнала нынешний пароль сотрудника: от сервера (вход через него), сама задала его через
  // сервер (смена своего пароля) или досчитала решённые сервером смены. Всё, что было по паролю
  // до этой минуты, в нём учтено — дальше в расчёт идут события после неё (b), свои смены,
  // которые ещё ждут отправки (с p), и смены пароля соседями, о приёме которых сервером здесь
  // ещё не известно (с q): сервер их пока мог не видеть. newer — узнанный пароль задан позже
  // своих ждущих смен: если сервер какую-то из них не проведёт («оставил более поздний»), это он
  function pwLearned(db, id, { newer = false } = {}) {
    try {
      const b = q(db, "SELECT MAX(seq) AS s FROM row_edits WHERE tbl = 'team_accounts' AND rowId = ?").get(id)?.s ?? -1
      const p =
        q(
          db,
          `SELECT MIN(e.seq) AS s FROM row_edits e JOIN outbox o ON o.id = e.opId
           WHERE e.tbl = 'team_accounts' AND e.rowId = ? AND o.state = 'pending' AND json_extract(e.data, '$.pw') IS NOT NULL`,
        ).get(id)?.s ?? null
      const peer =
        q(
          db,
          `SELECT MIN(e.seq) AS s FROM row_edits e
           WHERE e.tbl = 'team_accounts' AND e.rowId = ? AND e.synced = 0 AND json_extract(e.data, '$.pwChanged') = 1
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.id = e.opId)`,
        ).get(id)?.s ?? null
      setMeta(db, 'pwFrom:' + id, JSON.stringify({ b, p, q: peer, n: newer }))
    } catch (e) {
      log.warn('отметка о пароле сотрудника не записалась', e)
    }
  }
  function pwFrom(db, id) {
    try {
      const v = JSON.parse(getMeta(db, 'pwFrom:' + id) || 'null')
      if (v && typeof v === 'object') return { b: Number.isInteger(v.b) ? v.b : -1, p: Number.isInteger(v.p) ? v.p : null, q: Number.isInteger(v.q) ? v.q : null, n: v.n === true }
    } catch {
      /* испорченная отметка — как без неё */
    }
    return { b: -1, p: null, q: null, n: false }
  }

  // Своя смена пароля этого сотрудника ещё не ушла на сервер (вход через сервер в это время
  // идёт по прежнему паролю — отпечаток нового он подменять не должен)
  function pwPending(acc) {
    if (!acc?.localPw || !pharmacy || pharmacy.code !== acc.pharmacyCode) return false
    return !!q(pharmacy.db, "SELECT 1 FROM outbox WHERE id = ? AND state = 'pending'").get(acc.localPw)
  }

  // Сотрудника здесь или на соседней кассе заблокировали (или удалили), а сервер этого ещё не
  // знает. Удаление не отменяет ничья последующая правка; блокировку снимает только своя правка
  // (неподтверждённая правка соседа может только ограничить)
  function closedHere(db, id) {
    let closed = false
    for (const e of q(db, "SELECT opId, action, data FROM row_edits WHERE tbl = 'team_accounts' AND rowId = ? AND synced = 0 ORDER BY seq").all(id)) {
      if (e.action === 'del') return true
      let d = null
      try {
        d = JSON.parse(e.data)
      } catch {
        continue
      }
      if (!d?.set || typeof d.set !== 'object' || !('active' in d.set)) continue
      if (!d.set.active) closed = true
      else if (q(db, 'SELECT 1 FROM outbox WHERE id = ?').get(e.opId)) closed = false
    }
    return closed
  }

  // База магазина — заглянуть при входе (своя смена пароля, блокировка). Уже открыта — она и
  // есть; за кассой никого (или свой же магазин) — открываем: вход её всё равно откроет. Работает
  // сотрудник другого магазина — его базу не трогаем, проверки без неё
  function shopOf(code) {
    if (pharmacy?.code === code) return pharmacy
    const working = activeAccount()
    if (working && working.pharmacyCode !== code) return null
    try {
      return openPharmacy(code)
    } catch (e) {
      log.warn('база магазина не открылась при входе', e)
      return null
    }
  }

  // ── Сервер отказал ──
  // 401 — ключ входа больше не действует. Просто вышел срок ключа — это одно: пароль
  // прежний, и без интернета под ним входить можно. Всё остальное (сменили пароль,
  // закрыли учётную запись) отзывает и вход без интернета.
  function denied(acc, res) {
    if (res.status === 401) {
      const working = session.activeId() === acc.id
      session.drop(acc.id)
      // Пароль, заданный здесь без связи (отпечаток уже новый), не стираем: ключ отозван как
      // раз потому, что сервер принял этот новый пароль
      if (res.data?.message !== MESSAGES.needLogin && !accountById(core, acc.id)?.localPw) dropVerifier(core, acc.id)
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

  // ── Обмен кассами по местной сети: что знает база магазина ──
  // Общий ключ магазина выдаёт сервер при обмене. Хранится зашифрованным средствами
  // Windows, как ключи входа; в памяти — пока открыта база
  function lanKeyOf(ph) {
    if (ph.lanKey) return ph.lanKey
    const stored = getMeta(ph.db, 'lanKey')
    const key = stored ? open(stored) : null
    if (key) ph.lanKey = key
    return key || ''
  }
  function rememberLan(ph, data) {
    const lan = data?.lan
    let changed = false
    if (lan && typeof lan.key === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(lan.key) && lan.key !== lanKeyOf(ph)) {
      ph.lanKey = lan.key
      const sealed = seal(lan.key)
      if (sealed) setMeta(ph.db, 'lanKey', sealed)
      changed = true
    }
    if (lan && Number.isInteger(lan.devices) && String(lan.devices) !== getMeta(ph.db, 'lanDevices')) {
      setMeta(ph.db, 'lanDevices', String(lan.devices))
      changed = true
    }
    const name = data?.device?.name
    if (typeof name === 'string' && name && name !== getMeta(ph.db, 'deviceName')) {
      setMeta(ph.db, 'deviceName', name.slice(0, 60))
      changed = true
    }
    if (changed) lanNet?.sync().catch(() => {})
  }
  // Обмен нужен, когда у магазина больше одной кассы, вписан адрес соседа или сосед
  // уже знаком. Одна касса — сеть не открывается вовсе (и Windows ни о чём не спросит)
  function lanEnabled(ph) {
    if (!ph || !lanKeyOf(ph)) return false
    return Number(getMeta(ph.db, 'lanDevices') || 0) >= 2 || lanManual(ph.db).length > 0 || lanPeers(ph.db).length > 0
  }
  function lanAfterWrite(ph) {
    if (!lanEnabled(ph)) return
    try {
      lanCatchUp(ph.db, { deviceId, now: clock.now() })
    } catch (e) {
      log.warn('обмен по сети: операция не записалась в журнал', e)
    }
    lanNet?.kick()
  }
  const lanHub = {
    state() {
      const ph = pharmacy
      if (!ph) return null
      const key = lanKeyOf(ph)
      const wide = lanWideHere(core, ph.code)
      // За кассой начал работать тот, кому видны деньги магазина, — журналы соседей
      // нужны целиком, а не урезанными
      const was = getMeta(ph.db, 'lanWide') === '1'
      if (wide !== was) {
        if (wide) lanAskFull(ph.db)
        setMeta(ph.db, 'lanWide', wide ? '1' : '0')
      }
      return { enabled: lanEnabled(ph), key, deviceId, name: getMeta(ph.db, 'deviceName') || '', wide }
    },
    entriesFor(since, wide) {
      const ph = pharmacy
      if (!ph) return { entries: [], upTo: since, more: false }
      lanCatchUp(ph.db, { deviceId, now: clock.now() })
      return lanEntriesSince(ph.db, since, { wide })
    },
    receive(peerId, entries) {
      const ph = pharmacy
      if (!ph || !Array.isArray(entries) || !entries.length) return
      const r = lanReceive(ph.db, entries, { now: clock.now(), gen: lanGen(ph.db) })
      // Сотрудника завели, заблокировали или сменили ему пароль на соседней кассе — вход без
      // интернета здесь тоже по-новому
      if (r.changed.includes('users') || r.changed.includes('roles')) {
        // Список сотрудников с сервера — при следующем обмене целиком: если в нём уже есть тот,
        // кого завела соседняя касса (сервер принял его раньше, чем сюда дошёл обмен), касса так
        // узнает, что заведение принято, и операции над ним не ждут известия от соседа
        setMeta(ph.db, 'teamv', '')
        teamToCore(ph)
      }
      if (r.changed.length) send('changed', r.changed)
      // Сосед сообщил «сервер принял»: обменяться с сервером поскорее — его данные
      // снимут поправку, а ждавшие этого свои операции уйдут
      if (r.kickSync) ph.sync.kick()
      // Пришедшее от одного соседа — дальше остальным
      lanNet?.kick()
      send('status', status())
    },
    progress: (peerId, p) => pharmacy && lanPeerProgress(pharmacy.db, peerId, p),
    peers: () => (pharmacy ? lanPeers(pharmacy.db) : []),
    peer: (id) => (pharmacy ? lanPeer(pharmacy.db, id) : null),
    peerSeen: (p) => pharmacy && lanPeerSeen(pharmacy.db, p),
    manual: () => (pharmacy ? lanManual(pharmacy.db) : []),
    forgetAddress: (id) => pharmacy && q(pharmacy.db, "UPDATE lan_peers SET address = '' WHERE deviceId = ?").run(id),
  }

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
      // База магазина — до проверок: после перезапуска программы она ещё не открыта
      const ph = shopOf(user.pharmacy.code)
      // Сотрудника здесь или на соседней кассе заблокировали (удалили), а сервер ещё не знает:
      // входа нет и через сервер — до отправки блокировки. Ответ — как у сервера
      if (ph && closedHere(ph.db, user.id)) return refuse(401, 'Неверное имя или пароль')
      const verifier = seal(await makeVerifier(password))
      // Своя смена пароля этого сотрудника ещё в очереди: сервер пока знает прежний пароль, им и
      // вошли. Отпечаток нового не трогаем, а введённый запоминаем как прежний — он вернётся,
      // если сервер смену отвергнет
      const before = accountById(core, user.id)
      const pending = pwPending(before)
      const acc = remember(user, pending ? {} : { verifier })
      if (pending) q(core, 'UPDATE accounts SET prevVerifier = ? WHERE id = ?').run(verifier, user.id)
      // Сервер только что принял этот пароль — он и есть нынешний: свои прежние смены пароля (уже
      // решённые сервером) отпечаток больше не меняют
      else q(core, 'UPDATE accounts SET localPw = NULL, prevVerifier = NULL WHERE id = ?').run(user.id)
      if (ph) {
        // Сервер пустил — у него сотрудник не заблокирован, а здесь блокировки, ждущей отправки,
        // нет (базу магазина посмотреть не удалось — отметку не трогаем). Всё, что было по паролю
        // до этой минуты, учтено в введённом
        q(core, 'UPDATE accounts SET blocked = 0 WHERE id = ?').run(user.id)
        pwLearned(ph.db, user.id)
      }
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
      // Пароль сменили здесь без связи, а смена ещё не ушла: сервер новый пароль пока не знает —
      // это не повод закрывать вход по нему (база магазина нужна открытой и после перезапуска)
      if (verifier) shopOf(acc.pharmacyCode)
      if (verifier && !pwPending(acc) && (await checkVerifier(password, verifier))) {
        dropVerifier(core, acc.id)
        denied(acc, { status: 403, data: res.data })
      }
      // Введён прежний пароль (он вернулся бы, если сервер отвергнет свою смену), а сервер его
      // больше не принимает — возвращать нечего
      const prev = acc?.prevVerifier ? open(acc.prevVerifier) : null
      if (prev && (await checkVerifier(password, prev))) q(core, 'UPDATE accounts SET prevVerifier = NULL WHERE id = ?').run(acc.id)
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
      // Новый пароль задан только что — он и есть нынешний. Своя смена этого пароля, ещё ждущая
      // отправки (её без связи сделал другой владелец), старше: сервер её не проведёт, а если
      // отвергнет — останется этот пароль, а не прежний
      const ph = shopOf(acc.pharmacyCode)
      if (pwPending(accountById(core, acc.id))) q(core, 'UPDATE accounts SET verifier = ?, prevVerifier = ? WHERE id = ?').run(verifier, verifier, acc.id)
      else q(core, 'UPDATE accounts SET verifier = ?, localPw = NULL, prevVerifier = NULL WHERE id = ?').run(verifier, acc.id)
      if (ph) pwLearned(ph.db, acc.id, { newer: true })
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

    // Пароль сотрудника — отпечатком, тем же способом, что на сервере: сам пароль в базу
    // кассы и в очередь на отправку не попадает. Правила пароля — те же слова, что у сервера
    const route = req.path.split('?')[0]
    let body = req.body
    if (req.method !== 'GET' && /^\/users(\/[^/]+)?$/.test(route) && body && typeof body === 'object' && typeof body.password === 'string' && body.password) {
      const problem = passwordProblem(body.password)
      if (problem) return refuse(400, problem)
      const { password, ...rest } = body
      // Отпечаток пароля — сразу зашифрованным средствами Windows: в базе кассы и в очереди
      // на отправку открытого отпечатка нет (на сервер он уходит расшифрованным, push)
      const sealed = seal(await makeVerifier(password))
      if (!sealed) return refuse(400, MESSAGES.noSealing)
      body = { ...rest, passwordSealed: sealed }
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
        body,
      })
    } catch (e) {
      if (e instanceof ApiError) return refuse(e.status, e.messages || e.message)
      log.error(`локальный запрос ${req.method} ${req.path.split('?')[0]} не выполнен`, e)
      return refuse(500, MESSAGES.broken)
    }

    // Период глубже того, что хранится на компьютере, — за ним идём на сервер,
    // а своё неотправленное добавляем сами: сервер о нём ещё не знает
    if (data && data.__deep) return deep(req, acc, ph, data.__deep)
    // Записи на кассе нет (давний приход) — за ней идём на сервер. __offline — свой текст на
    // случай, если сервера нет (лист пересчёта больше, чем можно завести без связи)
    if (data && data.__remote) return online(req, acc, typeof data.__offline === 'string' ? data.__offline : '')
    if (req.method !== 'GET') {
      // Сотрудники и роли — сразу во вход без интернета этой кассы
      if (TEAM_ROUTE.test(route)) teamToCore(ph)
      // Записано на диск — теперь это надо отправить. Не дожидаясь ответа сервера:
      // кассир уже может пробивать следующий чек
      ph.sync.kick()
      // И соседним кассам по местной сети — сразу
      lanAfterWrite(ph)
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
    // Своё — поверх копии сервера: поправленное здесь заменяет её, удалённое здесь — убирает
    const own = new Map(mine.map((d) => [d.id, d]))
    const dateOf = (d) => d.date || d.createdAt || ''
    const fromServer = res.data.filter((d) => !own.has(d?.id))
    const data = [...fromServer, ...mine.filter((d) => !d.__deleted)].sort((a, b) => (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0))
    return { ...res, data }
  }

  // ── Запрос, на который умеет ответить только сервер ──
  async function online(req, acc, offlineMessage = '') {
    const route = req.path.split('?')[0]
    const offlineSays = () => offlineMessage || offlineText(route)

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
    if (!token) return offline(offlineSays())

    const res = await remote(req, token)
    // Связи нет или ответил не наш сервер. Настоящую ошибку сервера (500 с объяснением)
    // отдаём как есть — её текст полезнее общего «нужен интернет»
    if (!res.status || res.foreign) return offline(offlineSays(), !!res.timedOut)
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
      // Сначала сервер (у него всё за всё время), без связи — касса по своим журналам
      const fallback = matchFallback(req.method, req.path)
      if (fallback) {
        const res = await online(req, acc)
        if (res.status === 0) return await local(fallback, req, acc)
        // Сервер такой записи не знает, а у кассы она есть: товар или поставщика завели без
        // связи (здесь или на соседней кассе), и заведение ещё ждёт отправки — отвечает касса
        if (res.status === 404 && pharmacy && madeOffline(pharmacy.db, route, fallback.params[0])) return await local(fallback, req, acc)
        return res
      }
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

    // ── Обмен кассами по местной сети ──
    lanHub,
    attachLan(net) {
      lanNet = net
    },
    lanStatus() {
      const base = lanNet ? lanNet.status() : { enabled: false, running: false, peers: [], manual: [] }
      return { ...base, fromPeers: pharmacy ? lanAppliedCount(pharmacy.db) : 0 }
    },
    // Вписать адрес соседа вручную (поиск в сети не сработал). Только с правом на
    // настройки касс: это доступ к данным магазина
    async lanAdd(address) {
      if (!pharmacy || !hasPerm(activeAccount(), 'settings.devices')) return { ok: false, error: 'rights' }
      const a = parseAddress(address)
      if (!a) return { ok: false, error: 'address' }
      if (!lanKeyOf(pharmacy)) return { ok: false, error: 'nokey' }
      lanAddManual(pharmacy.db, a.text, clock.now())
      await lanNet?.sync()
      await lanNet?.now()
      return { ok: true }
    },
    async lanRemove(address) {
      if (!pharmacy || !hasPerm(activeAccount(), 'settings.devices')) return false
      const done = lanRemoveManual(pharmacy.db, String(address || ''))
      await lanNet?.sync()
      return done
    },
    async lanForget(peerId) {
      if (!pharmacy || !hasPerm(activeAccount(), 'settings.devices') || typeof peerId !== 'string') return false
      const done = lanForgetPeer(pharmacy.db, peerId)
      await lanNet?.sync()
      return done
    },
    lanNow: () => (lanNet ? lanNet.now() : Promise.resolve([])),

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
        ...describeOp(op, (kind, id) => findForRejected(pharmacy.db, kind, id)),
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
      // Раз в сутки — уборка журнала обмена по сети; чужое, так и не дошедшее до
      // сервера за две недели, снимается
      if (pharmacy) {
        try {
          if (lanPrune(pharmacy.db, clock.now())) send('changed', ['products', 'customers', 'sales', 'returns', 'shifts', 'arrivals'])
        } catch (e) {
          log.warn('обмен по сети: журнал не убран', e)
        }
      }
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
