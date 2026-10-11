// ── Состояние программы: значок, копия базы, отвергнутое сервером, срок без связи ──
//
// Кассир должен в любой момент видеть главное: сохранено ли то, что он сделал.
// Здесь это проверяется на настоящей программе и настоящем сервере:
//   • значок в шапке говорит правду — на связи, без интернета, сколько чеков ждёт;
//   • копия базы снимается, и испорченный файл базы сам поднимается из неё;
//   • то, что сервер не принял, видно владельцу, и он может с этим разобраться;
//   • без связи дольше разрешённого программа останавливается — и объясняет почему.
//
// Перед запуском:  npm run electron:build -- --dir   (нужен собранный интерфейс)
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, openSync, readdirSync, rmSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { MESSAGES } from '../src/gateway.mjs'
import { freshUserData, goTo, launchApp, PASS, readLocal, server, serverLogin, signIn, startProxy, USER } from './app.mjs'

test.describe.configure({ mode: 'serial' })

const TAG = 'STS-' + Date.now().toString(36)
const DAY = 86400000
const userData = freshUserData()
let proxy = null
let app = null
let page = null
let token = ''
let code = ''
let X = null

const dbFile = () => join(userData, 'data', `pharmacy-${code}.db`)
const badge = () => page.getByTestId('sync-badge')
const modal = () => page.getByTestId('status-modal')
const scanInput = () => page.locator('.scan-input')
const queue = (state) => readLocal(userData, code, 'SELECT COUNT(*) AS n FROM outbox WHERE state = ?', state)?.[0]?.n
const serverStock = async () => (await server(token, 'GET', '/products')).find((p) => p.id === X.id).stock
const launch = () => launchApp({ userData, env: { APTEKA_API_URL: proxy.apiUrl, APTEKA_TEST_HOOKS: '1' } })

async function sellOne() {
  await goTo(page, 'Касса')
  if (await scanInput().inputValue()) await scanInput().fill('')
  await scanInput().focus()
  await page.keyboard.type(X.barcode + '\n', { delay: 3 })
  await expect(page.locator('.kassa-table tbody tr', { hasText: X.name })).toBeVisible()
  await page.getByRole('button', { name: /Провести продажу/ }).click()
  const receipt = page.locator('.modal', { hasText: 'Чек продажи' })
  await expect(receipt).toBeVisible()
  await receipt.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Корзина пуста')).toBeVisible()
}

async function openStatus() {
  await badge().click()
  await expect(modal()).toBeVisible()
}
const closeStatus = async () => {
  await modal().getByRole('button', { name: 'Закрыть' }).click()
  await expect(modal()).toHaveCount(0)
}
// Строка «подпись — значение» в окне состояния
const rowOf = (label) => modal().locator('.total-row', { hasText: label })

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS — логин и пароль владельца тестовой аптеки').toBeTruthy()
  token = await serverLogin()
  code = (await server(token, 'GET', '/auth/me')).pharmacy.code
  X = await server(token, 'POST', '/products', {
    name: `${TAG} Таблетки`, barcode: '279' + String(Date.now()).slice(-9) + '1', category: 'Таблетки', price: 25, cost: 10, stock: 20, minStock: 0, unitsPerPack: 1, expiryDate: '2028-01-31',
  })
  proxy = await startProxy()
  ;({ app, page } = await launch())
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  await proxy?.close()
  if (X) await server(token, 'DELETE', `/products/${X.id}`).catch(() => {})
})

test('на связи: значок говорит, что всё отправлено', async () => {
  await signIn(page)
  await expect(badge()).toBeVisible({ timeout: 30_000 })
  await expect(badge()).toContainText('Всё отправлено', { timeout: 30_000 })
  await expect(badge()).toHaveClass(/\bok\b/)
  // Полосы «нет связи» в программе нет вовсе: о связи говорит значок
  await expect(page.locator('.conn-banner')).toHaveCount(0)
})

test('интернет пропал — значок сообщает об этом сам, а касса продолжает работать', async () => {
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета · касса работает', { timeout: 30_000 })
  await expect(badge()).toHaveClass(/\bwarn\b/)

  await sellOne()
  await expect(badge()).toContainText('Нет интернета · ждут отправки: 1', { timeout: 15_000 })
  await expect(page.locator('.conn-banner')).toHaveCount(0)
})

test('окно состояния: чек сохранён на этом компьютере, видно, сколько ещё можно работать без связи', async () => {
  await openStatus()
  await expect(modal()).toContainText('Связи с сервером нет. Касса работает: чеки сохраняются на этом компьютере')
  await expect(rowOf('Ждут отправки')).toContainText('1')
  await expect(rowOf('Без связи программа работает')).toContainText('7 дн.')
  await expect(rowOf('Без связи можно работать ещё')).toContainText('7 дн. (')
  // Про обновление программа говорит как есть: не настроено — или новой версии нет
  await expect(modal()).toContainText(/Автообновление не настроено|Установлена последняя версия/)
  await expect(rowOf('Версия программы')).toContainText(/\d+\.\d+\.\d+/)
})

test('копия базы снимается по кнопке — и в ней тот самый неотправленный чек', async () => {
  await expect(rowOf('Последняя копия')).toContainText('ещё не снималась')
  await modal().getByRole('button', { name: 'Снять копию сейчас' }).click()
  await expect(page.locator('.toast')).toContainText('Копия снята', { timeout: 30_000 })
  await expect(rowOf('Последняя копия')).not.toContainText('ещё не снималась')
  await closeStatus()

  const root = join(userData, 'backups')
  const [folder] = readdirSync(root)
  expect(readdirSync(join(root, folder)).sort()).toEqual(['core.db', `pharmacy-${code}.db`])
  const copy = new Database(join(root, folder, `pharmacy-${code}.db`), { readonly: true })
  expect(copy.pragma('quick_check(1)')[0].quick_check).toBe('ok')
  expect(copy.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get().n).toBe(1)
  copy.close()
})

test('файл базы испорчен — программа сама поднимает её из копии и честно об этом говорит', async () => {
  // Ещё один чек — уже после копии
  await sellOne()
  expect(queue('pending')).toBe(2)
  await app.close()

  // Сбойный диск: середина файла затёрта
  for (const suffix of ['-wal', '-shm']) rmSync(dbFile() + suffix, { force: true })
  const fd = openSync(dbFile(), 'r+')
  writeSync(fd, Buffer.alloc(4000, 0x5a), 0, 4000, 0)
  closeSync(fd)

  ;({ app, page } = await launch())
  // Вход на месте, касса открывается — человек продолжает работать
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await expect(badge()).toContainText('ждут отправки: 1', { timeout: 30_000 })
  expect(queue('pending'), 'чек, пробитый до копии, должен быть на месте').toBe(1)

  await openStatus()
  await expect(modal()).toContainText('Файл базы был повреждён, и программа подняла её из копии от')
  await expect(modal()).toContainText('сверьте кассу')
  await closeStatus()
  // Испорченный файл не стёрт — отложен в сторону
  expect(existsSync(join(userData, 'broken'))).toBe(true)
})

test('интернет вернулся: уцелевший чек уходит на сервер, значок снова «всё отправлено»', async () => {
  proxy.online()
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  expect(queue('pending')).toBe(0)
  // Из двух чеков до сервера дошёл один: второй был пробит после копии и пропал
  // вместе с испорченным файлом — ровно об этом программа и предупредила
  expect(await serverStock()).toBe(19)
  await openStatus()
  await expect(modal()).toContainText('Связь с сервером есть. Всё, что сделано на этой кассе, отправлено.')
  await expect(rowOf('Ждут отправки')).toContainText('ничего')
  await closeStatus()
})

test('сервер не принял операцию — владелец видит, что именно и почему, и может с этим разобраться', async () => {
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 30_000 })
  await sellOne()
  // Чек испорчен по дороге: сумма больше не сходится с позициями
  const db = new Database(dbFile())
  db.pragma('busy_timeout = 5000')
  const row = db.prepare("SELECT seq, payload FROM outbox WHERE state = 'pending' ORDER BY seq DESC LIMIT 1").get()
  const payload = JSON.parse(row.payload)
  payload.sale.total += 1
  db.prepare('UPDATE outbox SET payload = ? WHERE seq = ?').run(JSON.stringify(payload), row.seq)
  db.close()

  proxy.online()
  await expect(badge()).toContainText('Не принято сервером: 1', { timeout: 120_000 })
  await expect(badge()).toHaveClass(/\bbad\b/)
  expect(await serverStock(), 'отвергнутый чек не должен был списать товар на сервере').toBe(19)

  await openStatus()
  const item = modal().locator('.rash-row').first()
  await expect(item).toContainText('Чек')
  await expect(item).toContainText('26')
  await expect(item).toContainText(X.name)
  await expect(item).toContainText('Суммы чека не сходятся с его позициями')
  // Что именно было в чеке: в журналах кассы его больше нет, разобрать его можно только здесь
  await expect(modal()).toContainText('Эти операции сняты с учёта')
  const detail = item.getByTestId('rejected-detail')
  await detail.locator('summary').click()
  await expect(detail).toContainText('Оплата')
  await expect(detail).toContainText('Наличные')
  await expect(detail).toContainText(X.name)
  await expect(detail).toContainText('1 уп × 25')
  await item.getByRole('button', { name: 'Разобрался' }).click()
  await expect(modal().locator('.rash-row')).toHaveCount(0)
  await closeStatus()
  await expect(badge()).toContainText('Всё отправлено')
  // Остаток на кассе вернулся к тому, что знает сервер: отвергнутая продажа не в счёт
  await goTo(page, 'Касса')
  await scanInput().fill(X.name)
  await expect(page.locator('.kc-row', { hasText: X.name }).first().locator('.badge')).toHaveText('19 уп')
  await scanInput().fill('')
})

test('без связи осталось меньше двух дней — значок предупреждает заранее', async () => {
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 30_000 })
  // Проходит пять с половиной дней
  await app.evaluate((_electron, ms) => globalThis.__aptekaTest.shiftClock(ms), 5.5 * DAY)
  await expect(badge()).toContainText('Нет интернета · осталось 1 дн. 12 ч.', { timeout: 15_000 })
  await openStatus()
  await expect(modal()).toContainText('Подключите интернет хотя бы на минуту')
  await closeStatus()
  // Касса при этом работает
  await sellOne()
})

test('срок без связи вышел — программа останавливается и объясняет почему', async () => {
  await app.evaluate((_electron, ms) => globalThis.__aptekaTest.shiftClock(ms), 2 * DAY)
  const stop = page.locator('.suspended-card')
  await expect(stop).toBeVisible({ timeout: 15_000 })
  await expect(stop.locator('h1')).toHaveText(MESSAGES.offlineTitle)
  await expect(stop).toContainText(MESSAGES.offlineLimit)
  // Чек, пробитый до остановки, никуда не делся
  expect(queue('pending')).toBe(1)

  await stop.getByRole('button', { name: 'Понятно' }).click()
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 30_000 })
  // Войти без связи нельзя: пароль верный, но нужна проверка
  await page.locator('#lg-name').fill(USER)
  await page.locator('#lg-pw').fill(PASS)
  await page.locator('.login-card button.btn.block').click()
  await expect(page.locator('.login-card')).toContainText(MESSAGES.offlineLimit, { timeout: 30_000 })
  await expect(page.locator('.sidebar')).toHaveCount(0)
})

test('связь появилась — вход проходит, работа продолжается, чек уходит на сервер', async () => {
  proxy.online()
  await signIn(page)
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  expect(queue('pending')).toBe(0)
  expect(await serverStock()).toBe(18)
  await openStatus()
  await expect(rowOf('Без связи можно работать ещё')).toContainText('7 дн. (')
  await closeStatus()
  await sellOne()
  await expect.poll(serverStock, { timeout: 30_000 }).toBe(17)
})

test('часы компьютера показывают прошлое, а связи нет — программа говорит об этом; связь вернулась — подсказки больше нет', async () => {
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  proxy.offline()
  await expect(badge()).toContainText('Нет интернета', { timeout: 30_000 })
  await app.close()

  // Часы компьютера перевели назад (или они сбились): программа помнит момент,
  // которого на них ещё не было
  const core = new Database(join(userData, 'data', 'core.db'))
  core.pragma('busy_timeout = 5000')
  const saved = JSON.parse(core.prepare("SELECT value FROM meta WHERE key = 'clock'").get().value)
  core.prepare("UPDATE meta SET value = ? WHERE key = 'clock'").run(JSON.stringify({ ...saved, offset: 0, seen: Date.now() + 2 * DAY }))
  core.close()

  ;({ app, page } = await launch())
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  await expect(badge()).toContainText('Нет интернета · проверьте часы компьютера', { timeout: 30_000 })
  await openStatus()
  await expect(modal().getByTestId('clock-doubt')).toContainText('Дата и время на этом компьютере неверные')
  // Срок работы без связи при сбитых часах считается по-своему — и человеку это сказано
  await expect(modal()).toContainText('срок уменьшается и за время, пока компьютер был выключен')
  await closeStatus()
  // Касса при этом работает
  await sellOne()

  // Связь вернулась — время сверено с сервером, чек ушёл, подсказки больше нет
  proxy.online()
  await expect(badge()).toContainText('Всё отправлено', { timeout: 120_000 })
  await openStatus()
  await expect(modal().getByTestId('clock-doubt')).toHaveCount(0)
  await closeStatus()
  expect(queue('pending')).toBe(0)
})
