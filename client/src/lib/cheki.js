// ── Открытые чеки кассы ──
//
// Покупатель ушёл за кошельком или вспомнил, что нужно что-то ещё, — кассир
// открывает новый чек и обслуживает следующего, а первый остаётся вкладкой.
// Раньше чек жил только в памяти страницы: уйдёшь из кассы в другой раздел или
// обновишь страницу — и набранное пропало. Теперь чеки хранятся на устройстве.
//
// Хранятся именно на устройстве, а не на сервере: покупатель возвращается к тому
// же прилавку, и другой кассе его чек не нужен. Ключ свой у каждого магазина, чтобы
// чеки одной не показались другой в том же браузере. При выходе из программы они
// остаются — сменщик за тем же компьютером увидит отложенный чек.
//
// Товар открытые чеки НЕ бронируют: пока чек лежит, другая касса может продать
// последнюю пачку, а владелец — сменить цену. Поэтому чек перед показом и перед
// оплатой сверяется с базой (osvezhit) и говорит, что изменилось.
import { uppOf, lineUnits, lineGross, sellableUnits, fitLine } from './units.js'

// Больше пяти одновременно отложенных чеков у прилавка не бывает, а без предела
// вкладки молча копились бы неделями
export const MAX_CHEKOV = 5

const num = (v) => Number(v) || 0

export const klyuch = (code) => 'apteka_cheki_' + (code || 'net')

let seq = 0
const newId = () => 'c' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6)

// discMode/discValue — скидка на весь чек (сумма или процент), см. raspredelit.
// Пустое discValue — скидки на чек нет, строки живут со своими скидками
export const novyChek = (n) => ({ id: newId(), n, cart: [], payment: 'cash', customerId: '', received: '', payVia: '', discMode: 'sum', discValue: '' })

// Чек продан — вкладка остаётся с тем же номером, а всё остальное как у нового чека:
// корзина, оплата, клиент, «Получено» и скидка на чек. Собираем от novyChek, а не
// перечисляем поля руками: так однажды забылась скидка на чек, и она молча
// доставалась следующему покупателю
export const posleProdazhi = (c) => ({ ...novyChek(c.n), id: c.id })

// Номер нового чека — наименьший свободный: «Чек 2» читается у прилавка быстрее, чем «Чек 17»
export function svobodnyNomer(list) {
  let n = 1
  while (list.some((c) => c.n === n)) n++
  return n
}

// ── Разбор сохранённого ──
// В хранилище браузера может лежать что угодно: запись от прошлой версии,
// оборванная запись, чужая правка. Всё, что не похоже на чек, отбрасываем, и
// касса открывается с пустым чеком — сломанная запись не должна её ронять.
export function razobrat(raw) {
  let data = null
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    data = null
  }
  const list = []
  for (const c of Array.isArray(data?.list) ? data.list : []) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.cart)) continue
    if (list.length >= MAX_CHEKOV + 1) break
    const cart = c.cart
      .filter((i) => i && typeof i.productId === 'string' && i.productId)
      .map((i) => ({
        productId: i.productId,
        name: String(i.name || ''),
        price: num(i.price),
        cost: num(i.cost),
        unitsPerPack: uppOf(i),
        unit: i.unit || 'уп',
        stock: num(i.stock),
        looseUnits: num(i.looseUnits),
        qty: Math.max(0, Math.trunc(num(i.qty))),
        pieces: Math.max(0, Math.trunc(num(i.pieces))),
        discount: Math.max(0, num(i.discount)),
      }))
    const n = Math.trunc(num(c.n))
    const id = typeof c.id === 'string' && c.id && !list.some((x) => x.id === c.id) ? c.id : newId()
    list.push({
      id,
      n: n > 0 && !list.some((x) => x.n === n) ? n : svobodnyNomer(list),
      cart,
      payment: ['cash', 'card', 'debt', 'transfer'].includes(c.payment) ? c.payment : 'cash',
      customerId: typeof c.customerId === 'string' ? c.customerId : '',
      received: typeof c.received === 'string' ? c.received : '',
      payVia: typeof c.payVia === 'string' ? c.payVia : '',
      discMode: c.discMode === 'pct' ? 'pct' : 'sum',
      discValue: typeof c.discValue === 'string' ? c.discValue : '',
    })
  }
  if (!list.length) list.push(novyChek(1))
  list.sort((a, b) => a.n - b.n)
  const active = list.some((c) => c.id === data?.active) ? data.active : list[0].id
  return { list, active }
}

export function chitat(code) {
  try {
    return razobrat(localStorage.getItem(klyuch(code)))
  } catch {
    return razobrat(null) // приватный режим: чеки проживут до закрытия страницы
  }
}

export function pisat(code, state) {
  try {
    localStorage.setItem(klyuch(code), JSON.stringify({ list: state.list, active: state.active }))
  } catch {
    /* приватный режим или хранилище переполнено — чек остаётся в памяти страницы */
  }
}

// ── Сверка чека с базой ──
//
// Сервер при продаже берёт ТЕКУЩУЮ цену товара и текущий остаток, а строка чека
// помнит то, что было при сканировании. За минуту разница не возникает, но
// отложенный чек лежит и час: владелец меняет цену, вторая касса продаёт товар.
// Тогда на экране одна сумма, а сервер запишет другую — или откажет вовсе.
//
// Возвращает чек, приведённый к базе, и список того, что изменилось (notes) —
// кассир обязан это увидеть до того, как назовёт покупателю сумму.
//   gone  — товар удалён из базы
//   out   — годного товара не осталось вовсе
//   stock — осталось меньше, чем набрано
//   price — изменилась цена
const POLYA = ['productId', 'name', 'price', 'cost', 'unitsPerPack', 'unit', 'stock', 'looseUnits', 'qty', 'pieces', 'discount']
const otlichaetsya = (a, b) => POLYA.some((k) => a[k] !== b[k])

export function osvezhit(cart, products, mapId = (id) => id) {
  const notes = []
  const next = []
  let changed = false

  for (const line of cart) {
    // Товар, заведённый минуту назад, успевает сменить временный номер на настоящий.
    // Ищем и по новому номеру, и по прежнему: список товаров на экране может на
    // мгновение отстать от подмены, и товар выглядел бы удалённым из базы
    const id = mapId(line.productId)
    const p = products.find((x) => x.id === id) || products.find((x) => x.id === line.productId)
    if (!p) {
      notes.push({ kind: 'gone', name: line.name })
      changed = true
      continue
    }

    const upp = uppOf(p)
    let qty = Math.max(0, Math.trunc(num(line.qty)))
    let pieces = Math.max(0, Math.trunc(num(line.pieces)))
    // В карточке поменяли «штук в упаковке»: пересчитываем набранное через штуки
    if (uppOf(line) !== upp) {
      const units = lineUnits(line)
      qty = Math.floor(units / upp)
      pieces = units % upp
    }

    const bylaPustaya = qty === 0 && pieces === 0
    const avail = sellableUnits(p)
    const fit = fitLine({ qty, pieces, upp, avail })
    if (fit.capped) {
      // Строку, от которой ничего не осталось, убираем целиком. Пустую строку,
      // которую кассир сам довёл до нуля, чтобы продать штуки, — не трогаем
      if (!bylaPustaya && fit.qty === 0 && fit.pieces === 0) {
        notes.push({ kind: 'out', name: p.name })
        changed = true
        continue
      }
      notes.push({ kind: 'stock', name: p.name, avail })
    }
    if (num(p.price) !== num(line.price)) {
      notes.push({ kind: 'price', name: p.name, was: num(line.price), now: num(p.price) })
    }

    const fresh = {
      ...line,
      productId: p.id,
      name: p.name,
      price: p.price,
      cost: p.cost,
      unitsPerPack: upp,
      unit: p.unit,
      stock: p.stock,
      looseUnits: p.looseUnits,
      qty: fit.qty,
      pieces: fit.pieces,
    }
    // Скидка не больше суммы позиции — сумма могла уменьшиться
    fresh.discount = Math.min(Math.max(0, num(line.discount)), lineGross(fresh))
    if (otlichaetsya(line, fresh)) changed = true
    next.push(fresh)
  }

  return { cart: changed ? next : cart, notes, changed }
}

// ── Скидка на весь чек ──
//
// Кассир называет одну сумму («скину десятку») или процент на весь чек. А в чеке,
// в отчётах, в смене и в программе без связи скидка по-прежнему лежит по строкам —
// менять всё это ради одной цифры нельзя. Поэтому скидку на чек раскладываем по
// строкам пропорционально их сумме, до дирама. Остаток округления уходит в самые
// крупные строки, чтобы итог сошёлся ровно с названной суммой.
//
// mode: 'sum' — сумма в сомони, 'pct' — процент. Больше суммы чека и больше 100%
// скидка не бывает: лишнее молча урезается. Возвращает корзину с новыми скидками
// (ту же самую, если ничего не изменилось) и саму сумму скидки.
const kop = (x) => Math.round(x * 100) / 100

export function raspredelit(cart, mode, value) {
  const gross = cart.map((i) => Math.max(0, kop(lineGross(i))))
  const summa = kop(gross.reduce((s, g) => s + g, 0))
  const v = Number(String(value ?? '').trim().replace(',', '.'))
  let target = 0
  if (Number.isFinite(v) && v > 0 && summa > 0) {
    target = mode === 'pct' ? (summa * Math.min(v, 100)) / 100 : Math.min(v, summa)
  }
  target = kop(target)

  // Доля каждой строки — вниз до дирама; что не разошлось, докладываем крупным строкам
  const disc = gross.map((g) => (summa > 0 ? Math.floor((target * g) / summa * 100 + 1e-9) / 100 : 0))
  let rest = kop(target - disc.reduce((s, d) => s + d, 0))
  const poRazmeru = gross.map((g, i) => i).sort((a, b) => gross[b] - gross[a])
  for (const i of poRazmeru) {
    if (rest <= 0) break
    const mesto = kop(gross[i] - disc[i])
    const add = Math.min(mesto, rest)
    disc[i] = kop(disc[i] + add)
    rest = kop(rest - add)
  }

  let changed = false
  const next = cart.map((i, k) => {
    if ((num(i.discount) || 0) === disc[k]) return i
    changed = true
    return { ...i, discount: disc[k] }
  })
  return { cart: changed ? next : cart, total: kop(disc.reduce((s, d) => s + d, 0)), changed }
}

// ── Сдача ──
// Пустое поле «Получено» — это не ноль, а «без сдачи»: кассир ничего не вводил.
export function sdacha(total, received) {
  const raw = String(received ?? '').trim().replace(',', '.')
  if (!raw) return { state: 'none', diff: 0, received: null }
  const r = Number(raw)
  if (!Number.isFinite(r)) return { state: 'none', diff: 0, received: null }
  // До дирамов: 0,1 + 0,2 в двоичной арифметике не равно 0,3, а сдача — это деньги.
  // «|| 0» убирает отрицательный ноль: без него «дали ровно» показывало бы «Сдача −0»
  const diff = Math.round((r - num(total)) * 100) / 100 || 0
  return { state: diff < 0 ? 'short' : 'ok', diff, received: r }
}

// ── Быстрые купюры ──
// Чек на 137 — покупатель даст 140, 150, 200 или 500. Предлагаем ближайшие суммы,
// которые набираются купюрами сомони, чтобы кассир нажал одну кнопку вместо набора.
// Мелкие номиналы для крупного чека не предлагаем: «1260» при чеке на 1250 —
// сумма, которую никто не даёт.
const NOMINALY = [5, 10, 20, 50, 100, 200, 500, 1000]

export function kupyury(total) {
  const t = num(total)
  if (t <= 0) return []
  const out = []
  for (const d of NOMINALY) {
    if (d < t / 30) continue
    const v = Math.ceil(t / d) * d
    if (v > t && !out.includes(v)) out.push(v)
  }
  return out.sort((a, b) => a - b).slice(0, 4)
}

// ── Что набрано в поле сканера: штрихкод или название ──
// Сканер присылает код одним словом, без пробелов, и в нём много цифр. Название
// товара — слова. По этому отличаем «незнакомый штрихкод» (предложить завести
// товар) от «поиска по названию» (ничего заводить не надо).
export function pohozheNaKod(value) {
  const v = String(value ?? '').trim()
  if (!v || /\s/.test(v)) return false
  return v.replace(/\D/g, '').length >= 6
}

// Есть ли в строке буква. Только цифры — это обрывок кода, а не название:
// по нему нельзя добавлять «первый подходящий» товар
export const estBukva = (value) => /\p{L}/u.test(String(value ?? ''))
