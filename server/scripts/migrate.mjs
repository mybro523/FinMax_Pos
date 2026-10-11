// ── Приведение схемы базы к текущей версии программы ──
//
// Раньше при каждом старте выполнялся `prisma db push --accept-data-loss`. Он
// удобен, пока проект пишут: сравнивает базу со схемой и молча доводит её до
// нужного вида. Но у него нет истории. Откатить неудачную правку нечем, а флаг
// «согласен на потерю данных» означает ровно то, что написано: переименуй кто-то
// поле в схеме — и колонка с продажами за год уедет без вопросов.
//
// Теперь схема меняется миграциями: каждая правка — отдельный файл с SQL, база
// помнит, что уже применено, и применяется только новое.
//
// База аптеки создавалась прежним способом, поэтому таблицы в ней уже есть, а
// записи о миграциях — нет. Prisma в такой ситуации отказывается работать
// (P3005: «схема не пуста»). Правильный ответ — отметить первую миграцию как уже
// применённую: таблицы, которые она создаёт, и так на месте. Это делается здесь
// автоматически, чтобы не требовать ручных действий на сервере.
//
// Запуск: node scripts/migrate.mjs
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { adminUrl, ADMIN_SCHEMA } from './db-url.mjs'

// Запускаем CLI Prisma напрямую тем же Node, а не через npx: на Windows npx — это
// файл .cmd, запускать которые без оболочки Node отказывается, а с оболочкой путь
// с пробелом разваливает вызов
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js')

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations')
const ADMIN_SCHEMA_PATH = join('prisma', 'admin', 'schema.prisma')
const ADMIN_MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'admin', 'migrations')

function prisma(args, env = {}) {
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...env },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  return { ok: r.status === 0, out }
}

function say(msg) {
  console.log('[схема] ' + msg)
}

// Список миграций по порядку имён — так их нумерует и сама Prisma
function migrationNames() {
  if (!existsSync(MIGRATIONS_DIR)) return []
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function deploy() {
  const r = prisma(['migrate', 'deploy'])
  process.stdout.write(r.out)
  return r
}

// ── Схема панели управления ──
// Панель живёт в отдельной схеме той же базы: список аптек, учётные записи, оплаты.
// Prisma заводит в схеме таблицы, но саму схему не создаёт — а подключение указывает
// сразу внутрь неё. Поэтому создаём её сами, до миграций. Имя фиксированное,
// подставлять в запрос нечего.
async function ensureAdminSchema() {
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${ADMIN_SCHEMA}"`)
  } finally {
    await db.$disconnect()
  }
}

function deployAdmin() {
  const r = prisma(['migrate', 'deploy', '--schema', ADMIN_SCHEMA_PATH], {
    ADMIN_DATABASE_URL: adminUrl(process.env.DATABASE_URL),
  })
  process.stdout.write(r.out)
  return r
}

async function main() {
  if (process.env.DB_MIGRATE_ON_BOOT === 'false') {
    say('пропущено (DB_MIGRATE_ON_BOOT=false)')
    return
  }
  if (!process.env.DATABASE_URL) {
    console.error('[схема] DATABASE_URL не задан — применять миграции некуда')
    process.exit(1)
  }

  say('применяю миграции…')
  let r = deploy()

  // База уже существует, но о миграциях не знает — та самая ситуация после db push
  if (!r.ok && /P3005/.test(r.out)) {
    const names = migrationNames()
    if (!names.length) {
      console.error('[схема] база не пуста, а миграций нет — нечего отмечать применённым')
      process.exit(1)
    }
    say(`база создана прежним способом — отмечаю как применённое: ${names[0]}`)
    const mark = prisma(['migrate', 'resolve', '--applied', names[0]])
    process.stdout.write(mark.out)
    if (!mark.ok) {
      console.error('[схема] не удалось отметить первую миграцию применённой')
      process.exit(1)
    }
    r = deploy()
  }

  if (!r.ok) {
    console.error('')
    console.error('='.repeat(70))
    console.error('Схему базы привести к нужному виду не удалось.')
    console.error('Сервер не запущен намеренно: работать с несогласованной схемой')
    console.error('опаснее, чем не работать вовсе — ошибки полезли бы посреди продажи.')
    console.error('Разбор — в выводе выше.')
    console.error('='.repeat(70))
    console.error('')
    process.exit(1)
  }

  say('схема в актуальном состоянии')

  // Панель управления — после аптеки: она новая, и пока в ней нечему ломаться,
  // а вот аптека должна подняться в любом случае
  if (!existsSync(ADMIN_MIGRATIONS_DIR)) {
    say('панель управления: миграций нет, пропускаю')
    return
  }
  say('панель управления: применяю миграции…')
  await ensureAdminSchema()
  const a = deployAdmin()
  if (!a.ok) {
    console.error('')
    console.error('='.repeat(70))
    console.error('Схему панели управления привести к нужному виду не удалось.')
    console.error('Данные аптек при этом целы: они лежат в своих схемах.')
    console.error('Разбор — в выводе выше.')
    console.error('='.repeat(70))
    console.error('')
    process.exit(1)
  }
  say(`панель управления: схема «${ADMIN_SCHEMA}» в актуальном состоянии`)
}

main().catch((e) => {
  console.error('[схема] ' + (e?.message || e))
  process.exit(1)
})
