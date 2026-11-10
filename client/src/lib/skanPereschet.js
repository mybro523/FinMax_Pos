// ── Пересчёт сканером (1.7.2) ──
//
// Два места, где сканируют товар в инвентаризации:
//   • «Новый пересчёт» → «Выбранные товары»: каждый скан кладёт товар в список отбора
//     (наверх) и прибавляет к насчитанному одну упаковку. «Создать лист» заводит лист
//     только из этих товаров, и насчитанное сразу стоит в «По факту».
//   • Открытый лист: скан поднимает строку товара наверх и прибавляет одну упаковку.
// Одна упаковка — это unitsPerPack штук (у товара по 10 таблеток — +10 шт), мешок весового
// товара — его граммы (как штучный, 1.5.12). Весовой без мешка сканом не считают — вес
// вводят руками: скан только ставит курсор в поле.
// Здесь — правила и хранилище списка отбора; экран — pages/Inventory.jsx. Проверки —
// test/skanPereschet.test.js.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { isVesovoy, opensPack, uppOf } from './units.js'
import { MAX_DIGITS } from './pereschet.js'

// Больше этого число в поле «по факту» не поместится (девять цифр)
const MAX_UNITS = 10 ** MAX_DIGITS - 1
// Сколько товаров можно отобрать в один лист — как у сервера (inventory/dto.ts, MAX_PICKED)
export const MAX_PICKED = 10000

// Сколько штук прибавляет один скан. null — сканом не считают (весовой без мешка)
export function zaSkan(product) {
  if (!product) return null
  if (isVesovoy(product) && !opensPack(product)) return null
  return uppOf(product)
}

// Насчитанное после ещё одного скана. was — что было (пусто — ещё не считали)
export function plusSkan(was, product) {
  const step = zaSkan(product)
  if (step === null) return was === undefined ? null : was
  const base = was === null || was === undefined || was === '' ? 0 : Math.max(0, Math.trunc(Number(was) || 0))
  return Math.min(MAX_UNITS, base + step)
}

// ── Список отбора ──
// Строка: { productId, units } — units: сколько насчитали сканом (null — не считали: весовой).
// Свежий скан — наверху

// Ещё один скан товара: строка поднимается наверх (новая — встаёт наверх), к насчитанному
// прибавляется упаковка. Список полон — новый товар не добавляется (вернётся тот же список)
export function vOtbor(list, product) {
  const rows = Array.isArray(list) ? list : []
  const was = rows.find((r) => r.productId === product.id)
  if (!was && rows.length >= MAX_PICKED) return rows
  const units = plusSkan(was ? was.units : null, product)
  return [{ productId: product.id, units }, ...rows.filter((r) => r.productId !== product.id)]
}

// Поправили число руками (штуки или граммы; пусто — «не считали»)
export function vOtboreStavim(list, productId, units) {
  const v = units === null || units === undefined || units === '' ? null : Math.min(MAX_UNITS, Math.max(0, Math.trunc(Number(units) || 0)))
  return (list || []).map((r) => (r.productId === productId ? { ...r, units: v } : r))
}

export const izOtbora = (list, productId) => (list || []).filter((r) => r.productId !== productId)

// Строки отбора, чьих товаров больше нет (удалили на другом устройстве), не показываются
// и в лист не уходят
export const zhivyeVOtbore = (list, products) => {
  const ids = new Set((products || []).map((p) => p.id))
  return (list || []).filter((r) => ids.has(r.productId))
}

// Насчитанное отбором → поля «по факту» созданного листа: строка листа → набранный текст.
// Строки листа ищутся по товару; не считали — поле остаётся пустым
export function polyaIzOtbora(sheet, list) {
  const units = new Map((list || []).filter((r) => r.units !== null && r.units !== undefined).map((r) => [r.productId, r.units]))
  const out = {}
  for (const item of sheet?.items || []) {
    if (item.productId && units.has(item.productId)) out[item.id] = String(units.get(item.productId))
  }
  return out
}

// Строки открытого листа: отсканированные — наверху (свежий скан первым), остальные — как
// в листе. top — id строк листа в порядке сканов, свежий первым
export function poryadokStrok(items, top) {
  if (!top?.length) return items || []
  const at = new Map(top.map((id, i) => [id, i]))
  const up = (items || []).filter((i) => at.has(i.id)).sort((a, b) => at.get(a.id) - at.get(b.id))
  return [...up, ...(items || []).filter((i) => !at.has(i.id))]
}

// Отсканировали строку — она первая; повтор не дублируется
export const naverh = (top, id) => [id, ...(top || []).filter((x) => x !== id)]

// ── Хранилище списка отбора ──
// Сканировать сотню товаров и потерять список, нечаянно уйдя в другой раздел, — обидно.
// Список лежит в памяти страницы и в хранилище браузера (у каждого магазина свой) вместе
// с моментом первого скана: «по учёту» лист запишет на минуту создания, и насчитанное
// давно (товар с тех пор продавали) страница предложит проверить.
// В хранилище может лежать что угодно — берём только похожее на строки отбора
const KEY = 'finmax_inv_pick_'
const mem = new Map() // магазин → { at, list }
// С какого возраста отбора страница предупреждает: числа могли устареть
export const OTBOR_STARYY_MS = 3 * 60 * 60 * 1000
function clean(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const r of list) {
    if (!r || typeof r.productId !== 'string' || !r.productId || seen.has(r.productId)) continue
    const u = r.units === null || r.units === undefined ? null : Number(r.units)
    if (u !== null && (!Number.isInteger(u) || u < 0 || u > MAX_UNITS)) continue
    seen.add(r.productId)
    out.push({ productId: r.productId, units: u })
    if (out.length >= MAX_PICKED) break
  }
  return out
}
function stored(k) {
  if (!mem.has(k)) {
    let rec = { at: 0, list: [] }
    try {
      const raw = JSON.parse(localStorage.getItem(KEY + k) || 'null')
      const list = clean(raw?.list)
      rec = { at: list.length ? Number(raw?.at) || 0 : 0, list }
    } catch {
      /* приватный режим или испорченная запись */
    }
    mem.set(k, rec)
  }
  return mem.get(k)
}
export const readOtbor = (shop) => stored(String(shop || '')).list
// Когда отсканирован первый товар списка (0 — список пуст или момент неизвестен)
export const otborNachat = (shop) => stored(String(shop || '')).at
export function writeOtbor(shop, list, now = Date.now()) {
  const k = String(shop || '')
  const was = stored(k)
  const next = clean(list)
  const rec = { at: next.length ? (was.list.length && was.at ? was.at : now) : 0, list: next }
  mem.set(k, rec)
  try {
    if (next.length) localStorage.setItem(KEY + k, JSON.stringify(rec))
    else localStorage.removeItem(KEY + k)
  } catch {
    /* приватный режим или хранилище переполнено — список остаётся в памяти страницы */
  }
}

// ── Скан не в то поле ──
// Курсор стоит в поле количества или веса (весовой товар после скана, правка руками), а
// сканер стреляет следующий товар — цифры кода легли бы в поле как количество, а сам товар
// не посчитался бы. Сканер печатает код и жмёт Enter; набранное с момента входа в поле
// копится, и если Enter завершает код известного товара — это скан: поле возвращается к
// тому, что в нём было перед первой цифрой кода (набранное руками до скана остаётся), а
// товар считается как со сканера. Количество из восьми и больше цифр руками не набирают.
// buf — нажатые с входа в поле знаки; ответ — товар и длина кода в конце набора, или null
export const MIN_SKAN = 8
export function skanVPole(buf, products, productByCode) {
  const s = String(buf || '')
  for (let len = s.length; len >= MIN_SKAN; len--) {
    const code = s.slice(s.length - len)
    if (!/^\d+$/.test(code)) continue
    const product = productByCode(products, code)
    if (product) return { product, len }
  }
  return null
}
