// ── Резервная копия локальных баз ──
//
// В локальной базе лежит то, чего больше нет нигде: чеки, пробитые без интернета
// и ещё не ушедшие на сервер. Кассовый компьютер — не самое надёжное место: свет
// выключают, диск стареет. Поэтому раз в сутки программа снимает копию своих баз
// (общей и базы магазина) в папку backups и хранит несколько последних.
//
// Три правила.
//   1. Копия снимается средствами самой SQLite, а не копированием файла. Файл
//      работающей базы скопировать нельзя: часть записей в этот момент лежит в
//      журнале рядом, и копия вышла бы битой.
//   2. Снятая копия сразу проверяется — открывается и проходит проверку целостности.
//      Копия, которую нельзя открыть, хуже, чем её отсутствие: о беде узнали бы
//      в тот день, когда она понадобилась.
//   3. Копию можно класть ещё и во вторую папку — на другой диск или флешку.
//      Копия на том же диске спасает от испорченного файла, но не от сгоревшего диска.
//
// Что на диске и чем открывать базу, передаётся снаружи — модуль проверяется
// обычными тестами.
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const DAY_MS = 86400000
// Сколько копий хранить. Неделя: о поломке узнают не сразу, а копия после поломки
// бесполезна — нужна та, что была до
export const KEEP = 7

// Имя папки копии — момент её снятия и порядковый номер: 2026-10-04_15-30-05-12.
//
// Какая копия свежее, решает номер, а не время. Время в имени — время программы, а оно
// бывает неверным: сбитые часы компьютера, севшая батарейка, опечатка в дате. Пока
// копии сравнивались по времени, одна копия «из будущего» либо останавливала
// ежедневные копии, либо оттесняла настоящие; а на компьютере, где при каждом
// включении 2015 год, порядок и вовсе путался. Номер просто растёт с каждой копией.
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')
const STAMP = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d+))?$/
const parse = (name) => {
  const m = STAMP.exec(name)
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN
}
// Папка без номера (положили руками) — старше всех пронумерованных
const serial = (name) => Number(STAMP.exec(name)?.[5] || 0)
// Те же метка и её разбор — для загрузки копии вручную (restore.mjs)
export const copyStamp = stamp
export const copyTime = parse

// Целая ли база в этом файле. Быстрая проверка: страницы и их связи. База без единой
// таблицы — не копия, а пустое место: так выглядит «копия», снятая с пустого файла
export function intactFile(file, Database) {
  let db = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const rows = db.pragma('quick_check(1)')
    if (!(rows.length === 1 && Object.values(rows[0])[0] === 'ok')) return false
    return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      /* не открылась — закрывать нечего */
    }
  }
}

// ── Как назвать подпапку этого компьютера во второй папке копий ──
// Имя компьютера, каким его можно положить в путь (латиница, цифры, дефис,
// подчёркивание), и отпечаток полного имени. Отпечаток — всегда: компьютеры в магазинах
// называют и по-русски, и от «КАССА» с «Магазин» без него не осталось бы ничего, а от
// «Касса-1» с «Магазин-1» — одно и то же «1». Две кассы снова делили бы одну папку.
export function hostFolderOf(hostname) {
  const raw = String(hostname || '')
  const plain = raw
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
  const mark = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return `${plain || 'kassa'}-${mark}`
}

// host — имя этого компьютера. Во второй папке (флешка, сетевой диск) копии кладутся
// в подпапку с этим именем: одной папкой могут пользоваться две кассы, а файлы у них
// называются одинаково. Без подпапки касса с испорченной базой подняла бы копию
// соседней — вместе с её номером кассы и её неотправленными чеками.
export function createBackups({ dir, fs, Database, now = () => Date.now(), log = { info() {}, warn() {}, error() {} }, keep = KEEP, host = '' }) {
  const second = (extra) => (extra && host ? join(extra, host) : extra)

  const intact = (file) => intactFile(file, Database)

  // Копии в папке, новые сверху
  function listIn(root) {
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      return []
    }
    const all = names
      .filter((n) => STAMP.test(n))
      .map((name) => {
        const folder = join(root, name)
        let files = []
        try {
          files = fs.readdirSync(folder).filter((f) => f.endsWith('.db'))
        } catch {
          /* папку убрали, пока мы смотрели */
        }
        return { name, at: parse(name), n: serial(name), folder, files }
      })
      .filter((c) => c.files.length > 0)
    return ranked(all)
  }

  // От свежих к давним — по порядковому номеру; у папок без номера — по времени в имени
  const ranked = (copies) => [...copies].sort((a, b) => b.n - a.n || b.at - a.at)

  // Лишние копии — самые старые. Но папку, в которой лежит самая свежая копия какой-то
  // базы, не трогаем, сколько бы ей ни было: если файл базы испортился и в новые копии
  // больше не попадает, поднимать её будет не из чего, кроме этой папки
  function prune(root) {
    const seen = new Set()
    listIn(root).forEach((copy, n) => {
      const holdsNewest = copy.files.some((f) => !seen.has(f))
      copy.files.forEach((f) => seen.add(f))
      if (n < keep || holdsNewest) return
      try {
        fs.rmSync(copy.folder, { recursive: true, force: true })
      } catch (e) {
        log.warn('старая копия не удалилась', copy.folder, e?.message || e)
      }
    })
  }

  // Снять копию одной базы в файл. source: { name, db } — открытая база,
  // или { name, file } — файл базы, которая сейчас не открыта
  async function copyOne(source, target) {
    // Пустой файл SQLite открывает как новую базу — и «копия» с него вышла бы исправной
    // и пустой. Потом именно её, самую свежую, программа и подняла бы вместо настоящей
    if (!source.db && fs.statSync(source.file).size === 0) throw new Error('файл базы пуст')
    let own = null
    try {
      const db = source.db || (own = new Database(source.file, { readonly: true, fileMustExist: true }))
      await db.backup(target)
    } finally {
      try {
        own?.close()
      } catch {
        /* закрыта */
      }
    }
    // Копия — один файл. Рабочая база держит часть записей в журнале рядом с собой,
    // и копия унаследовала бы этот режим: при первом же открытии возле неё появились
    // бы ещё два файла, без которых она неполна. А копию носят на флешке одним файлом
    const copy = new Database(target)
    try {
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    if (!intact(target)) throw new Error('снятая копия не проходит проверку целостности')
  }

  return {
    dir,
    list: () => listIn(dir),
    last: () => listIn(dir)[0] || null,
    // Копии и в основной папке, и во второй (в подпапке этого компьютера), новые сверху.
    // where — откуда: main | extra
    listAll: ({ extra = '' } = {}) =>
      ranked([...listIn(dir).map((c) => ({ ...c, where: 'main' })), ...(extra ? listIn(second(extra)).map((c) => ({ ...c, where: 'extra' })) : [])]),
    // Пора ли снимать: последней копии больше суток (или её нет вовсе). «Больше суток» —
    // в любую сторону: если время последней копии от нынешнего далеко и вперёд, значит,
    // время программы с тех пор поправили, и сколько прошло на самом деле, неизвестно
    due: () => {
      const last = listIn(dir)[0]
      return !last || Math.abs(now() - last.at) >= DAY_MS
    },

    // ── Снять копию ──
    // extra — вторая папка (другой диск, флешка); её недоступность основной копии
    // не мешает. Возвращает, что получилось: { at, folder, files, skipped, extra }
    async run(sources, { extra = '' } = {}) {
      const at = now()
      // Номер — следующий за самым большим из имеющихся: и здесь, и во второй папке
      // (основную могли потерять вместе с диском, а счёт должен продолжаться)
      const top = Math.max(0, ...listIn(dir).map((c) => c.n), ...(extra ? listIn(second(extra)).map((c) => c.n) : []))
      const name = `${stamp(at)}-${top + 1}`
      const folder = join(dir, name)
      // Сначала во временную папку: недоснятая копия не должна выглядеть готовой
      const tmp = join(dir, `.${name}.tmp`)
      fs.mkdirSync(tmp, { recursive: true })
      const files = []
      // Базы, с которых копию снять не вышло (файл испорчен или занят). Одна такая
      // не должна оставить без копии остальные: на компьютере могут лежать базы
      // нескольких магазинов, и беда с давно не открывавшейся не повод не беречь рабочую
      const skipped = []
      try {
        for (const s of sources) {
          const target = join(tmp, s.name)
          try {
            await copyOne(s, target)
            files.push({ name: s.name, bytes: fs.statSync(target).size })
          } catch (e) {
            log.error(`копия базы ${s.name} не снята`, e?.message || e)
            skipped.push({ name: s.name, error: String(e?.message || e) })
            for (const suffix of ['', '-journal', '-wal', '-shm']) {
              try {
                fs.rmSync(target + suffix, { force: true })
              } catch {
                /* недоснятый файл уйдёт вместе с временной папкой или останется лишним */
              }
            }
          }
        }
        if (!files.length) throw new Error(skipped[0]?.error || 'копировать нечего')
        fs.renameSync(tmp, folder)
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true })
        throw e
      }
      prune(dir)
      log.info(`копия баз снята: ${folder} (${files.map((f) => f.name).join(', ')})`)

      const result = { at, folder, files, skipped, extra: null }
      if (extra) {
        try {
          const there = join(second(extra), name)
          fs.mkdirSync(there, { recursive: true })
          for (const f of files) {
            fs.copyFileSync(join(folder, f.name), join(there, f.name))
            if (!intact(join(there, f.name))) throw new Error(`копия ${f.name} во второй папке не читается`)
          }
          prune(second(extra))
          result.extra = { ok: true, folder: there }
        } catch (e) {
          // Флешку вынули, диск отключён — основная копия при этом снята
          log.warn('копия во вторую папку не записалась', extra, e?.message || e)
          result.extra = { ok: false, error: String(e?.message || e) }
        }
      }
      return result
    },

    // ── Самая свежая исправная копия базы с таким именем ──
    // Ищет и в основной папке, и во второй. Нет ни одной — null
    latestCopy(fileName, { extra = '' } = {}) {
      const all = ranked([...listIn(dir), ...(extra ? listIn(second(extra)) : [])])
      for (const c of all) {
        if (!c.files.includes(fileName)) continue
        const file = join(c.folder, fileName)
        if (intact(file)) return { file, at: c.at }
      }
      return null
    },

    // Есть ли вообще копии этой базы — исправные или нет. По этому программа отличает
    // первый запуск (копий нет и быть не могло) от потери (копии были, а взять нечего)
    knows(fileName, { extra = '' } = {}) {
      return [...listIn(dir), ...(extra ? listIn(second(extra)) : [])].some((c) => c.files.includes(fileName))
    },

    intact,
  }
}

// Сколько раз и с какой паузой пробовать убрать занятый файл
const TRIES = 5
const TRY_PAUSE_MS = 200
export const BUSY_MESSAGE =
  'Файл базы повреждён и занят другой программой. Закройте остальные программы (или перезагрузите компьютер) и запустите «FinMax POS» снова.'

// ── Открыть базу; если файл испорчен — поднять её из копии ──
//
// open(file) открывает базу и бросает ошибку, если не вышло. Испорченный файл не
// стираем, а откладываем в сторону (папка broken): в нём могут быть чеки, которых
// нет в копии, и специалист ещё сможет их достать.
//
// Возвращает { db, restored }: restored — из копии от какого момента поднята база
// (null — файл был цел; { at: null } — копии не нашлось, база начата заново).
export function openOrRestore({
  file,
  name,
  open,
  backups,
  fs,
  extra = '',
  now = () => Date.now(),
  log = { error() {}, warn() {} },
  // Подождать, не отдавая управления: база открывается не «потом», а прямо сейчас
  pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
}) {
  const damaged = (e) => /^SQLITE_(CORRUPT|NOTADB)/.test(String(e?.code || '')) || e?.damaged === true
  const tryOpen = () => {
    const db = open(file)
    let ok = false
    try {
      const rows = db.pragma('quick_check(1)')
      ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok'
    } catch (e) {
      db.close()
      throw e
    }
    if (!ok) {
      db.close()
      throw Object.assign(new Error('файл базы повреждён'), { damaged: true })
    }
    return db
  }

  // Файла базы нет или он пуст. Копий тоже нет — это первый запуск: начинаем с пустой
  // базы. Копия есть — значит, файл пропал (удалили, не пережил сбоя диска, оборвалась
  // запись). Начать с пустой базы значило бы молча потерять неотправленные чеки и сам
  // номер кассы — поднимаем копию
  const absent = () => {
    try {
      return !fs.existsSync(file) || fs.statSync(file).size === 0
    } catch {
      return true
    }
  }
  if (absent()) {
    if (backups.latestCopy(name, { extra })) log.error(`файл базы ${name} пропал или пуст — поднимаем базу из копии`)
    else {
      // Исправной копии нет. Если нет и следов прежней базы — ни журналов рядом, ни
      // копий (пусть негодных) — это первый запуск. Иначе база была и потеряна: об
      // этом человек должен узнать, а уцелевший журнал — не пропасть (пустой базе
      // SQLite его просто стёр бы)
      const traces = ['-wal', '-shm'].some((suffix) => fs.existsSync(file + suffix)) || backups.knows(name, { extra })
      if (!traces) return { db: tryOpen(), restored: null }
      log.error(`файл базы ${name} пропал или пуст, исправной копии нет`)
    }
  } else {
    try {
      return { db: tryOpen(), restored: null }
    } catch (e) {
      // Не про повреждение (база от более новой версии программы, диск недоступен) —
      // чинить копией тут нечего, и трогать файл нельзя
      if (!damaged(e)) throw e
      log.error(`база ${name} повреждена: ${e?.message || e}`)
    }
  }

  // Файл бывает ненадолго занят: антивирус как раз его читает. Пробуем несколько раз
  const insist = (action) => {
    let last = null
    for (let n = 0; n < TRIES; n++) {
      if (n) pause(TRY_PAUSE_MS)
      try {
        return action()
      } catch (e) {
        last = e
      }
    }
    throw last
  }

  // Всё, что осталось от прежней базы, — в сторону, а не в мусор: и испорченный файл,
  // и журналы. В журнале лежат записи, которые ещё не перенесены в сам файл, — чеки
  // последних минут; специалист их оттуда достанет. Оставлять журнал рядом с поднятой
  // копией нельзя: SQLite наложил бы его записи на чужую основу и испортил бы и её.
  // Сначала журналы, сам файл — последним: если что-то из них занято и убрать не
  // выйдет, файл базы останется на месте, и следующий запуск снова увидит поломку
  const aside = join(backups.dir, '..', 'broken', `${stamp(now())}`)
  let made = false
  for (const suffix of ['-wal', '-shm', '']) {
    if (!fs.existsSync(file + suffix)) continue
    // Папка заводится, только когда есть что в неё положить: файл мог пропасть бесследно
    if (!made) fs.mkdirSync(aside, { recursive: true })
    made = true
    try {
      insist(() => fs.renameSync(file + suffix, join(aside, name + suffix)))
    } catch (err) {
      log.warn('повреждённый файл не удалось отложить', file + suffix, err?.message || err)
      try {
        insist(() => fs.rmSync(file + suffix, { force: true }))
      } catch (e) {
        // Ни отложить, ни убрать: файл держит другая программа. Класть копию поверх
        // нельзя — рядом остался бы журнал испорченной базы. Говорим как есть:
        // человеку есть что сделать, а молча начать с пустой базы было бы хуже
        log.error('повреждённый файл занят и не убирается', file + suffix, e?.message || e)
        throw Object.assign(new Error(BUSY_MESSAGE), { busy: true, cause: e })
      }
    }
  }

  const copy = backups.latestCopy(name, { extra })
  if (copy) {
    fs.copyFileSync(copy.file, file)
    log.error(`база ${name} поднята из копии от ${new Date(copy.at).toISOString()}`)
    return { db: tryOpen(), restored: { at: copy.at } }
  }
  log.error(`копии базы ${name} нет — начинаем с пустой`)
  return { db: tryOpen(), restored: { at: null } }
}
