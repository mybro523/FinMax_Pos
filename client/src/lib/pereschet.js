// ── Лист пересчёта на экране ──
//
// Лист лежит на сервере, а считают его часами: с телефона у полок, с компьютера в
// кабинете, иногда вдвоём. Страница поэтому не считает лист «своим»:
//   • на экране — числа с сервера, а поверх них то, что ввели на этом устройстве и
//     чего на сервере ещё нет (typed: строка листа → набранный текст);
//   • на сервер уходят только строки, которые здесь изменили. Раньше уходил весь лист
//     таким, каким его видела вкладка, — и вкладка, открытая с утра, стирала пустотой
//     всё, что за день насчитали с другого устройства;
//   • введённое хранится на устройстве, пока сервер его не принял: связь у полок
//     бывает не всегда, а терять насчитанное за день нельзя.
// Здесь — расчёты и хранилище. Запросы и экран — в pages/Inventory.jsx.
import { unitCost } from './units.js'

// Длиннее девяти цифр в поле «по факту» не ввести: столько штук на полке не бывает, а
// вот штрихкод, считанный сканером не в то поле, — бывает. Девять цифр база хранит
// всегда; тринадцать сервер отверг бы, и хорошо, если с понятными словами
export const MAX_DIGITS = 9

// Поле «по факту» → штуки. Пусто — «эту позицию не считали», и это не ноль
export function countOf(raw) {
  if (raw === '' || raw === null || raw === undefined) return null
  return Math.max(0, Math.trunc(Number(raw) || 0))
}

const saved = (item) => (item.actualUnits === null || item.actualUnits === undefined ? null : Number(item.actualUnits))

// Что стоит в поле строки: своё, если строку здесь меняли, иначе — то, что на сервере
export function shownOf(item, typed) {
  const own = typed?.[item.id]
  if (own !== undefined) return own
  const units = saved(item)
  return units === null ? '' : String(units)
}

// Человек изменил поле. Вернул к тому, что и так лежит на сервере, — строка больше не
// «изменённая»: слать нечего, и чужую правку этой строки она потом не перебьёт
export function retype(typed, item, value) {
  const next = { ...typed }
  if (countOf(value) === saved(item)) delete next[item.id]
  else next[item.id] = String(value)
  return next
}

// Строки, изменённые здесь, — только они и уходят на сервер
export function deltaOf(sheet, typed) {
  const out = []
  for (const item of sheet?.items || []) {
    if (typed?.[item.id] !== undefined) out.push({ id: item.id, actualUnits: countOf(typed[item.id]) })
  }
  return out
}

// Лист таким, каким его видит человек: числа с сервера и введённое поверх
export function merged(sheet, typed) {
  return {
    ...sheet,
    items: (sheet?.items || []).map((item) => (typed?.[item.id] === undefined ? item : { ...item, actualUnits: countOf(typed[item.id]) })),
  }
}

// Сервер принял отправленное (sent). Из «введённого здесь» уходит то, что с отправки
// не меняли; изменённое после — остаётся и уйдёт в следующий раз
export function settle(typed, sent) {
  const next = { ...typed }
  for (const id of Object.keys(sent || {})) if (next[id] === sent[id]) delete next[id]
  return next
}

// Тот ли лист применён, что был на экране. wanted — лист с экрана (merged), got — лист
// с сервера. Сверяются все строки, а не только введённые здесь: человек подтверждал
// итог всего листа
export function sameCounts(wanted, got) {
  const have = new Map((got?.items || []).map((i) => [i.id, saved(i)]))
  return (wanted?.items || []).every((i) => have.has(i.id) && have.get(i.id) === saved(i))
}

// Итог листа — для шапки и для вопроса «применить?». rows — посчитанные строки:
// actual — сколько насчитали, diff — расхождение с учётом
export function tally(sheet, products) {
  const byId = new Map((products || []).map((p) => [p.id, p]))
  const rows = []
  for (const item of sheet?.items || []) {
    const actual = saved(item)
    if (actual !== null) rows.push({ ...item, actual, diff: actual - item.expectedUnits })
  }
  const shortage = rows.filter((d) => d.diff < 0)
  const surplus = rows.filter((d) => d.diff > 0)
  // Себестоимость в строке листа хранится за упаковку — делим по штукам товара
  const shortageCost = shortage.reduce(
    (s, d) => s + unitCost({ cost: d.cost, unitsPerPack: byId.get(d.productId)?.unitsPerPack }) * Math.abs(d.diff),
    0,
  )
  return { rows, counted: rows.length, shortage, surplus, shortageCost }
}

// ── Введённое, которого ещё нет на сервере ──
//
// Лежит в памяти страницы и в хранилище браузера, под именем листа. Память — главная:
// в приватном режиме хранилища нет, а уйти со страницы пересчёта в соседний раздел и
// вернуться человек должен и там. Хранилище переживает перезагрузку страницы и
// закрытую вкладку.
const KEY = 'apteka_inv_'
// Введённое по листу, к которому два месяца не возвращались, уже никому не нужно
const OLD_MS = 60 * 86400000
const MAX_ROWS = 100000

const mem = new Map()

// В хранилище может лежать что угодно: запись прошлой версии, чужая правка. Берём
// только то, что похоже на набранное в поле
function clean(typed) {
  const out = {}
  if (!typed || typeof typed !== 'object' || Array.isArray(typed)) return out
  let n = 0
  for (const [id, value] of Object.entries(typed)) {
    if (!id || typeof value !== 'string' || !/^\d*$/.test(value) || value.length > MAX_DIGITS) continue
    if (++n > MAX_ROWS) break
    out[id] = value
  }
  return out
}

function stored(id) {
  try {
    const rec = JSON.parse(localStorage.getItem(KEY + id) || 'null')
    return { at: Number(rec?.at) || 0, typed: clean(rec?.typed) }
  } catch {
    return { at: 0, typed: {} } // приватный режим или испорченная запись
  }
}

export function readDraft(id) {
  if (!mem.has(id)) mem.set(id, stored(id).typed)
  return mem.get(id)
}

export function writeDraft(id, typed, now = Date.now()) {
  const next = clean(typed)
  if (!Object.keys(next).length) return dropDraft(id)
  mem.set(id, next)
  try {
    localStorage.setItem(KEY + id, JSON.stringify({ at: now, typed: next }))
  } catch {
    /* приватный режим или хранилище переполнено — введённое остаётся в памяти страницы */
  }
}

export function dropDraft(id) {
  mem.set(id, {})
  try {
    localStorage.removeItem(KEY + id)
  } catch {
    /* приватный режим */
  }
}

// Лист применён — введённое на этом устройстве ему больше не нужно. Возвращает true,
// если оно в применённый лист не попало: об этом человеку надо сказать
export function closeDraft(sheet) {
  const typed = readDraft(sheet.id)
  dropDraft(sheet.id)
  return Object.keys(typed).length > 0 && !sameCounts(merged(sheet, typed), sheet)
}

// Разобрать введённое по списку листов с сервера. Возвращает применённые листы, в
// которые введённое здесь не попало (лист применили с другого устройства).
// Листы, которых в списке нет, не трогаются, пока не устареют: в этом же браузере
// могут работать с другой аптекой, и её листов в нашем списке не бывает.
// skip — листы, которые страница применяет прямо сейчас: их судьбу решает ответ на
// применение
export function pruneDrafts(list, { skip, now = Date.now() } = {}) {
  const applied = new Map((list || []).filter((x) => x.status === 'applied').map((x) => [x.id, x]))
  const ids = new Set()
  for (const [id, typed] of mem) if (Object.keys(typed).length) ids.add(id)
  const old = new Set()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(KEY)) continue
      const id = key.slice(KEY.length)
      ids.add(id)
      if (now - stored(id).at > OLD_MS) old.add(id)
    }
  } catch {
    /* приватный режим */
  }
  const missed = []
  for (const id of ids) {
    if (skip?.has(id)) continue
    const sheet = applied.get(id)
    if (sheet) {
      if (closeDraft(sheet)) missed.push(sheet)
    } else if (old.has(id)) dropDraft(id)
  }
  return missed
}
