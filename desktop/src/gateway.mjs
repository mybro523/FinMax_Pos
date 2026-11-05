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
import { randomBytes } from 'node:crypto'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
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
import { confirmLicence, hasLicence, licenceOf, licenceTerms, sealStatus, sealTerms, touchLicence } from './local/licence.mjs'
import { ApiError, getMeta, inTx, newId, openDb, q, setMeta } from './local/db.mjs'
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
import { applyPull, DOC_KEYS, tenantUserOf } from './local/snapshot.mjs'
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
  lanTopSeq,
  lanWideHere,
  waitsForPeer,
} from './local/lan.mjs'
import {
  addDiscrepancies,
  mainAcceptPeers,
  mainLogBase,
  nextRegisterName,
  ownOpDocs,
  pwFromLan,
  pwToLan,
  regApplyBase,
  regInstallDb,
  regPendingEntries,
  resolveDiscrepancy,
  setSoloPaired,
  shopSnapshot,
  shortKind,
  soloDiscrepancies,
  soloPairedList,
} from './local/solonet.mjs'
import { checkRequest, createRemote, DESKTOP_TOKEN, isLinkFailure } from './net.mjs'
import { cleanLogo } from './print/logo.mjs'
import { formatPairCode, newPairCode, pairKeys, pairRequest, parseAddress } from './lan.mjs'
import { createSync } from './sync.mjs'
import { activate as activateCode, activationState, useResetCode } from './local/activation.mjs'
import { validKey } from './local/licence-code.mjs'
import { acceptAll, deleteCustomer, isStandaloneDb, mergeProducts, pruneAccepted, setupShopDb, STANDALONE_CODE } from './local/standalone.mjs'
import { updateUser } from './local/ops/team.mjs'
import { touchedBy as touchedByOp } from './local/outbox.mjs'

// Объяснения для человека. Каждое есть в словаре интерфейса (client/src/lib/i18n.js)
// и показывается на выбранном языке — их сверяет проверка.
export const MESSAGES = {
  needLogin: 'Требуется вход в систему',
  noSealing: 'Пароль на этом компьютере сохранить не удалось — задайте его, когда будет интернет.',
  onlineOnly: 'Этот раздел работает только с интернетом. Касса, склад, инвентаризация, товары, поставщики, расходы, доходы и сотрудники доступны и без него.',
  notSent: 'Эта запись ещё не отправлена на сервер. Изменить или удалить её можно будет после отправки.',
  noOfflineLogin: 'Нет связи с сервером. Под этим именем на этом компьютере ещё не входили — первый вход возможен только с интернетом.',
  // Логотип в программе (магазин без интернета, 1.7.0)
  badLogo: 'Нужна картинка PNG или JPG не больше 300 КБ',
  // Кассы по сети без интернета (1.7.0)
  onMainOnly: 'Это делается на главном компьютере магазина.',
  noMerge: 'Пока к магазину подключены кассы, карточки товаров не объединяются.',
  pairFormat: 'Код подключения — 8 знаков. Проверьте, все ли введены.',
  pairAddress: 'Адрес главного компьютера записан неверно. Пример: 192.168.1.10',
  pairNotFound:
    'Главный компьютер не найден в сети. Проверьте, что он включён, программа на нём открыта и код подключения ещё действует. Не помогает — впишите адрес главного компьютера.',
  pairCode: 'Код подключения неверный или устарел — попросите новый на главном компьютере.',
  pairNoCode: 'На главном компьютере сейчас нет кода подключения — нажмите там «Подключить кассу» и введите новый код.',
  pairConnect: 'Не удалось связаться с главным компьютером. Проверьте сеть и брандмауэр Windows на обоих компьютерах.',
  pairBroken: 'Главный компьютер прислал повреждённые данные. Повторите подключение.',
  pairOtherShop: 'Эта касса раньше работала в другом магазине — подключить её к этому нельзя.',
  pairNotMain: 'Этот компьютер — касса магазина, подключить к нему другую кассу нельзя.',
  // Сверить оплату не с чем: зашифрованной записи о проверке сервером нет (её стёрли, или
  // проверки на этом компьютере не было) — работа после проверки (1.6.5, gateway withTerms)
  unverified: 'Программа не может подтвердить оплату магазина на этом компьютере. Подключите интернет хотя бы на минуту — работа продолжится сразу после проверки. Все чеки сохранены на этом компьютере.',
  suspended: 'Работа магазина приостановлен. Обратитесь к поставщику программы.',
  broken: 'Программа не смогла выполнить действие. Повторите; если не поможет — перезапустите программу.',
  oldSale: 'Этот чек оформлен давно и на кассе не хранится. Возврат по нему возможен только с интернетом.',
  // Файл базы испорчен, а убрать его и поднять копию не даёт другая программа
  dbBusy: BUSY_MESSAGE,
  rejectedSale: REJECTED_SALE,
  // ── Магазин без интернета (версия 1.6.0) ──
  soloUnavailable: 'В программе без интернета этот раздел не нужен: всё хранится на этом компьютере.',
  soloNotFound: 'Запись не найдена',
  wrongLogin: 'Неверное имя или пароль',
  oldPassword: 'Текущий пароль неверный',
  samePassword: 'Новый пароль совпадает со старым',
  noPasswordChange: 'Менять пароль вам не разрешено. Пароль меняет владелец в разделе «Сотрудники».',
  notActivated: 'Программа не активирована — введите код активации.',
  soloTitle: 'Срок работы программы закончился',
  notStandalone: 'Сначала выберите, как будет работать программа.',
  shopExists: 'Магазин на этом компьютере уже заведён — войдите под своим именем.',
  modeLocked: 'На этом компьютере уже работают — способ работы не меняется.',
  noShopName: 'Укажите название магазина',
  noLogin: 'Укажите имя для входа',
  longLogin: 'Имя для входа — не длиннее 50 знаков',
  loginBusy: 'Такое имя для входа на этом компьютере уже есть',
  noOwner: 'Владелец магазина не найден',
  whichOwner: 'Владельцев несколько — укажите имя того, кому сбросить пароль',
  // Магазин переехал с другого компьютера: пароли сотрудников остались там
  noPasswordHere: 'Пароль этого сотрудника на этом компьютере ещё не задан. Владелец задаёт его в разделе «Сотрудники».',
  noOwnerPasswordHere:
    'Пароль владельца на этом компьютере не задан. Войдите логином и паролем, которые задали здесь при заведении магазина, или нажмите «Забыли пароль?» — нужен код сброса от поставщика программы.',
  // С подстановкой логинов — по словарю не переводятся
  whichOwnerHere: (logins) =>
    `В загруженной копии несколько владельцев: ${logins.map((l) => `«${l}»`).join(', ')}. Войдите логином своего владельца из этого списка и паролем этого компьютера.`,
  loginMoved: (typed, now) => `Ваш логин на этом компьютере теперь «${now}»: логин «${typed}» в загруженной копии занят сотрудником. Войдите как «${now}» тем же паролем.`,
}

// Неверный пароль без связи: сколько ждать сервер (вдруг пароль сменили там)
const TYPO_WAIT_MS = 4000

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
// Вид документа → раздел окна (основа от главного компьютера называет документы видами)
const KIND_KEY_ALL = Object.fromEntries(Object.entries(DOC_KEYS).map(([key, kind]) => [kind, key]))

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
  // Основной или запасной адрес сервера (apibase.mjs, с 1.6.5). Нет — запросы идут на apiUrl.
  // pickWaitMs — сколько запрос ждёт выбора адреса (проверки ставят поменьше)
  chooser = null,
  pickWaitMs,
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
  // Магазин без интернета (1.6.0): открытый ключ кодов активации (из сборки) и код этого
  // компьютера — 5 байт и как его видит человек («XXXXX-XXXXX»)
  standalone = {},
  // 1.7.0: все магазины без интернета (config.mjs, OFFLINE_ONLY): компьютер, работавший с
  // сервером, переходит на работу без интернета при запуске
  offlineOnly = false,
  // Логотип магазина сменился (1.6.4) — экран покупателя показывает новый сразу
  onLogo = () => {},
  // Кассы по сети без интернета (1.7.0): порт, на котором главный слушает поиск (udpPort) —
  // проверки запускают программы на своих портах; обычно — порт по умолчанию (lan.mjs)
  lanPorts = {},
}) {
  const deviceId = deviceIdOf(core)
  // Обмен называет серверу ключ кассы: под её номером сервер слушает только того,
  // кто назвал этот ключ (см. local/accounts.mjs)
  const asDevice = { 'X-Device-Key': deviceKeyOf(core) }
  const remote = createRemote({ apiUrl, chooser, pickWaitMs, fetchImpl, onDate: (d, age) => clock.serverTime(d, age) })

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

  // Обмен, которого нет: магазин без интернета. Тот же набор действий, что у настоящего
  // (sync.mjs), — остальной код шлюза не различает, есть ли у магазина сервер
  const idleSync = () => ({
    start: async () => {},
    stop() {},
    kick() {},
    run: async () => ({ ok: true, changed: [] }),
    current: () => null,
    state: () => ({ online: false, syncing: false }),
    isOnline: () => false,
  })

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

    // Магазин без интернета обмена не ведёт: сервера у него нет (см. ниже, «Магазин без интернета»).
    // Только на компьютере, выбравшем работу без интернета (см. isSolo)
    ph.sync = code === STANDALONE_CODE && getMeta(core, 'appMode') === 'standalone' ? idleSync() : createSync({
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
        waitsForPeer: (op) => waitsForPeer(db, op, clock.now()),
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
            patient: true,
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
          const probe = await remote({ method: 'GET', path: '/health', timeoutMs: 10000, patient: true })
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
        return remote({ method: 'GET', path: '/sync/pull?' + query, timeoutMs: SYNC_TIMEOUT_MS, headers: asDevice, patient: true }, token)
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
    // Магазин без интернета: обмена нет, ждать нечего — показывать есть только срок активации
    if (isSolo(acc)) {
      return {
        online: false,
        standalone: true,
        checking: false,
        syncing: false,
        blocked: false,
        refused: '',
        pending: 0,
        rejected: 0,
        waiting: false,
        fromPeers: 0,
        syncedAt: null,
        licence: null,
        activation: activation(),
        restored: restoredNote(pharmacy.db),
        // Кассы по сети (1.7.0): главный — его кассы и код подключения; касса — её главный
        net: soloNet(),
      }
    }
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
      // Работа без связи: с 1.6.5 без ограничения; checkedAt — последняя связь с сервером
      licence: { checkedAt: lic.checkedAt, unlimited: true },
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
    let byId, roles, roleSys, peerRoles, per, known, teamAt, outcome
    try {
      byId = new Map(q(db, 'SELECT * FROM team_accounts').all().map((a) => [a.id, a]))
      roles = new Map(q(db, 'SELECT id, permissions FROM team_roles').all().map((r) => [r.id, r.permissions]))
      // Встроенная роль ('cashier' — «Кассир»: касса сразу после входа, без плиток меню)
      roleSys = new Map(q(db, 'SELECT id, system FROM team_roles').all().map((r) => [r.id, r.system || '']))
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
            // Магазин без интернета: владелец, заведённый на этом компьютере, которого не удалось
            // сопоставить с владельцем из загруженной копии (soloAdopt), — не «пропавший из списка»:
            // иначе в магазин некому было бы войти. Удалённый в «Сотрудниках» (x.del) — уходит
            const soloOwnerHere = code === STANDALONE_CODE && row.role === 'founder'
            if (x.del || failedCreation || (known && (!teamAt || row.seenAt < teamAt) && !soloOwnerHere)) {
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
            // Сотрудник без роли — кассир прежней версии; роли нет в списке — прежняя отметка
            const roleSystem = founder ? 'owner' : !a.roleId ? 'cashier' : roleSys.has(a.roleId) ? roleSys.get(a.roleId) : row.roleSystem || ''
            if (roleSystem !== (row.roleSystem || '')) set.roleSystem = roleSystem
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
          for (const other of holders(r.to, r.id)) {
            if (byId.has(other.id)) continue
            // Владельца магазина без интернета и того, кто сейчас за кассой, чужой логин не вытесняет
            const o = accountById(core, other.id)
            if ((code === STANDALONE_CODE && o?.role === 'founder') || other.id === active) continue
            q(core, 'DELETE FROM accounts WHERE id = ?').run(other.id)
          }
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
          for (const other of q(core, 'SELECT id, role FROM accounts WHERE login = ? AND id <> ?').all(a.login, id)) {
            // Владельца магазина без интернета чужой логин из копии не вытесняет (см. шаг 1)
            if (code === STANDALONE_CODE && other.role === 'founder') continue
            if (!byId.has(other.id)) q(core, 'DELETE FROM accounts WHERE id = ?').run(other.id)
          }
          if (q(core, 'SELECT 1 FROM accounts WHERE login = ?').get(a.login)) continue
          q(
            core,
            `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, tenantUserId, seenAt, permissions, roleName, blocked, localPw, roleSystem)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id, a.login, a.role, code, tmpl.pharmacyName || '', p.sealed, tmpl.subStatus || 'active', tmpl.paidUntil ?? null, a.userId ?? null,
            new Date(clock.now()).toISOString(), founder ? '' : roles.has(a.roleId) ? permsJson(roles.get(a.roleId)) : '', founder ? 'Владелец' : a.roleName || '',
            a.active && x.activeBy !== 'peer' ? 0 : 1, p.state === 'pending' ? p.opId : null,
            founder ? 'owner' : !a.roleId ? 'cashier' : roleSys.get(a.roleId) || '',
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
      if (/приостановлен/i.test(text)) {
        setSubscription(core, acc.pharmacyCode, { status: 'suspended' })
        sealStatus(core, acc.pharmacyCode, 'suspended', sealing)
      } else if (/Подписка закончилась/.test(text)) {
        setSubscription(core, acc.pharmacyCode, { status: 'expired' })
        sealStatus(core, acc.pharmacyCode, 'expired', sealing)
      }
    }
  }

  // Что сервер сказал о сотруднике и его магазине — запомнить для работы без связи
  function remember(user, extra = {}) {
    const acc = saveAccount(core, user, { now: clock.now(), ...extra })
    if (acc && user.subscription) {
      setSubscription(core, acc.pharmacyCode, { status: user.subscription.status, paidUntil: user.subscription.paidUntil })
      // Сервер ответил про подписку — отметка «последняя связь с сервером» (по ней же
      // держится память часов, см. local/licence.mjs)
      confirmLicence(
        core,
        acc.pharmacyCode,
        { now: clock.now(), days: user.subscription.offlineDays, paidUntil: user.subscription.paidUntil ?? null, status: user.subscription.status ?? null },
        sealing,
      )
    }
    return acc ? accountById(core, acc.id) : null
  }

  // ── Можно ли работать ──
  // По слову сервера о подписке: магазин заблокирован или кончилась оплата — работа закрыта.
  // Дату окончания оплаты касса знает заранее и закрывается в срок и без связи. Срока работы
  // без связи с 1.6.5 нет (решение владельца сервиса 05.11.2026, см. local/licence.mjs): без
  // интернета касса работает сколько угодно
  const licence = (acc) => licenceOf(core, acc.pharmacyCode, licNow(), sealing)

  // ── Подписка: обычные столбцы сверяются с зашифрованной записью (1.6.5) ──
  // Срок оплаты и состояние лежат и в обычных столбцах (accounts), и в зашифрованной записи
  // (local/licence.mjs) — со слова сервера в оба места. Столбцы можно поправить руками, запись —
  // нет. Пока срок работы без связи ограничивал такую правку месяцем, этого хватало; с 1.6.5 срока
  // нет — поэтому срок оплаты берётся более ранний, состояние — более строгое. Записи нет вовсе —
  // проверки сервером на этом компьютере не было (её пишет любой вход и обмен с интернетом) или её
  // стёрли: работа — после проверки
  const STRICT = { suspended: 3, expired: 2, trial: 1, active: 0 }
  function withTerms(acc) {
    if (!acc) return acc
    let t = licenceTerms(core, acc.pharmacyCode, sealing)
    if (!t) return { ...acc, unverified: true }
    // Запись прежней версии программы (до 1.6.5) срока оплаты не знает: до первого ответа сервера
    // берём обычные столбцы — и сразу запечатываем их, чтобы поздняя правка руками не помогла
    if (t.paidUntil == null && t.status == null && (acc.paidUntil || acc.subStatus)) {
      sealTerms(core, acc.pharmacyCode, { paidUntil: acc.paidUntil || null, status: acc.subStatus || null }, sealing)
      t = licenceTerms(core, acc.pharmacyCode, sealing) || t
    }
    const plain = Date.parse(acc.paidUntil || '')
    const sealed = Date.parse(t.paidUntil || '')
    const paidUntil = Number.isFinite(sealed) && !(plain <= sealed) ? t.paidUntil : acc.paidUntil
    const subStatus = (STRICT[t.status] ?? -1) > (STRICT[acc.subStatus] ?? -1) ? t.status : acc.subStatus
    return { ...acc, paidUntil, subStatus }
  }

  function access(acc) {
    // Магазин без интернета: подписки сервера нет — всё решает сам компьютер (soloAccess)
    if (isSolo(acc)) return soloAccess()
    const t = withTerms(acc)
    if (t?.unverified) return { status: 'unverified', canWrite: false, warn: true, message: MESSAGES.unverified }
    return subscriptionOf(t, licNow())
  }

  // Магазин без интернета: срок (если он есть) вышел посреди смены — кассир должен увидеть причину
  // сразу. У магазина с сервером срока работы без связи с 1.6.5 нет — объявлять нечего
  let closedByLicence = false
  function watchLicence() {
    const acc = activeAccount()
    if (!acc || !isSolo(acc)) {
      closedByLicence = false
      return
    }
    const sub = soloAccess()
    const expired = !sub.canWrite
    if (expired && !closedByLicence) send('suspended', { message: sub.message, title: MESSAGES.soloTitle, standalone: true, until: activation().untilHuman || '' })
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

  // ── Магазин без интернета (версия 1.6.0) ──
  // Сервера у такого магазина нет вовсе: вход — по отпечатку пароля здесь, каждая операция
  // принимается сразу после записи (local/standalone.mjs, acceptAll), а срок работы держит код
  // активации (local/activation.mjs). Способ работы выбирают при первом запуске (appMode)
  const solo = {
    publicKey: typeof standalone?.publicKey === 'string' ? standalone.publicKey : '',
    computerRaw: Buffer.isBuffer(standalone?.computerRaw) ? standalone.computerRaw : null,
    computerCode: typeof standalone?.computerCode === 'string' ? standalone.computerCode : '',
    // 1.7.0: кода активации нет (решение владельца сервиса 05.11.2026) — программа работает без
    // срока, касс сколько угодно. Механизм кодов не убран: вернуть его — requireCode: true (ключ и
    // код компьютера нужны и без него: ими подписан код сброса пароля владельца)
    requireCode: standalone?.requireCode === true,
  }
  const appMode = () => getMeta(core, 'appMode') || ''

  // ── 1.7.0: все магазины без интернета ──
  // Компьютер, работавший с сервером (тестовые магазины), переходит на работу без интернета:
  // входы сотрудников магазинов сервера убираются (файлы их баз остаются на диске — их никто не
  // открывает), способ работы — «без интернета». Магазин заводится заново, как на новом компьютере
  function toStandalone() {
    try {
      const cloud = q(core, 'SELECT id, login FROM accounts WHERE pharmacyCode <> ?').all(STANDALONE_CODE)
      inTx(core, () => {
        for (const a of cloud) q(core, 'DELETE FROM accounts WHERE id = ?').run(a.id)
        if (appMode() !== 'standalone') setMeta(core, 'appMode', 'standalone')
      })
      for (const a of cloud) session.drop(a.id)
      if (session.activeId() && !accountById(core, session.activeId())) session.deactivate()
      if (cloud.length) log.info(`без интернета: убраны входы магазинов сервера — ${cloud.map((a) => a.login).join(', ')}`)
    } catch (e) {
      log.error('переход на работу без интернета не удался', e)
    }
  }
  if (offlineOnly) toStandalone()
  // Магазин без интернета — и код магазина 'local', и способ работы этого компьютера: магазин
  // сервера с таким кодом (сервер его больше не выдаёт, но мог выдать раньше) на компьютере,
  // работающем с сервером, обменивается с ним как обычно
  function isSolo(acc) {
    return acc?.pharmacyCode === STANDALONE_CODE && appMode() === 'standalone'
  }
  const soloFile = () => join(dataDir, `pharmacy-${fileSafe(STANDALONE_CODE)}.db`)
  const soloAccounts = () => q(core, 'SELECT * FROM accounts WHERE pharmacyCode = ?').all(STANDALONE_CODE)
  // Список сотрудников магазина (база магазина) — в магазине без интернета он главный
  const soloTeam = (ph) => q(ph.db, 'SELECT id, login, role, userId, active FROM team_accounts ORDER BY ord, createdAt, id').all()
  // Магазин на этом компьютере заведён. Обычно это видно по входу (общая база). Общая база могла
  // потеряться (испорчена, начата заново), а база магазина цела: магазин всё равно есть — войти
  // можно через «Забыли пароль?» с кодом сброса (он заводит вход владельца заново)
  function soloShop() {
    if (q(core, 'SELECT 1 FROM accounts WHERE pharmacyCode = ? LIMIT 1').get(STANDALONE_CODE)) return true
    if (appMode() !== 'standalone' || !existsSync(soloFile())) return false
    try {
      return !!q(openPharmacy(STANDALONE_CODE).db, 'SELECT 1 FROM team_accounts LIMIT 1').get()
    } catch {
      return false
    }
  }
  // Время срока кода. Обычно — часы программы: назад они не идут (local/clock.mjs), опираясь на
  // зашифрованную запись о прожитом времени. Записи нет (её стёрли, чтобы перевести часы назад и
  // «вернуть» срок, или общая база начата заново) — время срока не раньше самого позднего
  // документа магазина: стереть документы — значит потерять магазин. Пока запись есть, даты
  // документов (их могли записать и сбитые вперёд часы) на срок не влияют
  function soloNow() {
    const now = licNow()
    if (appMode() !== 'standalone' || hasLicence(core, STANDALONE_CODE, sealing)) return now
    if (!existsSync(soloFile())) return now
    let floor = 0
    try {
      const db = openPharmacy(STANDALONE_CODE).db
      for (const sql of ['SELECT MAX(date) AS m FROM docs', 'SELECT MAX(createdAt) AS m FROM outbox']) {
        const v = Date.parse(q(db, sql).get()?.m || '')
        if (Number.isFinite(v) && v > floor) floor = v
      }
    } catch {
      /* база магазина не открылась — только часы */
    }
    return Math.max(now, floor)
  }
  // Без кода активации (requireCode: false) — работает всегда, без срока и без счёта касс
  const FREE = { active: true, activated: true, expired: false, warn: false, forever: true, until: null, untilHuman: null, endsAt: null, daysLeft: null, registers: null, serial: 0, message: '', free: true }
  function activation() {
    if (!solo.requireCode) return FREE
    return activationState(core, { publicKey: solo.publicKey, computerRaw: solo.computerRaw, now: soloNow() })
  }
  // Подписка — словами сервера: окно показывает её так же, как подписку магазина с сервером
  function soloAccess() {
    const a = activation()
    if (a.active) return { status: 'active', canWrite: true, warn: !!a.warn, daysLeft: a.daysLeft, paidUntil: a.endsAt, message: a.message || '', standalone: true }
    return { status: 'expired', canWrite: false, warn: true, daysLeft: 0, paidUntil: a.endsAt ?? null, message: a.message || MESSAGES.notActivated, standalone: true }
  }
  const soloView = (acc) => ({ ...userView(acc, licNow()), subscription: soloAccess(), standalone: true })

  async function soloLogin(name, password) {
    const login = String(name ?? '').trim()
    let ph = null
    if (soloShop()) {
      try {
        ph = openPharmacy(STANDALONE_CODE)
      } catch (e) {
        log.error('магазин без интернета: база магазина не открылась при входе', e)
      }
    }
    // Касса магазина (1.7.0): база пришла с главного, учётные записи — тоже (regLogins), и
    // сверять их не с чем: «переезда» здесь не было
    if (ph && !isRegister()) {
      // Загружена копия (с другого компьютера или своя прежняя): вход сверяется со списком
      // сотрудников магазина — сначала вход владельца, заведённого здесь, потом лишние входы
      try {
        const moved = await soloAdopt(ph, login, String(password ?? ''))
        if (moved?.refuse) return refuse(401, moved.refuse)
        soloPrune(ph)
      } catch (e) {
        log.error('магазин без интернета: вход не сверен со списком сотрудников', e)
      }
    }
    try {
      const acc = await offlineLogin(core, { name, password }, { now: licNow(), open })
      // На компьютере магазина без интернета входят только его сотрудники
      if (!isSolo(acc)) return refuse(401, MESSAGES.wrongLogin)
      session.activate(acc.id)
      onSession()
      enter(acc)
      log.info(`вход (без интернета): ${acc.login}`)
      return reply(201, { token: DESKTOP_TOKEN, user: soloView(acc) })
    } catch (e) {
      if (!(e instanceof ApiError)) throw e
      if (e.status === 503) {
        // Сотрудник магазина есть, а пароля для этого компьютера у него нет: магазин переехал
        // сюда копией, а отпечатки паролей остались на старом компьютере (они зашифрованы
        // средствами того Windows). Кому задать пароль и как — так и говорим
        const need = ph ? soloNeedsPassword(ph, login) : ''
        if (need) return refuse(401, need)
        // Такого имени здесь нет — для человека это тот же «неверное имя или пароль»
        return refuse(401, MESSAGES.wrongLogin)
      }
      return refuse(e.status, e.message)
    }
  }

  // Сотрудник с этим логином в магазине есть и не заблокирован, а войти ему здесь не по чему:
  // что ему сказать (пусто — сказать нечего, обычный отказ)
  function soloNeedsPassword(ph, login) {
    if (!login) return ''
    try {
      const member = q(ph.db, 'SELECT id, role, active FROM team_accounts WHERE login = ?').get(login)
      if (!member || !member.active) return ''
      const row = accountByLogin(core, login)
      if (row && row.id === member.id && row.verifier && open(row.verifier)) return ''
      return member.role === 'founder' ? MESSAGES.noOwnerPasswordHere : MESSAGES.noPasswordHere
    } catch {
      return ''
    }
  }

  // ── Магазин переехал на этот компьютер (загружена копия с другого) ──
  // Здесь завели магазин заново — с владельцем и паролем этого компьютера — и загрузили копию
  // старого. Владелец, заведённый здесь, и владелец в копии — один человек: его вход (пароль
  // этого компьютера) переходит к владельцу из копии — когда он сам входит этим паролем. Иначе их
  // было бы двое: «Сотрудники» показывали бы одного, а входил бы другой. Кому из владельцев копии
  // перейти: тому, чьим логином человек вошёл, или с тем же логином, что здесь, или единственному;
  // владельцев несколько и не ясно, кто он, — просим войти логином своего владельца из копии.
  // Пароли остальных сотрудников остались на старом компьютере — их задаёт владелец в «Сотрудниках».
  // Ответ: null — переходить нечему; { adopted } — перешёл; { refuse } — что сказать вместо входа
  async function soloAdopt(ph, login, password) {
    const team = soloTeam(ph)
    if (!team.length) return null
    const inTeam = new Set(team.map((a) => a.id))
    const strays = soloAccounts().filter((r) => r.role === 'founder' && !inTeam.has(r.id))
    if (!strays.length) return null
    // Владельцы из копии без своего входа здесь (или со входом, по которому здесь не войти:
    // отпечаток пароля со старого компьютера не расшифровать)
    const usable = new Set(soloAccounts().filter((r) => r.verifier && open(r.verifier)).map((r) => r.id))
    const free = team.filter((a) => a.role === 'founder' && a.active && !usable.has(a.id))
    if (!free.length) return null
    for (const row of strays) {
      // Без пароля этого владельца вход никому не переходит
      const verifier = row.verifier ? open(row.verifier) : null
      if (!verifier || !(await checkVerifier(password, verifier))) continue
      const byTyped = login !== row.login ? free.find((a) => a.login === login) || null : null
      const match = byTyped || free.find((a) => a.login === row.login) || (free.length === 1 ? free[0] : null)
      if (!match) return { refuse: MESSAGES.whichOwnerHere(free.map((a) => a.login)) }
      const shopName = String(getMeta(ph.db, 'shopName') || '') || row.pharmacyName
      // Логин — тот, которым человек входит: логин владельца из копии, если вошёл им, иначе логин
      // этого компьютера. Его занял сотрудник из копии — остаётся логин из копии, и человеку надо
      // об этом сказать: тем логином, что он набрал, ему больше не войти
      let finalLogin = match.login
      let movedTo = ''
      if (!byTyped && match.login !== row.login) {
        try {
          updateUser({ db: ph.db, now: clock.now(), user: { accountId: match.id, id: match.userId || 'acc:' + match.id, name: match.login, role: 'founder', permissions: [] }, deviceId }, match.id, { name: row.login })
          acceptAll(ph.db, { now: clock.now() })
          finalLogin = row.login
        } catch (e) {
          movedTo = match.login
          log.warn(`магазин без интернета: логин владельца из копии (${match.login}) не заменён на ${row.login}: ${e?.message || e}`)
        }
      }
      try {
        inTx(core, () => {
          q(core, 'DELETE FROM accounts WHERE id = ?').run(match.id)
          q(core, 'UPDATE accounts SET id = ?, tenantUserId = ?, login = ?, pharmacyName = ?, blocked = 0, localPw = NULL, prevVerifier = NULL WHERE id = ?').run(
            match.id, match.userId ?? null, finalLogin, shopName, row.id,
          )
        })
      } catch (e) {
        log.error(`магазин без интернета: вход владельца ${row.login} не перешёл к владельцу из копии`, e)
        return null
      }
      session.drop(row.id)
      ph.users.clear()
      log.warn(`магазин переехал на этот компьютер: вход владельца ${row.login} теперь у владельца из копии (логин ${finalLogin})`)
      return movedTo ? { refuse: MESSAGES.loginMoved(row.login, movedTo) } : { adopted: true }
    }
    return null
  }

  // Вход, которого нет в списке сотрудников магазина, убирается: после загрузки своей прежней
  // копии это сотрудник, заведённый позже неё, — в магазине его больше нет. Не трогаем владельца,
  // заведённого здесь, пока его вход может перейти к владельцу из копии (soloAdopt), и того, кто
  // сейчас за кассой (уберётся после выхода)
  function soloPrune(ph) {
    const team = soloTeam(ph)
    if (!team.length) return
    const inTeam = new Set(team.map((a) => a.id))
    const usable = new Set(soloAccounts().filter((r) => r.verifier && open(r.verifier)).map((r) => r.id))
    const adoptable = team.some((a) => a.role === 'founder' && a.active && !usable.has(a.id))
    for (const r of soloAccounts()) {
      if (inTeam.has(r.id)) continue
      if (r.role === 'founder' && adoptable) continue
      if (r.id === session.activeId()) continue
      q(core, 'DELETE FROM accounts WHERE id = ?').run(r.id)
      session.drop(r.id)
      log.warn(`магазин без интернета: вход ${r.login} убран — в базе магазина такого сотрудника нет`)
    }
    // Название магазина — из его базы (у загруженной копии оно своё)
    const shopName = String(getMeta(ph.db, 'shopName') || '')
    if (shopName) q(core, 'UPDATE accounts SET pharmacyName = ? WHERE pharmacyCode = ? AND pharmacyName <> ?').run(shopName, STANDALONE_CODE, shopName)
  }

  // Сделанное принять сразу — как принял бы сервер. Сотрудники: перенос во вход до приёма (свой
  // пароль, заведение) и после (приём закрепляет пароль) — так же, как при обмене с сервером
  function soloAccept(ph, { team = false } = {}) {
    // Касса магазина (1.7.0): принимает главный. Своё — в журнал обмена и главному поскорее
    if (isRegister()) {
      try {
        lanCatchUp(ph.db, { deviceId, now: clock.now(), fates: false, pwOut: pwOutFor(ph) })
      } catch (e) {
        log.warn('касса: операция не записалась в журнал обмена', e)
      }
      lanNet?.kick()
      send('status', status())
      return
    }
    if (team) teamToCore(ph)
    let done = []
    const extras = []
    // К главному подключены кассы: своё — сначала в журнал (касса получит операцию), приём и
    // основа для касс — одной записью на диск
    const net = soloRegisters(ph).length > 0
    try {
      inTx(ph.db, () => {
        if (net) lanCatchUp(ph.db, { deviceId, now: clock.now(), fates: false, pwOut: pwOutFor(ph) })
        done = acceptAll(ph.db, { now: clock.now(), extras })
        if (net && done.length) {
          mainLogBase(ph.db, { ops: done.map((op) => ({ id: op.id, type: op.type, docs: ownOpDocs(ph.db, op) })), extras, deviceId, now: clock.now() })
        }
      })
    } catch (e) {
      // Не принялось — останется в очереди и примется со следующей записью
      log.error('магазин без интернета: операции не приняты', e)
      done = []
    }
    // Приняты правки сотрудников или ролей (в том числе ждавшие с прошлого раза) — вход по ним
    // закрепляется сейчас: иначе отметка «пароль задан здесь» пережила бы свою операцию
    if (team || done.some((op) => /^(user|role)\./.test(op.type || ''))) {
      teamToCore(ph)
      // Кассам — новые учётные записи (логины, роли, пароли)
      if (net) {
        try {
          mainLogBase(ph.db, { logins: soloLoginsFor(ph), deviceId, now: clock.now() })
        } catch (e) {
          log.error('кассы по сети: учётные записи для касс не записаны', e)
        }
      }
    }
    if (net && done.length) lanNet?.kick()
    const keys = new Set(done.flatMap((op) => touchedByOp(op)))
    // То, что сервер заводит сам: оплата прихода из кассы, списание недостачи по пересчёту
    if (done.some((op) => op.type === 'arrival')) keys.add('supplierPayments')
    if (done.some((op) => op.type === 'inventory.apply')) keys.add('writeoffs')
    if (keys.size) send('changed', [...keys])
    send('status', status())
  }

  // Действие, которое раньше умел только сервер: выполняется здесь, под теми же правами
  async function soloWrite(acc, keys, fn, perms = []) {
    const closed = closedBySubscription(access(acc))
    if (closed) return closed
    if (perms.length && !perms.every((k) => hasPerm(acc, k))) return refuse(403, 'Недостаточно прав')
    const ph = openPharmacy(acc.pharmacyCode)
    let data
    try {
      data = fn(ph)
    } catch (e) {
      if (e instanceof ApiError) return refuse(e.status, e.messages || e.message)
      log.error('магазин без интернета: действие не выполнено', e)
      return refuse(500, MESSAGES.broken)
    }
    send('changed', keys)
    send('status', status())
    return reply(200, data)
  }

  async function soloRequest(req, acc) {
    const route = req.path.split('?')[0]
    // Касса магазина (1.7.0): сотрудников и роли заводят и меняют на главном (вход на кассах —
    // по учётным записям главного); удалить покупателя — тоже там (главный разошлёт)
    if (isRegister() && req.method !== 'GET' && (TEAM_ROUTE.test(route) || /^\/customers\/[^/]+$/.test(route) && req.method === 'DELETE')) {
      return refuse(403, MESSAGES.onMainOnly)
    }
    // Всё, что касса умеет сама, — как всегда; история товара и карточка поставщика — здесь же:
    // у этой кассы все документы за всё время
    const found = matchLocal(req.method, req.path) || matchFallback(req.method, req.path)
    if (found) return local(found, req, acc)
    let m
    if (req.method === 'POST' && (m = /^\/products\/([^/]+)\/merge$/.exec(route))) {
      if (isRegister() || soloRegisters(pharmacy).length) return refuse(409, MESSAGES.noMerge)
      const fromId = decodeURIComponent(m[1])
      return soloWrite(acc, ['products'], (ph) => mergeProducts(ph.db, fromId, String(req.body?.into ?? ''), { now: clock.now() }), ['products.edit', 'products.delete'])
    }
    if (req.method === 'DELETE' && (m = /^\/customers\/([^/]+)$/.exec(route))) {
      const id = decodeURIComponent(m[1])
      return soloWrite(
        acc,
        ['customers', 'payments', 'shifts'],
        (ph) => {
          const done = deleteCustomer(ph.db, id)
          // Кассам — с основой: покупатель, его долг и погашения уходят и у них
          if (soloRegisters(ph).length) {
            mainLogBase(ph.db, { gone: { customers: [id] }, deviceId, now: clock.now() })
            lanNet?.kick()
          }
          return done
        },
        ['customers.delete'],
      )
    }
    // Расхождения (1.7.0): касса продала без главного больше, чем было на складе — их видит главный
    if (req.method === 'GET' && route === '/discrepancies') return reply(200, isRegister() || !pharmacy ? [] : soloDiscrepancies(pharmacy.db))
    if (req.method === 'POST' && (m = /^\/discrepancies\/([^/]+)\/resolve$/.exec(route))) {
      if (isRegister() || !pharmacy) return refuse(403, MESSAGES.onMainOnly)
      if (!resolveDiscrepancy(pharmacy.db, decodeURIComponent(m[1]))) return refuse(404, MESSAGES.notFound)
      send('changed', ['discrepancies'])
      return reply(200, { ok: true })
    }
    if (req.method === 'GET' && route === '/sync/devices') return reply(200, [])
    return refuse(404, MESSAGES.soloUnavailable)
  }

  // Свой пароль — без сервера: проверяем прежний по отпечатку и записываем новый поправкой
  // сотрудника (как владелец меняет пароль в «Сотрудниках»), принимая её сразу
  const soloPwFails = new Map()
  async function soloChangePassword(req, acc) {
    if (!(acc.role === 'founder' || hasPerm(acc, 'profile.password'))) return refuse(403, MESSAGES.noPasswordChange)
    const oldPw = String(req.body?.oldPassword ?? '')
    const newPw = String(req.body?.newPassword ?? '')
    const fails = soloPwFails.get(acc.id) || { n: 0, until: 0 }
    if (fails.until > clock.now()) return refuse(429, 'Слишком много попыток. Попробуйте через минуту')
    const verifier = acc.verifier ? open(acc.verifier) : null
    if (!verifier || !(await checkVerifier(oldPw, verifier))) {
      fails.n += 1
      if (fails.n >= 5) Object.assign(fails, { n: 0, until: clock.now() + 60000 })
      soloPwFails.set(acc.id, fails)
      return refuse(400, MESSAGES.oldPassword)
    }
    soloPwFails.delete(acc.id)
    const problem = passwordProblem(newPw)
    if (problem) return refuse(400, problem)
    if (newPw === oldPw) return refuse(400, MESSAGES.samePassword)
    const sealed = seal(await makeVerifier(newPw))
    if (!sealed) return refuse(400, MESSAGES.noSealing)
    const ph = openPharmacy(acc.pharmacyCode)
    try {
      updateUser({ db: ph.db, now: clock.now(), user: { ...docUser(ph, acc), permissions: permissionsOf(acc) }, deviceId }, acc.id, { passwordSealed: sealed })
    } catch (e) {
      if (e instanceof ApiError) return refuse(e.status, e.messages || e.message)
      throw e
    }
    soloAccept(ph, { team: true })
    // Касса: новый пароль действует здесь сразу; главный узнает его с операцией (pwLan)
    if (isRegister()) q(core, 'UPDATE accounts SET verifier = ? WHERE id = ?').run(sealed, acc.id)
    return reply(201, { token: DESKTOP_TOKEN })
  }

  // ── До входа: способ работы, активация, магазин, сброс пароля владельца ──
  const soloApi = {
    info() {
      return {
        mode: appMode(),
        // На компьютере уже работали с сервером — выбор не показывается
        cloudAccounts: q(core, 'SELECT COUNT(*) AS n FROM accounts WHERE pharmacyCode <> ?').get(STANDALONE_CODE).n,
        shop: soloShop(),
        computer: solo.computerCode,
        ready: validKey(solo.publicKey) && !!solo.computerRaw,
        activation: activation(),
        // 1.7.0: способа работы не выбирают (всегда без интернета); код активации не нужен
        offlineOnly,
        codeRequired: solo.requireCode,
        // Касса магазина ('register') или главный компьютер (''); что с её главным — для экрана входа
        role: soloRole(),
        net: soloShop() ? soloNet() : null,
      }
    },
    // Кассы по сети (1.7.0). Подключить кассу — до входа (первый запуск) и после (заново)
    join(raw) {
      return soloJoin(raw)
    },
    pairStart() {
      return pairStart()
    },
    pairStop() {
      return pairStop()
    },
    unpair(id) {
      return soloUnpair(String(id ?? ''))
    },
    net() {
      return soloNet()
    },
    isRegister() {
      return appMode() === 'standalone' && isRegister()
    },
    // Выбор при первом запуске. Пока на компьютере никто не входил, его можно поменять
    chooseMode(mode) {
      if (!['cloud', 'standalone', ''].includes(mode)) return { error: MESSAGES.notStandalone }
      // Все магазины без интернета — другого способа работы нет
      if (offlineOnly && mode !== 'standalone') return { error: MESSAGES.notStandalone }
      if (q(core, 'SELECT 1 FROM accounts LIMIT 1').get()) return { error: MESSAGES.modeLocked }
      setMeta(core, 'appMode', mode)
      return { ok: true, mode }
    },
    activate(code) {
      if (appMode() !== 'standalone') return { error: MESSAGES.notStandalone }
      const now = soloNow()
      const r = activateCode(core, { publicKey: solo.publicKey, computerRaw: solo.computerRaw, code: String(code ?? ''), now })
      if (r.error) return r
      // Записи о прожитом времени нет (общая база начата заново): заводим её снова — от того же
      // времени, не раньше последнего документа магазина (soloNow)
      if (soloShop() && !hasLicence(core, STANDALONE_CODE, sealing)) confirmLicence(core, STANDALONE_CODE, { now, days: 30 }, sealing)
      log.info(`код активации принят: ${r.forever ? 'навсегда' : 'до ' + r.until}, касс — ${r.registers}`)
      // Срок мог закончиться посреди работы — новый код открывает её сразу
      watchLicence()
      if (activeAccount()) send('status', status())
      return { ok: true, activation: r }
    },
    async setupShop(raw) {
      if (appMode() !== 'standalone') return { error: MESSAGES.notStandalone }
      const a = activation()
      if (!a.active) return { error: a.expired ? a.message : MESSAGES.notActivated }
      if (soloShop()) return { error: MESSAGES.shopExists }
      const shopName = String(raw?.shopName ?? '').trim().slice(0, 120)
      const login = String(raw?.login ?? '').trim()
      const password = String(raw?.password ?? '')
      if (!shopName) return { error: MESSAGES.noShopName }
      if (!login) return { error: MESSAGES.noLogin }
      if (login.length > 50) return { error: MESSAGES.longLogin }
      if (q(core, 'SELECT 1 FROM accounts WHERE login = ?').get(login)) return { error: MESSAGES.loginBusy }
      const problem = passwordProblem(password)
      if (problem) return { error: problem }
      const sealed = seal(await makeVerifier(password))
      if (!sealed) return { error: MESSAGES.noSealing }
      const ownerId = newId()
      const ownerUserId = newId()
      const now = clock.now()
      const ph = openPharmacy(STANDALONE_CODE)
      try {
        setupShopDb(ph.db, { shopName, ownerId, ownerUserId, login, now })
      } catch (e) {
        if (e instanceof ApiError) return { error: e.message }
        throw e
      }
      q(
        core,
        `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, tenantUserId, seenAt, permissions, roleName, roleSystem)
         VALUES (?, ?, 'founder', ?, ?, ?, 'active', NULL, ?, ?, '', 'Владелец', 'owner')`,
      ).run(ownerId, login, STANDALONE_CODE, shopName, sealed, ownerUserId, new Date(now).toISOString())
      // Запись «до какого момента программа дожила» — та же, что у магазина с сервером: по ней
      // часы программы после перезапуска не идут назад (clock.mjs, licence.mjs)
      confirmLicence(core, STANDALONE_CODE, { now: licNow(), days: 30 }, sealing)
      // С этой минуты отсчитывается неделя до первого напоминания «сохраните копию на флешку»
      setMeta(core, 'soloSince', String(now))
      log.info(`магазин без интернета заведён: «${shopName}», владелец ${login}`)
      return { ok: true, login }
    },
    async resetPassword(raw) {
      if (appMode() !== 'standalone') return { error: MESSAGES.notStandalone }
      if (isRegister()) return { error: MESSAGES.onMainOnly }
      const r = useResetCode(core, { publicKey: solo.publicKey, computerRaw: solo.computerRaw, code: String(raw?.code ?? ''), now: soloNow() })
      if (r.error) return r
      if (!soloShop()) return { error: MESSAGES.noOwner }
      const ph = openPharmacy(STANDALONE_CODE)
      // Владельцы — по списку сотрудников магазина: он главный. Входа у владельца здесь может и не
      // быть — магазин переехал сюда копией или общая база начата заново: код сброса заводит его
      const owners = soloTeam(ph).filter((a) => a.role === 'founder' && a.active)
      if (!owners.length) return { error: MESSAGES.noOwner }
      const login = String(raw?.login ?? '').trim()
      const target = login ? owners.find((o) => o.login === login) : owners.length === 1 ? owners[0] : null
      if (!target) return { error: login ? MESSAGES.noOwner : MESSAGES.whichOwner }
      const password = String(raw?.password ?? '')
      const problem = passwordProblem(password)
      if (problem) return { error: problem }
      const sealed = seal(await makeVerifier(password))
      if (!sealed) return { error: MESSAGES.noSealing }
      try {
        inTx(core, () => {
          // С тем же логином — только он (владелец, заведённый здесь до загрузки копии, уходит)
          for (const other of q(core, 'SELECT id FROM accounts WHERE login = ? AND id <> ?').all(target.login, target.id)) {
            q(core, 'DELETE FROM accounts WHERE id = ?').run(other.id)
            session.drop(other.id)
          }
          if (!accountById(core, target.id)) {
            q(
              core,
              `INSERT INTO accounts (id, login, role, pharmacyCode, pharmacyName, verifier, subStatus, paidUntil, tenantUserId, seenAt, permissions, roleName, roleSystem)
               VALUES (?, ?, 'founder', ?, ?, ?, 'active', NULL, ?, ?, '', 'Владелец', 'owner')`,
            ).run(target.id, target.login, STANDALONE_CODE, String(getMeta(ph.db, 'shopName') || ''), sealed, target.userId ?? null, new Date(clock.now()).toISOString())
          }
        })
        const acc = accountById(core, target.id)
        updateUser({ db: ph.db, now: clock.now(), user: { ...docUser(ph, acc), permissions: [] }, deviceId }, target.id, { passwordSealed: sealed })
      } catch (e) {
        if (e instanceof ApiError) return { error: e.message }
        log.error('магазин без интернета: пароль владельца не сброшен', e)
        return { error: MESSAGES.broken }
      }
      soloAccept(ph, { team: true })
      soloPrune(ph)
      // Подбор пароля до сброса больше не держит вход
      loginSucceeded(core, target.login)
      r.mark()
      log.warn(`пароль владельца ${target.login} сброшен кодом сброса`)
      return { ok: true, login: target.login }
    },
  }

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
  // ── Магазин без интернета: кассы по сети (1.7.0) ──
  // Сервера нет — его роль берёт главный компьютер (local/solonet.mjs): принимает операции касс,
  // рассылает им основу, выдаёт код подключения. Роль этого компьютера — в общей базе программы:
  // soloRole 'register' — касса магазина, soloMain — её главный (номер, имя, «поколение» базы,
  // номер магазина); иначе — главный (или единственный) компьютер
  const soloRole = () => getMeta(core, 'soloRole') || ''
  const isRegister = () => soloRole() === 'register'
  function soloMain() {
    try {
      const v = JSON.parse(getMeta(core, 'soloMain') || 'null')
      return v && typeof v.deviceId === 'string' && v.deviceId ? v : null
    } catch {
      return null
    }
  }
  // Открыта база магазина без интернета
  const soloOpen = (ph) => !!ph && ph.code === STANDALONE_CODE && appMode() === 'standalone'
  // Кассы главного (по порядку подключения)
  const soloRegisters = (ph) => (ph && !isRegister() ? soloPairedList(ph.db) : [])

  // Ключ сети магазина: у главного заводится при первом коде подключения (вместе с «поколением»
  // базы и номером магазина), касса получает его при подключении. Хранится зашифрованным
  function mainKey(ph) {
    let key = lanKeyOf(ph)
    if (!key) {
      key = randomBytes(32).toString('base64url')
      const sealed = seal(key)
      if (!sealed) return ''
      setMeta(ph.db, 'lanKey', sealed)
      ph.lanKey = key
    }
    if (!getMeta(ph.db, 'soloEpoch')) setMeta(ph.db, 'soloEpoch', newId())
    if (!getMeta(ph.db, 'shopId')) setMeta(ph.db, 'shopId', newId())
    return key
  }
  const mainName = (ph) => getMeta(ph.db, 'deviceName') || 'Главный компьютер'

  // Отпечаток пароля для соседей: здесь он зашифрован средствами Windows, по сети — ключом магазина
  const pwOutFor = (ph) => (sealed) => {
    const key = lanKeyOf(ph)
    const v = key ? open(sealed) : null
    return v ? pwToLan(key, v) : null
  }

  // Учётные записи сотрудников для касс: вход на кассе — теми же логинами и паролями, что на
  // главном, и без главного (отпечатки — зашифрованы ключом магазина)
  function soloLoginsFor(ph) {
    const key = lanKeyOf(ph)
    return q(core, 'SELECT * FROM accounts WHERE pharmacyCode = ?')
      .all(STANDALONE_CODE)
      .map((a) => {
        const v = key && a.verifier ? open(a.verifier) : null
        let permissions = []
        try {
          const list = JSON.parse(a.permissions || '[]')
          if (Array.isArray(list)) permissions = list.filter((k) => typeof k === 'string')
        } catch {
          permissions = []
        }
        return {
          id: a.id,
          login: a.login,
          role: a.role,
          roleName: a.roleName || '',
          roleSystem: a.roleSystem || null,
          permissions,
          blocked: a.blocked ? 1 : 0,
          tenantUserId: a.tenantUserId || null,
          pw: v ? pwToLan(key, v) : null,
        }
      })
  }

  // Касса: учётные записи от главного — во вход этой кассы (пароли — ключом этого компьютера).
  // Своя смена пароля, которую главный ещё не принял, не перетирается прежним паролем
  function regLogins(ph, logins, key = lanKeyOf(ph)) {
    if (!Array.isArray(logins)) return
    const shopName = String(getMeta(ph.db, 'shopName') || '')
    const ownPw = new Set(
      q(
        ph.db,
        `SELECT DISTINCT e.rowId FROM row_edits e JOIN outbox o ON o.id = e.opId
         WHERE o.state = 'pending' AND e.tbl = 'team_accounts' AND json_extract(e.data, '$.pw') IS NOT NULL`,
      )
        .all()
        .map((r) => r.rowId),
    )
    const keep = new Set()
    inTx(core, () => {
      for (const l of logins) {
        if (typeof l?.id !== 'string' || !l.id || typeof l.login !== 'string' || !l.login) continue
        keep.add(l.id)
        const v = l.pw ? pwFromLan(key, l.pw) : null
        const sealedPw = v ? seal(v) : null
        const user = {
          id: l.id,
          name: l.login,
          role: l.role === 'founder' ? 'founder' : 'cashier',
          roleName: l.roleName || '',
          roleSystem: l.roleSystem || null,
          permissions: Array.isArray(l.permissions) ? l.permissions : [],
          pharmacy: { code: STANDALONE_CODE, name: shopName },
          subscription: { status: 'active', paidUntil: null },
        }
        saveAccount(core, user, { now: clock.now(), ...(ownPw.has(l.id) ? {} : { verifier: sealedPw }) })
        q(core, 'UPDATE accounts SET blocked = ?, tenantUserId = ? WHERE id = ?').run(l.blocked ? 1 : 0, l.tenantUserId || null, l.id)
      }
      for (const a of q(core, 'SELECT id FROM accounts WHERE pharmacyCode = ?').all(STANDALONE_CODE)) {
        if (keep.has(a.id)) continue
        q(core, 'DELETE FROM accounts WHERE id = ?').run(a.id)
        session.drop(a.id)
      }
    })
    if (session.activeId() && !accountById(core, session.activeId())) {
      session.deactivate()
      onSession()
    }
  }

  // Главный: пароли, заданные на кассах (пришли с их операциями) — во вход главного. С этой минуты
  // нынешний пароль сотрудника известен здесь (pwLearned): перенос сотрудников во вход его не сотрёт
  function soloPeerPasswords(ph, list) {
    const key = lanKeyOf(ph)
    for (const p of list) {
      const v = pwFromLan(key, p.pwLan)
      const sealedPw = v ? seal(v) : null
      if (!sealedPw) continue
      q(core, 'UPDATE accounts SET verifier = ?, localPw = NULL, prevVerifier = NULL WHERE id = ? AND pharmacyCode = ?').run(sealedPw, p.id, STANDALONE_CODE)
      pwLearned(ph.db, p.id)
    }
  }

  // Главный: операции касс, пришедшие по сети, — в принятые; основа — в журнал для касс
  function mainAccept(ph) {
    let r
    try {
      r = mainAcceptPeers(ph.db, { now: clock.now() })
    } catch (e) {
      log.error('кассы по сети: операции касс не приняты', e)
      return []
    }
    if (!r.ops.length) return []
    const team = r.ops.some((o) => /^(user|role)\./.test(o.type || ''))
    if (team) teamToCore(ph)
    if (r.pw.length) soloPeerPasswords(ph, r.pw)
    if (r.short.length) {
      const regs = new Map(soloPairedList(ph.db).map((x) => [x.deviceId, x.name]))
      addDiscrepancies(
        ph.db,
        r.short.map((x) => ({
          id: newId(),
          kind: shortKind(x.type),
          productId: x.productId,
          name: x.name,
          units: x.units,
          date: x.createdAt,
          deviceName: regs.get(x.origin) || '',
          userName: (x.accountId && accountById(core, x.accountId)?.login) || '',
          opId: x.opId,
        })),
      )
    }
    try {
      mainLogBase(ph.db, { ops: r.ops, extras: r.extras, logins: team || r.pw.length ? soloLoginsFor(ph) : [], deviceId, now: clock.now() })
    } catch (e) {
      log.error('кассы по сети: основа не записана', e)
    }
    const keys = new Set(['products', 'shifts'])
    for (const o of r.ops) for (const d of o.docs || []) if (KIND_KEY_ALL[d.kind]) keys.add(KIND_KEY_ALL[d.kind])
    if (r.extras.some((d) => d.kind === 'supplierpayment')) keys.add('supplierPayments')
    if (r.extras.some((d) => d.kind === 'writeoff')) keys.add('writeoffs')
    if (team) keys.add('users')
    if (r.short.length) keys.add('discrepancies')
    return [...keys]
  }

  // Касса: записи главного по порядку — операции поправкой, основа — когда до неё дошло
  function regReceive(ph, entries) {
    const changed = new Set()
    let chunk = []
    const flush = () => {
      if (!chunk.length) return
      const r = lanReceive(ph.db, chunk, { now: clock.now(), gen: lanGen(ph.db) })
      for (const k of r.changed) changed.add(k)
      chunk = []
    }
    for (const e of entries) {
      if (e?.kind !== 'base') {
        chunk.push(e)
        continue
      }
      flush()
      try {
        const keys = regApplyBase(ph.db, e, {
          onLogins: (list) => regLogins(ph, list),
          // Логотип ставят на главном — касса берёт его из основы (чеки, экран покупателя)
          onLogo: (l) => keepLogo(ph, l.logo, l.at),
        })
        for (const k of keys) changed.add(k)
      } catch (err) {
        log.error('касса: основа от главного не легла', err)
      }
    }
    flush()
    return [...changed]
  }

  // Магазин без интернета: база открыта и до входа (запуск программы) — главный отвечает своим
  // кассам и с экрана входа, касса получает сделанное на главном
  function soloWake() {
    if (appMode() !== 'standalone' || !existsSync(soloFile())) return
    try {
      openPharmacy(STANDALONE_CODE)
      lanNet?.sync().catch(() => {})
    } catch (e) {
      log.error('магазин без интернета: база магазина не открылась при запуске', e)
    }
  }

  // Уборка журнала обмена в магазине без интернета. Ничто не «истекает»: чужое принял главный.
  // Убирается старое (lan.mjs, LOG_KEEP_DAYS), что уже получили все: главный — все его кассы,
  // касса — главный
  function soloPrune_lan(ph) {
    const ids = isRegister() ? [soloMain()?.deviceId].filter(Boolean) : soloPairedList(ph.db).map((r) => r.deviceId)
    const got = ids.map((id) => lanPeer(ph.db, id)?.sentUpTo ?? 0)
    const keepAbove = got.length ? Math.min(...got) : lanTopSeq(ph.db)
    lanPrune(ph.db, clock.now(), { expire: false, keepAbove })
  }

  // ── Код подключения кассы ──
  // 8 знаков, 10 минут, одна касса. Только в памяти: закрыли программу — кода нет. Двадцать
  // неверных попыток — код закрыт (подбор)
  const PAIR_MS = 10 * 60 * 1000
  let pairing = null
  const pairOpen = () => (pairing && clock.now() < pairing.until ? pairing : null)
  function pairStart() {
    const acc = activeAccount()
    if (!acc || !isSolo(acc)) return { error: MESSAGES.soloUnavailable }
    if (isRegister()) return { error: MESSAGES.pairNotMain }
    if (!(acc.role === 'founder' || hasPerm(acc, 'settings.devices'))) return { error: 'Недостаточно прав' }
    const ph = openPharmacy(acc.pharmacyCode)
    if (!mainKey(ph)) return { error: MESSAGES.noSealing }
    const code = newPairCode()
    pairing = { code, keys: pairKeys(code), until: clock.now() + PAIR_MS, fails: 0 }
    lanNet?.sync().catch(() => {})
    send('status', status())
    log.info('кассы по сети: открыт код подключения')
    return { ok: true, code: formatPairCode(code), until: new Date(pairing.until).toISOString() }
  }
  function pairStop() {
    pairing = null
    lanNet?.sync().catch(() => {})
    send('status', status())
    return { ok: true }
  }

  // Главный: касса пришла с верным кодом — база магазина целиком и всё, что кассе надо знать
  function pairServe({ from, name, host, shopId, entries }) {
    const ph = pharmacy
    if (!pairOpen() || !soloOpen(ph) || isRegister()) return { error: 'nocode' }
    const myShop = getMeta(ph.db, 'shopId') || ''
    if (shopId && shopId !== myShop) return { error: 'othershop' }
    const now = clock.now()
    const at = new Date(now).toISOString()
    // Касса подключается заново: её операции, которые главный ещё не принял, — сначала принять
    if (Array.isArray(entries) && entries.length) {
      try {
        lanReceive(ph.db, entries, { now, gen: lanGen(ph.db) })
        mainAccept(ph)
      } catch (e) {
        log.error('кассы по сети: операции кассы при подключении не приняты', e)
      }
    }
    // Своё неотправленное (его быть не должно: главный принимает сразу) — принять до снимка
    soloAccept(ph)
    const list = soloPairedList(ph.db)
    const known = list.find((r) => r.deviceId === from)
    const regName = known?.name || nextRegisterName(list)
    const hostName = String(host || '').slice(0, 60)
    setSoloPaired(
      ph.db,
      known ? list.map((r) => (r.deviceId === from ? { ...r, host: hostName, pairedAt: at } : r)) : [...list, { deviceId: from, name: regName, host: hostName, pairedAt: at }],
    )
    const topSeq = lanTopSeq(ph.db)
    // Касса получит журнал главного с этого места: всё, что раньше, — уже в снимке
    lanPeerSeen(ph.db, { deviceId: from, name: regName, wide: true, ok: true, now })
    lanPeerProgress(ph.db, from, { sentUpTo: topSeq, gotUpTo: 0 })
    let db
    try {
      db = shopSnapshot(ph.db)
    } catch (e) {
      log.error('кассы по сети: снимок базы для кассы не снят', e)
      return { error: 'broken' }
    }
    pairing = null
    log.info(`кассы по сети: подключена ${regName} (${hostName || from})`)
    setTimeout(() => {
      send('status', status())
      lanNet?.kick()
    }, 0)
    return {
      meta: {
        main: { deviceId, name: mainName(ph) },
        shopId: myShop,
        epoch: getMeta(ph.db, 'soloEpoch') || '',
        topSeq,
        key: lanKeyOf(ph),
        name: regName,
        shopName: getMeta(ph.db, 'shopName') || '',
        logins: soloLoginsFor(ph),
      },
      db,
    }
  }

  // Касса: подключиться к главному по коду (первый запуск — магазина на этом компьютере ещё нет)
  const PAIR_ERRORS = {
    format: 'pairFormat',
    address: 'pairAddress',
    notfound: 'pairNotFound',
    code: 'pairCode',
    nocode: 'pairNoCode',
    connect: 'pairConnect',
    big: 'pairBroken',
    broken: 'pairBroken',
    othershop: 'pairOtherShop',
  }
  let joining = false
  async function soloJoin(raw) {
    if (appMode() !== 'standalone') return { error: MESSAGES.notStandalone }
    if (joining) return { error: MESSAGES.broken }
    // Касса подключается заново (главный загрузил копию базы или отключил её): её операции, которые
    // главный ещё не принял, — с собой: он примет их до того, как снимет базу для кассы
    const again = isRegister() && soloShop()
    if (!again && soloShop()) return { error: MESSAGES.shopExists }
    let entries = []
    if (again) {
      try {
        const ph = openPharmacy(STANDALONE_CODE)
        lanCatchUp(ph.db, { deviceId, now: clock.now(), fates: false, pwOut: pwOutFor(ph) })
        entries = regPendingEntries(ph.db)
      } catch (e) {
        log.error('касса: свои операции для главного не собраны', e)
        return { error: MESSAGES.broken }
      }
    }
    joining = true
    let r
    try {
      r = await pairRequest({
        code: String(raw?.code ?? ''),
        address: String(raw?.address ?? ''),
        deviceId,
        name: '',
        host: hostname(),
        shopId: again ? soloMain()?.shopId || '' : '',
        entries,
        ...(Number.isInteger(lanPorts.udpPort) && lanPorts.udpPort > 0 ? { udpPort: lanPorts.udpPort } : {}),
      })
    } finally {
      joining = false
    }
    if (r.error) return { error: MESSAGES[PAIR_ERRORS[r.error] || 'pairBroken'] || MESSAGES.pairBroken }
    const m = r.meta || {}
    if (typeof m.key !== 'string' || !m.key || typeof m.main?.deviceId !== 'string' || !Buffer.isBuffer(r.db)) return { error: MESSAGES.pairBroken }
    const sealedKey = seal(m.key)
    if (!sealedKey) return { error: MESSAGES.noSealing }
    // База главного — файлом магазина этой кассы
    closePharmacy()
    const file = soloFile()
    try {
      writeFileSync(file + '.new', r.db)
      for (const ext of ['', '-wal', '-shm']) rmSync(file + ext, { force: true })
      renameSync(file + '.new', file)
    } catch (e) {
      log.error('касса: база главного не записалась', e)
      return { error: MESSAGES.broken }
    }
    let ph
    try {
      ph = openPharmacy(STANDALONE_CODE)
      regInstallDb(ph.db, { main: m.main, address: r.address, port: r.port, topSeq: m.topSeq, lanKeySealed: sealedKey, name: m.name, now: clock.now() })
      ph.lanKey = m.key
    } catch (e) {
      log.error('касса: база главного не открылась', e)
      return { error: MESSAGES.broken }
    }
    setMeta(core, 'soloRole', 'register')
    setMeta(core, 'soloMain', JSON.stringify({ deviceId: m.main.deviceId, name: String(m.main.name || ''), epoch: String(m.epoch || ''), shopId: String(m.shopId || '') }))
    regLogins(ph, m.logins, m.key)
    confirmLicence(core, STANDALONE_CODE, { now: licNow(), days: 30 }, sealing)
    if (!getMeta(core, 'soloSince')) setMeta(core, 'soloSince', String(clock.now()))
    ph.users.clear()
    lanNet?.sync().catch(() => {})
    // Подключились заново за работой — окно перечитывает всё
    if (again) {
      send('changed', [...LOCAL_SECTIONS, 'shop', 'discrepancies'])
      send('status', status())
    }
    log.info(`касса подключена к магазину «${m.shopName || ''}» как ${m.name || ''} (главный ${m.main.name || m.main.deviceId})`)
    return { ok: true, shopName: String(m.shopName || ''), name: String(m.name || '') }
  }

  // Главный: отключить кассу (её ключ сети больше не принимается)
  function soloUnpair(regId) {
    const acc = activeAccount()
    if (!acc || !isSolo(acc) || isRegister()) return { error: MESSAGES.onMainOnly }
    if (!(acc.role === 'founder' || hasPerm(acc, 'settings.devices'))) return { error: 'Недостаточно прав' }
    const ph = openPharmacy(acc.pharmacyCode)
    const list = soloPairedList(ph.db)
    if (!list.some((r) => r.deviceId === regId)) return { error: MESSAGES.notFound }
    setSoloPaired(ph.db, list.filter((r) => r.deviceId !== regId))
    try {
      lanForgetPeer(ph.db, regId)
    } catch {
      /* соседа могло и не быть */
    }
    lanNet?.sync().catch(() => {})
    send('status', status())
    return { ok: true }
  }

  // Что показать в окне про кассы по сети. На связи — по обмену (lan.mjs: последний обмен не
  // дольше 20 секунд назад); error — что сказал сосед в последний раз ('epoch' — главный загрузил
  // копию базы, 'star' — главный отключил эту кассу: подключить заново)
  function soloNet() {
    const ph = pharmacy
    if (!soloOpen(ph)) return null
    let live = new Map()
    try {
      live = new Map((lanNet?.status().peers || []).map((p) => [p.deviceId, p]))
    } catch {
      /* сеть не ответила — покажем, что знает база */
    }
    const seen = new Map(lanPeers(ph.db).map((p) => [p.deviceId, p]))
    if (isRegister()) {
      const m = soloMain()
      const p = m ? live.get(m.deviceId) : null
      return {
        role: 'register',
        name: getMeta(ph.db, 'deviceName') || '',
        main: m ? { name: m.name || '', online: !!p?.online, seenAt: seen.get(m.deviceId)?.okAt || null, error: p?.error || '', address: seen.get(m.deviceId)?.address || '' } : null,
        // Своё, что главный ещё не принял
        pending: pendingCount(ph.db),
      }
    }
    const p = pairOpen()
    return {
      role: 'main',
      name: mainName(ph),
      registers: soloPairedList(ph.db).map((r) => {
        const peer = live.get(r.deviceId)
        return { deviceId: r.deviceId, name: r.name, host: r.host || '', pairedAt: r.pairedAt || null, online: !!peer?.online, seenAt: seen.get(r.deviceId)?.okAt || null }
      }),
      pairing: p ? { code: formatPairCode(p.code), until: new Date(p.until).toISOString() } : null,
      discrepancies: soloDiscrepancies(ph.db).length,
    }
  }

  const lanHub = {
    state() {
      const ph = pharmacy
      if (!ph) return null
      // Магазин без интернета: звезда вокруг главного; часы касс с сервером не сверены (anyTime)
      if (soloOpen(ph)) {
        const reg = isRegister()
        const m = reg ? soloMain() : null
        const key = lanKeyOf(ph)
        const enabled = !!key && (reg ? !!m : soloPairedList(ph.db).length > 0 || !!pairOpen())
        return {
          enabled,
          key,
          deviceId,
          name: reg ? getMeta(ph.db, 'deviceName') || '' : mainName(ph),
          wide: true,
          epoch: reg ? m?.epoch || '' : getMeta(ph.db, 'soloEpoch') || '',
          anyTime: true,
        }
      }
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
      if (soloOpen(ph)) {
        // Своё — уже в журнале (soloAccept); отметок о судьбе нет — принятое кассы узнают из основы
        lanCatchUp(ph.db, { deviceId, now: clock.now(), fates: false, pwOut: pwOutFor(ph) })
        return lanEntriesSince(ph.db, since, { wide: true })
      }
      lanCatchUp(ph.db, { deviceId, now: clock.now() })
      return lanEntriesSince(ph.db, since, { wide })
    },
    receive(peerId, entries) {
      const ph = pharmacy
      if (!ph || !Array.isArray(entries) || !entries.length) return
      if (soloOpen(ph)) {
        let keys = []
        if (isRegister()) {
          if (peerId !== soloMain()?.deviceId) return
          keys = regReceive(ph, entries)
        } else {
          if (!soloPairedList(ph.db).some((r) => r.deviceId === peerId)) return
          lanReceive(ph.db, entries, { now: clock.now(), gen: lanGen(ph.db) })
          keys = mainAccept(ph)
        }
        if (keys.length) send('changed', keys)
        lanNet?.kick()
        send('status', status())
        return
      }
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
    // Магазин без интернета (1.7.0): звезда — касса говорит только с главным, главный — только со
    // своими кассами; «поколение» базы главного (сменилось — он загрузил копию, кассам подключиться заново)
    allow(id) {
      const ph = pharmacy
      if (!soloOpen(ph)) return true
      if (isRegister()) return id === soloMain()?.deviceId
      return soloPairedList(ph.db).some((r) => r.deviceId === id)
    },
    epochOk(e) {
      const ph = pharmacy
      if (!soloOpen(ph)) return true
      const mine = isRegister() ? soloMain()?.epoch || '' : getMeta(ph.db, 'soloEpoch') || ''
      return !mine || e === mine
    },
    pairInfo() {
      const p = pairOpen()
      return p && soloOpen(pharmacy) && !isRegister() ? p.keys : null
    },
    pairFailed() {
      if (!pairing) return
      pairing.fails += 1
      if (pairing.fails >= 20) {
        pairing = null
        log.warn('кассы по сети: код подключения закрыт — слишком много неверных попыток')
        send('status', status())
      }
    },
    pairServe: (req) => pairServe(req),
  }

  // ── Вход ──
  async function login(req) {
    const name = String(req.body?.name ?? '')
    const password = String(req.body?.password ?? '')
    // Компьютер магазина без интернета: сервера нет — проверяем здесь, к серверу не ходим
    if (appMode() === 'standalone' || isSolo(accountByLogin(core, name.trim()))) return soloLogin(name, password)
    let res = await remote(req)

    // Сервер не ответил или ответил бедой по дороге — проверяем пароль сами
    if (isLinkFailure(res)) {
      let refusal = null
      try {
        // Счёт неудачных попыток и срок подписки — по времени срока: за часами компьютера,
        // которым нельзя верить, оно не идёт, и переводом даты запрет на вход не снять
        const acc = await offlineLogin(core, { name, password }, { now: licNow(), open, terms: withTerms, unverified: MESSAGES.unverified })
        session.activate(acc.id)
        onSession()
        enter(acc)
        log.info(`вход без связи: ${acc.login}`)
        return reply(201, { token: DESKTOP_TOKEN, user: { ...userView(withTerms(acc), licNow()), subscription: access(acc) } })
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        refusal = e
      }
      // Без сервера не вышло: человека здесь не знают, пароль не тот (его могли сменить на сервере),
      // оплату не подтвердить или она закончилась (сервер мог её продлить). Если сам вход на сервер
      // не ходил (сервер недавно молчал или адрес ещё выбирается) — пробуем по-настоящему: на медленной
      // связи короткая проверка адреса могла не успеть (net.mjs). На неверный пароль — коротко
      // (опечатка не должна ждать, пока Windows ищет адрес, 10–15 секунд). Кроме «слишком много попыток»
      if (res.skipped && refusal.status !== 429) {
        const typo = refusal.status === 401 && refusal.message === 'Неверное имя или пароль'
        res = await remote({ ...req, patient: true, ...(typo ? { timeoutMs: Math.min(req.timeoutMs || TYPO_WAIT_MS, TYPO_WAIT_MS) } : {}) })
      }
      if (isLinkFailure(res)) {
        // Человека на этом компьютере не знают — отвечаем как «нет связи», но с объяснением
        if (refusal.status === 503) return offline(MESSAGES.noOfflineLogin, !!res.timedOut)
        return refuse(refusal.status, refusal.message)
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
      // Логотип убрали, пока программа была закрыта или без связи: окно за ним не пойдёт
      // (сервер сказал «логотипа нет») — стираем и копию кассы, иначе лента печатала бы прежний
      if (ph) logoFromView(ph, user.pharmacy)
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
    if (isSolo(acc)) {
      const view = soloView(accountById(core, acc.id))
      return closedBySubscription(view.subscription) || reply(200, view)
    }
    const token = session.tokenOf(acc.id)
    if (token) {
      const res = await remote(req, token)
      if (res.status === 200 && res.data?.id) {
        remember(res.data)
        if (pharmacy && pharmacy.code === acc.pharmacyCode) logoFromView(pharmacy, res.data.pharmacy)
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
    if (isSolo(acc)) return soloChangePassword(req, acc)
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

  // ── Логотип магазина (1.6.4) ──
  // Картинку ставит владелец сервиса; касса печатает её на чеках и ленте и показывает на
  // экране покупателя — и без интернета. Поэтому последняя полученная картинка лежит в базе
  // магазина (meta: shopLogo, shopLogoAt). Окно спрашивает GET /shop/logo: есть связь — ответ
  // сервера (он же — в базу), нет связи или сервер прежней версии — то, что лежит.
  const LOGO_KEY = 'shopLogo'
  const LOGO_AT_KEY = 'shopLogoAt'
  let logoMemo = { code: '', logo: '', at: null }
  function storedLogo(ph) {
    if (logoMemo.code !== ph.code) {
      const logo = cleanLogo(getMeta(ph.db, LOGO_KEY) || '')
      logoMemo = { code: ph.code, logo, at: logo ? getMeta(ph.db, LOGO_AT_KEY) || null : null }
    }
    return logoMemo
  }
  function keepLogo(ph, logo, at) {
    const was = storedLogo(ph)
    const clean = cleanLogo(logo)
    const when = clean && typeof at === 'string' ? at : null
    if (was.logo === clean && was.at === when) return
    inTx(ph.db, () => {
      setMeta(ph.db, LOGO_KEY, clean)
      setMeta(ph.db, LOGO_AT_KEY, when || '')
    })
    logoMemo = { code: ph.code, logo: clean, at: when }
    try {
      onLogo()
    } catch {
      /* экран покупателя не важнее кассы */
    }
  }
  // Сверка с сервером. Ответы могут прийти не по порядку (окно, «связь вернулась» и сигнал
  // «магазин изменился» спрашивают почти разом, а картинка едет секунды) — записывается только
  // ответ на последний вопрос. У сервера спрашиваем со своей отметкой: та же картинка — он
  // ответит коротко ({ same: true }), без сотен килобайт. Отказ сервера (401/403) — возвращаем
  let logoSeq = 0
  async function fetchLogo(ph, acc, timeoutMs) {
    const token = session.tokenOf(acc.id)
    if (!token) return null
    const my = ++logoSeq
    const kept = storedLogo(ph)
    const known = kept.logo && kept.at ? kept.at : ''
    const res = await remote({ method: 'GET', path: '/shop/logo' + (known ? '?at=' + encodeURIComponent(known) : ''), timeoutMs }, token)
    // Ответил не наш сервер (вход в чужой Wi-Fi) — как «нет связи»: сессию не трогаем
    if (res.foreign) return null
    if (res.status === 200 && res.data && typeof res.data === 'object') {
      if (my === logoSeq && !(res.data.same === true && known && res.data.at === known)) keepLogo(ph, res.data.logo, res.data.at)
      return null
    }
    if (res.status === 401 || res.status === 403) {
      denied(acc, res)
      return res
    }
    return null
  }
  // Сверка в фоне (связь вернулась, «кто я» сказал «логотипа нет»): сменился — окну сигнал
  // «магазин изменился», оно заберёт картинку у кассы
  async function refreshLogo() {
    const acc = activeAccount()
    if (!acc || !pharmacy || pharmacy.code !== acc.pharmacyCode) return
    const ph = pharmacy
    const before = storedLogo(ph)
    await fetchLogo(ph, acc)
    const after = storedLogo(ph)
    if (after.logo !== before.logo || after.at !== before.at) send('changed', ['shop'])
  }
  // «Логотипа нет» в ответе «кто я» или входа (logoAt: null). У кассы картинки и нет — делать
  // нечего. Есть — сверяемся с сервером, а не стираем сразу: «кто я» мог отстать от смены
  // логотипа (сервер помнит сотрудника 10 секунд). Отметки нет вовсе (сервер прежней версии) —
  // ничего не трогаем
  function logoFromView(ph, view) {
    if (view && view.logoAt === null && storedLogo(ph).logo) refreshLogo().catch(() => {})
  }
  // Окну отдаём картинку целиком (это не сеть). Связь есть — сначала сверка с сервером. Связи нет
  // (или касса уже знает, что она плохая) — сразу то, что лежит у кассы, а сверка — в фоне:
  // окно не ждёт пятнадцать секунд, чек печатается с логотипом
  async function shopLogo(req, acc) {
    const ph = openPharmacy(acc.pharmacyCode)
    if (ph.sync.isOnline()) {
      const denial = await fetchLogo(ph, acc, req.timeoutMs)
      if (denial) return denial
    } else refreshLogo().catch(() => {})
    const now = storedLogo(ph)
    return reply(200, { logo: now.logo, at: now.at })
  }

  // Магазин без интернета (1.7.0): сервера нет — логотип ставят в программе («Настройки» → «Чек и
  // печать»). Картинку окно уже подготовило (client/src/lib/logoImage.js): PNG или JPEG до 300 КБ —
  // здесь та же проверка, что у сервера (cleanLogo). Пустая строка — убрать логотип
  async function setShopLogo(req, acc) {
    if (!isSolo(acc)) return refuse(404, MESSAGES.soloUnavailable)
    if (isRegister()) return refuse(403, MESSAGES.onMainOnly)
    if (!(acc.role === 'founder' || hasPerm(acc, 'settings.print'))) return refuse(403, 'Недостаточно прав')
    const raw = req.body?.logo
    if (typeof raw !== 'string') return refuse(400, MESSAGES.badLogo)
    const clean = cleanLogo(raw)
    if (raw && !clean) return refuse(400, MESSAGES.badLogo)
    const ph = openPharmacy(acc.pharmacyCode)
    keepLogo(ph, clean, clean ? new Date(clock.now()).toISOString() : null)
    log.info(clean ? 'логотип магазина поставлен в программе' : 'логотип магазина убран')
    // Кассам — с основой (local/solonet.mjs, mainLogBase: logo)
    if (soloRegisters(ph).length) {
      try {
        mainLogBase(ph.db, { logo: { logo: storedLogo(ph).logo, at: storedLogo(ph).at }, deviceId, now: clock.now() })
        lanNet?.kick()
      } catch (e) {
        log.error('кассы по сети: логотип для касс не записан', e)
      }
    }
    send('changed', ['shop'])
    const now = storedLogo(ph)
    return reply(200, { logo: now.logo, at: now.at })
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
    // Магазин без интернета: все чеки — здесь, за давними ходить некуда
    const standaloneShop = isSolo(acc)

    if (!standaloneShop && req.method === 'POST' && req.path.split('?')[0] === '/returns') {
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
        standalone: standaloneShop,
      })
    } catch (e) {
      if (e instanceof ApiError) return refuse(e.status, e.messages || e.message)
      log.error(`локальный запрос ${req.method} ${req.path.split('?')[0]} не выполнен`, e)
      return refuse(500, MESSAGES.broken)
    }

    if (standaloneShop) {
      // Сервера нет: чего нет здесь, нет нигде
      if (data && (data.__remote || data.__deep)) return refuse(404, MESSAGES.soloNotFound)
      if (req.method !== 'GET') soloAccept(ph, { team: TEAM_ROUTE.test(route) })
      return reply(req.method === 'POST' ? 201 : 200, data)
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
      if (route === '/shop/logo' && req.method === 'GET') return await shopLogo(req, acc)
      if (route === '/shop/logo' && req.method === 'POST') return await setShopLogo(req, acc)
      if (route === '/auth/change-password' && req.method === 'POST') return await changePassword(req, acc)
      if (isSolo(acc)) return await soloRequest(req, acc)

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
    // Магазин без интернета: что показать до входа и что сделать (main.mjs, окно входа)
    standalone: soloApi,

    // Программа запущена: если кто-то был за кассой — открываем его магазин
    // и начинаем обмен с сервером
    resume() {
      const acc = activeAccount()
      if (!acc) {
        // Пометка есть, а сотрудника в базе нет (базу стёрли) — входа нет
        if (session.activeId()) session.deactivate()
        soloWake()
        return false
      }
      try {
        const ph = openPharmacy(acc.pharmacyCode)
        // Магазин без интернета: загруженная копия могла сменить список сотрудников (программа
        // перезапускается после загрузки, но могла и упасть до выхода) — без входа дальше нельзя:
        // при входе вход сверится со списком (soloAdopt, soloPrune)
        if (isSolo(acc) && !q(ph.db, 'SELECT 1 FROM team_accounts WHERE id = ?').get(acc.id)) {
          session.deactivate()
          return false
        }
        // Сеть магазина без интернета — сразу (lanHub.state)
        if (isSolo(acc)) lanNet?.sync().catch(() => {})
        ph.sync.start().catch(() => {})
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
        // …и сверяем логотип магазина (1.6.4)
        refreshLogo().catch(() => {})
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
        sealStatus(core, acc.pharmacyCode, 'suspended', sealing)
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
    // Название магазина вошедшего — как его задали в панели (пробный чек печатается с ним)
    activeShop: () => String(activeAccount()?.pharmacyName || '').trim(),
    // Логотип магазина вошедшего (data URL или ''): печать на ленте и экран покупателя
    // Логотип открытого магазина. За кассой никого (вышли) — всё равно его: экран покупателя
    // после выхода остаётся с названием магазина, пусть и с логотипом. Печатать без входа нельзя
    shopLogo() {
      const acc = activeAccount()
      if (!pharmacy || (acc && pharmacy.code !== acc.pharmacyCode)) return ''
      return storedLogo(pharmacy).logo
    },
    // Есть ли у вошедшего право (любое из перечисленных). Владелец может всё
    activeCan: (...keys) => hasPerm(activeAccount(), ...keys),

    // Открытая база магазина — для резервной копии
    pharmacyFile: () => (pharmacy ? { name: pharmacy.name, db: pharmacy.db } : null),

    // Раз в минуту: память часов и уборка журнала обмена по сети
    tick() {
      // До какого момента программа дожила — в ту же зашифрованную запись, что и
      // проверка подписки: с него часы продолжат после перезапуска (см. licence.mjs)
      const acc = activeAccount()
      if (acc) touchLicence(core, acc.pharmacyCode, licNow(), sealing, floorNow())
      // Магазин без интернета: не вышел ли срок, пока программа просто стояла открытой
      watchLicence()
      // Раз в сутки — уборка журнала обмена по сети; чужое, так и не дошедшее до
      // сервера, а её касса замолчала, снимается (local/lan.mjs)
      if (pharmacy) {
        try {
          if (soloOpen(pharmacy)) soloPrune_lan(pharmacy)
          else if (lanPrune(pharmacy.db, clock.now())) send('changed', ['products', 'customers', 'sales', 'returns', 'shifts', 'arrivals'])
        } catch (e) {
          log.warn('обмен по сети: журнал не убран', e)
        }
        // Магазин без интернета: служебные журналы приёма старше полутора месяцев не нужны
        // (документы остаются все)
        try {
          if (isStandaloneDb(pharmacy.db)) pruneAccepted(pharmacy.db, clock.now())
        } catch (e) {
          log.warn('магазин без интернета: журналы приёма не убраны', e)
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
