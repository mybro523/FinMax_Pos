// ── Экран печати программы: что основная часть принимает от окна ──
// Предпросмотр, печать и PDF обязаны совпадать — поэтому все трое собираются из одних
// значений. Здесь проверяется сама просьба окна и параметры для движка печати.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { pageRequest, pdfOptions, printOptions, STICKER_MM } from '../src/print/page.mjs'
import { safePdfName } from '../src/files.mjs'

test('просьба окна: принтер, ориентация, копии — в разумных пределах', () => {
  assert.deepEqual(pageRequest({ printer: 'HP LaserJet', landscape: true, copies: 3 }), { printer: 'HP LaserJet', landscape: true, roll: false, copies: 3 })
  // Пусто — принтер по умолчанию, одна копия, книжная
  assert.deepEqual(pageRequest(undefined), { printer: '', landscape: false, roll: false, copies: 1 })
  assert.deepEqual(pageRequest({ printer: 42, landscape: 'да', copies: 'много' }), { printer: '', landscape: false, roll: false, copies: 1 })
  assert.equal(pageRequest({ copies: 1000 }).copies, 99)
  assert.equal(pageRequest({ copies: -5 }).copies, 1)
  assert.equal(pageRequest({ copies: 2.7 }).copies, 2)
  assert.equal(pageRequest({ printer: 'x'.repeat(500) }).printer.length, 220)
  // Наклейку не поворачивают: она по размеру этикетки
  assert.deepEqual(pageRequest({ roll: true, landscape: true }), { printer: '', landscape: false, roll: true, copies: 1 })
})

test('предпросмотр и печать — одинаковые страницы: A4, ориентация, фон печатается', () => {
  const ask = pageRequest({ printer: 'Офис', landscape: true, copies: 2 })
  const pdf = pdfOptions(ask)
  const job = printOptions(ask)
  assert.deepEqual(pdf, { printBackground: true, landscape: true, pageSize: 'A4' })
  assert.deepEqual(job, { silent: true, deviceName: 'Офис', printBackground: true, landscape: true, copies: 2, pageSize: 'A4' })
  // Без окна печати Windows — оно и не показало бы предпросмотр
  assert.equal(job.silent, true)
})

test('наклейка 58×40 мм: в PDF — по размеру этикетки, на принтер — на заправленную бумагу', () => {
  const ask = pageRequest({ roll: true, printer: 'Xprinter XP-365B' })
  const pdf = pdfOptions(ask)
  assert.equal(pdf.landscape, false)
  assert.ok(Math.abs(pdf.pageSize.width * 25.4 - STICKER_MM.width) < 1e-9)
  assert.ok(Math.abs(pdf.pageSize.height * 25.4 - STICKER_MM.height) < 1e-9)
  const job = printOptions(ask)
  assert.equal(job.pageSize, undefined, 'размер наклейки знает драйвер принтера этикеток')
  assert.equal(job.deviceName, 'Xprinter XP-365B')
})

test('имя PDF: название документа и дата, без запрещённых знаков, всегда .pdf', () => {
  assert.equal(safePdfName('Товары 2026-10-18.pdf'), 'Товары 2026-10-18.pdf')
  assert.equal(safePdfName('Чек продажи 2026-10-18'), 'Чек продажи 2026-10-18.pdf')
  assert.equal(safePdfName('Этикетки — Нурофен 200мг/№10'), 'Этикетки — Нурофен 200мг №10.pdf')
  assert.equal(safePdfName('..\\..\\Windows\\x'), 'Windows x.pdf')
  assert.equal(safePdfName(''), 'FinMax.pdf')
  assert.equal(safePdfName('отчётpdf'), 'отчётpdf.pdf', 'без точки — это не расширение')
})

test('принтеры, которые сохраняют файл, а не печатают, — узнаются по имени и драйверу', async () => {
  const { printerKind } = await import('../src/print/page.mjs')
  const pdf = { name: 'Microsoft Print to PDF', isDefault: true, options: { 'printer-make-and-model': 'Microsoft Print To PDF', system_driverinfo: 'Microsoft Print To PDF;10.0' } }
  const xps = { name: 'Microsoft XPS Document Writer', options: { 'printer-make-and-model': 'Microsoft XPS Document Writer v4' } }
  const fax = { name: 'Факс', options: { 'printer-make-and-model': 'Microsoft Shared Fax Driver' } }
  const onenote = { name: 'OneNote (Desktop)', options: { 'printer-make-and-model': 'Send to Microsoft OneNote 16 Driver' } }
  const xp = { name: 'XP-80C', options: { 'printer-make-and-model': 'XP-80C', system_driverinfo: 'XP-80C;7.17' } }
  const hp = { name: 'HP LaserJet 1020', options: { 'printer-make-and-model': 'HP LaserJet 1020' } }
  const generic = { name: 'Чековый принтер', options: { 'printer-make-and-model': 'Generic / Text Only' } }
  const list = [pdf, xps, fax, onenote, xp, hp, generic]
  assert.equal(printerKind(list, ''), 'file', 'по умолчанию — «Microsoft Print to PDF»')
  assert.equal(printerKind(list, 'Microsoft XPS Document Writer'), 'file')
  assert.equal(printerKind(list, 'Факс'), 'file', 'русское имя факса — по драйверу')
  assert.equal(printerKind(list, 'OneNote (Desktop)'), 'file')
  assert.equal(printerKind(list, 'XP-80C'), null)
  assert.equal(printerKind(list, 'HP LaserJet 1020'), null)
  assert.equal(printerKind(list, 'Чековый принтер'), null)
  // По умолчанию — настоящий принтер
  assert.equal(printerKind([{ ...pdf, isDefault: false }, { ...hp, isDefault: true }], ''), null)
  // Принтеров нет вовсе — 'none'; по умолчанию не назначен, а принтер один — он
  assert.equal(printerKind([], ''), 'none')
  assert.equal(printerKind([hp], ''), null)
  // Список не прочитался — решать не по чему, печатает движок (не «нет принтера»)
  assert.equal(printerKind(null, ''), null)
  // Несколько принтеров и ни один не назначен по умолчанию — тоже решает движок
  assert.equal(printerKind([{ ...pdf, isDefault: false }, hp], ''), null)
  // Выбранного принтера нет в списке — это решит сам движок печати (ответит ошибкой)
  assert.equal(printerKind(list, 'Удалённый принтер'), null)
})

test('настоящий аппарат с «FAX» в названии — принтер; любые PDF-принтеры и факс Windows — файл', async () => {
  const { printerKind } = await import('../src/print/page.mjs')
  const m = (name, model, driver = model) => ({ name, options: { 'printer-make-and-model': model, system_driverinfo: driver + ';1.0' } })
  // Настоящие аппараты — печатают
  assert.equal(printerKind([m('Brother FAX-2840 Printer', 'Brother FAX-2840 Printer')], 'Brother FAX-2840 Printer'), null)
  assert.equal(printerKind([m('Canon FAX-L170', 'Canon FAX-L170 (FAX)')], 'Canon FAX-L170'), null)
  assert.equal(printerKind([m('Brother MFC-7360N Printer', 'Brother MFC-7360N Printer')], 'Brother MFC-7360N Printer'), null)
  // Виртуальные — сохраняют файл
  for (const [name, model] of [
    ['Fax', 'Microsoft Shared Fax Driver'],
    ['Факс', 'Microsoft Shared Fax Driver'],
    ['Adobe PDF', 'Adobe PDF Converter'],
    ['PDF24', 'PDF24'],
    ['doPDF v7', 'doPDF v7'],
    ['Microsoft Office Document Image Writer', 'Microsoft Office Document Image Writer Driver'],
  ]) assert.equal(printerKind([m(name, model)], name), 'file', name)
  // Факс Windows по одному имени, даже если драйвер не назван
  assert.equal(printerKind([{ name: 'Fax' }], 'Fax'), 'file')
})
