// ── Загрузить копию базы вручную ──
//
// Владелец загружает копию сам: свою прежнюю или копию сломавшегося компьютера с флешки.
// Проверяется главное: загружается ровно база магазина, прежний файл не пропадает, общая
// база (вход, срок работы без связи) остаётся своей, с чужой копии переносится только
// номер кассы, а негодная копия не трогает ничего.
//
// Здесь всё настоящее — SQLite и файлы на диске, во временной папке.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createBackups } from '../src/backup.mjs'
import { getMeta, openDb, setMeta } from '../src/local/db.mjs'
import { CORE_SCHEMA, PHARMACY_SCHEMA } from '../src/local/schema.mjs'
import { applyRestore, describeCopy, findCopies, MANIFEST, requestRestore, RESTORE_FILE, saveCopyTo, STAGE_DIR } from '../src/restore.mjs'

const NOW = Date.parse('2026-10-18T07:00:00.000Z')
const A = { id: '11111111-1111-4111-8111-111111111111', key: 'A'.repeat(43) }
const B = { id: '22222222-2222-4222-8222-222222222222', key: 'B'.repeat(43) }
const SHOP = 'pharmacy-demo.db'
const MAX = PHARMACY_SCHEMA.length

// Компьютер с программой: папка данных, общая база с номером кассы, база магазина
function machine(device) {
  const userData = fs.mkdtempSync(join(os.tmpdir(), 'apteka-restore-'))
  const data = join(userData, 'data')
  fs.mkdirSync(data)
  const core = openDb(join(data, 'core.db'), CORE_SCHEMA)
  setMeta(core, 'deviceId', device.id)
  setMeta(core, 'deviceKey', device.key)
  // Своя запись часов и подписки — она не должна смениться ни от какой копии
  setMeta(core, 'clock', JSON.stringify({ seen: NOW }))
  core.close()
  const shop = openDb(join(data, SHOP), PHARMACY_SCHEMA)
  shop.close()
  const logs = []
  const log = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) }
  const backups = createBackups({ dir: join(userData, 'backups'), fs, Database, now: () => NOW, log })
  return { userData, data, logs, log, backups, shopFile: join(data, SHOP), coreFile: join(data, 'core.db') }
}
const withShop = (m, fn) => {
  const db = openDb(m.shopFile, PHARMACY_SCHEMA)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
// Чек без связи: операция в очереди на отправку
const sell = (db, id) =>
  db.prepare("INSERT INTO outbox (id, type, payload, createdAt, state) VALUES (?, 'sale', '{}', '2026-10-18T06:00:00Z', 'pending')").run(id)
const queue = (db) => db.prepare("SELECT id FROM outbox WHERE state = 'pending' ORDER BY seq").all().map((r) => r.id)
// Запись журнала обмена с соседними кассами
const lanEntry = (db, id) => db.prepare("INSERT INTO lan_log (id, kind, origin, createdAt, body) VALUES (?, 'op', 'x', '2026-10-18T06:00:00Z', '{}')").run(id)
async function snapshot(m) {
  const r = await m.backups.run([
    { name: 'core.db', file: m.coreFile },
    { name: SHOP, file: m.shopFile },
  ])
  return r.folder
}
const apply = (m) => applyRestore({ userData: m.userData, dataDir: m.data, fs, Database, now: () => NOW + 60000, schemaMax: MAX, log: m.log })
const ask = (m, folder, extra = {}) => requestRestore({ userData: m.userData, fs, Database, folder, shopFile: SHOP, foreign: false, at: NOW, now: () => NOW, ...extra })
const metaIn = (file, key) => {
  const db = new Database(file, { readonly: true })
  try {
    return getMeta(db, key)
  } finally {
    db.close()
  }
}

test('копия этой кассы загружается: в базе ровно то, что было в копии, прежний файл отложен', async () => {
  const m = machine(A)
  withShop(m, (db) => sell(db, 'чек-1'))
  const folder = await snapshot(m)
  withShop(m, (db) => sell(db, 'чек-2 (после копии)'))

  ask(m, folder)
  assert.ok(fs.existsSync(join(m.userData, RESTORE_FILE)), 'просьба записана')
  const r = apply(m)
  assert.equal(r.ok, true)
  assert.equal(r.foreign, false)
  withShop(m, (db) => assert.deepEqual(queue(db), ['чек-1'], 'в базе — копия'))
  // Прежний файл не стёрт: в нём чек, которого нет в копии
  const replaced = join(m.userData, 'replaced')
  const aside = join(replaced, fs.readdirSync(replaced)[0], SHOP)
  const old = new Database(aside, { readonly: true })
  assert.deepEqual(queue(old), ['чек-1', 'чек-2 (после копии)'])
  old.close()
  // Просьба выполнена один раз, отложенные файлы убраны
  assert.equal(fs.existsSync(join(m.userData, RESTORE_FILE)), false)
  assert.equal(fs.existsSync(join(m.userData, STAGE_DIR)), false)
  assert.equal(apply(m), null, 'второй запуск ничего не повторяет')
})

test('загруженная база спрашивает у сервера весь магазин и сообщает окну, что копию загрузили вручную', async () => {
  const m = machine(A)
  withShop(m, (db) => {
    setMeta(db, 'cursor', '2026-10-17T10:00:00Z|500')
    setMeta(db, 'wcursor', '2026-10-17T10:00:00Z|500')
  })
  const folder = await snapshot(m)
  ask(m, folder)
  apply(m)
  assert.equal(metaIn(m.shopFile, 'needFull'), '1')
  assert.equal(metaIn(m.shopFile, 'cursor'), '')
  assert.equal(metaIn(m.shopFile, 'wcursor'), '')
  assert.deepEqual(JSON.parse(metaIn(m.shopFile, 'restored')), { from: NOW, at: NOW + 60000, manual: true, foreign: false })
  // С загруженной базой программа работает как обычно
  withShop(m, (db) => sell(db, 'чек-после-загрузки'))
})

test('журнал обмена с соседними кассами продолжает нумерацию прежнего файла', async () => {
  const m = machine(A)
  withShop(m, (db) => lanEntry(db, 'op-1'))
  const folder = await snapshot(m)
  withShop(m, (db) => {
    for (let n = 2; n <= 6; n++) lanEntry(db, 'op-' + n)
  })
  ask(m, folder)
  apply(m)
  withShop(m, (db) => {
    lanEntry(db, 'op-новая')
    // Соседи помнят номера до 6 — новая запись должна получить номер больше
    assert.equal(db.prepare("SELECT seq FROM lan_log WHERE id = 'op-новая'").get().seq, 7)
  })
})

test('общая база остаётся своей: вход, часы и срок работы без связи из копии не берутся', async () => {
  const m = machine(A)
  const folder = await snapshot(m)
  const core = openDb(m.coreFile, CORE_SCHEMA)
  setMeta(core, 'clock', JSON.stringify({ seen: NOW + 999 }))
  core.close()
  ask(m, folder)
  apply(m)
  assert.equal(JSON.parse(metaIn(m.coreFile, 'clock')).seen, NOW + 999)
  assert.equal(metaIn(m.coreFile, 'deviceId'), A.id)
})

test('копия другого компьютера: эта касса получает её номер и ключ, а неотправленные чеки той кассы — её очередь', async () => {
  const old = machine(A)
  withShop(old, (db) => sell(db, 'чек старой кассы'))
  const folder = await snapshot(old)

  const fresh = machine(B)
  const d = describeCopy({ folder, files: fs.readdirSync(folder), shopFile: SHOP, deviceId: B.id, schemaMax: MAX, fs, Database })
  assert.equal(d.foreign, true)
  assert.equal(d.pending, 1)
  assert.equal(d.problem, '')

  ask(fresh, folder, { foreign: true })
  const r = apply(fresh)
  assert.equal(r.ok, true)
  assert.equal(r.foreign, true)
  assert.equal(metaIn(fresh.coreFile, 'deviceId'), A.id)
  assert.equal(metaIn(fresh.coreFile, 'deviceKey'), A.key)
  // Своя запись часов при этом не тронута
  assert.equal(JSON.parse(metaIn(fresh.coreFile, 'clock')).seen, NOW)
  withShop(fresh, (db) => assert.deepEqual(queue(db), ['чек старой кассы']))
  assert.equal(JSON.parse(metaIn(fresh.shopFile, 'restored')).foreign, true)
})

test('что в копии: своя/чужая, сколько не ушло на сервер, когда снята; негодные — с причиной', async () => {
  const m = machine(A)
  withShop(m, (db) => {
    sell(db, 'ч1')
    sell(db, 'ч2')
  })
  const folder = await snapshot(m)
  const look = (over = {}) => describeCopy({ folder, files: fs.readdirSync(folder), shopFile: SHOP, deviceId: A.id, schemaMax: MAX, fs, Database, ...over })
  const own = look()
  assert.deepEqual({ foreign: own.foreign, pending: own.pending, problem: own.problem, at: own.at }, { foreign: false, pending: 2, problem: '', at: NOW })
  // Копия другого магазина: базы этого магазина в ней нет
  assert.equal(look({ shopFile: 'pharmacy-drugoy.db' }).problem, 'noshop')
  // Копия от более новой версии программы
  assert.equal(look({ schemaMax: MAX - 1 }).problem, 'newer')
  // Без общей базы — неполная
  assert.equal(look({ files: [SHOP] }).problem, 'incomplete')
  // Испорченный файл копии
  const fd = fs.openSync(join(folder, SHOP), 'r+')
  fs.writeSync(fd, Buffer.alloc(3000, 0x5a), 0, 3000, 0)
  fs.closeSync(fd)
  assert.equal(look().problem, 'broken')
  // Быстрый взгляд для списка (без полной проверки) тоже видит, что файл не открывается
  assert.equal(look({ thorough: false }).problem, 'broken')
})

// Список копий смотрит на них бегло (полная проверка большой базы — заметное время), поэтому
// порчу в середине файла обязана поймать загрузка
test('порча в середине файла копии: полная проверка её видит, и загрузить такую копию нельзя', async () => {
  const m = machine(A)
  withShop(m, (db) => sell(db, 'чек'))
  const folder = await snapshot(m)
  // Испорчена середина файла: заголовок цел, база открывается
  const file = join(folder, SHOP)
  const size = fs.statSync(file).size
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, size - 8192)
  fs.closeSync(fd)
  const look = (thorough) => describeCopy({ folder, files: fs.readdirSync(folder), shopFile: SHOP, deviceId: A.id, schemaMax: MAX, fs, Database, thorough })
  assert.equal(look(true).problem, 'broken', 'перед загрузкой порча видна')
  // А просьба загрузить такую копию не проходит: файл проверяется ещё раз, уже у себя
  assert.throws(() => ask(m, folder), /не читается/)
})

test('копия, которую унесли или испортили после просьбы, не загружается — и ничего не трогает', async () => {
  const m = machine(A)
  withShop(m, (db) => sell(db, 'чек'))
  const folder = await snapshot(m)
  ask(m, folder)
  // Отложенную копию испортили, пока программа перезапускалась
  const staged = join(m.userData, STAGE_DIR, SHOP)
  const fd = fs.openSync(staged, 'r+')
  fs.writeSync(fd, Buffer.alloc(3000, 0x5a), 0, 3000, 0)
  fs.closeSync(fd)
  const r = apply(m)
  assert.equal(r.ok, false)
  assert.match(r.error, /повреждён/)
  withShop(m, (db) => assert.deepEqual(queue(db), ['чек'], 'база осталась прежней'))
  assert.equal(fs.existsSync(join(m.userData, 'replaced')), false)
  assert.equal(fs.existsSync(join(m.userData, RESTORE_FILE)), false, 'просьба не повторится')
  assert.ok(m.logs.some((l) => l[0] === 'error' && /не загружена/.test(l[1])))
})

test('испорченная или подложенная просьба не выполняется', () => {
  const m = machine(A)
  fs.writeFileSync(join(m.userData, RESTORE_FILE), '{ это не JSON', 'utf8')
  assert.equal(apply(m).ok, false)
  // Путь мимо папки отложенной копии и чужое имя файла — тоже нет
  fs.writeFileSync(join(m.userData, RESTORE_FILE), JSON.stringify({ folder: os.tmpdir(), shopFile: SHOP }), 'utf8')
  assert.equal(apply(m).ok, false)
  fs.mkdirSync(join(m.userData, STAGE_DIR))
  fs.writeFileSync(join(m.userData, RESTORE_FILE), JSON.stringify({ folder: join(m.userData, STAGE_DIR), shopFile: '../core.db' }), 'utf8')
  assert.equal(apply(m).ok, false)
  assert.throws(() => ask(m, join(m.userData, STAGE_DIR)), /нельзя/)
  assert.throws(() => ask(m, 'относительный/путь'), /неверно/)
})

test('копия откладывается к себе сразу: флешку вынули, а копию из папки копий вытеснили — загрузка всё равно идёт', async () => {
  const m = machine(A)
  withShop(m, (db) => sell(db, 'чек'))
  const folder = await snapshot(m)
  ask(m, folder)
  fs.rmSync(folder, { recursive: true, force: true })
  assert.equal(apply(m).ok, true)
  withShop(m, (db) => assert.deepEqual(queue(db), ['чек']))
})

test('где лежат копии: сама папка, папка копий кассы и вторая папка целиком', async () => {
  const m = machine(A)
  const folder = await snapshot(m)
  const root = fs.mkdtempSync(join(os.tmpdir(), 'apteka-flash-'))
  const kassa = join(root, 'KASSA-1-1a2b3c4d')
  fs.mkdirSync(join(kassa, '2026-10-18_07-00-00-1'), { recursive: true })
  fs.mkdirSync(join(kassa, '.2026-10-18_08-00-00-2.tmp'), { recursive: true })
  for (const f of ['core.db', SHOP]) {
    fs.copyFileSync(join(folder, f), join(kassa, '2026-10-18_07-00-00-1', f))
    fs.copyFileSync(join(folder, f), join(kassa, '.2026-10-18_08-00-00-2.tmp', f))
  }
  fs.mkdirSync(join(root, 'Фото'))
  fs.writeFileSync(join(root, 'Фото', 'kartinka.jpg'), 'x')
  const found = (start) => findCopies(start, { fs }).map((c) => c.folder)
  assert.deepEqual(found(root), [join(kassa, '2026-10-18_07-00-00-1')], 'недоснятая копия и папки без баз пропущены')
  assert.deepEqual(found(kassa), [join(kassa, '2026-10-18_07-00-00-1')])
  assert.deepEqual(found(join(kassa, '2026-10-18_07-00-00-1')), [join(kassa, '2026-10-18_07-00-00-1')])
  // Подпись: с какого компьютера — по папке компьютера во второй папке
  const d = describeCopy({ folder: join(kassa, '2026-10-18_07-00-00-1'), files: ['core.db', SHOP], shopFile: SHOP, deviceId: B.id, schemaMax: MAX, fs, Database })
  assert.equal(d.computer, 'KASSA-1')
})

test('«Сохранить копию в…»: отдельная папка с понятным именем, базы целы, рядом описание', async () => {
  const m = machine(A)
  withShop(m, (db) => sell(db, 'чек'))
  const folder = await snapshot(m)
  const dest = fs.mkdtempSync(join(os.tmpdir(), 'apteka-save-'))
  const label = 'FinMax POS — копия 2026-10-18 12-00'
  const first = saveCopyTo({ from: folder, dest, label, at: NOW, info: { computer: 'KASSA-1' }, fs, Database })
  const second = saveCopyTo({ from: folder, dest, label, at: NOW, fs, Database })
  assert.equal(first, join(dest, label))
  assert.equal(second, join(dest, label + ' (2)'), 'прежнюю сохранённую копию не затирает')
  assert.deepEqual(fs.readdirSync(first).sort(), [MANIFEST, 'core.db', SHOP].sort())
  // Окно «Загрузить копию» узнаёт её: время и компьютер — из описания
  const d = describeCopy({ folder: first, files: ['core.db', SHOP], shopFile: SHOP, deviceId: A.id, schemaMax: MAX, fs, Database })
  assert.deepEqual({ at: d.at, computer: d.computer, pending: d.pending, foreign: d.foreign, problem: d.problem }, { at: NOW, computer: 'KASSA-1', pending: 1, foreign: false, problem: '' })
})
