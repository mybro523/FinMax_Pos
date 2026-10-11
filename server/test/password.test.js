// ── Пароли: правила и хранение ──
// Самая опасная правка из всех: ошибка здесь означает, что войти не может никто.
// Причём не сразу — прежние пароли перестали бы подходить у всех разом, а новые
// работали бы, и понять причину было бы трудно.
//
// Поэтому проверяется в первую очередь одно: пароль, заведённый ДО смены правил
// хранения, обязан подходить после неё. Отпечаток для этого собирается здесь
// вручную, ровно тем способом, каким его собирала прежняя версия.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes, scryptSync } = require('node:crypto')

const {
  hashPassword,
  verifyPassword,
  passwordProblem,
  isOutdatedHash,
  MIN_PASSWORD,
} = require('../dist/auth/password')

// Отпечаток по прежним правилам: соль, двоеточие, scrypt с настройками по умолчанию
function oldStyleHash(pw) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`
}

test('пароль, заведённый до смены правил, продолжает подходить', async () => {
  const stored = oldStyleHash('staryy-parol')
  assert.equal(await verifyPassword('staryy-parol', stored), true, 'прежние пароли перестали работать — вход закрыт для всех')
  assert.equal(await verifyPassword('drugoy-parol', stored), false)
})

test('отпечаток промежуточного поколения тоже подходит', async () => {
  // Между двумя выкладками успели появиться отпечатки вида s2 — с большим объёмом
  // памяти, из-за которого сервер и упал. Их владельцы обязаны входить как обычно.
  const salt = randomBytes(16).toString('hex')
  const pw = 'parol-mezhdu-vykladkami'
  const v2 = `s2$65536$${salt}$${scryptSync(pw, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex')}`
  assert.equal(await verifyPassword(pw, v2), true, 'промежуточные отпечатки перестали работать')
  assert.equal(await verifyPassword('drugoy', v2), false)
})

test('проверка не даёт чужому отпечатку запросить много памяти', async () => {
  // Стоимость записана в самом отпечатке. Подставив огромное число, можно было бы
  // заставить сервер выделить гигабайты на один вход — и уронить его чужими руками.
  const salt = randomBytes(16).toString('hex')
  assert.equal(await verifyPassword('lyuboy', `s3$99999999$8$1$${salt}$aa`), false, 'пропущена непомерная стоимость')
  assert.equal(await verifyPassword('lyuboy', `s2$99999999$${salt}$aa`), false, 'пропущена непомерная стоимость')
})

test('прежний отпечаток помечен как устаревший — его надо переписать', async () => {
  assert.equal(isOutdatedHash(oldStyleHash('lyuboy-parol')), true)
  assert.equal(isOutdatedHash(await hashPassword('lyuboy-parol')), false)
})

test('новый отпечаток подходит только своему паролю', async () => {
  const stored = await hashPassword('novyy-parol')
  assert.equal(await verifyPassword('novyy-parol', stored), true)
  assert.equal(await verifyPassword('novyy-parol ', stored), false, 'пробел в конце — уже другой пароль')
  assert.equal(await verifyPassword('Novyy-parol', stored), false, 'заглавная буква — уже другой пароль')
  assert.equal(await verifyPassword('', stored), false)
})

test('в новом отпечатке записана вся стойкость — иначе её нельзя было бы менять', async () => {
  const stored = await hashPassword('proverka-vida')
  const [version, n, r, p, salt, hash] = stored.split('$')
  assert.equal(version, 's3')
  assert.equal(salt.length, 32, 'соль должна быть шестнадцатью байтами')
  assert.equal(hash.length, 128, 'отпечаток должен быть шестьюдесятью четырьмя байтами')

  // Память на одну проверку — 128 × N × r. Множитель p сюда НЕ входит: он повторяет
  // работу, а не занимает место (замерено: N=16384 p=4 — 98 мс и 16 МБ, N=65536 p=1 —
  // 109 мс и 64 МБ). Именно память я и проглядел, поднимая стойкость через N:
  // 64 МБ на каждый вход уронили сервер, и Railway перестал его поднимать.
  const bytes = 128 * Number(n) * Number(r)
  assert.ok(bytes <= 32 * 1024 * 1024, `одна проверка требует ${(bytes / 1048576).toFixed(0)} МБ — контейнер этого не переживёт`)
  assert.ok(Number(p) >= 2, 'работа не увеличена: стойкость держится только на памяти, а её поднимать нельзя')
})

test('два одинаковых пароля дают разные отпечатки', async () => {
  // Иначе по базе видно, у кого пароли совпадают, и подобрав один — вошёл ко всем
  assert.notEqual(await hashPassword('odin-i-tot-zhe'), await hashPassword('odin-i-tot-zhe'))
})

test('испорченный отпечаток не пускает и не роняет сервер', async () => {
  for (const junk of ['', 'мусор', 's2$', 's2$65536$', 'a:b', ':::', 's2$10$sol$otpechatok', null, undefined]) {
    assert.equal(await verifyPassword('lyuboy', junk), false, `пропустил мусор: ${JSON.stringify(junk)}`)
  }
})

// ── Правила ──
test('короткий пароль не принимается', async () => {
  assert.equal(MIN_PASSWORD, 6)
  for (const pw of ['', '1', 'abc', '12345', 'парол']) {
    assert.match(String(passwordProblem(pw)), /короткий/, `принял короткий пароль «${pw}»`)
  }
  assert.equal(passwordProblem('normalnyy-parol'), null)
})

test('пароль, который подберут с первой попытки, не принимается', async () => {
  // Длину они проходят, а защитой не являются: кассир наберёт именно такой
  for (const pw of ['123456', '111111', 'qwerty', 'password', 'apteka', '000000', 'QWERTY']) {
    assert.ok(passwordProblem(pw), `принял очевидный пароль «${pw}»`)
  }
})

test('пароль из одного повторяющегося символа не принимается', async () => {
  assert.ok(passwordProblem('аааааа'))
  assert.ok(passwordProblem('zzzzzzzz'))
  assert.equal(passwordProblem('zzzzzza'), null, 'а вот это уже нормальный пароль')
})

test('обычные человеческие пароли проходят', async () => {
  for (const pw of ['aptek12026', 'shifo-2026', 'МояАптека1', 'k4ssa!2026']) {
    assert.equal(passwordProblem(pw), null, `зря отверг «${pw}»`)
  }
})

test('проверка пароля стоит заметного времени — иначе перебор по базе дёшев', async () => {
  const stored = await hashPassword('zamer-vremeni')
  const at = Date.now()
  await verifyPassword('zamer-vremeni', stored)
  const ms = Date.now() - at
  // Порог намеренно низкий: на слабой машине сборки бывает медленнее и быстрее,
  // а проверяем мы не скорость, а что стойкость вообще не сброшена в ноль
  assert.ok(ms >= 20, `проверка заняла ${ms} мс — стойкость подозрительно низкая`)
})

// ── Самая опасная ошибка, какую здесь можно допустить ──
// Проверка пароля возвращает обещание, а не «да/нет». Забыть перед ней await —
// значит получить объект, который в любом условии считается истиной: программа
// пустила бы кого угодно с любым паролем. Ни сборка, ни типы этого не замечают:
// `!обещание` — совершенно законное выражение, просто всегда ложное.
//
// Поэтому читаем исходники и требуем await перед каждой проверкой пароля.
test('перед каждой проверкой пароля стоит await', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const SRC = path.join(__dirname, '..', 'src')

  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts') && e.name !== 'password.ts') files.push(full)
    }
  }
  walk(SRC)

  const bad = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/verifyPassword\(/g)) {
      const before = text.slice(Math.max(0, m.index - 40), m.index)
      if (!/await\s+[\w.]*$/.test(before)) {
        const line = text.slice(0, m.index).split(String.fromCharCode(10)).length
        bad.push(`${path.basename(f)}:${line}`)
      }
    }
  }
  assert.deepEqual(bad, [], `проверка пароля без await — вход открыт для всех: ${bad.join(', ')}`)
})

// ── Ради чего всё это ──
// Проверка пароля стоит около четырёхсот миллисекунд процессорного времени, и это
// намеренно. Но раньше она считалась в общем потоке, то есть на всё это время
// сервер замирал целиком: ни продажи, ни списка товаров, ни ответа «я жив».
// Один вход — четыре десятых секунды тишины для всех аптек сразу. А входят они
// разом, в начале смены.
//
// Здесь проверяется ровно это: пока идут проверки паролей, сервер продолжает
// откликаться. С прежним, синхронным вариантом счётчик остался бы на нуле —
// именно так я однажды и получил «ноль миллисекунд» в неверном замере.
test('проверка пароля больше не останавливает весь сервер', async () => {
  const stored = await hashPassword('parol-dlya-zamera')

  let awake = 0
  const beat = setInterval(() => awake++, 10)
  try {
    await Promise.all([1, 2, 3, 4].map(() => verifyPassword('parol-dlya-zamera', stored)))
  } finally {
    clearInterval(beat)
  }

  assert.ok(awake >= 5, `за время четырёх проверок сервер очнулся ${awake} раз — значит он стоял`)
})
