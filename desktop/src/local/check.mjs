// ── Проверка того, что прислало окно ──
//
// Сервер проверяет каждое поле запроса и отвечает понятным отказом: «Количество:
// только целое число». Локальная база обязана делать то же: окно — веб-страница,
// и верить ей на слово нельзя. Ошибка в интерфейсе не должна записать в базу чек
// с дробным числом упаковок или отрицательной ценой.
//
// Тексты отказов те же, что у сервера (server/src/common/validation-ru.ts).
import { ApiError, bad } from './db.mjs'
import { D } from './money.mjs'
import { isExpired, isoOrNull } from './time.mjs'

const FIELDS = {
  name: 'Название',
  phone: 'Телефон',
  note: 'Примечание',
  barcode: 'Штрихкод',
  qty: 'Количество',
  units: 'Количество',
  pieces: 'Штуки',
  cost: 'Закупочная цена',
  amount: 'Сумма',
  discount: 'Скидка',
  expiryDate: 'Срок годности',
  openingCash: 'Наличные на начало',
  countedCash: 'Пересчитано наличных',
  payment: 'Оплата',
  refund: 'Возврат денег',
  reason: 'Причина',
  items: 'Позиции',
  supplier: 'Поставщик',
  customerId: 'Клиент',
  productId: 'Товар',
  saleId: 'Чек',
  debt: 'Долг',
  clientId: 'clientId',
  restock: 'restock',
  category: 'Категория',
  date: 'Дата',
  fromCash: 'Из кассы',
  shiftId: 'Смена',
  payVia: 'Сервис перевода',
  refundVia: 'Сервис перевода',
  kind: 'Вид операции',
  supplierId: 'Поставщик',
}

const label = (field) => FIELDS[field] || field
// Сколько позиций в одном документе. Столько же принимает сервер (server/src/sync/payload.ts)
export const MAX_LINES = 500
// Числа — тоже в его пределах: сумму больше или количество больше сервер отвергнет.
// Отказать надо здесь, пока документ не оформлен. Позже отказ пришёл бы от сервера —
// когда товар уже на полке или ушёл к покупателю, а смена закрыта с этой суммой
export const MAX_MONEY = 9_999_999_999.99
export const MAX_COUNT = 10_000_000
// Штук в упаковке и штук в одной строке документа. Штуки база хранит обычным целым
// числом, и больше в него не помещается
export const MAX_UPP = 100_000
export const MAX_UNITS = 2_000_000_000
// Дальше 9999 года база дат не хранит. В поле даты браузер пускает и шесть цифр года,
// и лишняя цифра («20266») — обычная опечатка
const MAX_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

// Сумма документа — не больше той, что примет сервер. Каждое число в пределах, а
// произведение может выйти за них: сто тысяч упаковок по цене с лишним нулём
export function sumOk(...sums) {
  if (sums.some((s) => D(s).abs().gt(MAX_MONEY))) throw bad('Сумма документа слишком велика. Проверьте количество и цены.')
}

// Карточку с таким числом штук в упаковке сайт уже не сохранит, но она могла остаться
// с прежних времён. Чек с ней сервер отверг бы — когда товар уже ушёл к покупателю
export function packOk(upp, name) {
  if (upp > MAX_UPP) throw bad(`«${name}»: в карточке слишком много штук в упаковке (больше ${MAX_UPP}). Исправьте карточку товара.`)
}

// Штук в строке — не больше, чем примет сервер. Упаковки в пределах, штук в упаковке
// в пределах, а произведение — нет: четыре миллиона упаковок по пятьсот штук
export function unitsOk(units, text = 'Количество слишком велико. Проверьте количество.') {
  if (units > MAX_UNITS) throw bad(text)
}

// Срок годности (уже разобранный в единый вид) — в пределах того, что хранит база.
// Иначе сервер не смог бы записать приход вовсе, и за ним встала бы вся очередь кассы
export function expiryOk(iso) {
  if (iso && Date.parse(iso) > MAX_DATE_MS) throw bad('Срок годности: проверьте год')
}

// Срок, который кассир вписал с упаковки возвращаемого товара. Пусто — null: срок
// поставит правило (stock.mjs, returnExpiry). Товар с истёкшим сроком в продажу не
// возвращают — его списывают. Тексты отказов — слово в слово как у сервера
// (server/src/common/stock.ts, enteredExpiry)
export const RETURN_EXPIRED = 'Срок на упаковке уже истёк — такой товар в продажу не возвращают. Выберите «Списать».'
export function enteredExpiry(raw, restock, now) {
  if (raw === undefined || raw === null || raw === '') return null
  const iso = isoOrNull(raw)
  if (!iso) throw bad('Срок годности: неверная дата')
  expiryOk(iso)
  if (restock && isExpired(iso, now)) throw bad(RETURN_EXPIRED)
  return iso
}
const empty = (v) => v === undefined || v === null

// Собирает все нарушения разом — как сервер: человеку показывают весь список,
// а не по одной ошибке за попытку
export function checker() {
  const problems = []
  const fail = (text) => {
    problems.push(text)
    return undefined
  }

  const api = {
    str(v, field, { optional = false, min = 0 } = {}) {
      if (empty(v)) return optional ? undefined : fail(`${label(field)}: только текст`)
      if (typeof v !== 'string') return fail(`${label(field)}: только текст`)
      if (v.length < min) return fail(`${label(field)}: не короче ${min} символов`)
      return v
    },
    int(v, field, { optional = false, min = 0, max = MAX_COUNT } = {}) {
      if (empty(v)) return optional ? undefined : fail(`${label(field)}: только целое число`)
      if (typeof v !== 'number' || !Number.isInteger(v)) return fail(`${label(field)}: только целое число`)
      if (v < min) return fail(`${label(field)}: не меньше ${min}`)
      if (v > max) return fail(`${label(field)}: не больше ${max}`)
      return v
    },
    num(v, field, { optional = false, min = 0, max = MAX_MONEY } = {}) {
      if (empty(v)) return optional ? undefined : fail(`${label(field)}: только число`)
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${label(field)}: только число`)
      if (v < min) return fail(`${label(field)}: не меньше ${min}`)
      if (v > max) return fail(`${label(field)}: не больше ${max}`)
      return v
    },
    bool(v, field, { optional = false } = {}) {
      if (empty(v)) return optional ? undefined : fail(`${label(field)}: только «да» или «нет»`)
      if (typeof v !== 'boolean') return fail(`${label(field)}: только «да» или «нет»`)
      return v
    },
    oneOf(v, field, values, { optional = false } = {}) {
      if (empty(v) && optional) return undefined
      if (!values.includes(v)) return fail(`${label(field)}: допустимо только — ${values.join(', ')}`)
      return v
    },
    list(v, field, { min = 1, max = MAX_LINES } = {}) {
      if (!Array.isArray(v)) {
        fail(`${label(field)}: ожидается список`)
        return []
      }
      if (v.length < min) fail(`${label(field)}: нужна хотя бы ${min} позиция`)
      // Отказать надо сейчас, пока документ не оформлен: позже его отверг бы сервер,
      // а товар к тому времени уже лежал бы на полке или ушёл к покупателю
      if (v.length > max) {
        fail(`${label(field)}: не больше ${max} в одном документе — разделите на несколько`)
        return []
      }
      return v
    },
    // Закончить проверку: если нарушения были — отказ со всем списком
    done() {
      if (!problems.length) return
      const err = new ApiError(400, problems.join(', '))
      err.messages = problems
      throw err
    },
  }
  return api
}

// Тело запроса — всегда объект. Массив, строка или пустота вместо него означают,
// что окно прислало не то
export const bodyOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
