// ── Страховка от забытых настроек транзакций ──
// Стандартных пяти секунд Prisma денежным операциям не хватает: при малейшей
// задержке сети транзакция обрывается на полпути, а кассир видит невнятный отказ
// базы (код P2028). Поэтому в проекте заведены TX и TX_LONG, и каждая транзакция
// обязана брать одну из них.
//
// Забыть это легко — четыре места уже забыли, включая закрытие смены. Поэтому
// проверяем не поведение, а сам код: читаем исходники и смотрим, чем закрыт
// каждый вызов $transaction.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')

function tsFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

// Находим `$transaction(` и его закрывающую скобку, считая вложенность.
// Строки и комментарии для наших исходников можно не разбирать: скобок в них нет.
function transactions(code) {
  const out = []
  const needle = '$transaction('
  let at = 0
  while ((at = code.indexOf(needle, at)) !== -1) {
    const open = at + needle.length - 1
    let depth = 0
    let end = -1
    for (let i = open; i < code.length; i++) {
      const c = code[i]
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break
    out.push({
      line: code.slice(0, at).split('\n').length,
      body: code.slice(open + 1, end),
    })
    at = end
  }
  return out
}

test('у каждой транзакции задан свой лимит времени', () => {
  const bad = []
  for (const file of tsFiles(SRC)) {
    const code = fs.readFileSync(file, 'utf8')
    for (const t of transactions(code)) {
      // Последний аргумент должен быть TX, TX_LONG или TX_SNAPSHOT (тот же лимит
      // времени, что у TX, плюс чтение одним снимком)
      if (!/,\s*TX(_LONG|_SNAPSHOT)?\s*$/.test(t.body.trimEnd())) {
        bad.push(`${path.relative(SRC, file)}:${t.line}`)
      }
    }
  }
  assert.deepEqual(
    bad,
    [],
    'без TX/TX_LONG останутся транзакции со стандартными 5 секундами:\n' + bad.map((b) => '  · ' + b).join('\n'),
  )
})

test('проверка вообще находит транзакции — иначе она бесполезна', () => {
  let found = 0
  for (const file of tsFiles(SRC)) found += transactions(fs.readFileSync(file, 'utf8')).length
  assert.ok(found >= 10, `транзакций найдено всего ${found} — разбор кода сломан`)
})

test('разбор скобок не путается на вложенных вызовах', () => {
  const code = 'await p.$transaction(async (tx) => { await f(g(1), h(2)) }, TX)'
  const [t] = transactions(code)
  assert.match(t.body.trimEnd(), /,\s*TX$/)
})

test('транзакция без настроек распознаётся как проблема', () => {
  const code = 'await p.$transaction(async (tx) => { await f(1) })'
  const [t] = transactions(code)
  assert.ok(!/,\s*TX(_LONG)?\s*$/.test(t.body.trimEnd()), 'такой вызов должен считаться забытым')
})
