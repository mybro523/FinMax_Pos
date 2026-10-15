// ── Обмен с сервером ──
//
// Касса работает с локальной базой, а сервер — место, где сходятся все кассы магазина
// и сайт. Обмен всегда идёт в два шага и всегда в этом порядке:
//
//   1. Отправка. Всё, что сделано здесь и ещё не принято сервером, уходит пачками,
//      по порядку. У каждой операции свой номер, созданный на кассе: сервер узнаёт
//      повтор по номеру, поэтому после обрыва связи пачку можно просто послать ещё раз.
//   2. Получение. Касса спрашивает «что изменилось с прошлого раза» и получает
//      только это.
//
// Порядок важен: сначала своё, потом чужое. А про операцию, которую мы отправили, но
// ответа не дождались, касса спрашивает при получении: «вот её номер — принята?».
// Сервер отвечает из того же состояния базы, из которого отдаёт данные. Поэтому касса
// точно знает, какие из её операций в этих данных уже есть (их поправку она снимает),
// а каких ещё нет (их поправка остаётся). Посчитать операцию дважды — в остатке сервера
// и в своём журнале — так нельзя, чем бы ни кончилась отправка.
//
// Связи нет — ничего страшного: попытка повторяется с нарастающей паузой, а касса
// тем временем продаёт из того, что лежит на диске.
//
// Чем ходить на сервер и что делать с ответом, передаётся снаружи — модуль
// проверяется обычными тестами, без сети и без базы.

// Пауза перед повтором после неудачи: 5, 10, 20, 40 секунд, дальше раз в минуту
const RETRY_MS = [5000, 10000, 20000, 40000, 60000]
// При живой связи — сверка раз в пять минут, страховка от потерянного сообщения
const IDLE_MS = 5 * 60 * 1000
// Продажа сделана — отправляем почти сразу, но не на каждый чек отдельным запросом:
// кассир пробивает три чека подряд, и они уходят одной пачкой
const KICK_MS = 1000
// Сколько операций в одной пачке. Оборвалась связь — повторить придётся не всё
const BATCH = 50
// Сервер столько раз подряд не смог записать одну и ту же операцию — сама она уже
// не пройдёт, и человек должен это увидеть: за ней стоит вся очередь
const STUCK_AFTER = 3
// О скольких операциях касса спрашивает за один обмен (сервер принимает чуть больше)
const ASK_MAX = 100
// Полная загрузка не проходит, а короткие ответы проходят — следующую попытку забрать
// всё откладываем: 5 секунд, 15, минута, две, дальше раз в пять минут
const FULL_WAIT_MS = [5000, 15000, 60000, 120000, 300000]
// Меньше секунды между заходами не бывает, что бы ни вышло при вычитании
const MIN_PLAN_MS = 1000

const linkFailed = (res) => !res || !res.status || res.status >= 500 || !!res.foreign

export function createSync({
  // (ops, token) → { status, data: { results } }
  push,
  // (cursor) → { status, data }
  pull,
  // Локальная база глазами обмена
  store,
  // Каким ключом отправлять операцию сотрудника. Пусто — отправить пока нечем
  tokenFor = () => '',
  onChanged = () => {},
  // Сервер отказал: 401 — ключ входа больше не действует, 403 — подписка.
  // Вторым передаётся ключ, которым шла отправка (при получении — пусто).
  // Ответ 'retry' означает: отозван ключ не того, кто сейчас за кассой, — обмен
  // продолжается, операции уйдут другим ключом
  onDenied = () => {},
  // Что сейчас с обменом — для значка в интерфейсе
  onState = () => {},
  // Сервер ответил на обмен — вместе с данными он сообщает, кто за кассой и что с подпиской
  onPulled = () => {},
  log = { warn() {} },
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
  // Секундомер: паузы между попытками полной загрузки считаются по нему, а не по
  // часам компьютера — те могут перевести
  now = () => performance.now(),
}) {
  let running = null
  let again = false
  let timer = null
  let fails = 0
  let started = false
  // refused — сервер на связи, но пачку операций целиком не принял (и это не про
  // вход и не про подписку). Сама по себе такая беда не пройдёт: очередь будет
  // стоять, пока не обновят программу или сервер, — человек должен это увидеть
  let state = { online: null, syncing: false, blocked: false, refused: '' }
  // Операция, которую сервер не может записать, и сколько раз подряд
  let stuck = { id: '', n: 0 }
  // ── Полная загрузка, которая не проходит ──
  // Её просит локальная база после отказа сервера. Весь магазин — большой ответ, и по
  // слабой связи он может обрываться раз за разом, пока короткие ответы «что
  // изменилось» доходят. Касса не должна остаться из-за этого без свежих цен и
  // остатков — и не должна ждать минутами, когда связь просто моргнула.
  //
  // Поэтому после неудачной попытки следующий заход идёт только за изменениями и
  // заодно показывает, в чём дело:
  //   • он тоже не прошёл — связи нет вовсе, размер ответа ни при чём: счёт неудач
  //     сбрасывается, и как только связь появится, касса снова попросит всё;
  //   • он прошёл — не проходит именно большой ответ: следующая попытка забрать всё
  //     откладывается, с каждой неудачей дальше (FULL_WAIT_MS), а изменения тем
  //     временем идут как обычно.
  // fullFails — сколько попыток подряд не удалось; fullAt — раньше какого момента не
  // пробовать снова; probing — прошлая попытка не удалась, и что со связью, ещё не ясно
  let fullFails = 0
  let fullAt = 0
  let probing = false
  const forgetFull = () => {
    fullFails = 0
    fullAt = 0
    probing = false
  }
  const fullFailed = () => {
    fullFails++
    probing = true
  }
  // Сколько осталось до следующей попытки забрать всё. Она не нужна или и так будет
  // при ближайшем заходе — расписание обычное
  const untilFull = () => (fullAt > 0 && !probing && store.wantsFull?.() ? Math.max(MIN_PLAN_MS, fullAt - now()) : Infinity)

  function setState(next) {
    const merged = { ...state, ...next }
    if (merged.online === state.online && merged.syncing === state.syncing && merged.blocked === state.blocked && merged.refused === state.refused) return
    state = merged
    onState(state)
  }

  function plan(ms) {
    if (timer) timers.clear(timer)
    timer = null
    if (!started) return
    timer = timers.set(() => {
      timer = null
      run().catch(() => {})
    }, ms)
  }

  // ── Шаг первый: отправить сделанное ──
  // Возвращает: ok — можно спрашивать свежие данные; иначе — что помешало
  async function pushAll() {
    let blocked = false
    for (;;) {
      const ops = store.pendingOps(BATCH)
      if (!ops.length) break

      // Пачка — подряд идущие операции, которые можно отправить одним ключом.
      // Порядок не нарушаем: упёрлись в операцию без ключа — дальше не идём
      const token = tokenFor(ops[0])
      if (!token) {
        blocked = true
        break
      }
      const batch = []
      for (const op of ops) {
        if (tokenFor(op) !== token) break
        batch.push(op)
      }

      // Запоминаем попытку ДО отправки: если программу закроют или связь оборвётся
      // посреди запроса, после перезапуска мы будем знать, что судьба этих
      // операций неизвестна
      store.markAttempt(batch)
      const res = await push(batch, token)
      if (linkFailed(res)) return { ok: false, reached: false, blocked }
      if (res.status === 401 || res.status === 403) {
        // Сервер отказал до того, как взялся за операции, — ни одна не принята
        store.clearAttempts(batch)
        if (onDenied(res, token) === 'retry') return { ok: false, reached: true, blocked }
        return { ok: false, reached: true, denied: true, blocked }
      }
      const results = Array.isArray(res.data?.results) ? res.data.results : null
      if (res.status >= 300 || !results) {
        // Запрос отвергнут целиком (не тот вид) — сервер ничего не записал
        store.clearAttempts(batch)
        log.warn('сервер не принял пачку операций', res.status, res.data?.message)
        const why = Array.isArray(res.data?.message) ? res.data.message.join(', ') : res.data?.message
        return { ok: false, reached: true, blocked, refused: String(why || `ответ ${res.status}`).slice(0, 300) }
      }

      const byId = new Map(batch.map((o) => [o.id, o]))
      // Не записанные: сервер прямо сказал «не смог» или не дошёл до них вовсе —
      // он останавливается на первой неудаче, чтобы не нарушить порядок
      const notWritten = []
      for (const r of results) {
        const op = byId.get(r?.id)
        if (!op) continue
        byId.delete(op.id)
        if (r.status === 'ok' || r.status === 'duplicate') store.ack(op, r)
        else if (r.status === 'rejected') store.reject(op, r.error)
        else notWritten.push(op)
      }
      notWritten.push(...byId.values())
      // Про них ответ определённый — неизвестности нет, счётчик попыток снимаем
      store.clearAttempts(notWritten)
      if (notWritten.length) {
        const head = notWritten[0]
        stuck = stuck.id === head.id ? { id: head.id, n: stuck.n + 1 } : { id: head.id, n: 1 }
        if (stuck.n < STUCK_AFTER) return { ok: false, reached: true, blocked }
        const said = results.find((r) => r?.id === head.id)?.error
        return { ok: false, reached: true, blocked, refused: String(said || 'Сервер не смог записать операцию.').slice(0, 300) }
      }
      stuck = { id: '', n: 0 }
    }
    return { ok: true, reached: true, blocked }
  }

  // ── Шаг второй: забрать изменившееся ──
  async function pullOnce() {
    // Операции, которые уходили на сервер, а ответа мы не получили: спрашиваем о них.
    // Их больше, чем можно назвать за раз, — значит, свежие данные брать нельзя:
    // сначала отправка должна выяснить судьбу хотя бы части
    const sent = store.sentOps(ASK_MAX + 1)
    if (sent.length > ASK_MAX) return { ok: false, reached: false, changed: [] }
    // Локальная база просит забрать всё заново — отметку «докуда получили» не называем.
    // Когда попытка уместна, а когда пока идём за изменениями — см. выше, у fullFails
    const wantFull = !!store.wantsFull?.()
    // Просьба снята (полный ответ пришёл сам) — счёт неудач начинается заново
    if (!wantFull) forgetFull()
    const saved = store.cursor()
    // Без отметки спрашивать «что изменилось» не о чем — только всё
    const full = wantFull && (!saved || (!probing && now() >= fullAt))
    const since = full ? '' : saved
    // Попытка забрать всё не удалась. Считаем их, только когда есть чем заняться
    // вместо неё — то есть когда есть отметка
    const failedFull = (result) => {
      if (full && saved) fullFailed()
      return result
    }
    const res = await pull(since, sent.map((o) => o.id))
    if (linkFailed(res)) {
      // За изменениями — и то не дошли: связи нет вовсе
      if (!full && wantFull) forgetFull()
      return failedFull({ ok: false, reached: false, changed: [] })
    }
    // Короткий ответ после неудачной попытки дошёл: связь есть, не проходит именно
    // большой. Следующую попытку откладываем — чем больше неудач, тем дальше
    if (!full && probing) {
      probing = false
      fullAt = now() + FULL_WAIT_MS[Math.min(fullFails, FULL_WAIT_MS.length) - 1]
    }
    if (res.status === 401 || res.status === 403) {
      onDenied(res, null)
      return { ok: false, reached: true, denied: true, changed: [] }
    }
    if (res.status !== 200 || !res.data || typeof res.data !== 'object' || !res.data.data) {
      return failedFull({ ok: false, reached: true, changed: [] })
    }
    const fates = res.data.ops
    // Спросили, а сервер о судьбе операций промолчал. Применять такие данные нельзя:
    // неизвестно, есть ли в них наши операции
    if (sent.length && (!fates || typeof fates !== 'object')) {
      log.warn('сервер не ответил о судьбе отправленных операций — данные не применяются')
      return { ok: false, reached: true, changed: [] }
    }
    let changed = []
    try {
      changed = store.applyPull(res.data, sent)
    } catch (e) {
      log.warn('данные сервера не записались в локальную базу', e)
      return failedFull({ ok: false, reached: true, changed: [] })
    }
    onPulled(res.data)
    if (full) forgetFull()
    // Локальная база всё ещё просит полную загрузку (ответ принёс отказ по операции,
    // или мы спрашивали только изменения) — нужен ещё один заход, сразу. Но не когда
    // только что спрашивали всё и не получили, и не когда решено пока обходиться
    // изменениями: это был бы круг запросов без паузы
    return { ok: true, reached: true, changed, more: !full && !probing && now() >= fullAt && !!store.wantsFull?.() }
  }

  async function cycle() {
    setState({ syncing: true })
    let result = { ok: false, changed: [] }
    try {
      const sent = await pushAll()
      if (sent.denied) {
        result = { ok: false, changed: [], denied: true }
        setState({ online: true, blocked: sent.blocked })
        return result
      }
      // Отправка упёрлась в обрыв связи — получение пропускаем. Упёрлась в отказ
      // сервера записать (он ответил) — получать можно: неизвестности нет
      const got = sent.reached ? await pullOnce() : { ok: false, reached: false, changed: [] }
      if (got.denied) {
        result = { ok: false, changed: [], denied: true }
        setState({ online: true, blocked: sent.blocked })
        return result
      }
      setState({ online: sent.reached && got.reached, blocked: sent.blocked, refused: sent.refused || '' })
      if (got.changed.length) onChanged(got.changed)
      // Нужна полная загрузка — не ждём пять минут: сразу ещё один заход
      if (got.more) again = true
      result = { ok: sent.ok && got.ok, changed: got.changed }
      return result
    } finally {
      setState({ syncing: false })
    }
  }

  // Обмен прямо сейчас. Одновременно идёт один; просьба, пришедшая во время него,
  // означает «и ещё раз после» — но не десять раз, сколько бы ни просили
  function run() {
    if (running) {
      // Тот, кто ждёт, дождётся и повторного захода: он идёт продолжением этого же
      again = true
      return running
    }
    running = cycle()
      .catch((e) => {
        log.warn('обмен с сервером не удался', e)
        return { ok: false, changed: [] }
      })
      .then((result) => {
        running = null
        fails = result.ok ? 0 : fails + 1
        if (again) {
          again = false
          return run()
        }
        // Удачный заход — следующий по расписанию, но не позже, чем подойдёт время
        // снова попробовать полную загрузку
        if (!result.denied) plan(result.ok ? Math.min(IDLE_MS, untilFull()) : RETRY_MS[Math.min(fails - 1, RETRY_MS.length - 1)])
        return result
      })
    return running
  }

  return {
    run,

    // Что-то изменилось (здесь пробили чек, сервер сообщил о чужом) — обменяться скоро
    kick() {
      if (!started) return
      if (running) {
        again = true
        return
      }
      plan(KICK_MS)
    },

    start() {
      started = true
      return run()
    },

    stop() {
      started = false
      if (timer) timers.clear(timer)
      timer = null
      again = false
    },

    state: () => state,
    isOnline: () => state.online === true,
    current: () => running,
  }
}
