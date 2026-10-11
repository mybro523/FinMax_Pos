// ── Уборка тестовых данных ──
// Проверки помечают всё, что создают: аптеки, товары, клиенты, сотрудники и
// категории начинаются с известных приставок. Обычно каждый прогон убирает за
// собой сам, но если он оборвался посередине, следы остаются — этот скрипт их
// подчищает.
//
// Убирается по-разному, смотря кем вошли.
//
// Владельцем сервиса — убираются аптеки прогонов целиком, вместе со схемой. Это
// и проще, и полнее: документы (чеки, приходы, возвраты, списания) поштучно не
// удаляются, и правильно, что не удаляются — история аптеки не должна стираться
// по кнопке. А вот схему тестовой аптеки снести можно: настоящей аптеки там нет.
//
// Сотрудником аптеки — убираются только справочники внутри неё, как раньше.
//
// Запуск:  node e2e/cleanup.mjs [адрес API] [логин] [пароль]
import { get, del, login, API } from './lib.mjs'

const PREFIXES = ['UI-', 'E2E-', 'BK-', 'PROBE-', 'DEPLOY-PROBE-', 'SOCKDIAG-', 'SD2-']
const isTest = (name) => PREFIXES.some((p) => String(name || '').startsWith(p))
// Код аптеки всегда в нижнем регистре — приставки сравниваем так же
const isTestCode = (code) => PREFIXES.some((p) => String(code || '').startsWith(p.toLowerCase()))

async function sweep(label, path, list) {
  const junk = list.filter((x) => isTest(x.name))
  let removed = 0
  for (const x of junk) {
    try {
      await del(`${path}/${x.id}`)
      removed++
    } catch (e) {
      console.log(`  не удалось убрать ${label}: ${x.name} — ${e.message}`)
    }
  }
  console.log(`  ${label}: убрано ${removed} из ${junk.length} (всего ${list.length})`)
  return removed
}

async function sweepPharmacies() {
  const list = await get('/admin/pharmacies')
  const junk = list.filter((p) => isTestCode(p.code) || isTest(p.name))
  let removed = 0
  for (const p of junk) {
    try {
      await del(`/admin/pharmacies/${p.id}?confirm=${p.code}`)
      removed++
    } catch (e) {
      console.log(`  не удалось убрать аптеку ${p.code} — ${e.message}`)
    }
  }
  console.log(`  аптеки прогонов: убрано ${removed} из ${junk.length} (всего ${list.length})`)
  return removed
}

console.log(`Уборка тестовых данных на ${API}`)
const me = await login()
console.log(`  вошли как ${me.name} (${me.role})\n`)

let total = 0
if (me.role === 'superadmin') {
  total += await sweepPharmacies()
} else {
  // Порядок важен: категорию нельзя удалить, пока в ней есть товары
  total += await sweep('товары', '/products', await get('/products'))
  total += await sweep('клиенты', '/customers', await get('/customers'))
  total += await sweep('сотрудники', '/users', await get('/users'))
  total += await sweep('категории', '/categories', await get('/categories'))
}

console.log(`\nВсего убрано записей: ${total}`)
