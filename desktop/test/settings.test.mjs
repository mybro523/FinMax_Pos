// ── Настройки этого компьютера ──
// Файл лежит рядом с данными программы и может оказаться каким угодно: пустым,
// испорченным, правленным руками. Программа от этого падать не должна.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettings, sanitizeSettings } from '../src/settings.mjs'
import { PRINT_DEFAULTS } from '../src/print/transport.mjs'

// Папка копий и версия — без настроек печати (у них свои проверки)
const core = ({ backupDir, version }) => ({ backupDir, version })

// Диск в памяти
function disk(initial) {
  const files = new Map(initial ? [['settings.json', initial]] : [])
  return {
    files,
    readFileSync: (f) => {
      if (!files.has(f)) throw new Error('ENOENT')
      return files.get(f)
    },
    writeFileSync: (f, text) => files.set(f, text),
  }
}
const FOLDER = process.platform === 'win32' ? 'D:\\Копии магазина' : '/mnt/kopii'

test('нет файла, мусор в файле, чужие поля — настройки по умолчанию', () => {
  assert.deepEqual(createSettings({ file: 'settings.json', fs: disk() }).get(), { backupDir: '', version: '', print: PRINT_DEFAULTS })
  assert.deepEqual(core(createSettings({ file: 'settings.json', fs: disk('{не json') }).get()), { backupDir: '', version: '' })
  assert.deepEqual(sanitizeSettings({ backupDir: 42, version: ['1.0.0'], print: 'мусор', lishnee: true }), { backupDir: '', version: '', print: PRINT_DEFAULTS })
  assert.deepEqual(core(sanitizeSettings(null)), { backupDir: '', version: '' })
})

test('папка для копий — только полный путь', () => {
  assert.equal(sanitizeSettings({ backupDir: FOLDER }).backupDir, FOLDER)
  // Относительный путь зависел бы от того, откуда запустили программу
  assert.equal(sanitizeSettings({ backupDir: 'kopii' }).backupDir, '')
  assert.equal(sanitizeSettings({ backupDir: '../../kopii' }).backupDir, '')
  assert.equal(sanitizeSettings({ backupDir: 'x'.repeat(500) }).backupDir, '')
})

test('версия — только вида 1.2.3', () => {
  assert.equal(sanitizeSettings({ version: '1.2.3' }).version, '1.2.3')
  assert.equal(sanitizeSettings({ version: '1.2' }).version, '')
  assert.equal(sanitizeSettings({ version: '1.2.3; rm -rf' }).version, '')
})

test('настройка сохраняется на диск и читается при следующем запуске', () => {
  const d = disk()
  const s = createSettings({ file: 'settings.json', fs: d })
  assert.deepEqual(core(s.set({ backupDir: FOLDER })), { backupDir: FOLDER, version: '' })
  s.set({ version: '1.0.1' })
  assert.deepEqual(core(createSettings({ file: 'settings.json', fs: d }).get()), { backupDir: FOLDER, version: '1.0.1' })
  // Убрать папку — остальное не трогается
  s.set({ backupDir: '' })
  assert.deepEqual(core(createSettings({ file: 'settings.json', fs: d }).get()), { backupDir: '', version: '1.0.1' })
  // Настройки печати лежат в том же файле и не мешают остальным
  s.set({ print: { mode: 'network', host: '192.168.1.50', width: 48 } })
  const again = createSettings({ file: 'settings.json', fs: d }).get()
  assert.deepEqual([again.print.mode, again.print.host, again.print.width, again.version], ['network', '192.168.1.50', 48, '1.0.1'])
})

test('диск недоступен — настройка действует до перезапуска, программа не падает', () => {
  const d = disk()
  d.writeFileSync = () => {
    throw new Error('EACCES')
  }
  const s = createSettings({ file: 'settings.json', fs: d })
  assert.equal(s.set({ backupDir: FOLDER }).backupDir, FOLDER)
  assert.equal(s.get().backupDir, FOLDER)
})
