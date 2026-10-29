// ── Копия базы на диск D (1.5.8): куда класть, когда пора, сколько хранить ──
//
// Настоящие файлы во временной папке и настоящая SQLite: копия с диска должна открываться
// так же, как «Сохранить копию в…», — её возвращает обычная «Загрузить копию».
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { chooseDiskFolder, diskDue, diskLabel, DISK_EVERY_MS, DISK_FOLDER, listDiskCopies, pruneDisk, removeTree, writeDiskCopy } from '../src/disk-backup.mjs'
import { findCopies, MANIFEST, saveCopyTo } from '../src/restore.mjs'

const tmp = (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'disk-backup-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
// Папка «свежей копии баз», как её снимает backup.mjs: общая база и база магазина
function snapshot(root, name = 'snap') {
  const dir = join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['core.db', 'pharmacy-shifo.db']) {
    const db = new Database(join(dir, f))
    db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)')
    db.close()
  }
  return dir
}

test('имя папки копии: магазин и время; знаки, запрещённые в Windows, убраны', () => {
  assert.equal(diskLabel('Супермаркет София', '2026-10-29 19-15'), 'Супермаркет София 2026-10-29 19-15')
  assert.equal(diskLabel('Магазин "Шифо"/1: <опт>?', '2026-10-29 19-15'), 'Магазин Шифо 1 опт 2026-10-29 19-15')
  assert.equal(diskLabel('Аптека «Шифо».. ', '2026-10-29 19-15'), 'Аптека «Шифо» 2026-10-29 19-15', 'точки и пробелы в конце Windows отрезает — убираем сами')
  assert.equal(diskLabel('', '2026-10-29 19-15'), 'FinMax POS 2026-10-29 19-15')
  assert.equal(diskLabel(null, 'x'), 'FinMax POS x')
  assert.ok(diskLabel('Я'.repeat(200), 's').length <= 62, 'длинное название обрезается')
})

test('куда класть: диск D, его нет — C; на D не записать — тоже C', (t) => {
  const root = tmp(t)
  const D = join(root, 'D')
  const C = join(root, 'C')
  fs.mkdirSync(C)
  // Диска D нет вовсе
  let r = chooseDiskFolder({ fs, roots: [D, C] })
  assert.equal(r.dir, join(C, DISK_FOLDER))
  assert.match(r.tried[0], /нет такого диска/)
  assert.ok(fs.existsSync(r.dir) && fs.readdirSync(r.dir).length === 0, 'папка заведена, пробный файл убран')
  // Диск D есть — копии на нём
  fs.mkdirSync(D)
  r = chooseDiskFolder({ fs, roots: [D, C] })
  assert.equal(r.dir, join(D, DISK_FOLDER))
  // На D не записать: на месте папки копий — файл (как дисковод или защищённая флешка)
  removeTree(fs, join(D, DISK_FOLDER))
  assert.ok(!fs.existsSync(join(D, DISK_FOLDER)), 'папка с русским именем и тире удалена')
  fs.writeFileSync(join(D, DISK_FOLDER), 'не папка')
  r = chooseDiskFolder({ fs, roots: [D, C] })
  assert.equal(r.dir, join(C, DISK_FOLDER))
  assert.equal(r.tried.length, 1)
  // Не записать нигде — dir: null и объяснение по каждому диску
  r = chooseDiskFolder({ fs, roots: [join(root, 'X'), join(root, 'Y')] })
  assert.equal(r.dir, null)
  assert.equal(r.tried.length, 2)
})

test('пора ли: раз в 2 дня — по часам программы или по часам срока без связи', () => {
  const now = Date.UTC(2026, 9, 29, 12)
  assert.equal(diskDue({ lastAt: 0, lastLic: 0, now, lic: 1000 }), true, 'копии ещё не было')
  assert.equal(diskDue({ lastAt: now - DISK_EVERY_MS + 60000, lastLic: 5000, now, lic: 5000 + 3600000 }), false, 'прошло меньше 2 суток')
  assert.equal(diskDue({ lastAt: now - DISK_EVERY_MS, lastLic: 5000, now, lic: 5000 + 3600000 }), true, 'по часам программы прошло 2 суток')
  // Часы компьютера сбиты (прошлую копию сняли «в будущем»), а по часам срока прошло 2 суток
  assert.equal(diskDue({ lastAt: now + 10 * 86400000, lastLic: 5000, now, lic: 5000 + DISK_EVERY_MS }), true)
  // Часы перевели назад на неделю: по часам программы прошло «минус неделю» — тоже пора
  assert.equal(diskDue({ lastAt: now + 7 * 86400000, lastLic: 5000, now, lic: 5000 }), true)
  // Значения из базы приходят строками
  assert.equal(diskDue({ lastAt: String(now - 3600000), lastLic: '5000', now, lic: 5000 + 3600000 }), false)
})

test('копия на диск открывается как «Сохранить копию в…», хранятся 15 последних своих, ручные не трогаются', (t) => {
  const root = tmp(t)
  const snap = snapshot(root)
  const dir = join(root, 'D', DISK_FOLDER)
  fs.mkdirSync(dir, { recursive: true })
  // Копия, положенная туда руками («Сохранить копию в…»): без пометки auto
  const manual = saveCopyTo({ from: snap, dest: dir, label: 'FinMax POS — копия 2026-10-01 10-00', at: Date.UTC(2026, 9, 1), fs, Database })
  const base = Date.UTC(2026, 9, 1, 12)
  for (let i = 0; i < 17; i++) {
    const at = base + i * DISK_EVERY_MS
    const path = writeDiskCopy({ from: snap, dir, label: diskLabel('Супермаркет София', `2026-10-${String(1 + 2 * i).padStart(2, '0')} 12-00`), at, info: { version: '1.5.8' }, fs, Database, keep: 15 })
    assert.ok(fs.existsSync(join(path, 'pharmacy-shifo.db')) && fs.existsSync(join(path, 'core.db')))
  }
  const mine = listDiskCopies({ dir, fs })
  assert.equal(mine.length, 15, 'своих копий — 15')
  assert.equal(mine[0].at, base + 16 * DISK_EVERY_MS, 'сверху — самая свежая')
  assert.ok(!mine.some((c) => c.at === base || c.at === base + DISK_EVERY_MS), 'две самые старые удалены')
  assert.ok(fs.existsSync(manual), 'копию, сохранённую руками, программа не трогает')
  const m = JSON.parse(fs.readFileSync(join(mine[0].folder, MANIFEST), 'utf8'))
  assert.equal(m.auto, true)
  assert.equal(m.app, 'FinMax POS')
  // «Загрузить копию» находит копии в папке на диске — каждую своей папкой
  const found = findCopies(dir, { fs, depth: 1 }).filter((c) => c.folder !== dir)
  assert.equal(found.length, 16, '15 своих и одна ручная')
  assert.ok(found.every((c) => c.files.includes('pharmacy-shifo.db')))
  // Лишнего прореживать нечего
  assert.equal(pruneDisk({ dir, fs, keep: 15 }), 0)
})

test('одинаковое имя в ту же минуту — вторая копия рядом с пометкой (2), первая цела', (t) => {
  const root = tmp(t)
  const snap = snapshot(root)
  const dir = join(root, 'C', DISK_FOLDER)
  fs.mkdirSync(dir, { recursive: true })
  const a = writeDiskCopy({ from: snap, dir, label: 'Магазин 2026-10-29 19-15', at: 1, fs, Database })
  const b = writeDiskCopy({ from: snap, dir, label: 'Магазин 2026-10-29 19-15', at: 2, fs, Database })
  assert.notEqual(a, b)
  assert.ok(b.endsWith('(2)'))
  assert.equal(listDiskCopies({ dir, fs }).length, 2)
})
