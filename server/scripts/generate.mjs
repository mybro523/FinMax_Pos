// ── Генерация клиентов Prisma ──
// Схемы в проекте две, и наборы таблиц у них разные, поэтому и клиента два:
//   · prisma/schema.prisma       — данные аптеки (товары, продажи, остатки);
//   · prisma/admin/schema.prisma — панель управления (аптеки, вход, оплаты).
//
// Оба нужны уже на этапе установки: без них не соберётся TypeScript. Отдельный
// скрипт вместо строчки в package.json нужен по двум причинам.
//
// Первая: схема панели объявляет адрес через ADMIN_DATABASE_URL, и Prisma требует
// эту переменную даже для генерации, когда к базе никто не подключается. При сборке
// образа её нет и быть не может — адрес базы известен только на работающем сервере.
// Поэтому подставляем заглушку: на результат генерации адрес не влияет.
//
// Вторая: задать переменную одной строкой в npm-скрипте не выйдет — «VAR=x команда»
// работает в Linux и не работает в командной строке Windows, где проект пишут.
//
// Запуск: node scripts/generate.mjs (сам вызывается из postinstall).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { adminUrl } from './db-url.mjs'

// Запускаем CLI Prisma напрямую тем же Node, а не через npx. На Windows npx —
// это файл .cmd, а Node отказывается запускать такие без оболочки; с оболочкой же
// аргументы склеиваются в строку, и путь с пробелом (а он тут именно такой)
// разваливает вызов. Прямой путь к файлу работает одинаково везде.
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js')

// Настоящий адрес, если он есть, — иначе заглушка того же вида. Prisma разбирает
// её как адрес и на этом успокаивается; подключаться при генерации она не станет.
const PLACEHOLDER = 'postgresql://net:net@localhost:5432/net'
const real = process.env.DATABASE_URL
process.env.ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL || adminUrl(real || PLACEHOLDER)

const SCHEMAS = [
  { name: 'аптека', path: 'prisma/schema.prisma' },
  { name: 'панель управления', path: 'prisma/admin/schema.prisma' },
]

for (const s of SCHEMAS) {
  console.log(`[prisma] генерирую клиент: ${s.name}`)
  const r = spawnSync(process.execPath, [PRISMA_CLI, 'generate', '--schema', s.path], {
    stdio: 'inherit',
    timeout: 180000,
  })
  if (r.status !== 0) {
    console.error(`[prisma] не удалось сгенерировать клиент: ${s.name}`)
    process.exit(1)
  }
}
