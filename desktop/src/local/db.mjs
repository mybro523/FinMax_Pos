// ── Открыть локальную базу ──
//
// SQLite — это один файл на диске компьютера. Он открывается только в основной
// части программы: окно к нему доступа не имеет и получает данные через мост.
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

// Отказ, который увидит человек: с кодом, как у сервера (400 — не то прислали,
// 403 — нельзя, 404 — не найдено). Интерфейс показывает текст как есть.
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
export const bad = (message) => new ApiError(400, message)
export const forbidden = (message) => new ApiError(403, message)
export const notFound = (message) => new ApiError(404, message)

// Номер новой записи. Создаётся на кассе и остаётся тем же на сервере — по нему
// сервер узнаёт повторную отправку и не записывает операцию второй раз.
export const newId = () => randomUUID()

export function openDb(file, migrations) {
  const db = new Database(file)
  try {
    // WAL: чтение не ждёт записи, а внезапное выключение компьютера не портит файл
    db.pragma('journal_mode = WAL')
    // FULL: записанный чек обязан пережить отключение питания. На кассе записи
    // короткие и редкие — цена этой надёжности незаметна
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    migrate(db, migrations)
  } catch (e) {
    // Не открылась — не держим файл занятым: его захотят заменить или скопировать.
    // Испорченный файл «открывается» без ошибки и падает на первом же обращении,
    // поэтому и настройки выше стоят под этой же защитой
    db.close()
    throw e
  }
  return db
}

function migrate(db, migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const done = Number(getMeta(db, 'schema') || 0)
  // Базу открыла версия программы старее той, что её создала (поставили прежний
  // установщик поверх нового). Работать с незнакомым устройством базы нельзя:
  // запись по старым правилам испортила бы данные молча.
  if (done > migrations.length) {
    throw new Error('Локальная база создана более новой версией программы. Установите свежую версию.')
  }
  if (done === migrations.length) return
  db.transaction(() => {
    for (let i = done; i < migrations.length; i++) db.exec(migrations[i])
    setMeta(db, 'schema', String(migrations.length))
  })()
}

// ── Готовые запросы ──
// Разбор текста запроса стоит дороже самого запроса, а касса повторяет одни и те же
// по много раз в минуту. Разобранный запрос запоминается за своей базой и уходит
// вместе с ней, когда базу закрывают.
const prepared = new WeakMap()

export function q(db, sql) {
  let bySql = prepared.get(db)
  if (!bySql) prepared.set(db, (bySql = new Map()))
  let st = bySql.get(sql)
  if (!st) bySql.set(sql, (st = db.prepare(sql)))
  return st
}

export function getMeta(db, key) {
  return q(db, 'SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
}

export function setMeta(db, key, value) {
  q(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
}

// Несколько записей как одна: либо все, либо ни одной. Продажа — это чек, движения
// остатка, долг клиента и строка в очереди отправки; половина продажи хуже, чем ничего.
export const inTx = (db, fn) => db.transaction(fn)()
