// ── Какой адрес сервера: основной или запасной ──
//
// 04.11.2026 у регистратора домена (Navju) отказали DNS-серверы: имя api.finmaxpos.tj перестало
// находиться, и сайт показывал «Нет связи с сервером», хотя сам сервер работал. Сервер отвечает и
// под своим именем у OVH — это запасной адрес. Оба адреса спрашиваются разом (GET /health), и
// работа идёт через тот, что ответил.
//
// Основной — главный: ему даётся фора PREFER_MS, а пока работа идёт через запасной, основной раз
// в RETURN_MS проверяется снова — ответил, и работа возвращается на него. Пропала связь посреди
// работы — выбор делается заново (не чаще раза в RECHECK_MS).
//
// Выбирать начинают сразу при запуске, в фоне: пока человек вводит логин и пароль, адрес уже
// известен, и вход не ждёт проверки (05.11.2026: раньше выбор начинался по кнопке «Войти» и
// добавлял ко входу почти две секунды).
//
// Один и тот же файл служит сайту (client/src/db/apiBase.js) и программе для Windows
// (desktop/src/apibase.mjs) — их сверяет проверка desktop/test/apibase.test.mjs. Без браузера
// и без сети: проверка адреса (probe) и таймеры передаются снаружи.

export const PREFER_MS = 300
export const RECHECK_MS = 20000
export const RETURN_MS = 5 * 60 * 1000

// Паузы считаются по секундомеру, а не по часам компьютера: часы переводят (кассир поправил
// время, Windows сверила его), и пауза «20 секунд» растянулась бы на сутки — а с ней и «связи нет»
const stopwatch = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())

export function createBaseChooser({
  primary,
  fallback = '',
  probe,
  now = stopwatch,
  preferMs = PREFER_MS,
  recheckMs = RECHECK_MS,
  returnMs = RETURN_MS,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
}) {
  let base = primary
  // Запасного нет — выбирать нечего: работа идёт через основной, без проверок
  let chosen = !fallback
  // Ответил ли сервер при последнем выборе: true — да, false — молчат оба адреса,
  // null — ещё не выбирали (или выбирать нечего)
  let reachable = null
  let picking = null
  let lastPick = -Infinity
  let back = null
  let stopped = false
  const listeners = new Set()

  function setBase(b) {
    const was = base
    base = b
    if (was === b) return
    // Ошибка подписчика не должна ломать сам выбор адреса
    for (const fn of [...listeners]) {
      try {
        fn(b)
      } catch {
        /* беда подписчика — не выбора */
      }
    }
  }

  // Работа идёт через запасной — основной проверяется снова через returnMs
  function planReturn() {
    if (back) timers.clear(back)
    back = null
    if (stopped || !fallback || base !== fallback || !(returnMs > 0)) return
    back = timers.set(async () => {
      back = null
      if (stopped || picking || base !== fallback) return planReturn()
      let ok = false
      try {
        ok = !!(await probe(primary))
      } catch {
        ok = false
      }
      // Пока проверяли, мог начаться новый выбор — тогда решит он
      if (ok && !picking && !stopped && base === fallback) {
        reachable = true
        setBase(primary)
      }
      planReturn()
    }, returnMs)
    // Таймер возврата не держит программу живой (в браузере такого вызова нет)
    if (typeof back?.unref === 'function') back.unref()
  }

  function pick() {
    lastPick = now()
    picking = new Promise((resolve) => {
      let settled = false
      let p = null // true / false — ответил ли основной
      let f = null
      let grace = null
      const done = (b, ok) => {
        if (settled) return
        settled = true
        if (grace) timers.clear(grace)
        chosen = true
        reachable = ok
        picking = null
        setBase(b)
        planReturn()
        resolve(b)
      }
      const check = () => {
        if (p === true) return done(primary, true)
        if (f === true && p === false) return done(fallback, true)
        if (f === true && !grace) grace = timers.set(() => done(fallback, true), preferMs)
        // Оба молчат — адрес прежний: ошибку покажет сам запрос
        if (p === false && f === false) return done(base, false)
      }
      const ask = (b, set) =>
        Promise.resolve()
          .then(() => probe(b))
          .then(
            (ok) => !!ok,
            () => false,
          )
          .then((ok) => {
            set(ok)
            check()
          })
      ask(primary, (ok) => (p = ok))
      ask(fallback, (ok) => (f = ok))
    })
    return picking
  }

  return {
    // Нынешний адрес (до выбора — основной)
    current: () => base,
    chosen: () => chosen,
    reachable: () => reachable,
    // Дождаться выбора (первый раз — выбрать). maxWaitMs — ждать не дольше: не успели —
    // ответ null, а выбор идёт дальше в фоне
    ready(maxWaitMs) {
      if (chosen) return Promise.resolve(base)
      const job = picking || pick()
      if (!(maxWaitMs >= 0) || maxWaitMs === Infinity) return job
      return new Promise((resolve) => {
        const t = timers.set(() => resolve(null), maxWaitMs)
        job.then((b) => {
          timers.clear(t)
          resolve(b)
        })
      })
    },
    // Запрос не дошёл до сервера: выбрать заново (не чаще раза в recheckMs). Ответ — адрес
    // после выбора; совпал с прежним — повторять запрос незачем
    async failed() {
      if (!fallback) return base
      if (picking) return picking
      const since = now() - lastPick
      // Меньше нуля — время пошло назад (секундомер такого не делает, но переданное снаружи
      // время может): пора выбирать
      if (since >= 0 && since < recheckMs) return base
      return pick()
    },
    // По этому адресу только что ответил наш сервер (обычный запрос, не проверка) — значит,
    // он доступен, что бы ни показала проверка (на медленной связи она могла не успеть)
    answered(b) {
      if (b === base && chosen) reachable = true
    },
    // Сменился адрес — постоянному соединению переоткрыться на новом
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // Больше не нужен (проверки, выход из программы): таймер возврата снимается
    stop() {
      stopped = true
      if (back) timers.clear(back)
      back = null
    },
  }
}
