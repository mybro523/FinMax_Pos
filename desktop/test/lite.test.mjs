// ── Облегчённый вид для слабых компьютеров ──
//
// Слабый компьютер: меньше 3,5 ГБ памяти (у 32-разрядной Windows 7 с 4 ГБ — около 3,2),
// не больше двух ядер или видеокарта, которая не ускоряет отрисовку. «Сам» — включается
// только на слабом; «всегда» и «выключен» — как выбрал владелец.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { LITE_ARG, liteState, sanitizeLite, weakReasons } from '../src/lite.mjs'
import { sanitizeSettings } from '../src/settings.mjs'

const GB = 1024 ** 3
const FAST = { totalmem: 8 * GB, cpus: 8, gpu: { gpu_compositing: 'enabled' } }

test('слабый компьютер — по памяти, ядрам и видеокарте', () => {
  assert.deepEqual(weakReasons(FAST), [])
  assert.deepEqual(weakReasons({ ...FAST, totalmem: 3.9 * GB }), [], '4 ГБ (Windows показывает 3,9) — не слабый')
  assert.deepEqual(weakReasons({ ...FAST, totalmem: 3.2 * GB }), ['memory'], '32-разрядная Windows 7 с 4 ГБ')
  assert.deepEqual(weakReasons({ ...FAST, totalmem: 2 * GB }), ['memory'])
  assert.deepEqual(weakReasons({ ...FAST, cpus: 2 }), ['cpu'])
  assert.deepEqual(weakReasons({ ...FAST, cpus: 4 }), [])
  assert.deepEqual(weakReasons({ ...FAST, gpu: { gpu_compositing: 'disabled_software' } }), ['gpu'])
  assert.deepEqual(weakReasons({ ...FAST, gpu: { gpu_compositing: 'unavailable_software' } }), ['gpu'])
  assert.deepEqual(weakReasons({ ...FAST, gpu: { gpu_compositing: 'enabled_on' } }), [])
  assert.deepEqual(weakReasons({ totalmem: 2 * GB, cpus: 2, gpu: { gpu_compositing: 'disabled_software' } }), ['memory', 'cpu', 'gpu'])
  // Не узнали — не считаем слабым
  assert.deepEqual(weakReasons({}), [])
  assert.deepEqual(weakReasons({ totalmem: 0, cpus: 0, gpu: null }), [])
})

test('«сам», «всегда», «выключен» — и подпись для настроек', () => {
  const weak = { totalmem: 2 * GB, cpus: 2, gpu: { gpu_compositing: 'enabled' } }
  assert.equal(liteState('auto', FAST).active, false)
  assert.equal(liteState('auto', weak).active, true)
  assert.equal(liteState('on', FAST).active, true)
  assert.equal(liteState('off', weak).active, false)
  assert.deepEqual(liteState('auto', weak), { mode: 'auto', active: true, reasons: ['memory', 'cpu'], memoryGb: 2, cpus: 2 })
  assert.equal(liteState('ерунда', weak).mode, 'auto', 'неизвестное — «сам»')
  assert.equal(liteState(undefined).active, false)
  assert.equal(sanitizeLite('on'), 'on')
  assert.equal(sanitizeLite(1), 'auto')
  assert.equal(LITE_ARG, '--finmax-lite')
})

test('настройка этого компьютера: по умолчанию «сам», чужое не сохраняется', () => {
  assert.equal(sanitizeSettings(null).lite, 'auto')
  assert.equal(sanitizeSettings({ lite: 'off' }).lite, 'off')
  assert.equal(sanitizeSettings({ lite: '<script>' }).lite, 'auto')
})

test('видеокарта: что узнали в прошлый раз — только «да» или «нет»', () => {
  assert.equal(sanitizeSettings(null).gpuSoft, false)
  assert.equal(sanitizeSettings({ gpuSoft: true }).gpuSoft, true)
  assert.equal(sanitizeSettings({ gpuSoft: 'true' }).gpuSoft, false)
})
