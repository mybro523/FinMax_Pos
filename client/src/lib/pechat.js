// ── Печать: одна дорога для сайта и программы ──
//
// Всё, что идёт на бумагу, рисуется в печатном слое (components/PrintDoc.jsx) —
// отдельно от страницы. Напечатать — значит отдать этот слой принтеру:
//   • на сайте это делает окно печати браузера — предпросмотр у него свой;
//   • в программе для Windows окно печати Windows предпросмотра не умеет (так и
//     пишет: «приложение не поддерживает предварительный просмотр»), поэтому там
//     открывается экран программы с настоящими страницами (components/PrintPreview.jsx).
//
// Что открыто в экране печати, хранится здесь: кнопка «Печать» в любом разделе зовёт
// pechat(), экран печати живёт один на всю программу и слушает эти просьбы.
//
// Расширение в путях указано намеренно: файл загружается и проверками, без сборщика.
import { bridge } from './desktop.js'
import { labelConfig, labelPrinterOf, printConfig, printTicket } from './print.js'

let current = null
const subs = new Set()
const emit = () => subs.forEach((f) => f())

export const pechatState = () => current
export function onPechat(cb) {
  subs.add(cb)
  return () => subs.delete(cb)
}
export function closePechat() {
  current = null
  emit()
}

// Есть ли у программы свой экран печати. На сайте его нет; в программе прежней
// версии (без предпросмотра в основной части) — тоже нет
export const hasPreview = (b = bridge) => !!b?.print?.preview

// ── Напечатать то, что лежит в печатном слое ──
// kind: 'sheet' — лист раздела или «Отчёт о прибылях и убытках»; 'ticket' — чек,
// возврат или Z-отчёт (ticket — его строки: их можно отдать и на чековую ленту);
// 'labels' — лист этикеток A4; 'sticker' — наклейки на принтере этикеток (size — их размер).
// system — что сделать на сайте; b — мост программы (подменяется проверками).
// Возвращает, где печатается: 'system' — окно браузера, 'preview' — экран программы
export function pechat(opts = {}, { system = () => window.print(), b = bridge } = {}) {
  if (!hasPreview(b)) {
    system()
    return 'system'
  }
  current = { kind: 'sheet', ...opts, at: Date.now() }
  emit()
  return 'preview'
}

// ── Чек, возврат, Z-отчёт ──
// В программе с настроенным чековым принтером чек уходит в него сразу — кассир
// у очереди не должен проходить через экран печати. Иначе — как всё остальное:
// предпросмотр (программа) или окно печати (сайт). Не вышло — ошибка с объяснением
export async function pechatTicket(ticket, { system = () => window.print(), b = bridge } = {}) {
  if (hasPreview(b)) {
    const c = await printConfig()
    if (c && c.mode !== 'system') {
      await printTicket(ticket, system)
      return 'printer'
    }
  }
  return pechat({ kind: 'ticket', ticket }, { system, b })
}

// ── Наклейки со штрихкодом ──
// В программе с выбранным принтером этикеток наклейки уходят в него сразу — страницами
// размера наклейки, без экрана печати. Иначе — экран печати программы с предпросмотром
// (сайт — окно печати браузера). size — размер наклейки, мм; cfg — настройка принтера,
// по которой окно нарисовало наклейки (печатать надо ровно по ней). Не вышло — ошибка словами
export async function pechatNakleyki(size, { cfg, system = () => window.print(), b = bridge } = {}) {
  if (b?.labels) {
    const c = cfg !== undefined ? cfg : await labelConfig()
    if (labelPrinterOf(c)) {
      let r = null
      try {
        r = await b.labels.print({ w: size?.w, h: size?.h })
      } catch {
        r = null
      }
      if (!r?.ok) throw new Error(r?.error || 'Не удалось отправить задание на принтер.')
      return 'printer'
    }
  }
  return pechat({ kind: 'sticker', size }, { system, b })
}

// ── Какой документ печатается ──
// В печатном слое бывает несколько документов: лист раздела и открытое поверх него
// окно (чек, этикетки). На бумагу идёт один — с бóльшим prio, из равных — открытый
// последним. То же правило записано в стилях печати (index.css, «Печатный слой»):
// здесь оно нужно экрану печати — узнать, что печатаем и как назвать PDF
export function activeDoc(root) {
  const docs = root ? [...root.children].filter((n) => n.classList?.contains('print-doc')) : []
  let best = null
  for (const d of docs) {
    const p = Number(d.getAttribute('data-prio')) || 0
    if (!best || p >= (Number(best.getAttribute('data-prio')) || 0)) best = d
  }
  return best
}

// Текст для content в правилах страницы (название магазина внизу листа) — строкой CSS.
// Название вписывает человек: кавычка или обратная косая черта в нём не должны закрыть
// строку раньше времени и сломать поля страницы, перевод строки внутри строки CSS
// недопустим. Длина ограничена до экранирования — обрезка не разрежет «\\» пополам — и по
// знакам, а не по половинкам: эмодзи в названии не превратится в «�»
export function cssString(raw) {
  const s = Array.from(String(raw ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80).join('')
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// Заголовок страницы на время печати: «Чек продажи — Магазин «Шифо»». Браузер берёт его
// для имени PDF («Сохранить как PDF») и вписывает в свойства файла, программа для Windows —
// в свойства PDF. Без этого в каждом PDF магазина стояло бы имя программы. Пусто — заголовок
// не трогать
export function printTitle(title, shop) {
  return [title, shop].map((s) => String(s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' — ')
}

// Имя файла PDF: название документа и дата. Запрещённые в именах файлов Windows
// знаки убираются
export function pdfName(title, now = new Date()) {
  const clean = String(title || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `${clean || 'FinMax POS'} ${d}.pdf`
}
