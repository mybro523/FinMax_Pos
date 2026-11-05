// ── Логотип магазина: что показывать и когда забирать заново (1.6.4) ──
//
// Без React и без сети: запрос get(path) передаётся снаружи — так эту логику проверяют тесты
// (client/test/logoSync.test.js), а окно подключает её в lib/logo.js.
//
// Откуда берётся: GET /shop/logo → { logo: data URL или '', at }. «Кто я» несёт pharmacy.logoAt —
// когда логотип поставили (null — логотипа нет). Сигнал сервера «магазин изменился» ('shop') и
// «связь вернулась» — повод свериться. Сверка дешёвая: окно называет отметку своей картинки
// (?at=), и если она та же, сервер отвечает без картинки ({ at, same: true }).
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { cleanLogo } from './logoClean.js'

export function createLogoSync(get) {
  // Что показано: code — чей логотип; at — отметка картинки (undefined — ещё не забирали,
  // null — логотипа нет); logo — сама картинка или ''
  let state = { code: '', at: undefined, logo: '' }
  const listeners = new Set()
  const set = (next) => {
    if (next.code === state.code && next.at === state.at && next.logo === state.logo) return
    state = next
    for (const fn of [...listeners]) fn()
  }

  // Что «кто я» говорил о логотипе в прошлый раз. Сверяемся с ним, а не с показанной картинкой:
  // после сигнала «магазин изменился» картинка уже новая, а «кто я» в памяти ещё прежний — и
  // каждый новый чек (а их сотни за смену) иначе стирал бы логотип или забирал его заново
  let seen = { code: '', at: undefined }

  // Забрать картинку. Запросы могут обгонять друг друга (сигнал пришёл, пока шёл прежний) —
  // принимается только ответ на последний. force — не присоединяться к уже идущему запросу:
  // он мог начаться раньше, чем сменился логотип
  let seq = 0
  let pending = null
  function load(code, force = false) {
    if (!force && pending && pending.code === code) return pending.promise
    const my = ++seq
    // Отметка картинки, которая уже есть: совпадёт — сервер ответит без картинки
    const known = state.code === code && typeof state.at === 'string' && state.logo ? state.at : ''
    const promise = Promise.resolve()
      .then(() => get('/shop/logo' + (known ? '?at=' + encodeURIComponent(known) : '')))
      .then((r) => {
        if (my !== seq || state.code !== code) return
        if (r?.same === true && known && r.at === known) return
        set({ code, at: typeof r?.at === 'string' ? r.at : null, logo: cleanLogo(r?.logo) })
      })
      .catch(() => {
        // Нет связи или сервер прежней версии: остаётся то, что есть, — чек печатается и так. А
        // «кто я» забываем: следующий чек попробует снова, а не будет без логотипа до перезагрузки
        if (my === seq && state.code === code) seen = { code: '', at: undefined }
      })
      .finally(() => {
        if (pending?.seq === my) pending = null
      })
    pending = { code, seq: my, promise }
    return promise
  }

  // Свести логотип с тем, кто вошёл: другой магазин — прежний логотип забыть сразу (чужой не
  // показываем ни мгновения); «кто я» принёс новую отметку — забрать картинку
  function sync(user) {
    const ph = user?.pharmacy
    const code = ph?.code || ''
    if (!code) {
      seq++
      pending = null
      seen = { code: '', at: undefined }
      set({ code: '', at: undefined, logo: '' })
      return
    }
    const at = ph.logoAt
    if (code === seen.code && at === seen.at && state.code === code) return
    seen = { code, at }
    if (code !== state.code) set({ code, at: undefined, logo: '' })
    // «Кто я» говорит: логотипа нет. Картинки и не было — так и есть (запрос, начатый раньше, её
    // уже не вернёт). Картинка есть — сверяемся с сервером, а не стираем сразу: «кто я» мог
    // отстать от сигнала «магазин изменился» на несколько секунд (сервер помнит сотрудника 10 с)
    if (at === null) {
      if (state.code === code && state.logo) {
        load(code, true)
        return
      }
      seq++
      pending = null
      set({ code, at: null, logo: '' })
      return
    }
    // Та же картинка уже есть
    if (typeof at === 'string' && at === state.at) return
    // Отметки нет (программа без связи ответила «кто я» сама) — то, что уже забрали, и есть нынешнее
    if (at === undefined && state.at !== undefined) return
    load(code)
  }

  return {
    sync,
    // Сервер: «магазин изменился» — логотип поставили, заменили или убрали
    changed() {
      if (state.code) return load(state.code, true)
    },
    // Связь вернулась: пока её не было, логотип могли сменить, а сигнал — пройти мимо. Запрос уже
    // идёт (вход и подключение совпали по времени) — его ответ и так свежий, второй не нужен
    reconnected() {
      if (state.code && !(pending && pending.code === state.code)) return load(state.code, true)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // Логотип для магазина code: data URL или '' (нет логотипа или он чужой)
    logoFor: (code) => (code && state.code === code ? state.logo : ''),
    // Для проверок: дождаться идущего запроса
    settled: () => pending?.promise ?? Promise.resolve(),
  }
}
