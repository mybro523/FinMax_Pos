// ── Загрузить копию базы вручную ──
//
// Копии баз программа снимает сама (backup.mjs) и испорченный файл сама же поднимает из
// копии при запуске. Здесь — загрузка копии по просьбе владельца: «Загрузить копию» в
// окне «Состояние программы». Для чего это нужно:
//   • старый компьютер сломался, а копия его баз — на флешке. Новая касса загружает её и
//     становится той кассой — с её номером, сменой и чеками, которые не успели уйти на
//     сервер (они уйдут, как только будет связь);
//   • вернуть базу этой кассы к одной из её копий.
// Магазин на прошлую дату так не вернуть: всё, что уже на сервере, там и остаётся и при
// обмене приходит обратно (магазин целиком — «Резервная копия» в настройках сайта).
//
// Правила.
//   1. Загружается только база магазина, в который вошли. Общая база — вход, срок работы
//      без связи, часы — остаётся своей: иначе старой копией можно было бы вернуть себе
//      истраченный срок работы без интернета. С копии другого компьютера берутся только
//      номер и ключ кассы — так эта касса и становится той.
//   2. Файл работающей базы подменить нельзя. Поэтому основная часть откладывает нужные
//      файлы копии к себе (папка restore-source — флешку могут вынуть, а копию в папке
//      backups — вытеснить новые копии), записывает просьбу (restore-pending.json) и
//      перезапускает программу. Выполняется просьба при запуске — до того, как открыта
//      хоть одна база.
//   3. Нынешний файл не стирается, а откладывается в папку replaced. Перед этим основная
//      часть снимает обычную копию — её можно загрузить обратно тем же окном.
//   4. Загруженная база спрашивает у сервера весь магазин заново (то, что не ушло, сначала
//      уйдёт), а журнал обмена с соседними кассами продолжает нумерацию прежнего файла:
//      иначе соседи, помнящие прежние номера, пропустили бы новые записи.
//
// Что на диске и чем открывать базу, передаётся снаружи — модуль проверяется обычными
// тестами.
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { copyStamp, copyTime, intactFile } from './backup.mjs'

export const RESTORE_FILE = 'restore-pending.json'
export const STAGE_DIR = 'restore-source'
// Описание копии, сохранённой кнопкой «Сохранить копию в…»: когда и с какого компьютера
export const MANIFEST = 'copy.json'

const SHOP = /^pharmacy-[A-Za-z0-9_-]+[.]db$/
const DB_FILE = /^(core|pharmacy-[A-Za-z0-9_-]+)[.]db$/
// Номер и ключ кассы — в том виде, в каком их создаёт программа (local/accounts.mjs)
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEVICE_KEY = /^[A-Za-z0-9_-]{20,200}$/
// Имя папки второй папки копий у компьютера: «KASSA-1-1a2b3c4d» (backup.mjs, hostFolderOf)
const HOST_FOLDER = /-[0-9a-f]{8}$/

// Что не так с копией — окно показывает это человеку своими словами
export const PROBLEMS = {
  incomplete: 'Неполная копия: в ней нет общей базы программы',
  noshop: 'В копии нет базы этого магазина',
  broken: 'Копия повреждена',
  newer: 'Копия от более новой версии программы — сначала обновите программу',
}

function withDb(Database, file, fn, fallback) {
  let db = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    return fn(db)
  } catch {
    return fallback
  } finally {
    try {
      db?.close()
    } catch {
      /* не открылась — закрывать нечего */
    }
  }
}
const metaOf = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
const upsert = (db) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

// ── Где лежат копии ──
// Папка, которую выбрал человек, может быть самой копией, папкой копий одной кассы или
// второй папкой целиком (в ней по папке на компьютер). Смотрим на два уровня вглубь.
// Недоснятые копии (папки с точкой в начале имени) пропускаем
export function findCopies(root, { fs, depth = 2, limit = 60 }) {
  const found = []
  const walk = (folder, level) => {
    if (found.length >= limit) return
    let entries = []
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    const files = entries.filter((e) => e.isFile() && DB_FILE.test(e.name)).map((e) => e.name).sort()
    if (files.length) found.push({ folder, files })
    if (level >= depth) return
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(join(folder, e.name), level + 1)
  }
  walk(root, 0)
  return found
}

// Когда снята копия: из описания сохранённой копии, из имени папки или по времени файла
function copyAt(folder, file, fs) {
  try {
    const m = JSON.parse(fs.readFileSync(join(folder, MANIFEST), 'utf8'))
    if (Number.isFinite(m?.at)) return m.at
  } catch {
    /* копия не из «Сохранить копию в…» */
  }
  const t = copyTime(basename(folder))
  if (Number.isFinite(t)) return t
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

// С какого компьютера копия — для подписи в окне. Сохранённая копия знает это сама; у
// копии из второй папки им называется папка компьютера
function computerOf(folder, fs) {
  try {
    const m = JSON.parse(fs.readFileSync(join(folder, MANIFEST), 'utf8'))
    if (typeof m?.computer === 'string' && m.computer) return m.computer.slice(0, 60)
  } catch {
    /* описания нет */
  }
  const parent = basename(dirname(folder))
  return HOST_FOLDER.test(parent) ? parent.replace(HOST_FOLDER, '') : ''
}

// ── Что в копии ──
// Читаем сами и только на чтение: годится ли копия этому магазину, с этого ли она
// компьютера, сколько в ней не ушло на сервер, когда снята.
// shopFile — файл базы магазина, в который вошли; deviceId — номер этой кассы;
// schemaMax — сколько шагов устройства базы знает эта версия программы.
// thorough — полная проверка целостности файла. Она идёт по всему файлу, и на большой
// базе магазина — заметное время, поэтому список копий обходится без неё, а копию,
// которую загружают, проверяют полностью
export function describeCopy({ folder, files, shopFile, deviceId, schemaMax, fs, Database, thorough = true }) {
  const shop = join(folder, shopFile)
  const out = { folder, at: copyAt(folder, files.includes(shopFile) ? shop : join(folder, files[0] || ''), fs), computer: computerOf(folder, fs), pending: 0, foreign: false, problem: '' }
  if (!files.includes('core.db')) return { ...out, problem: 'incomplete' }
  const device = withDb(Database, join(folder, 'core.db'), (db) => metaOf(db, 'deviceId'), null)
  if (!device || !DEVICE_ID.test(device)) return { ...out, problem: 'broken' }
  out.foreign = device !== deviceId
  if (!SHOP.test(shopFile) || !files.includes(shopFile)) return { ...out, problem: 'noshop' }
  if (thorough && !intactFile(shop, Database)) return { ...out, problem: 'broken' }
  const info = withDb(
    Database,
    shop,
    (db) => ({
      schema: Number(metaOf(db, 'schema') || 0),
      pending: (() => {
        try {
          return db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n
        } catch {
          return 0
        }
      })(),
    }),
    null,
  )
  if (!info) return { ...out, problem: 'broken' }
  if (info.schema > schemaMax) return { ...out, problem: 'newer' }
  return { ...out, pending: info.pending }
}

// Номер и ключ кассы из общей базы копии. Не похожи на настоящие — null
export function deviceOfCopy(file, Database) {
  return withDb(
    Database,
    file,
    (db) => {
      const id = metaOf(db, 'deviceId')
      const key = metaOf(db, 'deviceKey')
      return DEVICE_ID.test(id || '') && DEVICE_KEY.test(key || '') ? { id, key } : null
    },
    null,
  )
}

// ── Попросить загрузить копию ──
// Нужные файлы копии — к себе (см. правило 2), затем просьба. Её выполнит следующий
// запуск. foreign — копия другого компьютера: нужен ещё её номер кассы
export function requestRestore({ userData, fs, Database, folder, shopFile, foreign, at, now }) {
  if (typeof folder !== 'string' || !isAbsolute(folder) || !SHOP.test(shopFile)) throw new Error('копия указана неверно')
  const stage = join(userData, STAGE_DIR)
  // Папка, куда копия откладывается перед загрузкой, сама источником быть не может:
  // её очистка стёрла бы копию раньше, чем та скопирована
  const from = resolve(folder)
  if (from === resolve(stage) || from.startsWith(resolve(stage) + sep)) throw new Error('копию из этой папки загрузить нельзя')
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  try {
    for (const name of foreign ? [shopFile, 'core.db'] : [shopFile]) {
      fs.copyFileSync(join(folder, name), join(stage, name))
      if (!intactFile(join(stage, name), Database)) throw new Error(`файл ${name} копии не читается`)
    }
    if (foreign && !deviceOfCopy(join(stage, 'core.db'), Database)) throw new Error('в копии нет номера кассы')
    const ask = { folder: stage, from: folder, shopFile, foreign: !!foreign, at: Number.isFinite(at) ? at : null, requestedAt: now() }
    fs.writeFileSync(join(userData, RESTORE_FILE), JSON.stringify(ask), 'utf8')
    return ask
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw e
  }
}

// Докуда дошёл журнал обмена с соседними кассами в этом файле
function lanTopOf(file, Database) {
  return withDb(
    Database,
    file,
    (db) => {
      const top = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM lan_log').get().n) || 0
      const used = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'lan_log'").get()?.seq) || 0
      return Math.max(top, used)
    },
    0,
  )
}

// ── Выполнить просьбу ──
// Зовётся при запуске, пока ни одна база не открыта. Нет просьбы — null. Иначе
// { ok, at, foreign } или { ok: false, error } — в последнем случае базы остаются как были.
// Просьба выполняется один раз: что бы ни случилось дальше, следующий запуск её не повторит
export function applyRestore({ userData, dataDir, fs, Database, now, schemaMax, log = { info() {}, warn() {}, error() {} } }) {
  const mark = join(userData, RESTORE_FILE)
  if (!fs.existsSync(mark)) return null
  let ask = null
  try {
    ask = JSON.parse(fs.readFileSync(mark, 'utf8'))
  } catch {
    ask = null
  }
  try {
    fs.rmSync(mark, { force: true })
  } catch (e) {
    log.warn('просьба о загрузке копии не убралась', e?.message || e)
  }
  const stage = join(userData, STAGE_DIR)
  const done = (result) => {
    try {
      fs.rmSync(stage, { recursive: true, force: true })
    } catch {
      /* уберётся в следующий раз */
    }
    if (!result.ok) log.error('копия базы не загружена: ' + result.error)
    return result
  }
  if (!ask || ask.folder !== stage || !SHOP.test(ask.shopFile || '')) return done({ ok: false, error: 'просьба о загрузке копии испорчена' })
  const src = join(stage, ask.shopFile)
  if (!fs.existsSync(src) || !intactFile(src, Database)) return done({ ok: false, error: 'файл копии не найден или повреждён' })
  const schema = withDb(Database, src, (db) => Number(metaOf(db, 'schema') || 0), NaN)
  if (!(schema <= schemaMax)) return done({ ok: false, error: PROBLEMS.newer })
  const identity = ask.foreign ? deviceOfCopy(join(stage, 'core.db'), Database) : null
  if (ask.foreign && !identity) return done({ ok: false, error: 'в копии нет номера кассы' })

  // ── Нынешний файл — в сторону ──
  // Сначала сам файл, потом его журналы: не убрался файл — не тронуто ничего. Не убрался
  // журнал — возвращаем всё на место: рядом с загруженной копией чужому журналу не место
  // (SQLite наложил бы его записи на другую основу), а без журнала прежняя база неполна
  const target = join(dataDir, ask.shopFile)
  const aside = join(userData, 'replaced', copyStamp(now()))
  const moved = []
  const putBack = () => {
    for (const suffix of [...moved].reverse()) {
      try {
        fs.renameSync(join(aside, ask.shopFile + suffix), target + suffix)
      } catch (e) {
        log.error('прежний файл базы не вернулся на место', target + suffix, e?.message || e)
      }
    }
  }
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!fs.existsSync(target + suffix)) continue
      fs.mkdirSync(aside, { recursive: true })
      fs.renameSync(target + suffix, join(aside, ask.shopFile + suffix))
      moved.push(suffix)
    }
  } catch (e) {
    putBack()
    return done({ ok: false, error: 'файл базы занят другой программой: ' + (e?.message || e) })
  }
  const lanTop = moved.includes('') ? lanTopOf(join(aside, ask.shopFile), Database) : 0

  // ── Копию — на место ──
  try {
    fs.copyFileSync(src, target)
    const db = new Database(target)
    try {
      db.transaction(() => {
        const put = upsert(db)
        // Окно скажет, что загружена копия и от какого она момента (см. gateway, restoredNote)
        put.run('restored', JSON.stringify({ from: ask.at, at: now(), manual: true, foreign: !!identity }))
        // Весь магазин — заново с сервера: копия старая, а на сервере с тех пор всё шло
        put.run('needFull', '1')
        put.run('cursor', '')
        put.run('wcursor', '')
        const hasLan = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lan_log'").get()
        if (lanTop > 0 && hasLan) {
          const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'lan_log'").get()
          if (!row) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('lan_log', ?)").run(lanTop)
          else if (Number(row.seq) < lanTop) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'lan_log'").run(lanTop)
        }
      })()
    } finally {
      db.close()
    }
    if (!intactFile(target, Database)) throw new Error('загруженная база не проходит проверку целостности')
  } catch (e) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(target + suffix, { force: true })
      } catch {
        /* уберём что сможем */
      }
    }
    putBack()
    return done({ ok: false, error: 'копия не записалась: ' + (e?.message || e) })
  }

  // ── Копия с другого компьютера: эта касса становится той ──
  let warning = ''
  if (identity) {
    let core = null
    try {
      core = new Database(join(dataDir, 'core.db'))
      core.pragma('busy_timeout = 5000')
      core.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      core.transaction(() => {
        const put = upsert(core)
        put.run('deviceId', identity.id)
        put.run('deviceKey', identity.key)
      })()
    } catch (e) {
      warning = 'номер кассы не перенесён: ' + (e?.message || e)
      log.error('копия загружена, но ' + warning)
    } finally {
      try {
        core?.close()
      } catch {
        /* закрыта */
      }
    }
  }
  log.info(
    `загружена копия базы ${ask.shopFile}` +
      (Number.isFinite(ask.at) ? ` от ${new Date(ask.at).toISOString()}` : '') +
      (identity && !warning ? `; касса теперь ${identity.id}` : '') +
      (moved.length ? `; прежний файл — в ${aside}` : ''),
  )
  return done({ ok: true, at: ask.at, foreign: !!identity && !warning, warning })
}

// ── Сохранить копию в выбранную папку ──
// from — папка свежей копии (backup.mjs). В выбранной папке появляется своя, с понятным
// именем label; рядом с базами — описание (copy.json): по нему окно «Загрузить копию»
// узнаёт, когда и где снята копия
export function saveCopyTo({ from, dest, label, at, info = {}, fs, Database }) {
  const names = fs.readdirSync(from).filter((f) => DB_FILE.test(f))
  if (!names.length) throw new Error('копировать нечего')
  let target = join(dest, label)
  for (let n = 2; fs.existsSync(target); n++) target = join(dest, `${label} (${n})`)
  fs.mkdirSync(target, { recursive: true })
  try {
    for (const f of names) {
      fs.copyFileSync(join(from, f), join(target, f))
      if (!intactFile(join(target, f), Database)) throw new Error(`копия ${f} не читается`)
    }
    fs.writeFileSync(join(target, MANIFEST), JSON.stringify({ app: 'FinMax POS', at, ...info }, null, 2), 'utf8')
  } catch (e) {
    fs.rmSync(target, { recursive: true, force: true })
    throw e
  }
  return target
}
