// ── Принтер этикеток: настройка этого компьютера и задание на печать ──
// Наклейки печатаются без окна печати, поэтому ошибиться в параметрах задания нельзя:
// не тот размер страницы — и на рулон наклеек уйдёт лист A4.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { LABEL_DEFAULTS, labelPrintOptions, labelSize, pageMicrons, sanitizeLabels } from '../src/print/labels.mjs'
import { createSettings } from '../src/settings.mjs'

test('настройка по умолчанию: принтер не выбран, 58×40, 203 dpi, без сдвига', () => {
  assert.deepEqual(sanitizeLabels(undefined), { ...LABEL_DEFAULTS })
  assert.deepEqual(sanitizeLabels('мусор'), { ...LABEL_DEFAULTS })
  assert.deepEqual(LABEL_DEFAULTS, { printer: '', w: 58, h: 40, dpi: 203, dx: 0, dy: 0, flip: false })
})

test('настройка из окна: в пределах, с шагом, лишнее не запоминается', () => {
  const v = sanitizeLabels({ printer: 'Xprinter XP-365B', w: '40', h: 30.2, dpi: '300', dx: 1.26, dy: -0.44, flip: true, lishnee: 1 })
  assert.deepEqual(v, { printer: 'Xprinter XP-365B', w: 40, h: 30, dpi: 300, dx: 1.3, dy: -0.4, flip: true })
  // За пределами — к краю: ширина 25–110, высота 20–150, сдвиг ±10 мм
  const far = sanitizeLabels({ w: 500, h: 1, dx: 99, dy: -99 })
  assert.deepEqual([far.w, far.h, far.dx, far.dy], [110, 20, 10, -10])
  // Мусор — значения по умолчанию; dpi — только 203 или 300
  const junk = sanitizeLabels({ printer: 42, w: 'x', h: null, dpi: 600, dx: 'влево', flip: 'да' })
  assert.deepEqual(junk, { ...LABEL_DEFAULTS })
  assert.equal(sanitizeLabels({ printer: 'x'.repeat(500) }).printer.length, 220)
})

test('размер наклейки из просьбы окна: нет его — из настроек', () => {
  assert.deepEqual(labelSize({ w: 30, h: 20 }), { w: 30, h: 20 })
  assert.deepEqual(labelSize({ w: 43.3, h: 25.2 }), { w: 43.5, h: 25 })
  assert.deepEqual(labelSize(undefined, { w: 40, h: 30 }), { w: 40, h: 30 })
  assert.deepEqual(labelSize({ w: 0, h: 30 }, { w: 40, h: 30 }), { w: 40, h: 30 })
})

test('задание на принтер этикеток: без окна, на выбранный принтер, страница — ровно наклейка', () => {
  const job = labelPrintOptions({ printer: 'Xprinter XP-365B', w: 40, h: 30 })
  assert.deepEqual(job, {
    silent: true,
    deviceName: 'Xprinter XP-365B',
    printBackground: true,
    landscape: false,
    copies: 1,
    margins: { marginType: 'none' },
    pageSize: { width: 40000, height: 30000 },
  })
  // Микроны — целыми; самый маленький размер больше минимума движка (352 мкм)
  assert.deepEqual(pageMicrons({ w: 43.5, h: 25.5 }), { width: 43500, height: 25500 })
  assert.ok(pageMicrons({ w: 25, h: 20 }).height > 352)
})

test('настройка запоминается в файле настроек и читается после перезапуска', () => {
  const files = new Map()
  const fs = {
    readFileSync: (f) => {
      if (!files.has(f)) throw new Error('нет файла')
      return files.get(f)
    },
    writeFileSync: (f, data) => files.set(f, data),
  }
  const s = createSettings({ file: 'settings.json', fs })
  assert.deepEqual(s.get().labels, { ...LABEL_DEFAULTS })
  s.set({ labels: { printer: 'XP-365B', w: 30, h: 20, dx: 0.5 } })
  const again = createSettings({ file: 'settings.json', fs }).get()
  assert.deepEqual(again.labels, { printer: 'XP-365B', w: 30, h: 20, dpi: 203, dx: 0.5, dy: 0, flip: false })
  // Остальные настройки не тронуты
  assert.equal(again.print.mode, 'system')
})
