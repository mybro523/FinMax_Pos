// ── Резервная копия локальных баз ──
//
// Копия нужна в тот день, когда с диском что-то случилось. Проверяется главное:
// копия снимается с работающей базы и читается; испорченная база сама поднимается
// из копии; то, что чинить копией нельзя, не трогается.
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
import { BUSY_MESSAGE, createBackups, DAY_MS, hostFolderOf, openOrRestore } from '../src/backup.mjs'
import { openDb } from '../src/local/db.mjs'

const SCHEMA = ['CREATE TABLE cheki (id TEXT PRIMARY KEY, summa INTEGER NOT NULL)']
const NOW = Date.parse('2026-10-04T10:00:00.000Z')

function setup({ host = '' } = {}) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'apteka-backup-'))
  const data = join(root, 'data')
  fs.mkdirSync(data)
  const time = { now: NOW }
  const logs = []
  const log = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) }
  const backups = createBackups({ dir: join(root, 'backups'), fs, Database, now: () => time.now, log, host })
  const file = join(data, 'pharmacy-a.db')
  const open = (f = file) => openDb(f, SCHEMA)
  return { root, data, time, logs, log, backups, file, open }
}
const cheki = (db) => db.prepare('SELECT id FROM cheki ORDER BY id').all().map((r) => r.id)
const sell = (db, id) => db.prepare('INSERT INTO cheki (id, summa) VALUES (?, 100)').run(id)
// Испортить файл базы так, как это делает сбойный диск: затереть середину
function corrupt(file) {
  for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, Buffer.alloc(3000, 0x5a), 0, 3000, 0)
  fs.closeSync(fd)
}

test('копия снимается с работающей базы и содержит всё, что было записано', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  sell(db, 'чек-2')
  // База открыта и в неё продолжают писать — так и будет в магазине
  const r = await t.backups.run([{ name: 'pharmacy-a.db', db }])
  sell(db, 'чек-3')

  assert.equal(r.files[0].name, 'pharmacy-a.db')
  assert.ok(r.files[0].bytes > 0)
  // Копия — один файл: её носят на флешке, и служебных файлов рядом быть не должно
  assert.deepEqual(fs.readdirSync(r.folder), ['pharmacy-a.db'])
  assert.match(r.folder, /2026-10-04_10-00-00-1$/, 'в имени папки — время и порядковый номер копии')
  const copy = new Database(join(r.folder, 'pharmacy-a.db'), { readonly: true })
  assert.deepEqual(cheki(copy), ['чек-1', 'чек-2'], 'в копии должно быть ровно то, что было на момент снятия')
  copy.close()
  assert.equal(t.backups.last().at, NOW)
  db.close()
})

test('база, которая сейчас не открыта, копируется из файла', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  db.close()
  const r = await t.backups.run([{ name: 'pharmacy-a.db', file: t.file }])
  const copy = new Database(join(r.folder, 'pharmacy-a.db'), { readonly: true })
  assert.deepEqual(cheki(copy), ['чек-1'])
  copy.close()
})

test('копия нужна раз в сутки, хранится семь последних', async () => {
  const t = setup()
  const db = t.open()
  assert.equal(t.backups.due(), true, 'копий ещё нет — пора')
  for (let day = 0; day < 10; day++) {
    sell(db, 'чек-' + day)
    await t.backups.run([{ name: 'pharmacy-a.db', db }])
    assert.equal(t.backups.due(), false, 'только что сняли')
    t.time.now += DAY_MS - 60000
    assert.equal(t.backups.due(), false, 'сутки ещё не прошли')
    t.time.now += 60000
    assert.equal(t.backups.due(), true)
  }
  const list = t.backups.list()
  assert.equal(list.length, 7)
  assert.equal(list[0].at, NOW + 9 * DAY_MS, 'самая свежая — первая')
  assert.equal(list.at(-1).at, NOW + 3 * DAY_MS, 'три самые старые убраны')
  db.close()
})

test('недоснятая копия не выдаётся за готовую', async () => {
  const t = setup()
  // Ни с одной базы копию снять не вышло — копии нет вовсе, и следов от неё тоже
  const bad = join(t.data, 'pharmacy-b.db')
  fs.writeFileSync(bad, Buffer.alloc(5000, 0x5a))
  await assert.rejects(() => t.backups.run([{ name: 'pharmacy-b.db', file: bad }, { name: 'net.db', file: join(t.data, 'нет-такого.db') }]))
  assert.deepEqual(t.backups.list(), [], 'оборвавшаяся копия осталась в списке')
  assert.deepEqual(fs.readdirSync(t.backups.dir), [], 'временная папка не убрана')
  assert.equal(t.backups.due(), true, 'копии нет — значит, её по-прежнему пора снимать')
})

test('одна испорченная база не оставляет без копии остальные', async () => {
  // На компьютере могут лежать базы нескольких магазинов. Беда с одной — давно не
  // открывавшейся — не должна отменять копию рабочей: в ней чеки, которых нет нигде
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  const bad = join(t.data, 'pharmacy-b.db')
  fs.writeFileSync(bad, Buffer.alloc(5000, 0x5a))

  const r = await t.backups.run([
    { name: 'pharmacy-b.db', file: bad },
    { name: 'pharmacy-a.db', db },
    { name: 'pharmacy-c.db', file: join(t.data, 'нет-такого.db') },
  ])
  assert.deepEqual(r.files.map((f) => f.name), ['pharmacy-a.db'])
  assert.deepEqual(r.skipped.map((x) => x.name), ['pharmacy-b.db', 'pharmacy-c.db'], 'что не попало в копию, названо поимённо')
  assert.ok(r.skipped.every((x) => x.error))
  assert.deepEqual(fs.readdirSync(r.folder), ['pharmacy-a.db'], 'от несостоявшихся копий не должно остаться обрывков')
  const copy = new Database(join(r.folder, 'pharmacy-a.db'), { readonly: true })
  assert.deepEqual(cheki(copy), ['чек-1'])
  copy.close()
  assert.ok(t.logs.some((l) => l[0] === 'error' && /pharmacy-b\.db не снята/.test(l[1])), 'о пропущенной базе написано в журнал')
  db.close()
})

test('база перестала попадать в копии — её последняя копия не убирается, сколько бы ей ни было', async () => {
  // Файл базы испортился, пока программа работала. Копия с него больше не снимается,
  // а старые копии уходят по одной в сутки. Через неделю поднимать базу было бы не из чего
  const t = setup()
  const a = t.open()
  const fileB = join(t.data, 'pharmacy-b.db')
  const b = t.open(fileB)
  sell(a, 'чек-а')
  sell(b, 'чек-б')
  await t.backups.run([{ name: 'pharmacy-a.db', db: a }, { name: 'pharmacy-b.db', db: b }])
  b.close()
  corrupt(fileB)

  for (let day = 1; day <= 10; day++) {
    t.time.now += DAY_MS
    const r = await t.backups.run([{ name: 'pharmacy-a.db', db: a }, { name: 'pharmacy-b.db', file: fileB }])
    assert.deepEqual(r.skipped.map((x) => x.name), ['pharmacy-b.db'])
  }
  const list = t.backups.list()
  assert.equal(list.length, 8, 'семь последних — и та, в которой последняя копия испортившейся базы')
  assert.equal(list.at(-1).at, NOW)
  assert.deepEqual(t.backups.latestCopy('pharmacy-b.db')?.at, NOW)

  // И она действительно поднимается
  const r = openOrRestore({ file: fileB, name: 'pharmacy-b.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-б'])
  r.db.close()
  a.close()
})

test('вторая папка: копия ложится и туда; недоступная вторая папка основной копии не мешает', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  const flash = join(t.root, 'флешка')
  fs.mkdirSync(flash)
  const r = await t.backups.run([{ name: 'pharmacy-a.db', db }], { extra: flash })
  assert.equal(r.extra.ok, true)
  assert.equal(t.backups.intact(join(r.extra.folder, 'pharmacy-a.db')), true)

  // Флешку вынули: вместо папки — путь, по которому создать ничего нельзя
  t.time.now += DAY_MS
  const gone = join(t.file, 'внутри-файла')
  const r2 = await t.backups.run([{ name: 'pharmacy-a.db', db }], { extra: gone })
  assert.equal(r2.extra.ok, false)
  assert.ok(r2.extra.error)
  assert.equal(t.backups.list().length, 2, 'основная копия должна быть снята несмотря ни на что')
  db.close()
})

test('файл базы испорчен — программа сама поднимает её из последней копии', async () => {
  const t = setup()
  let db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  sell(db, 'чек-2 (после копии)')
  db.close()
  corrupt(t.file)

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-1'], 'поднята копия: в ней то, что было на момент её снятия')
  // С поднятой базой можно работать дальше
  sell(r.db, 'чек-3')
  r.db.close()
  // Испорченный файл не стёрт: в нём могли остаться чеки, которых нет в копии
  const aside = join(t.root, 'broken')
  assert.equal(fs.readdirSync(join(aside, fs.readdirSync(aside)[0])).includes('pharmacy-a.db'), true)
  assert.ok(t.logs.some((l) => l[0] === 'error' && /повреждена/.test(l[1])))
})

test('испорченная копия пропускается — берётся ближайшая исправная', async () => {
  const t = setup()
  let db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  t.time.now += DAY_MS
  sell(db, 'чек-2')
  const fresh = await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  corrupt(join(fresh.folder, 'pharmacy-a.db'))
  corrupt(t.file)

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
})

test('копия есть только во второй папке (диск меняли) — база поднимается оттуда', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  const flash = join(t.root, 'флешка')
  fs.mkdirSync(flash)
  await t.backups.run([{ name: 'pharmacy-a.db', db }], { extra: flash })
  db.close()
  fs.rmSync(t.backups.dir, { recursive: true, force: true })
  corrupt(t.file)

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, extra: flash, now: () => t.time.now, log: t.log })
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
})

test('копий нет вовсе — база начинается заново, а не роняет программу', () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  db.close()
  corrupt(t.file)
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: null })
  assert.deepEqual(cheki(r.db), [])
  r.db.close()
})

test('целая база открывается как обычно, копии не трогаются', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  sell(db, 'чек-2')
  db.close()
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.equal(r.restored, null)
  assert.deepEqual(cheki(r.db), ['чек-1', 'чек-2'])
  r.db.close()
  assert.equal(fs.existsSync(join(t.root, 'broken')), false)
})

test('база от более новой версии программы — это не поломка: копией её не подменяют', async () => {
  const t = setup()
  const db = openDb(t.file, [...SCHEMA, 'CREATE TABLE novoe (id TEXT)'])
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  sell(db, 'чек-2')
  db.close()
  // Поверх новой версии поставили прежнюю: она знает только первый шаг схемы
  assert.throws(
    () => openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log }),
    /более новой версией/,
  )
  assert.equal(fs.existsSync(join(t.root, 'broken')), false, 'исправный файл отложен как повреждённый')
  const still = new Database(t.file, { readonly: true })
  assert.deepEqual(cheki(still), ['чек-1', 'чек-2'], 'данные тронуты')
  still.close()
})

test('испорченный файл ненадолго занят (его читает антивирус) — программа ждёт и поднимает копию', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  corrupt(t.file)

  let busy = 2
  const pauses = []
  const flaky = {
    ...fs,
    renameSync: (...a) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return fs.renameSync(...a)
    },
  }
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs: flaky, now: () => t.time.now, log: t.log, pause: (ms) => pauses.push(ms) })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-1'])
  assert.equal(pauses.length, 2, 'две неудачи — две паузы, третья попытка удалась')
  r.db.close()
})

test('испорченный файл занят намертво — программа говорит об этом, а не падает и не начинает с пустой базы', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  corrupt(t.file)
  const before = fs.readFileSync(t.file)

  const locked = () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  }
  const stuck = { ...fs, renameSync: locked, rmSync: locked }
  let copied = false
  stuck.copyFileSync = (...a) => {
    copied = true
    return fs.copyFileSync(...a)
  }
  assert.throws(
    () => openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs: stuck, now: () => t.time.now, log: t.log, pause: () => {} }),
    (e) => e.busy === true && e.message === BUSY_MESSAGE,
  )
  assert.equal(copied, false, 'копию поверх занятого файла класть нельзя')
  assert.deepEqual(fs.readFileSync(t.file), before, 'сам файл не тронут')
  // Занятость прошла — следующий запуск поднимает базу как обычно
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
})

test('копия «из будущего» (часы когда-то врали) не останавливает ежедневные копии и не считается самой свежей', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  // Компьютер загрузился с неверным годом — и копия снялась с отметкой 2038 года
  const real = t.time.now
  t.time.now = Date.parse('2038-07-09T10:00:00.000Z')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  t.time.now = real
  assert.equal(t.backups.due(), true, 'иначе ежедневные копии прекратились бы до 2038 года')

  sell(db, 'чек-2')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  assert.equal(t.backups.due(), false, 'сегодняшняя копия снята — до завтра не пора')
  assert.equal(t.backups.last().at, real, 'последней считается настоящая копия')
  const copy = t.backups.latestCopy('pharmacy-a.db')
  assert.equal(copy.at, real, 'и поднимать базу программа будет из неё, а не из копии «из будущего»')

  // Через неделю ежедневных копий копия «из будущего» уходит как самая старая
  for (let day = 1; day <= 8; day++) {
    t.time.now += DAY_MS
    await t.backups.run([{ name: 'pharmacy-a.db', db }])
  }
  assert.equal(t.backups.list().some((c) => c.at > t.time.now), false)
  assert.equal(t.backups.list().length, 7)
  db.close()
})

test('часы компьютера при включении показывают 2015 год: копии не путаются — порядок по отметке программы, а не по времени папки', async () => {
  // Села батарейка на плате. Время программы верное (его сказал сервер), и копии
  // названы им. Но при запуске, пока часы программы ещё не подняты, «сейчас» — это
  // часы компьютера: 2015 год. Все копии выглядят «из будущего»
  const t = setup()
  const db = t.open()
  for (let day = 0; day < 5; day++) {
    sell(db, 'чек-' + day)
    await t.backups.run([{ name: 'pharmacy-a.db', db }])
    t.time.now += DAY_MS
  }
  db.close()
  const last = NOW + 4 * DAY_MS

  t.time.now = Date.parse('2015-01-01T00:00:40.000Z')
  assert.deepEqual(t.backups.list().map((c) => c.at), [4, 3, 2, 1, 0].map((d) => NOW + d * DAY_MS), 'свежие — первыми')
  assert.equal(t.backups.latestCopy('pharmacy-a.db').at, last)
  corrupt(t.file)
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: last })
  assert.deepEqual(cheki(r.db), ['чек-0', 'чек-1', 'чек-2', 'чек-3', 'чек-4'], 'поднята последняя копия, а не случайная')
  r.db.close()
})

test('копия, снятая до того, как подняты часы программы (перед обновлением), не удаляется тут же как «самая старая»', async () => {
  const t = setup()
  const db = t.open()
  for (let day = 0; day < 7; day++) {
    sell(db, 'чек-' + day)
    await t.backups.run([{ name: 'pharmacy-a.db', db }])
    t.time.now += DAY_MS
  }
  db.close()
  // Запуск новой версии на компьютере с севшей батарейкой: «сейчас» — 2015 год
  t.time.now = Date.parse('2015-01-01T00:00:40.000Z')
  const r = await t.backups.run([{ name: 'pharmacy-a.db', file: t.file }])
  assert.equal(fs.existsSync(r.folder), true, 'только что снятая копия прежней версии должна остаться')
  assert.equal(t.backups.list().length, 7)
  assert.equal(t.backups.list().some((c) => c.at === NOW), false, 'ушла самая давняя по отметке программы')
})

test('две копии с одной и той же отметкой не мешают друг другу', async () => {
  // Часы компьютера при каждом включении начинают с одного и того же дня — и копия
  // перед обновлением второй раз получила бы то же имя папки
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  const first = await t.backups.run([{ name: 'pharmacy-a.db', db }])
  sell(db, 'чек-2')
  const again = await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  assert.match(first.folder, /2026-10-04_10-00-00-1$/)
  assert.match(again.folder, /2026-10-04_10-00-00-2$/)
  assert.equal(t.backups.list().length, 2)
  assert.equal(t.backups.last().folder, again.folder, 'из двух с одной отметкой свежее та, что снята позже')
  const copy = new Database(t.backups.latestCopy('pharmacy-a.db').file, { readonly: true })
  assert.deepEqual(cheki(copy), ['чек-1', 'чек-2'])
  copy.close()
})

test('пустой файл базы копией не становится — и вместо настоящей копии не поднимается', async () => {
  const t = setup()
  const a = t.open()
  const fileB = join(t.data, 'pharmacy-b.db')
  const b = t.open(fileB)
  sell(b, 'чек-б')
  await t.backups.run([{ name: 'pharmacy-a.db', db: a }, { name: 'pharmacy-b.db', db: b }])
  b.close()
  // Назавтра файл второй базы пуст (запись оборвалась), и программа снимает копию
  // закрытых баз по файлам — так делается перед обновлением
  for (const suffix of ['-wal', '-shm']) fs.rmSync(fileB + suffix, { force: true })
  fs.writeFileSync(fileB, '')
  t.time.now += DAY_MS
  const r = await t.backups.run([{ name: 'pharmacy-a.db', db: a }, { name: 'pharmacy-b.db', file: fileB }])
  assert.deepEqual(r.skipped.map((x) => x.name), ['pharmacy-b.db'], 'пустой файл в копию не попадает')
  assert.deepEqual(fs.readdirSync(r.folder), ['pharmacy-a.db'])
  a.close()

  const back = openOrRestore({ file: fileB, name: 'pharmacy-b.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(back.restored, { at: NOW }, 'поднята вчерашняя копия — та, в которой чеки')
  assert.deepEqual(cheki(back.db), ['чек-б'])
  back.db.close()

  // И если пустая «копия» всё же лежит в папке (осталась от прежней версии программы) —
  // исправной она не считается
  const bogus = join(t.backups.dir, '2026-10-06_10-00-00')
  fs.mkdirSync(bogus)
  new Database(join(bogus, 'pharmacy-b.db')).close()
  assert.equal(t.backups.intact(join(bogus, 'pharmacy-b.db')), false)
  assert.equal(t.backups.latestCopy('pharmacy-b.db').at, NOW)
})

test('файл базы пропал, исправной копии нет, но следы базы есть — это не «первый запуск»: человек узнаёт о потере', async () => {
  // Журнал без самого файла
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  db.close()
  for (const suffix of ['', '-shm']) fs.rmSync(t.file + suffix, { force: true })
  const journal = Buffer.from('записи последних минут')
  fs.writeFileSync(t.file + '-wal', journal)
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: null }, 'база была и пропала — молчать об этом нельзя')
  assert.deepEqual(cheki(r.db), [])
  r.db.close()
  const aside = join(t.root, 'broken')
  assert.deepEqual(fs.readFileSync(join(aside, fs.readdirSync(aside)[0], 'pharmacy-a.db-wal')), journal, 'журнал отложен, а не стёрт пустой базой')

  // Копия была, но не читается
  const u = setup()
  const db2 = u.open()
  sell(db2, 'чек-1')
  const made = await u.backups.run([{ name: 'pharmacy-a.db', db: db2 }])
  db2.close()
  corrupt(join(made.folder, 'pharmacy-a.db'))
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(u.file + suffix, { force: true })
  const r2 = openOrRestore({ file: u.file, name: 'pharmacy-a.db', open: u.open, backups: u.backups, fs, now: () => u.time.now, log: u.log })
  assert.deepEqual(r2.restored, { at: null })
  r2.db.close()
  assert.ok(u.logs.some((l) => l[0] === 'error' && /исправной копии нет/.test(l[1])))
})

test('во второй папке у каждого компьютера своя подпапка: соседняя касса чужую копию не поднимет', async () => {
  const flash = fs.mkdtempSync(join(os.tmpdir(), 'apteka-flash-'))
  // Две кассы кладут копии на один сетевой диск. Файлы у них называются одинаково
  const one = setup({ host: 'KASSA-1' })
  const two = setup({ host: 'KASSA-2' })
  const a = one.open()
  sell(a, 'чек первой кассы')
  const ra = await one.backups.run([{ name: 'pharmacy-a.db', db: a }], { extra: flash })
  a.close()
  two.time.now += 3600_000 // вторая касса сняла копию часом позже — её копия «свежее»
  const b = two.open()
  sell(b, 'чек второй кассы')
  const rb = await two.backups.run([{ name: 'pharmacy-a.db', db: b }], { extra: flash })
  b.close()
  assert.equal(ra.extra.ok && rb.extra.ok, true)
  assert.deepEqual(fs.readdirSync(flash).sort(), ['KASSA-1', 'KASSA-2'])

  // У первой кассы пропали и база, и своя папка копий — остался сетевой диск
  fs.rmSync(one.backups.dir, { recursive: true, force: true })
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(one.file + suffix, { force: true })
  const r = openOrRestore({ file: one.file, name: 'pharmacy-a.db', open: one.open, backups: one.backups, fs, extra: flash, now: () => one.time.now, log: one.log })
  assert.deepEqual(cheki(r.db), ['чек первой кассы'], 'поднята своя копия, а не более свежая копия соседней кассы')
  r.db.close()
})

test('файла базы нет, а копия есть — программа поднимает копию, а не начинает с пустой', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(t.file + suffix, { force: true })

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW }, 'человек должен узнать, что база поднята из копии')
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
  assert.equal(fs.existsSync(join(t.root, 'broken')), false, 'откладывать было нечего — пустой папки не остаётся')
})

test('файл базы пуст (запись оборвалась), а копия есть — поднимается копия', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  for (const suffix of ['-wal', '-shm']) fs.rmSync(t.file + suffix, { force: true })
  fs.writeFileSync(t.file, '')

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW }, 'пустой файл SQLite открывает как новую базу — и чеки, и номер кассы молча пропали бы')
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
})

test('файла базы нет и копий нет — это первый запуск: пустая база, без всяких сообщений', () => {
  const t = setup()
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.equal(r.restored, null)
  assert.deepEqual(cheki(r.db), [])
  r.db.close()
  assert.equal(fs.existsSync(join(t.root, 'broken')), false)
  assert.equal(t.logs.some((l) => l[0] === 'error'), false)
})

test('файл базы пропал, а её журнал остался — журнал откладывается в сторону, а не стирается: в нём чеки последних минут', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  // Компьютер выключили с открытой программой: рядом с базой остался журнал, а в нём
  // записи, которые в сам файл ещё не перенесены. Потом пропал сам файл
  for (const suffix of ['', '-shm']) fs.rmSync(t.file + suffix, { force: true })
  const journal = Buffer.from('записи последних минут')
  fs.writeFileSync(t.file + '-wal', journal)

  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-1'], 'копия поднята чистой: чужой журнал на неё не наложен')
  r.db.close()
  const aside = join(t.root, 'broken')
  const kept = join(aside, fs.readdirSync(aside)[0], 'pharmacy-a.db-wal')
  assert.deepEqual(fs.readFileSync(kept), journal, 'журнал должен сохраниться: специалист достанет из него чеки')
})

test('журнал пропавшей базы занят и не убирается — копия поверх не кладётся: программа говорит об этом', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  for (const suffix of ['', '-shm']) fs.rmSync(t.file + suffix, { force: true })
  fs.writeFileSync(t.file + '-wal', 'записи последних минут')

  const held = (f) => String(f).endsWith('-wal')
  let copied = false
  const stuck = {
    ...fs,
    renameSync: (a, b) => {
      if (held(a)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return fs.renameSync(a, b)
    },
    rmSync: (a, o) => {
      if (held(a)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return fs.rmSync(a, o)
    },
    copyFileSync: (...a) => {
      copied = true
      return fs.copyFileSync(...a)
    },
  }
  assert.throws(
    () => openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs: stuck, now: () => t.time.now, log: t.log, pause: () => {} }),
    (e) => e.busy === true && e.message === BUSY_MESSAGE,
  )
  assert.equal(copied, false, 'рядом с чужим журналом копию класть нельзя: SQLite наложил бы его записи на неё')
  assert.equal(fs.existsSync(t.file), false)
})

test('журнал испорченной базы занят: сам файл остаётся на месте, и следующий запуск поднимает копию', async () => {
  const t = setup()
  const db = t.open()
  sell(db, 'чек-1')
  await t.backups.run([{ name: 'pharmacy-a.db', db }])
  db.close()
  corrupt(t.file)

  // Рядом с базой лежит её журнал, и его держит другая программа: ни отложить, ни удалить
  const held = (f) => String(f).endsWith('-wal')
  const stuck = {
    ...fs,
    existsSync: (f) => held(f) || fs.existsSync(f),
    renameSync: (a, b) => {
      if (held(a)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return fs.renameSync(a, b)
    },
    rmSync: (a, o) => {
      if (held(a)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return fs.rmSync(a, o)
    },
  }
  assert.throws(
    () => openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs: stuck, now: () => t.time.now, log: t.log, pause: () => {} }),
    (e) => e.busy === true,
  )
  assert.equal(fs.existsSync(t.file), true, 'файл базы убран раньше журнала: следующий запуск увидел бы пустое место и начал бы с нуля')

  // Журнал освободился — база поднимается из копии, и программа об этом говорит
  const r = openOrRestore({ file: t.file, name: 'pharmacy-a.db', open: t.open, backups: t.backups, fs, now: () => t.time.now, log: t.log })
  assert.deepEqual(r.restored, { at: NOW })
  assert.deepEqual(cheki(r.db), ['чек-1'])
  r.db.close()
})

test('подпапка компьютера во второй папке: разные имена — разные папки, в том числе русские', () => {
  // Компьютеры в магазинах называют и по-русски. Без отпечатка полного имени «КАССА» и
  // «Магазин» получили бы одну и ту же папку, а «Касса-1» и «Магазин-1» — одну на двоих
  const names = ['KASSA-1', 'KASSA-2', 'КАССА', 'Магазин', 'Касса-1', 'Магазин-1', 'касса', 'DESKTOP-9F3K2LM', '']
  const folders = names.map(hostFolderOf)
  assert.equal(new Set(folders).size, names.length, 'папки совпали: ' + folders.join(' | '))
  for (const folder of folders) assert.match(folder, /^[A-Za-z0-9_-]+-[0-9a-f]{8}$/, 'имя папки годится для любого диска: ' + folder)
  assert.match(hostFolderOf('KASSA-1'), /^KASSA-1-/, 'латинское имя видно в названии папки')
  assert.match(hostFolderOf('КАССА'), /^kassa-/)
  assert.equal(hostFolderOf('KASSA-1'), hostFolderOf('KASSA-1'), 'у одного компьютера папка всегда одна и та же')
})
