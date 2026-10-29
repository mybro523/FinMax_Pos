// ── Копия базы на диск D (версия 1.5.8) ──
//
// Раз в сутки программа и так снимает копию баз в свою папку (backup.mjs). Но эта папка —
// на диске C, внутри профиля Windows: переустановили Windows или отказал диск — пропали и
// базы, и их копии. Поэтому раз в 2 дня программа сама, без интернета, кладёт копию ещё и
// на диск D — в папку «FinMax POS — копии». Диска D нет или на него не записать (под D —
// дисковод, флешка защищена от записи) — на диск C, в такую же папку в корне; не вышло и
// там — в «Документы» пользователя.
//
// Копия — такая же, как «Сохранить копию в…»: папка с файлами баз и copy.json. Поэтому
// её возвращает обычная «Загрузить копию». Имя папки — магазин, дата и время по часам
// компьютера: «Супермаркет София 2026-10-29 19-15». Хранятся 15 последних копий, снятых
// так (в copy.json пометка auto); папки, положенные туда руками («Сохранить копию в…»),
// программа не трогает.
//
// Что на диске, передаётся снаружи (fs) — модуль проверяется обычными тестами.
import { join } from 'node:path'
import { MANIFEST, saveCopyTo } from './restore.mjs'

export const DISK_FOLDER = 'FinMax POS — копии'
export const DISK_EVERY_MS = 2 * 86400000
export const DISK_KEEP = 15
// По порядку: диск D, диск C. Третий вариант («Документы») добавляет main.mjs
export const DISK_ROOTS = ['D:\\', 'C:\\']

// ── Удалить файл или папку целиком ──
// fs.rmSync в Node 24.8 на Windows молча ничего не удаляет, если в пути есть русские буквы
// или длинное тире («FinMax POS — копии»): ошибки нет, а файлы на месте. В программе (Electron
// 44 и 22) этой беды нет, но копии на диске не должны копиться ни при каком движке: если
// после rmSync путь остался, удаляем пофайлово — unlinkSync и rmdirSync так не ошибаются
export function removeTree(fs, path) {
  try {
    fs.rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* ниже — пофайлово */
  }
  if (!fs.existsSync(path)) return
  const walk = (p) => {
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(join(p, name))
      fs.rmdirSync(p)
    } else fs.unlinkSync(p)
  }
  walk(path)
}

// Имя папки копии. Знаки, которых Windows не допускает в именах файлов, — пробелом; точки и
// пробелы в конце имени Windows отрезает сама — убираем их заранее. Пусто — «FinMax POS»
export function diskLabel(shop, stamp) {
  const clean = String(shop ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
  return `${Array.from(clean).slice(0, 60).join('').trim() || 'FinMax POS'} ${stamp}`
}

// ── Куда класть ──
// Первый диск из списка, на котором папку копий удаётся завести и записать в неё пробный
// файл. Возвращает { dir, tried }: dir — папка копий (null — не вышло нигде), tried — что
// не подошло и почему (для объяснения человеку)
export function chooseDiskFolder({ fs, roots = DISK_ROOTS, folder = DISK_FOLDER, probe = '.probe' }) {
  const tried = []
  for (const root of roots) {
    if (!root) continue
    try {
      if (!fs.existsSync(root)) {
        tried.push(`${root} — нет такого диска`)
        continue
      }
      const dir = join(root, folder)
      fs.mkdirSync(dir, { recursive: true })
      const file = join(dir, probe)
      fs.writeFileSync(file, 'ok')
      removeTree(fs, file)
      return { dir, tried }
    } catch (e) {
      tried.push(`${root} — ${e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EROFS' ? 'нельзя записать' : e?.code || e?.message || e}`)
    }
  }
  return { dir: null, tried }
}

// ── Пора ли ──
// Прошло 2 суток с прошлой копии на диск — по часам программы или по часам срока работы
// без связи (они идут почти как настоящие и на компьютере со сбитыми часами; см. backup:
// так же решается, пора ли ежедневная копия). Копии ещё не было — пора
export function diskDue({ lastAt, lastLic, now, lic, every = DISK_EVERY_MS }) {
  const at = Number(lastAt) || 0
  const l = Number(lastLic) || 0
  if (!at && !l) return true
  if (l && Number.isFinite(lic) && lic - l >= every) return true
  return !at || Math.abs(now - at) >= every
}

// Копии на диске, снятые программой сама (пометка auto в copy.json), новые сверху
export function listDiskCopies({ dir, fs }) {
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const folder = join(dir, name)
    try {
      const m = JSON.parse(fs.readFileSync(join(folder, MANIFEST), 'utf8'))
      if (m?.auto === true && Number.isFinite(m.at)) out.push({ folder, name, at: m.at })
    } catch {
      /* не наша копия или не копия вовсе */
    }
  }
  return out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
}

// Лишние — самые старые из своих копий
export function pruneDisk({ dir, fs, keep = DISK_KEEP, log = { warn() {} } }) {
  const extra = listDiskCopies({ dir, fs }).slice(keep)
  for (const c of extra) {
    try {
      removeTree(fs, c.folder)
    } catch (e) {
      log.warn('старая копия на диске не удалилась', c.folder, e?.message || e)
    }
  }
  return extra.length
}

// ── Положить копию ──
// from — папка свежей копии баз (backup.mjs снял её только что); label — имя папки на диске.
// Возвращает путь к папке копии
export function writeDiskCopy({ from, dir, label, at, info = {}, fs, Database, keep = DISK_KEEP, log }) {
  const path = saveCopyTo({ from, dest: dir, label, at, info: { ...info, auto: true }, fs, Database })
  pruneDisk({ dir, fs, keep, log })
  return path
}
