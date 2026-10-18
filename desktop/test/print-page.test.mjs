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
