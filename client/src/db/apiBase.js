// ── Какой адрес сервера: основной или запасной ──
//
// 04.11.2026 у регистратора домена (Navju) отказали DNS-серверы: имя api.finmaxpos.tj перестало
// находиться, и сайт показывал «Нет связи с сервером», хотя сам сервер работал. Сервер отвечает и
// под своим именем у OVH — это запасной адрес. Теперь сайт спрашивает оба адреса разом (GET
// /health) и работает с тем, что ответил; основному даётся фора — запасной берётся, только если
// основной молчит дольше PREFER_MS. Пропала связь посреди работы — выбор делается заново
// (не чаще раза в RECHECK_MS).
//
// Без браузера и без сети: проверка адреса (probe) передаётся снаружи — так это проверяют тесты
// (client/test/apiBase.test.js). Расширение в пути указано намеренно.

export const PREFER_MS = 1500
export const RECHECK_MS = 20000

export function createBaseChooser({ primary, fallback = '', probe, now = () => Date.now(), preferMs = PREFER_MS, recheckMs = RECHECK_MS }) {
  let base = primary
  let chosen = !fallback // запасного нет — выбирать нечего
  let picking = null
  let lastPick = -Infinity
  const listeners = new Set()

  function pick() {
    lastPick = now()
    picking = new Promise((resolve) => {
      let settled = false
      let p = null // true / false — ответил ли основной
      let f = null
      let grace = null
      const done = (b) => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        const was = base
        base = b
        chosen = true
        picking = null
        if (was !== b) for (const fn of [...listeners]) fn(b)
        resolve(b)
      }
      const check = () => {
        if (p === true) return done(primary)
        if (f === true && p === false) return done(fallback)
        if (f === true && !grace) grace = setTimeout(() => done(fallback), preferMs)
        // Оба молчат — остаёмся, где были: ошибку покажет сам запрос
        if (p === false && f === false) return done(base)
      }
      Promise.resolve()
        .then(() => probe(primary))
        .then((ok) => !!ok, () => false)
        .then((ok) => {
          p = ok
          check()
        })
      Promise.resolve()
        .then(() => probe(fallback))
        .then((ok) => !!ok, () => false)
        .then((ok) => {
          f = ok
          check()
        })
    })
    return picking
  }

  return {
    // Нынешний адрес (до выбора — основной)
    current: () => base,
    chosen: () => chosen,
    // Дождаться выбора (первый раз — выбрать)
    ready() {
      if (chosen) return Promise.resolve(base)
      return picking || pick()
    },
    // Запрос не дошёл до сервера: выбрать заново (не чаще раза в recheckMs). Ответ — адрес
    // после выбора; совпал с прежним — повторять запрос незачем
    async failed() {
      if (!fallback) return base
      if (picking) return picking
      if (now() - lastPick < recheckMs) return base
      return pick()
    },
    // Сменился адрес — постоянному соединению переоткрыться на новом
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
