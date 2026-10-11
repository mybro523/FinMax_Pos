// Ждём, пока на сервере окажется свежая сборка.
// Признак — поле, которого в старой версии не было: заводим временный товар,
// смотрим карточку и сразу удаляем.
//
// Запуск:  node e2e/wait-deploy.mjs [адрес API] [логин] [пароль] [поле]
import { get, post, del, login, API } from './lib.mjs'

const FIELD = process.argv[5] || 'expiredUnits'
const TRIES = 40
const DELAY_MS = 15000

async function probe() {
  const p = await post('/products', {
    name: 'DEPLOY-PROBE-' + Date.now().toString(36),
    barcode: '288' + String(Date.now()).slice(-10),
    category: 'Таблетки',
    cost: 0,
    price: 0,
    stock: 0,
  })
  try {
    return FIELD in p
  } finally {
    await del('/products/' + p.id).catch(() => {})
  }
}

console.log(`Жду сборку с полем «${FIELD}» на ${API}`)
await login()

for (let i = 1; i <= TRIES; i++) {
  let ok = false
  try {
    ok = await probe()
  } catch (e) {
    console.log(`  ${i}/${TRIES} — сервер отвечает ошибкой (${e.message.slice(0, 60)}) — вероятно, идёт перезапуск`)
    await new Promise((r) => setTimeout(r, DELAY_MS))
    continue
  }
  if (ok) {
    console.log(`\n\x1b[32mНовая сборка на месте\x1b[0m (попытка ${i}, примерно ${Math.round((i * DELAY_MS) / 1000)} с)`)
    process.exit(0)
  }
  console.log(`  ${i}/${TRIES} — пока старая версия`)
  await new Promise((r) => setTimeout(r, DELAY_MS))
}

console.log('\n\x1b[31mНе дождались.\x1b[0m Проверьте, идёт ли сборка в Railway.')
process.exit(1)
