// ── Нагрузочная проверка: сколько магазинов сервер тянет одновременно ──
//
// Это проверка главного риска всей затеи. У каждого магазина своя схема и своё
// подключение к базе, а Postgres отдаёт их ограниченное число — обычно сотню на
// всех. Расчёт говорит, что запаса хватает. Расчёт может быть неверным: предел
// базы у хостинга свой, и подключения открываются не только под запросы.
//
// Отдельно проверяется вытеснение. Открытых подключений держим не больше
// TENANT_MAX_CLIENTS, и когда магазинов больше, самое давно не нужное закрывается.
// Вопрос в том, что случится, если закрыть его ровно в тот момент, когда по нему
// идёт запрос. Поэтому магазинов здесь намеренно больше, чем предел: без этого
// вытеснение просто не начнётся, и проверять будет нечего.
//
// ⚠️ Проверка нагружает работающий сервер и может ненадолго его положить. В том
// и смысл: найти предел на пустой системе, а не на тридцати работающих магазинах.
// Свои магазины она заводит сама и убирает за собой даже при обрыве.
//
// Запуск:
//   node e2e/load.mjs <адрес API> <логин> <пароль> --НАГРУЗКА [сколько магазинов]
import { API, get, post, del, login, loginAs, getToken } from './lib.mjs'

if (!process.argv.includes('--НАГРУЗКА')) {
  console.log('Проверка нагружает работающий сервер и может его ненадолго положить.')
  console.log('Запуск: node e2e/load.mjs <API> <логин> <пароль> --НАГРУЗКА [сколько магазинов]')
  process.exit(2)
}

const COUNT = Number(process.argv.find((a) => /^\d+$/.test(a))) || 30
const ROUNDS = 3
const TAG = 'load-' + Date.now().toString(36)

const bold = (s) => `\x1b[1m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`

// ── Замеры ──
const times = []
const errors = new Map()
let ok = 0

function note(err) {
  // Складываем по смыслу, а не по тексту: в сообщении бывают имена и числа,
  // а нам важно, каких именно отказов сколько
  const raw = String(err?.message || err)
  const kind = raw.includes('подключений')
    ? 'не хватило подключений к базе'
    : raw.includes('не уложилась во время')
      ? 'операция не уложилась во время'
      : raw.includes('fetch failed') || raw.includes('terminated')
        ? 'обрыв соединения с сервером'
        : raw.slice(0, 90)
  errors.set(kind, (errors.get(kind) || 0) + 1)
}

async function timed(label, fn) {
  const at = Date.now()
  try {
    const r = await fn()
    times.push(Date.now() - at)
    ok++
    return r
  } catch (e) {
    times.push(Date.now() - at)
    note(e)
    return null
  }
}

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : 0)

// ── Работа одного магазина ──
// Не «дёрнуть один адрес много раз», а обычный рабочий круг: посмотреть товары,
// завести новый, принять поставку, продать, посмотреть чеки. Именно так нагрузка
// раскладывается по схемам, а не бьёт в одну таблицу.
async function workday(ph, n) {
  for (let round = 0; round < ROUNDS; round++) {
    await timed('products', () => get('/products', ph.token))

    const barcode = '277' + String(Date.now()).slice(-7) + String(n).padStart(2, '0')
    const product = await timed('new-product', () =>
      post('/products', { name: `${TAG} товар ${round}`, barcode, category: 'Таблетки', price: 100 }, ph.token),
    )
    if (!product) continue

    await timed('arrival', () =>
      post(
        '/arrivals',
        {
          supplier: TAG,
          items: [{ productId: product.id, qty: 5, cost: 60, expiryDate: new Date(Date.now() + 200 * 86400000).toISOString() }],
        },
        ph.token,
      ),
    )
    await timed('sale', () =>
      post('/sales', { items: [{ productId: product.id, qty: 1 }], payment: 'cash', clientId: `${TAG}-${n}-${round}` }, ph.token),
    )
    await timed('sales', () => get('/sales', ph.token))
  }
}

// ── Прогон ──
const created = []
let serviceToken = ''

async function cleanup() {
  if (!created.length) return
  process.stdout.write(`\nУбираю за собой: магазинов ${created.length}… `)
  let removed = 0
  for (const ph of created) {
    try {
      await del(`/admin/pharmacies/${ph.id}?confirm=${ph.code}`, serviceToken)
      removed++
    } catch {
      /* попробуем остальные: недоубранное лучше неубранного */
    }
  }
  console.log(removed === created.length ? green(`убрано ${removed}`) : red(`убрано ${removed} из ${created.length}`))
  if (removed !== created.length) {
    console.log(red('Остатки уберите: node e2e/cleanup.mjs <API> <логин> <пароль>'))
  }
}

// Обрыв на середине не должен оставлять за собой полсотни схем
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await cleanup()
    process.exit(130)
  })
}

async function main() {
  console.log(`${bold('Нагрузочная проверка')}  ${API}\n  магазинов: ${COUNT}, кругов у каждой: ${ROUNDS}\n`)
  const me = await login()
  if (me.role !== 'superadmin') {
    console.log(red('Нужен вход владельцем сервиса: магазины заводит он'))
    process.exit(2)
  }
  serviceToken = getToken()

  // ── Заведение ──
  // Здесь же измеряется то, о чём спрашивают в первую очередь: сколько времени
  // занимает подключить нового клиента.
  console.log(bold('1. Завожу магазина'))
  const provisionAt = Date.now()
  for (let n = 0; n < COUNT; n++) {
    const code = `${TAG}-${n}`
    const password = 'load-' + Math.random().toString(36).slice(2, 10)
    try {
      const ph = await post('/admin/pharmacies', { code, name: `${TAG} ${n}`, ownerPassword: password }, serviceToken)
      created.push({ ...ph, token: await loginAs(ph.ownerLogin, password) })
      process.stdout.write('.')
    } catch (e) {
      process.stdout.write(red('x'))
      note(e)
    }
  }
  const provisionMs = Date.now() - provisionAt
  console.log(
    `\n  заведено ${created.length} из ${COUNT} за ${(provisionMs / 1000).toFixed(1)} с ` +
      `(${(provisionMs / Math.max(1, created.length) / 1000).toFixed(1)} с на магазин)\n`,
  )
  if (!created.length) {
    console.log(red('Не удалось завести ни одного магазина — проверять нечего'))
    return
  }

  // ── Одновременная работа ──
  console.log(bold('2. Все магазины работают одновременно'))
  const loadAt = Date.now()
  await Promise.all(created.map((ph, n) => workday(ph, n)))
  const loadMs = Date.now() - loadAt

  // ── Итог ──
  const total = ok + [...errors.values()].reduce((s, v) => s + v, 0)
  console.log(`\n${bold('════════════════════════════════════════════════════════════')}`)
  console.log(`Магазинов одновременно:   ${created.length}`)
  console.log(`Запросов:             ${total}, успешно ${ok}, с отказом ${total - ok}`)
  console.log(`Время работы:         ${(loadMs / 1000).toFixed(1)} с`)
  console.log(`Запросов в секунду:   ${(total / (loadMs / 1000)).toFixed(1)}`)
  console.log(`Отклик, медиана:      ${pct(times, 0.5)} мс`)
  console.log(`Отклик, 95-й:         ${pct(times, 0.95)} мс`)
  console.log(`Отклик, худший:       ${Math.max(0, ...times)} мс`)

  if (errors.size) {
    console.log(`\n${red('Отказы:')}`)
    for (const [kind, n] of [...errors].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${kind}`)
  } else {
    console.log(`\n${green('Отказов нет')}`)
  }

  // Сервер должен остаться живым — это и есть главный ответ
  try {
    const health = await get('/health', '')
    console.log(`\nСервер после нагрузки: ${green('жив')} (${health.commit})`)
  } catch (e) {
    console.log(`\nСервер после нагрузки: ${red('не отвечает')} — ${e.message}`)
  }
}

try {
  await main()
} catch (e) {
  console.error(red('\nПрогон оборвался: ' + e.message))
} finally {
  await cleanup()
}
