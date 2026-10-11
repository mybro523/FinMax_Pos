// ── Страховка: восстановление копии не должно упираться в размер запроса ──
// Express принимает тело не больше 100 КБ по умолчанию. Резервная копия аптеки —
// это вся база одним запросом, и уже на второй год работы она весит мегабайты.
// Пока лимит не поднят, копия снимается исправно, а поднять её нельзя — причём
// выясняется это ровно в тот день, ради которого копию и делали.
//
// Вернуть эту поломку легко: достаточно убрать один аргумент при создании
// приложения, и Nest снова поставит свой разбор тела со стандартными 100 КБ.
// Снаружи ничего не изменится — продажи и приходы гораздо меньше и пройдут.
// Поэтому проверяем не поведение, а сам код запуска.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MAIN = path.join(__dirname, '..', 'src', 'main.ts')
const code = fs.readFileSync(MAIN, 'utf8')

// «100mb» → байты. Всё, что не распознали, — ноль: тест обязан упасть, а не
// молча признать непонятное значение достаточным
function toBytes(size) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(String(size).trim())
  if (!m) return 0
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase()]
  return Number(m[1]) * unit
}

test('стандартный разбор тела отключён — иначе свой лимит ничего не решает', () => {
  assert.match(
    code,
    /NestFactory\.create[\s\S]{0,120}?bodyParser:\s*false/,
    'приложение создаётся без { bodyParser: false }: Nest поставит свой разбор со 100 КБ, и наш лимит уже не применится',
  )
})

test('свой разбор тела включён для json и форм', () => {
  assert.match(code, /useBodyParser\(\s*'json'/, "нет вызова useBodyParser('json') — тело запроса разбирать нечем")
  assert.match(code, /useBodyParser\(\s*'urlencoded'/, "нет вызова useBodyParser('urlencoded')")
})

test('лимит берётся из одной величины, а не задан числом в двух местах', () => {
  const calls = [...code.matchAll(/useBodyParser\([^)]*limit:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  assert.equal(calls.length, 2, `ожидались два вызова useBodyParser с limit, найдено ${calls.length}`)
  assert.equal(calls[0], calls[1], 'json и urlencoded используют разные величины лимита — они разъедутся при первой же правке')
})

test('лимита хватает на резервную копию работающей аптеки', () => {
  const m = /BODY_LIMIT\s*=\s*process\.env\.BODY_LIMIT\s*\|\|\s*'([^']+)'/.exec(code)
  assert.ok(m, 'не найдено значение BODY_LIMIT по умолчанию')

  const bytes = toBytes(m[1])
  // Восемь мегабайт — это порядка десяти тысяч чеков с позициями. Меньше
  // ставить нельзя: аптека наберёт столько за первый же год работы.
  assert.ok(
    bytes >= 8 * 1024 ** 2,
    `лимит по умолчанию ${m[1]} мал для резервной копии — нужно хотя бы 8mb`,
  )
})
