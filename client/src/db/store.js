// ── Слой данных фронта поверх REST API (NestJS) ──
// • Оптимистичные обновления: кэш меняется мгновенно, запрос уходит следом.
// • Кэш сохраняется в localStorage → мгновенный старт после перезагрузки.
// • Фоновый polling подтягивает изменения с других устройств (общая база).
// Расширения в путях указаны намеренно: с ними файл загружается не только
// сборщиком, но и напрямую — этим пользуются тесты слоя данных.
import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api.js'
import { dayKey } from '../lib/time.js'
import { blockUpdate } from '../lib/version.js'
import { isDivisible, isVesovoy, kgText, stockUnits, edinica } from '../lib/units.js'

const EMPTY = []
// «returns» и «writeoffs» — журналы возвратов и списаний. Они нужны, чтобы деньги
// сходились: возврат уменьшает выручку и наличные в кассе, списание — прибыль.
// Загружаются только когда страница их запросила (списания доступны лишь владельцу),
// поэтому у кассира они не опрашиваются и 403 не возникает.
//
// «expenses» и «expenseCategories» — расходы магазина и их статьи. Тоже только для
// владельца и тоже по требованию: их запрашивают «Расходы», «Отчёты» и «Настройки».
//
// «incomes» и «incomeCategories» — доходы вне продаж и их статьи: по тем же правилам.
//
// «suppliers» — поставщики (всем; долги в них видит только владелец), «supplierPayments» —
// оплаты им (владельцу), «cashMoves» — внесения и изъятия наличных, «payServices» —
// сервисы перевода для кассы. «supplierReturns» — возвраты товара поставщикам.
const COLLECTIONS = [
  'products', 'sales', 'arrivals', 'customers', 'deferred', 'shifts', 'payments', 'returns', 'writeoffs', 'categories',
  'expenses', 'expenseCategories', 'suppliers', 'supplierPayments', 'cashMoves', 'payServices', 'productTypes',
  'incomes', 'incomeCategories', 'supplierReturns',
]
// Адрес раздела на сервере — там, где он не совпадает с названием раздела здесь
const PATHS = {
  expenseCategories: 'expense-categories', supplierPayments: 'supplier-payments', cashMoves: 'cash-moves', payServices: 'pay-services',
  productTypes: 'product-types', incomeCategories: 'income-categories', supplierReturns: 'supplier-returns',
}
export const pathOf = (key) => '/' + (PATHS[key] || key)
// ── Кэш принадлежит своему магазину ──
// Раньше ключ был общий на всю программу. Пока магазин был один, это ничего
// не значило; теперь на одном компьютере может работать не одна. Владелец сервиса
// заглянул в магазин клиента, вернулся к себе — и до первого ответа сервера видит
// чужие товары. Данные при этом не смешиваются в базе, но на экране показывается
// не то, и заметить подмену невозможно: интерфейс выглядит обычным.
//
// Поэтому в ключ входит код магазина. Чужой кэш просто не находится: он лежит под
// другим именем и подхватить его нельзя даже случайно.
const LS_BASE = 'apteka_cache_v3_'

function currentCode() {
  try {
    // Ключ входа живёт во вкладке; старое хранилище — для проверок без браузера
    const tab = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('apteka_user') : null
    const u = JSON.parse(tab || localStorage.getItem('apteka_user') || 'null')
    return u?.pharmacy?.code || 'net'
  } catch {
    return 'net'
  }
}

// Ключ считается при каждом обращении, а не один раз при загрузке: магазин
// меняется на ходу — вошли под другой учётной записью, заглянули к клиенту
const lsKey = (key) => `${LS_BASE}${currentCode()}_${key}`
const POLL_MS = 8000

// ── Глубина кэша по разделам ──
// В памяти устройства держим только свежие записи — иначе с годами опрос каждые
// восемь секунд тянул бы десятки тысяч чеков, а журналы копились бы в хранилище
// браузера до переполнения. За более ранние даты экраны запрашивают нужный
// отрезок отдельно (loadRange) и получают ВСЮ историю за него.
//
// Продажи держим короче: их больше всех, и в работе нужны последние.
export const SALES_CACHE_DAYS = 60
export const JOURNAL_CACHE_DAYS = 180

export const CACHE_DAYS = {
  sales: SALES_CACHE_DAYS,
  arrivals: JOURNAL_CACHE_DAYS,
  returns: JOURNAL_CACHE_DAYS,
  writeoffs: JOURNAL_CACHE_DAYS,
  payments: JOURNAL_CACHE_DAYS,
  expenses: JOURNAL_CACHE_DAYS,
  incomes: JOURNAL_CACHE_DAYS,
  supplierPayments: JOURNAL_CACHE_DAYS,
  cashMoves: JOURNAL_CACHE_DAYS,
  supplierReturns: JOURNAL_CACHE_DAYS,
}

const QUERY = Object.fromEntries(Object.entries(CACHE_DAYS).map(([k, d]) => [k, `?days=${d}`]))

// Достаёт ли начало периода глубже кэша — значит, за ним надо идти на сервер
export function needsServerFor(key, from) {
  const days = CACHE_DAYS[key]
  if (!days) return false
  const t = from instanceof Date ? from.getTime() : new Date(from).getTime()
  return t < Date.now() - days * 86400000
}

const cache = Object.fromEntries(COLLECTIONS.map((k) => [k, EMPTY]))
const loaded = new Set() // коллекции, успешно загруженные с сервера в этой сессии
const hydrated = new Set() // коллекции, восстановленные из localStorage (есть что показать)
const active = new Map() // key -> сколько открытых экранов сейчас смотрят на коллекцию
const inflight = new Map()
const firstLoading = new Set() // грузятся впервые и показать пока нечего
const mutating = new Map() // key -> число незавершённых оптимистичных мутаций по коллекции
const listeners = new Set()
let conn = 'ok' // 'ok' | 'error' — состояние связи с сервером

// Пока по коллекции идёт оптимистичная мутация (POST/PATCH/DELETE), фоновый polling
// НЕ опрашивает её — иначе GET мог бы затереть временную запись и вызвать мерцание/дубль.
// Заодно на это время запрещаем самообновление программы: перезагрузка посреди
// незавершённой записи потеряла бы продажу.
let releaseUpdate = null
export function beginMutate(keys) {
  keys.forEach((k) => mutating.set(k, (mutating.get(k) || 0) + 1))
  if (!releaseUpdate) releaseUpdate = blockUpdate()
}
export function endMutate(keys) {
  keys.forEach((k) => {
    const n = (mutating.get(k) || 1) - 1
    if (n <= 0) mutating.delete(k)
    else mutating.set(k, n)
  })
  if (mutating.size === 0 && releaseUpdate) {
    releaseUpdate()
    releaseUpdate = null
  }
}
const isMutating = (key) => (mutating.get(key) || 0) > 0

// Восстановление кэша из localStorage — интерфейс появляется мгновенно
try {
  for (const k of COLLECTIONS) {
    const raw = localStorage.getItem(lsKey(k))
    if (!raw) continue
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      cache[k] = arr
      hydrated.add(k)
    }
  }
} catch {
  /* приватный режим/переполнение — работаем без персиста */
}

function persist(key) {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(cache[key]))
  } catch {
    /* ignore quota */
  }
}
function emit() {
  listeners.forEach((l) => l())
}
function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function setConn(next) {
  if (conn !== next) {
    conn = next
    emit()
  }
}

// Счётчик локальных изменений по коллекции. Нужен из-за гонки: фоновый опрос мог
// уйти на сервер ДО того, как мы записали товар, а вернуться ПОСЛЕ — и затереть
// только что добавленную запись данными, где её ещё нет. Тогда добавленный товар
// пропадал с экрана до следующего опроса или перезагрузки страницы.
const epoch = new Map()
const bumpEpoch = (key) => epoch.set(key, (epoch.get(key) || 0) + 1)

// Прямая запись в кэш + уведомление подписчиков (используется и для оптимизма)
export function setCollection(key, arr) {
  cache[key] = arr
  loaded.add(key)
  bumpEpoch(key)
  persist(key)
  emit()
}
const get = (key) => cache[key] || EMPTY

// ── Показать сообщение из слоя данных ──
// Тост живёт в React, а сюда попадают события из фона: неудавшаяся запись,
// продлённая подписка. Мост регистрируется из App при запуске.
let notifier = (msg, type) => (type === 'err' ? console.error(msg) : console.log(msg))
export function setNotifier(fn) {
  notifier = fn
}
export function notify(msg, type = 'ok') {
  notifier(msg, type)
}
export function notifyError(msg) {
  notifier(msg, 'err')
}

// Загрузка/обновление одной коллекции с сервера
export function fetchKey(key) {
  if (!COLLECTIONS.includes(key)) return Promise.resolve()
  if (inflight.has(key)) return inflight.get(key)

  const hasSomething = loaded.has(key) || hydrated.has(key) || (cache[key] && cache[key].length > 0)
  if (!hasSomething) {
    firstLoading.add(key)
    emit()
  }

  // Запоминаем состояние ДО запроса: если за время ответа на этом устройстве
  // что-то записали, ответ уже устарел и затирать им свежие данные нельзя
  const startedAt = epoch.get(key) || 0

  const p = api
    .get(pathOf(key) + (QUERY[key] || ''))
    .then((data) => {
      setConn('ok')
      if ((epoch.get(key) || 0) !== startedAt) return // пока ответ летел, список изменили — выбрасываем
      cache[key] = Array.isArray(data) ? data : EMPTY
      loaded.add(key)
      persist(key)
    })
    .catch((e) => {
      // Баннер «нет связи» — только про реальный обрыв. Отказ по правам (403 на
      // журнале списаний у кассира) связью не является, пугать им не за что.
      if (!e?.status || e.status >= 500) setConn('error')
      console.error('Не удалось загрузить', key, e)
    })
    .finally(() => {
      inflight.delete(key)
      if (firstLoading.delete(key)) emit()
      else emit()
    })
  inflight.set(key, p)
  return p
}

// refresh() без аргументов — обновить все уже загруженные коллекции
export function refresh(...keys) {
  const list = keys.length ? keys : [...new Set([...loaded, ...hydrated])]
  return Promise.all(list.map((k) => fetchKey(k)))
}

// Раздел за произвольный период — для дат глубже кэша. Возвращает полный список
// за отрезок, ничего не обрезая. Пустой from означает «с самого начала».
export function loadRange(key, from, to) {
  const qs = new URLSearchParams()
  if (from) qs.set('from', new Date(from).toISOString())
  if (to) qs.set('to', new Date(to).toISOString())
  if (!from && !to) qs.set('days', '0') // всё время
  return api.get(pathOf(key) + '?' + qs.toString()).then((d) => (Array.isArray(d) ? d : []))
}

// Продажи за период — тот же loadRange, оставлено под привычным именем
export const loadSalesRange = (from, to) => loadRange('sales', from, to)

function ensureLoaded(key) {
  if (loaded.has(key) || !COLLECTIONS.includes(key)) return
  fetchKey(key)
}

// Полный сброс кэша (при выходе из аккаунта) — чтобы следующий пользователь не видел чужие данные
export function resetStore() {
  for (const k of COLLECTIONS) cache[k] = EMPTY
  // Убираем кэш ВСЕХ магазинов, а не только текущего: этот сброс делается при выходе
  // и при смене того, кто работает, и оставлять после себя чужие данные незачем.
  // Заодно уходят остатки от прежних версий ключа.
  try {
    // Перебираем через length/key — это единственный способ, работающий везде:
    // у хранилища браузера ключи не перечисляются как у обычного объекта
    const doomed = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith(LS_BASE) || key.startsWith('apteka_cache_v2_'))) doomed.push(key)
    }
    doomed.forEach((key) => localStorage.removeItem(key))
  } catch {
    /* приватный режим */
  }
  loaded.clear()
  hydrated.clear()
  firstLoading.clear()
  inflight.clear()
  mutating.clear()
  emit()
}

// ── Хуки ──
// Пока экран открыт, его коллекции считаются «живыми» и участвуют в фоновом опросе.
// Экран закрыли — опрос по ним прекращается: касса не должна каждые 8 секунд тянуть
// отчёты и журналы только потому, что их один раз открывали за смену.
export function useCollection(key) {
  const data = useSyncExternalStore(
    subscribe,
    () => cache[key] || EMPTY,
    () => cache[key] || EMPTY,
  )
  useEffect(() => {
    active.set(key, (active.get(key) || 0) + 1)
    ensureLoaded(key)
    return () => {
      const n = (active.get(key) || 1) - 1
      if (n <= 0) active.delete(key)
      else active.set(key, n)
    }
  }, [key])
  return data
}

// true, пока коллекция грузится ПЕРВЫЙ раз и показать ещё нечего
export function useFirstLoading(key) {
  return useSyncExternalStore(
    subscribe,
    () => firstLoading.has(key),
    () => false,
  )
}

// Состояние связи с сервером: 'ok' | 'error'
export function useConnection() {
  return useSyncExternalStore(
    subscribe,
    () => conn,
    () => 'ok',
  )
}

// ── Мгновенные обновления ──
// Слой связи (realtime.js) сообщает сюда, живо ли постоянное соединение, и
// присылает названия изменившихся разделов. Обратной зависимости нет: связь
// знает про данные, данные про связь — только через эти две функции.
let realtimeUp = false
export function setRealtimeConnected(up) {
  realtimeUp = !!up
}

// Сигнал «раздел изменился» для страниц, которые держат данные у себя, а не в
// общем кэше. Такая одна — сотрудники: список короткий, меняется раз в месяц,
// заводить под него коллекцию было незачем. Но узнавать об изменении она обязана
// наравне со всеми, иначе заведённый на кассе сотрудник не появится у владельца.
const signalListeners = new Set()
export function onChanged(fn) {
  signalListeners.add(fn)
  return () => signalListeners.delete(fn)
}

// Пришёл сигнал «раздел изменился». Перезапрашиваем только то, что открыто
// на экране: остальное подтянется само, когда пользователь туда зайдёт.
export function invalidate(keys) {
  const list = keys || []
  for (const k of list) {
    if (active.has(k) && !isMutating(k)) fetchKey(k)
  }
  for (const fn of [...signalListeners]) {
    try {
      fn(list)
    } catch {
      /* один сломавшийся слушатель не должен мешать остальным */
    }
  }
}

// Перезапросить всё, что открыто на экране. Нужно после обрыва связи и после
// смены состояния подписки: пока связи не было, измениться могло что угодно,
// а какие именно разделы — сказать некому.
export function refreshAll() {
  pollNow(true)
}

// ── Фоновая синхронизация между устройствами ──
// Журналы — приходы, возвраты, списания, погашения долгов — меняются несколько раз
// в день, а не в минуту. Опрашивать их наравне с товарами и продажами незачем:
// берём их заметно реже, а при возвращении на вкладку — сразу и все.
const SLOW_KEYS = new Set([
  'arrivals', 'returns', 'writeoffs', 'payments', 'expenses', 'expenseCategories', 'suppliers', 'supplierPayments', 'cashMoves', 'payServices',
  'incomes', 'incomeCategories', 'supplierReturns',
])
const SLOW_EVERY = 8 // каждый восьмой тик ≈ раз в минуту

let pollTimer = null
let tick = 0
function pollNow(force = false) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  tick++
  for (const k of active.keys()) {
    // При живом постоянном соединении всё приходит сигналом, и опрос нужен лишь
    // как страховка от потерянного события — раз в минуту вместо восьми секунд
    const slow = realtimeUp || SLOW_KEYS.has(k)
    if (!force && slow && tick % SLOW_EVERY !== 0) continue
    // Пропускаем коллекции с незавершённой мутацией — чтобы опрос не затёр оптимистичную запись
    if (!inflight.has(k) && !isMutating(k)) fetchKey(k)
  }
}
export function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => pollNow(), POLL_MS)
  const catchUp = () => pollNow(true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') catchUp()
  })
  window.addEventListener('focus', catchUp)
  window.addEventListener('online', catchUp)
}

const tempId = () => 'tmp_' + uid()

// ── Временная запись стала настоящей ──
// Новый товар виден на экране сразу, ещё до ответа сервера, — иначе кассир не мог
// бы завести товар и тут же его продать. Живёт он под временным номером, а когда
// приходит ответ, номер меняется на настоящий.
//
// Беда в том, что временный номер к этому моменту мог кто-то запомнить: корзина
// кассы, отложенный чек, открытая карточка. Для них товар просто исчезал —
// «Товар не найден» при попытке продать то, что лежит на экране.
//
// Раньше это пряталось за медлительностью: переход между разделами занимал вчетверо
// больше времени, чем ответ сервера, и подмена всегда успевала произойти раньше,
// чем кассир доходил до кассы. Стоило программе стать быстрой — и ошибка вылезла.
//
// Поэтому помним, во что превратился каждый временный номер, и переводим по
// требованию. Помним недолго: список чистится, чтобы не расти всю смену.
const renamed = new Map()
const RENAMED_MAX = 500

function remember(tempKey, realKey) {
  if (renamed.size >= RENAMED_MAX) renamed.clear()
  renamed.set(tempKey, realKey)
}

// Настоящий номер записи. Для обычных номеров возвращает их же.
export function realId(id) {
  let cur = id
  // Цепочка не длиннее нескольких шагов; ограничение — страховка от кольца
  for (let i = 0; i < 5 && renamed.has(cur); i++) cur = renamed.get(cur)
  return cur
}

// ── Доступ к данным + оптимистичные CRUD ──
export const db = {
  get,

  // Добавление: мгновенно показываем временную запись, затем заменяем серверной
  push: async (key, obj) => {
    const temp = { id: tempId(), ...obj }
    setCollection(key, [temp, ...get(key)])
    beginMutate([key])
    try {
      const created = await api.post(pathOf(key), obj)
      const list = get(key)
      // Обычно просто заменяем временную запись настоящей. Но если её в списке
      // уже нет (например, пришло обновление с другого устройства) — добавляем,
      // иначе сохранённая запись пропала бы с экрана
      const has = list.some((x) => x.id === temp.id)
      setCollection(key, has ? list.map((x) => (x.id === temp.id ? created : x)) : [created, ...list])
      // Кто-то мог уже запомнить временный номер — пусть найдёт запись и по нему
      if (created?.id) remember(temp.id, created.id)
      return created
    } catch (e) {
      setCollection(key, get(key).filter((x) => x.id !== temp.id))
      throw e
    } finally {
      endMutate([key])
      fetchKey(key) // сверяемся с сервером: на экране должно быть ровно то, что в базе
    }
  },

  // Изменение: мгновенно применяем патч, при ошибке откатываем к снимку
  update: async (key, tempOrId, patch) => {
    const id = realId(tempOrId)
    const prev = get(key)
    setCollection(key, prev.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    beginMutate([key])
    try {
      const updated = await api.patch(`${pathOf(key)}/${id}`, patch)
      setCollection(key, get(key).map((x) => (x.id === id ? updated : x)))
      return updated
    } catch (e) {
      setCollection(key, prev)
      throw e
    } finally {
      endMutate([key])
      fetchKey(key)
    }
  },

  // Удаление: мгновенно убираем из кэша, при ошибке возвращаем
  remove: async (key, tempOrId) => {
    const id = realId(tempOrId)
    const prev = get(key)
    setCollection(key, prev.filter((x) => x.id !== id))
    beginMutate([key])
    try {
      await api.del(`${pathOf(key)}/${id}`)
    } catch (e) {
      setCollection(key, prev)
      throw e
    } finally {
      endMutate([key])
      fetchKey(key)
    }
  },
}

// ── Утилиты ──
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

// Денежный формат: целые — без копеек, дробные — до 2 знаков (дирамы).
// Согласовано с серверным Decimal(12,2), чтобы не было ложных «расхождений» в кассе.
// Форматтер один на всю программу: собирать его заново на каждую сумму дорого — в кассе,
// списке товаров и отчётах это тысячи вызовов, а на старом компьютере — доли секунды
const MONEY_NF = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
export const money = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return MONEY_NF.format(v) + ' сомони'
}

// ── Штучная продажа: упаковки + вскрытая упаковка ──
// Сами формулы живут в lib/units — одна копия на всю программу. Здесь только
// привычные имена, под которыми их знают экраны.
export { uppOf as unitsPerPack, isDivisible, stockUnits as totalUnits, unitPrice } from '../lib/units.js'
// Человекочитаемый остаток: «N уп» или «N уп + M шт» (для делимых)
export function stockText(p) {
  // Весовой товар: один вес в килограммах, без «упаковок и штук»
  // Дробный товар: одно число в своей единице — «12,35 кг», «4,5 л»
  if (isVesovoy(p)) return `${kgText(stockUnits(p))} ${edinica(p)}`
  const unit = p?.unit || 'уп'
  const packs = Number(p?.stock) || 0
  if (!isDivisible(p)) return `${packs} ${unit}`
  const loose = Number(p?.looseUnits) || 0
  return loose > 0 ? `${packs} ${unit} + ${loose} шт` : `${packs} ${unit}`
}

// Календарный день по Таджикистану (UTC+5). Оставлено для совместимости.
export const todayKey = dayKey
