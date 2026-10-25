// ── Печать: одна дорога для сайта и программы (lib/pechat.js) ──
// На сайте печатает окно браузера, в программе — её экран печати с предпросмотром.
// Ошибка здесь — человек нажал «Печать», а ничего не открылось, или открылось
// не то: чек вместо отчёта, отчёт вместо чека.
import test from 'node:test'
import assert from 'node:assert/strict'
import { activeDoc, closePechat, cssString, hasPreview, onPechat, pdfName, pechat, pechatState, pechatTicket, printTitle } from '../src/lib/pechat.js'

const withPreview = { print: { preview: () => {} } }

test('сайт: печатает окно браузера, экран программы не открывается', () => {
  let printed = 0
  assert.equal(hasPreview(null), false)
  assert.equal(pechat({ kind: 'sheet' }, { system: () => printed++, b: null }), 'system')
  assert.equal(printed, 1)
  assert.equal(pechatState(), null)
  // Программа прежней версии (без предпросмотра в основной части) — тоже окно печати
  assert.equal(pechat({}, { system: () => printed++, b: { print: { ticket: () => {} } } }), 'system')
  assert.equal(printed, 2)
})

test('программа: открывается её экран печати с тем, что печатаем; закрыли — пусто', () => {
  const seen = []
  const off = onPechat(() => seen.push(pechatState()))
  let printed = 0
  assert.equal(pechat({ kind: 'labels' }, { system: () => printed++, b: withPreview }), 'preview')
  assert.equal(printed, 0, 'окно печати Windows не открывается')
  assert.equal(pechatState().kind, 'labels')
  assert.equal(seen.length, 1)
  // Без вида — лист раздела
  pechat({}, { b: withPreview })
  assert.equal(pechatState().kind, 'sheet')
  closePechat()
  assert.equal(pechatState(), null)
  assert.equal(seen.length, 3)
  off()
})

test('чек: в программе без чекового принтера — экран печати с выбором ленты; на сайте — окно браузера', async () => {
  const ticket = { head: ['Магазин'], rows: [], totals: [], tail: [] }
  assert.equal(await pechatTicket(ticket, { b: withPreview }), 'preview')
  assert.deepEqual([pechatState().kind, pechatState().ticket], ['ticket', ticket])
  closePechat()
  let printed = 0
  assert.equal(await pechatTicket(ticket, { system: () => printed++, b: null }), 'system')
  assert.equal(printed, 1)
})

// Узлы печатного слоя без браузера: класс и prio
const node = (prio, title, cls = 'print-doc') => ({ classList: { contains: (c) => c === cls }, getAttribute: (a) => (a === 'data-prio' ? String(prio) : a === 'data-title' ? title : null) })

test('печатается один документ: окно поверх листа раздела, из равных — открытый последним', () => {
  assert.equal(activeDoc(null), null)
  assert.equal(activeDoc({ children: [] }), null)
  const sheet = node(1, 'Товары')
  const style = node(0, '', 'pd-page-style')
  assert.equal(activeDoc({ children: [style, sheet] }).getAttribute('data-title'), 'Товары')
  // Открыли чек — печатается он, хотя лист раздела остался на месте
  const chek = node(2, 'Чек продажи')
  assert.equal(activeDoc({ children: [sheet, chek] }).getAttribute('data-title'), 'Чек продажи')
  assert.equal(activeDoc({ children: [chek, sheet] }).getAttribute('data-title'), 'Чек продажи', 'порядок в слое не важен — важен prio')
  // Два листа — последний
  assert.equal(activeDoc({ children: [sheet, node(1, 'ОПУ')] }).getAttribute('data-title'), 'ОПУ')
})

test('название магазина внизу листа: строка CSS, которую не сломать кавычкой или переводом строки', () => {
  assert.equal(cssString('Пайкар'), '"Пайкар"')
  assert.equal(cssString('Магазин "Сомон"'), '"Магазин \\"Сомон\\""')
  assert.equal(cssString('Склад\\Душанбе'), '"Склад\\\\Душанбе"')
  // Перевод строки внутри строки CSS недопустим — он становится пробелом
  assert.equal(cssString('  Аптека\n№1  '), '"Аптека №1"')
  assert.equal(cssString(null), '""')
  // Длина ограничена до экранирования: обратная косая черта на границе не остаётся одна
  // и не съедает закрывающую кавычку
  const s = cssString('я'.repeat(79) + '\\' + 'хвост')
  assert.equal(s, '"' + 'я'.repeat(79) + '\\\\' + '"')
  assert.ok(!/(^|[^\\])(\\\\)*\\"$/.test(s), 'закрывающая кавычка не экранирована')
  // Строка, вставленная в правило страницы, остаётся одной строкой: снаружи кавычек
  // ничего не появляется
  const evil = cssString('"; } body { display: none } @page { content: "')
  assert.equal(evil.replace(/\\./g, '').split('"').length, 3, 'ровно одна пара кавычек без экранирования')
  // Обрезка по знакам: эмодзи на границе не разрезается пополам («�» в поле листа)
  const emoji = cssString('я'.repeat(79) + '🛒' + 'хвост')
  assert.equal(emoji, '"' + 'я'.repeat(79) + '🛒' + '"')
})

test('заголовок на время печати: «документ — магазин» — из него имя PDF и свойства файла', () => {
  assert.equal(printTitle('Чек продажи', 'Магазин «Шифо»'), 'Чек продажи — Магазин «Шифо»')
  assert.equal(printTitle('  Долги  клиентов ', ''), 'Долги клиентов')
  assert.equal(printTitle('', 'Пайкар'), 'Пайкар')
  // Нечего ставить — пусто: заголовок страницы не трогается
  assert.equal(printTitle('', '   '), '')
  assert.equal(printTitle(null, undefined), '')
})

test('имя PDF: название документа и дата, без знаков, запрещённых в именах файлов', () => {
  const day = new Date(2026, 9, 18, 15, 0)
  assert.equal(pdfName('Товары', day), 'Товары 2026-10-18.pdf')
  assert.equal(pdfName('Этикетки — Нурофен 200мг/№10', day), 'Этикетки — Нурофен 200мг №10 2026-10-18.pdf')
  assert.equal(pdfName('', day), 'FinMax POS 2026-10-18.pdf')
  assert.equal(pdfName('a:b*c?"d<e>f|g', day), 'a b c d e f g 2026-10-18.pdf')
})
