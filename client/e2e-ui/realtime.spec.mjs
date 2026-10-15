// ── Мгновенность: два окна одновременно, без единой перезагрузки ──
//
// Это единственная проверка, где два человека работают в один момент: владелец
// сервиса в панели и кассир за кассой. Всё, что здесь ловится, невидимо для
// остальных проверок — они смотрят на ответ сервера, а беда живёт на ЧУЖОМ экране.
//
// Правило прогона: страницу не перезагружаем нигде. Ни разу. Если проверка проходит
// только после перезагрузки — значит мгновенности нет, а есть обычная загрузка.
//
// Что проверяется:
//   владелец сервиса видит, кто сейчас за кассой;
//   продление доходит до кассы в ту же секунду — предупреждение снимается само;
//   работа в одном окне магазина видна во втором окне того же магазина;
//   приостановка приходит с объяснением, а не молчаливым обрывом связи.
//
// Запуск:  npx playwright test e2e-ui/realtime.spec.mjs   (в папке client)
import { test, expect } from '@playwright/test'

const USER = process.env.APP_USER || 'admin'
const PASS = process.env.APP_PASS || 'admin'
const API = process.env.API_URL || 'https://saasapteka-production.up.railway.app/api'

const TAG = 'rt' + Date.now().toString(36).slice(-6)
const OWNER_LOGIN = TAG + '-hozyain'
const OWNER_PASS = 'proverka-2026'

// Сколько ждём мгновенного. Настоящий путь — сервер, сеть, браузер — укладывается
// в доли секунды; десять секунд здесь только для того, чтобы медленная машина
// не выдавала ложных провалов. Опоздание на минуту это уже не пропустит.
const INSTANT = 10_000

const state = { id: null, token: null }

async function signIn(page, name, password) {
  await page.goto('/')
  const card = page.locator('.login-card')
  if (await card.isVisible().catch(() => false)) {
    await page.locator('#lg-name').fill(name)
    await page.locator('#lg-pw').fill(password)
    await page.getByRole('button', { name: /Войти/ }).click()
  }
}

// Магазин для прогона заводим запросом, а не руками: сам путь заведения проверяется
// в panel.spec.mjs, а здесь он занял бы минуту чужого времени
test.beforeAll(async ({ request }) => {
  const res = await request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
  state.token = (await res.json()).token
  const auth = { Authorization: `Bearer ${state.token}` }

  const made = await request.post(`${API}/admin/pharmacies`, {
    headers: auth,
    timeout: 180_000,
    data: {
      code: TAG,
      name: `Магазин ${TAG}`,
      ownerName: 'Проверка связи',
      city: 'Душанбе',
      trialDays: 3, // мало — чтобы предупреждение о пробном периоде точно висело
      ownerLogin: OWNER_LOGIN,
      ownerPassword: OWNER_PASS,
    },
  })
  expect(made.ok(), `магазин для прогона завести не удалось: ${await made.text()}`).toBeTruthy()
  state.id = (await made.json()).id
})

test.afterAll(async ({ request }) => {
  if (!state.id) return
  await request
    .delete(`${API}/admin/pharmacies/${state.id}?confirm=${TAG}`, {
      headers: { Authorization: `Bearer ${state.token}` },
      timeout: 180_000,
    })
    .catch(() => {})
})

test.describe.configure({ mode: 'serial' })

test('владелец сервиса видит, кто сейчас за кассой', async ({ browser }) => {
  test.setTimeout(120_000)
  const panel = await browser.newPage()
  const kassa = await browser.newPage()

  await signIn(panel, USER, PASS)
  await expect(panel.locator('.topbar h1')).toHaveText('Магазины')

  const row = panel.locator('tbody tr', { hasText: TAG }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  // Пока за кассой никого — отметки нет
  await expect(row.locator('.live-dot')).toHaveCount(0)

  // Кассир входит во втором окне. Панель НЕ трогаем: она должна узнать сама
  await signIn(kassa, OWNER_LOGIN, OWNER_PASS)
  await expect(kassa.locator('.sidebar')).toBeVisible()

  await expect(row.locator('.live-dot')).toHaveCount(1, { timeout: INSTANT })

  // Кассир закрыл программу — отметка гаснет, снова без перезагрузки панели.
  //
  // Срок здесь такой же короткий, как везде, и это не случайно. Пока связь начиналась
  // с обычных запросов, уход замечался только по молчанию — до полуминуты. Теперь
  // постоянное соединение поднимается сразу, и закрытую вкладку сервер видит тут же.
  // Если кто-нибудь вернёт прежний порядок, эта проверка первой об этом скажет.
  await kassa.close()
  await expect(row.locator('.live-dot')).toHaveCount(0, { timeout: INSTANT })
  await panel.close()
})

test('продление доходит до кассы в ту же секунду', async ({ browser }) => {
  test.setTimeout(120_000)
  const kassa = await browser.newPage()
  const panel = await browser.newPage()

  await signIn(kassa, OWNER_LOGIN, OWNER_PASS)

  // ── Где теперь про подписку ──
  // Оранжевой полосы над кассой больше нет: владелец сервиса убрал её отовсюду,
  // кассир к деньгам за программу отношения не имеет. Состояние подписки живёт
  // в «Настройках», и с него мы и начинаем.
  await expect(kassa.locator('.conn-banner.pay'), 'полоса про подписку вернулась в разделы').toHaveCount(0)
  await kassa.locator('.sidebar').getByRole('link', { name: /Настройки/ }).first().click()
  const block = kassa.locator('.panel', { hasText: 'Подписка' }).first()
  await expect(block).toBeVisible({ timeout: 30_000 })
  await expect(block).toContainText(/Пробный период|Оплачено до/)
  const before = (await block.innerText()).replace(/\s+/g, ' ')

  await signIn(panel, USER, PASS)
  await panel.locator('tbody tr', { hasText: TAG }).first().click()
  const card = panel.locator('.modal', { hasText: `Магазин ${TAG}` }).first()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: /Продлить/ }).click()

  const pay = panel.locator('.modal', { hasText: /Продлить|Оплата/ }).last()
  await expect(pay).toBeVisible()
  await pay.getByRole('button', { name: /Продлить|Сохранить|Записать/ }).last().click()

  // ── Главное во всей проверке ──
  // Кассу не трогали и не перезагружали. Человеку сказали, что произошло…
  await expect(kassa.locator('.toast')).toContainText(/продлен/i, { timeout: INSTANT })
  // …и состояние подписки в настройках обновилось само, без перезагрузки
  await expect
    .poll(async () => (await block.innerText()).replace(/\s+/g, ' '), {
      message: 'состояние подписки в настройках не обновилось после оплаты',
      timeout: INSTANT,
    })
    .not.toBe(before)

  await panel.close()
  await kassa.close()
})

test('работа в одном окне магазина видна во втором без перезагрузки', async ({ browser }) => {
  test.setTimeout(120_000)
  const one = await browser.newPage()
  const two = await browser.newPage()
  await signIn(one, OWNER_LOGIN, OWNER_PASS)
  await signIn(two, OWNER_LOGIN, OWNER_PASS)

  for (const p of [one, two]) {
    await p.locator('.sidebar').getByRole('link', { name: /Товары/ }).first().click()
    await expect(p.locator('.topbar h1')).toHaveText('Товары')
  }

  const name = `${TAG} Аспирин`
  await one.getByRole('button', { name: /Добавить товар/ }).click()
  const modal = one.locator('.modal').first()
  await expect(modal).toBeVisible()
  await modal.locator('.field', { hasText: 'Название' }).locator('input').first().fill(name)
  await modal.locator('input[placeholder="487…"]').fill('277' + String(Date.now()).slice(-10))
  await modal.locator('select').first().selectOption('Таблетки')
  const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
  await num('Закупочная цена').fill('40')
  await num('Цена продажи').fill('90')
  await num('Остаток').fill('5')
  await modal.getByRole('button', { name: /^Сохранить$/ }).click()
  await expect(modal).toBeHidden()

  // Второе окно ничего не нажимало
  await expect(two.locator('tbody')).toContainText(name, { timeout: INSTANT })
  await one.close()
  await two.close()
})

test('приостановка приходит с объяснением, а не молчаливым обрывом', async ({ browser }) => {
  test.setTimeout(120_000)
  const kassa = await browser.newPage()
  const panel = await browser.newPage()

  await signIn(kassa, OWNER_LOGIN, OWNER_PASS)
  await expect(kassa.locator('.sidebar')).toBeVisible()

  await signIn(panel, USER, PASS)
  await panel.locator('tbody tr', { hasText: TAG }).first().click()
  const card = panel.locator('.modal', { hasText: `Магазин ${TAG}` }).first()
  await card.getByRole('button', { name: /Приостановить/ }).click()
  // Приостановка спрашивает подтверждение: это не то действие, которое делают
  // случайным нажатием мимо строки
  const ask = panel.locator('.modal', { hasText: 'Приостановить работу магазина?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: /^Приостановить$/ }).click()

  // На кассе — понятное объяснение вместо пропавшей связи. Без него кассир решил бы,
  // что виноват интернет, и упёрся бы в отказ посреди продажи.
  const stop = kassa.locator('.suspended-card')
  await expect(stop, 'магазин отключили молча').toBeVisible({ timeout: INSTANT })
  await expect(stop).toContainText(/приостановлен/i)
  await expect(stop).toContainText(/поставщику программы/i)

  // Прочитал — вышел. Дальше обычная форма входа, а не пустой экран.
  await stop.getByRole('button', { name: /Понятно/ }).click()
  await expect(kassa.locator('.login-card')).toBeVisible()

  // Возвращаем работу, чтобы уборка прошла как обычно
  await card.getByRole('button', { name: /Возобновить/ }).click()
  const askBack = panel.locator('.modal', { hasText: 'Возобновить работу магазина?' })
  await expect(askBack).toBeVisible()
  await askBack.getByRole('button', { name: /^Возобновить$/ }).click()
  await expect(card.getByRole('button', { name: /Приостановить/ })).toBeVisible({ timeout: 30_000 })

  await panel.close()
  await kassa.close()
})
