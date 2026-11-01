import { useSyncExternalStore } from 'react'
import { getUser } from '../../db/auth'

// ── Приход, начатый, но ещё не оформленный ──
// Новый приход — вкладка экрана, а не всплывающее окно. Раньше окно закрывалось от
// Esc или щелчка мимо — и набранная накладная пропадала целиком. Теперь черновик
// живёт здесь, в памяти программы, а не в самом экране: переключились на
// «Поступления», ушли в кассу и вернулись — строки на месте.
//
// На диск черновик не пишется намеренно: данные магазина в браузере не хранятся.
// Закрыли программу (вкладку сайта) — черновика нет. Он привязан к сотруднику и
// магазину: вошёл другой человек — начинает с чистого листа, чужую накладную не видит.
//
// Здесь же — что выбрано на экране: поставщик слева (он же поставщик нового прихода),
// открытая вкладка и вкладка формы под таблицей. Вернулись в раздел — всё как было.

export const blankForm = () => ({
  productId: '', // товар, выбранный в форме
  code: '', // поле «Штрихкод»: отсканированный или вписанный код
  q: '', // поле «Наименование»: название выбранного товара или то, что набрали для поиска
  qty: '1',
  pieces: '',
  base: '', // цена поставщика за упаковку (до скидки)
  disc: '', // скидка поставщика, %
  price: '', // цена продажи
  price0: 0, // цена продажи до прихода
  piece: '', // своя цена за 1 шт (1.5.11): пусто — по расчёту (цена / штук в упаковке)
  piece0: null, // своя цена штуки до прихода (null — своей не было)
  mk: null, // наценка, пока её вписывают
  expiryDate: '',
  editKey: '', // строка таблицы, открытая в форме для правки
  // Поле «Кол-во в упаковке» (1.5.12): null — как в карточке (не трогали); иначе — что
  // вписали: штук в упаковке, у весового — кг в мешке (пусто — на вес). Упаковку можно
  // поменять и у товара из базы — карточка получит её при проведении прихода
  pack: null,
  // Количество набрали руками (а не «1» по умолчанию): при переходе весового «на вес» ↔ «в
  // мешке» набранное переводится из килограммов в мешки, а «1» по умолчанию — нет
  qtyTouched: false,
  // Упаковку сменили у товара с ценами: прежние цены были за прежнюю упаковку (scale — перевести)
  // или уже за новую (keep). Пока не ответили, строку не добавить (lib/prihod, packAsk)
  packScale: null,
  // Новый товар: кода или названия нет в базе — товар заводится прямо из формы
  // («Завести и добавить»). Его единица и категория; упаковка — в поле pack
  nov: false,
  novUnit: 'уп',
  novCat: '',
})

const blankPay = (sourceId = '') => ({ method: '', paid: '', fromCash: false, sourceId })

// ── Возврат поставщику, начатый, но не оформленный ──
// Строки (lib/prihod.js: retLineFromProduct), форма добавления, как поставщик вернул
// деньги (debt · cash · own · card) и причина
export const blankRetForm = () => ({ productId: '', code: '', q: '', qty: '1', pieces: '', price: '', editKey: '' })
const blankRet = (sourceId = '') => ({ lines: [], form: blankRetForm(), refund: '', note: '', sourceId })

const blank = (owner = '') => ({
  owner,
  supplierId: '',
  period: null, // период сверху; пусто — текущий месяц
  tab: 'journal', // journal · new · balance · reports
  sub: 'add', // add · sel · finish — вкладка под таблицей
  lines: [],
  checked: [], // отмеченные галочкой строки
  discAll: false, // скидка «на все товары»
  form: blankForm(),
  pay: blankPay(),
  flash: '', // строка, которую только что добавили или нашли сканером
  ret: blankRet(), // возврат поставщику (вкладка «Возврат»)
})

let state = blank()
const subs = new Set()
const ownerNow = () => {
  const u = getUser()
  return u ? `${u.id}:${u.pharmacy?.id || u.pharmacy?.name || ''}` : ''
}

// Сменился сотрудник или магазин — черновик прежнего не показываем
function snapshot() {
  const owner = ownerNow()
  if (state.owner !== owner) state = blank(owner)
  return state
}
function subscribe(cb) {
  subs.add(cb)
  return () => subs.delete(cb)
}

export function usePrihod() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export const getPrihod = snapshot

// patch — объект или функция от нынешнего состояния
export function setPrihod(patch) {
  const s = snapshot()
  state = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }
  subs.forEach((f) => f())
}
export const setForm = (patch) => setPrihod((s) => ({ form: { ...s.form, ...(typeof patch === 'function' ? patch(s.form) : patch) } }))
export const setPay = (patch) => setPrihod((s) => ({ pay: { ...s.pay, ...patch } }))

// Приход оформлен — чистый лист. Выбранный поставщик и касса оплаты остаются:
// следующую накладную того же поставщика часто принимают сразу
export function resetDraft() {
  setPrihod((s) => ({ lines: [], checked: [], discAll: false, form: blankForm(), pay: blankPay(s.pay.sourceId), sub: 'add', flash: '' }))
}

export const setRet = (patch) => setPrihod((s) => ({ ret: { ...s.ret, ...(typeof patch === 'function' ? patch(s.ret) : patch) } }))
export const setRetForm = (patch) => setRet((r) => ({ form: { ...r.form, ...(typeof patch === 'function' ? patch(r.form) : patch) } }))
// Возврат оформлен — чистый лист; касса, в которую клали деньги, остаётся
export const resetRet = () => setPrihod((s) => ({ ret: blankRet(s.ret.sourceId) }))
