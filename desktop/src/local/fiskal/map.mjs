// ── Фискальный принтер Fiscat: сборка запросов и разбор ответов ──
//
// Протокол «Технология Групп» v2.9 (Таджикистан). Чистый модуль: ни сети, ни базы —
// только перевод продажи и смены этой кассы в тело запроса устройства и ответа обратно.
// Проверяется обычными тестами (test/fiskal-map.test.mjs).
//
// Деньги у устройства — в дирамах целыми, как и у нас (money.mjs). Суммы в чеке обязаны
// сойтись: Σ products.sum == receiptSum == receiptCash + receiptNonCash, и price*quantity
// у каждой позиции — ровно её sum. Любое расхождение на дирам устройство отвергнет либо
// разведёт фискальный чек с отчётом кассы, поэтому вся арифметика здесь — целочисленная.
import Decimal from 'decimal.js'
import { D } from '../money.mjs'

const ROUND = Decimal.ROUND_HALF_UP
const roundC = (dec) => Number(D(dec).toDecimalPlaces(0, ROUND))
const int = (v) => Math.trunc(Number(v) || 0)

// ── Справочники устройства ──
// Режимы налогообложения (СНО) — ровно те, что принимает устройство (п. 2.4.2)
export const TAX_TYPES = ['GENERAL', 'SIMPLIFIED1', 'SIMPLIFIED2', 'SIMPLIFIED3', 'SPECIAL', 'SIMPLIFIED4', 'SIMPLIFIED5', 'SIMPLIFIED6']
// Ставка НДС → процент. Цены в магазине с НДС внутри, поэтому налог вычисляется ИЗ суммы.
export const VAT_RATES = { STANDARD: 14, REDUCED1: 7, REDUCED2: 5, REDUCED3: 2.5, REDUCED4: 10, ZERO_TAX: 0, ZERO_TAX_EXPORT: 0 }
export const VAT_CODES = Object.keys(VAT_RATES)
export const COMMODITIES = ['GOODS', 'SERVICE', 'JOB', 'ADVANCE']

export const isTaxType = (v) => TAX_TYPES.includes(v)
export const isVatCode = (v) => VAT_CODES.includes(v)
export const isCommodity = (v) => COMMODITIES.includes(v)

// ── Помощники ──
// Налог, «сидящий» в сумме с включённым НДС: sum * R / (100 + R), до дирама
export function vatInclusive(sumC, vatCode) {
  const r = VAT_RATES[vatCode] ?? 0
  if (!r) return 0
  return roundC(D(int(sumC)).times(r).dividedBy(100 + r))
}

const enc = new TextEncoder()
// Строка не длиннее maxBytes БАЙТ (нац. буквы — 2–3 байта). Режем по границе символа;
// экранирование кавычек и слешей делает сам JSON.stringify при отправке.
function fitBytes(str, maxBytes, fallback) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  if (enc.encode(s).length <= maxBytes) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const n = enc.encode(ch).length
    if (used + n > maxBytes) break
    out += ch
    used += n
  }
  return out || fallback
}
// Наименование товара для ленты — не длиннее 128 байт (п. 2.4.2)
export const fitName = (name) => fitBytes(name, 128, '—')
// Имя кассира — не длиннее 64 байт (п. 2.2.2)
export const fitCashier = (name) => fitBytes(name, 64, 'Кассир')
// externalId — до 36 знаков ASCII (у продажи это UUID, 36 знаков). Непечатное и пробелы убираем.
export const fitExternalId = (id) =>
  String(id ?? '')
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, 36)

// ── Подгонка сумм строк под итог чека ──
// Каждая строка округлена сама по себе, а итог продажи — один раз (так считает и сервер,
// money.mjs). На товаре, продаваемом дробно, суммы строк могут разойтись с итогом на дирам.
// Разложим разницу по строкам (±1 дирам, крупные — первыми), чтобы Σ строк == итог ТОЧНО.
// Все суммы на входе положительные (нулевые строки отсеяны выше), итог — тоже.
export function reconcile(lineC, totalC) {
  const out = lineC.map(int)
  let delta = int(totalC) - out.reduce((s, c) => s + c, 0)
  if (!delta || !out.length) return out
  const step = delta > 0 ? 1 : -1
  const order = out.map((_, i) => i).sort((a, b) => out[b] - out[a] || a - b)
  let guard = order.length * (Math.abs(delta) + 1) + order.length
  let k = 0
  while (delta !== 0 && guard-- > 0) {
    const i = order[k % order.length]
    // сумму строки ниже 1 дирама не опускаем: price у позиции не может быть меньше 1
    if (!(step < 0 && out[i] + step < 1)) {
      out[i] += step
      delta -= step
    }
    k += 1
  }
  return out
}

// Одна строка чека → позиция для устройства. Цену и количество подбираем так, чтобы
// price * quantity == sum ТОЧНО. Проданное целыми упаковками (или целыми штуками) без
// остатка показываем как «quantity по price»; всё прочее — одной позицией (quantity 1).
function productLine(line, cfg) {
  const sum = int(line.sumC)
  const whole = line.pieces === 0 ? int(line.qty) : int(line.qty) === 0 ? int(line.pieces) : 0
  let quantity = 1
  let price = sum
  if (whole >= 1 && whole <= 999999 && sum % whole === 0) {
    quantity = whole
    price = sum / whole
  }
  return { code: null, name: fitName(line.name), price, quantity, commodity: cfg.commodity, vatCode: cfg.vatCode, sum }
}

// Разбивка оплаты: наличные → receiptCash, карта и перевод → receiptNonCash. Долг сюда не
// попадает — он не фискализируется (решение владельца). Сумма обеих частей равна итогу.
const CASH = new Set(['cash'])

// ── Чек операции: приход (продажа) или возврат прихода (возврат) → тело POST /api/formReceipt ──
// input: { totalC (дирамы, деньги по чеку), payment (способ оплаты/возврата), lines:
// [{ name, qty, pieces, sumC }] }. sumC — чистая сумма строки в дирамах. Итог берём из
// операции (деньги уже взяты/отданы), суммы строк подгоняем под него. Тело приход и возврат
// отличается только operationType. Возвращает null, когда бить нечего (итог 0 / нет строк).
export function operationReceipt(input, cfg, { externalId, operationType = 'INCOME', shouldPrintSlip = true } = {}) {
  const totalC = int(input?.totalC)
  if (totalC <= 0) return null
  const kept = (Array.isArray(input?.lines) ? input.lines : []).filter((l) => int(l?.sumC) > 0)
  if (!kept.length) return null
  const sums = reconcile(kept.map((l) => int(l.sumC)), totalC)
  const products = kept.map((l, i) => productLine({ ...l, sumC: sums[i] }, cfg))
  const cash = CASH.has(input.payment)
  return {
    formCode: 'RECEIPT',
    externalId: fitExternalId(externalId),
    shouldPrintSlip,
    operationType,
    taxType: cfg.taxType,
    products,
    receiptSum: totalC,
    receiptCash: cash ? totalC : 0,
    receiptNonCash: cash ? 0 : totalC,
    taxes: { vats: [{ vatCode: cfg.vatCode, vatSum: vatInclusive(totalC, cfg.vatCode) }] },
  }
}
// Чек прихода (продажа) и чек возврата прихода (возврат) — одно тело, разный operationType
export const saleReceipt = (input, cfg, opts = {}) => operationReceipt(input, cfg, { ...opts, operationType: 'INCOME' })
export const returnReceipt = (input, cfg, opts = {}) => operationReceipt(input, cfg, { ...opts, operationType: 'REVERT_INCOME' })

// ── Внесение и изъятие наличных, промежуточный отчёт ──
// Суммы — в дирамах целыми, всегда больше нуля (проверяет вызывающий код).
export const addCashReq = (amountC, { shouldPrintSlip = true } = {}) => ({ formCode: 'ADD_CASH', shouldPrintSlip, addAmount: int(amountC) })
export const removeCashReq = (amountC, { shouldPrintSlip = true } = {}) => ({ formCode: 'REMOVE_CASH', shouldPrintSlip, removeAmount: int(amountC) })
// X-отчёт: промежуточный, смену НЕ закрывает (в отличие от closeShift). printZeroData=false —
// печатать только счётчики, по которым были операции
export const xReportReq = ({ shouldPrintSlip = true, printZeroData = false } = {}) => ({ formCode: 'GET_X_REPORT', shouldPrintSlip, printZeroData })

// ── Смена ──
export const openShiftReq = ({ cashier, externalId, shouldPrintSlip = true } = {}) => ({
  formCode: 'OPEN_SHIFT',
  shouldPrintSlip,
  cashier: fitCashier(cashier),
  externalId: fitExternalId(externalId),
})
export const closeShiftReq = ({ cashier, externalId, shouldPrintSlip = true } = {}) => ({
  formCode: 'CLOSE_SHIFT',
  shouldPrintSlip,
  cashier: fitCashier(cashier),
  externalId: fitExternalId(externalId),
})
// Состояние устройства — без печати (п. 2.1): зовём редко, только чтобы понять, открыта ли
// смена, не заблокировано ли устройство, есть ли бумага
export const statusReq = () => ({ formCode: 'DEVICE_STATUS', shouldPrintSlip: false })

// ── Разбор ответа ──
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strOrNull = (v) => (typeof v === 'string' && v ? v : null)
// Фискальные реквизиты документа из ответа formReceipt/openShift/closeShift — их мы храним у чека/смены
const fdOf = (data) => ({
  fdNumber: numOrNull(data?.fdNumber),
  fpd: strOrNull(data?.fpd),
  shiftNumber: numOrNull(data?.shiftNumber),
  receiptNumber: numOrNull(data?.receiptNumber),
  onlineStatus: typeof data?.onlineStatus === 'boolean' ? data.onlineStatus : null,
})

// Разобранный JSON устройства → { ok, data, fd } или { ok:false, code, message }.
// 200 с rc:"SUCCESS" — успех; 200 с другим rc — ошибка с кодом в rc; HTTP 503 и обрывы
// связи разбирает слой сети (client.mjs) и сюда уже не доходит.
export function parseReply(json) {
  const rc = json && typeof json === 'object' ? json.rc : undefined
  if (rc === 'SUCCESS') return { ok: true, data: json.data || {}, fd: fdOf(json.data) }
  return { ok: false, code: typeof rc === 'string' && rc ? rc : 'UNKNOWN_ERROR', message: typeof json?.message === 'string' ? json.message : '' }
}
