// ── Панель владельца сервиса: путь целиком, настоящим браузером ──
//
// Проверяется то, чего не видно ни расчётами, ни запросами к API. Именно здесь
// пряталась ошибка, которую поймал живой человек: заведение аптеки идёт около
// пятнадцати секунд, а браузерный код обрывал ожидание ровно на пятнадцатой —
// и показывал «Сервер не отвечает», хотя аптека к тому моменту уже создавалась.
// Через API это не находится: срок ожидания живёт в браузере, а не на сервере.
//
// Прогон проходит весь путь как человек: вход, заведение аптеки, ожидание,
// логин с паролем, вход этим владельцем, работа в кассе, уборка за собой.
//
// Запуск:  npm run test:ui  (в папке client)
//   APP_URL, APP_USER, APP_PASS — если система развёрнута по другому адресу
import { test, expect } from '@playwright/test'

const USER = process.env.APP_USER || 'admin'
const PASS = process.env.APP_PASS || 'admin'
const API = process.env.API_URL || 'https://saasapteka-production.up.railway.app/api'

// Метка прогона: по ней видно свои записи и легко убрать за собой
const TAG = 'ui' + Date.now().toString(36).slice(-6)
const CODE = TAG
const OWNER_LOGIN = TAG + '-hozyain'
const OWNER_PASS = 'proverka-2026'

// Что узнали по ходу — нужно следующим шагам и уборке
const state = { pharmacyId: null }

async function signIn(page, name, password) {
  await page.goto('/')
  const card = page.locator('.login-card')
  if (await card.isVisible().catch(() => false)) {
    await page.locator('#lg-name').fill(name)
    await page.locator('#lg-pw').fill(password)
    await page.getByRole('button', { name: /Войти/ }).click()
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('Владелец сервиса заводит аптеку и она работает', () => {
  test('вход владельцем сервиса открывает панель, а не кассу', async ({ page }) => {
    await signIn(page, USER, PASS)
    await expect(page.locator('.topbar h1')).toHaveText('Аптеки')
    // У владельца сервиса своей аптеки нет — бокового меню кассы быть не должно
    await expect(page.locator('.sidebar')).toHaveCount(0)
  })

  // Заведение и ожидание — одна проверка, и это не лень. Запрос идёт в фоне той
  // самой вкладки: закончи проверка здесь, Playwright закрыл бы её и оборвал работу.
  // Первый прогон так и сделал — аптека не создалась вовсе.
  test('окно закрывается сразу, работа идёт в фоне, пароль всплывает сам', async ({ page }) => {
    test.setTimeout(240_000)
    await signIn(page, USER, PASS)

    await page.getByRole('button', { name: /Завести аптеку/ }).click()
    const form = page.locator('.modal', { hasText: 'Новая аптека' })
    await expect(form).toBeVisible()

    const field = (label) => form.locator('.field', { hasText: label }).locator('input').first()
    await field('Код аптеки').fill(CODE)
    await field('Название').fill(`Аптека ${TAG}`)
    await field('Владелец').fill('Проверка')
    await field('Телефон').fill('+992 900 11 22 33')
    await field('Город').fill('Душанбе')
    await field('Логин владельца').fill(OWNER_LOGIN)
    await field('Пароль').fill(OWNER_PASS)

    const clickedAt = Date.now()
    await form.getByRole('button', { name: /^Завести$/ }).click()

    // ── Главное в этой проверке ──
    // Окно обязано закрыться мгновенно. Раньше оно висело до пятнадцатой секунды
    // и заканчивалось красной полосой «Сервер не отвечает» — при том, что аптека
    // создавалась. Три секунды здесь — с огромным запасом на медленную машину.
    await expect(form).toBeHidden({ timeout: 3000 })
    const closedIn = Date.now() - clickedAt
    expect(closedIn, `окно закрывалось ${closedIn} мс — оно должно закрываться сразу`).toBeLessThan(3000)

    // И никакой ложной ошибки: работа только началась
    await expect(page.locator('.toast.err')).toHaveCount(0)

    // Видно, что команда принята: строка «заводится…» в списке.
    // Ищем именно строку, а не «где-нибудь в таблице»: таблиц на странице две —
    // сверху отдельно те аптеки, что требуют внимания сегодня.
    await expect(page.getByText('заводится…')).toBeVisible()
    await expect(page.locator('tbody tr', { hasText: CODE }).first()).toBeVisible()

    // ── Ждём, не трогая вкладку ──
    // Когда аптека готова, окно с логином и паролем открывается само: пароль
    // показывается один раз, и потерять его из-за того, что человек отвлёкся, нельзя
    const done = page.locator('.modal', { hasText: 'Аптека заведена' })
    await expect(done).toBeVisible({ timeout: 180_000 })
    await expect(done).toContainText(OWNER_LOGIN)
    await expect(done).toContainText(OWNER_PASS)
    await done.getByRole('button', { name: /Записал/ }).click()

    // Пометки больше нет, вместо неё настоящая строка
    await expect(page.getByText('заводится…')).toHaveCount(0)
    const row = page.locator('tbody tr', { hasText: CODE })
    await expect(row.first()).toBeVisible()

    // Карточка открывается щелчком — значит аптека настоящая, а не пометка
    await row.first().click()
    const card = page.locator('.modal', { hasText: `Аптека ${TAG}` }).first()
    await expect(card).toBeVisible()
    await expect(card).toContainText('Пробный период')
    await expect(card).toContainText('Проверка')

    // Запоминаем, что убирать, если следующая проверка оборвётся
    const res = await page.request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
    const { token } = await res.json()
    const list = await (await page.request.get(`${API}/admin/pharmacies`, { headers: { Authorization: `Bearer ${token}` } })).json()
    state.pharmacyId = list.find((p) => p.code === CODE)?.id
    expect(state.pharmacyId, 'аптека не найдена на сервере').toBeTruthy()
  })

  test('владелец новой аптеки входит и попадает в свою кассу', async ({ page }) => {
    await signIn(page, OWNER_LOGIN, OWNER_PASS)
    // У аптеки боковое меню есть — в отличие от панели
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.side-user .su-name')).toHaveText(OWNER_LOGIN)
    await expect(page.locator('.side-user .su-role')).toHaveText('Основатель')
  })

  test('новая аптека начинает с пустого склада и своими категориями', async ({ page }) => {
    await signIn(page, OWNER_LOGIN, OWNER_PASS)
    await page.locator('.sidebar').getByRole('link', { name: /Товары/ }).first().click()
    await expect(page.locator('.topbar h1')).toHaveText('Товары')
    // Ни одного товара: аптека новая, и чужих данных в ней быть не может
    await expect(page.locator('tbody')).toContainText('Ничего не найдено')
  })

  test('в новой аптеке проходит настоящая продажа', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, OWNER_LOGIN, OWNER_PASS)

    // Заводим товар
    await page.locator('.sidebar').getByRole('link', { name: /Товары/ }).first().click()
    await page.getByRole('button', { name: /Добавить товар/ }).click()
    const modal = page.locator('.modal').first()
    await expect(modal).toBeVisible()
    const code = '277' + String(Date.now()).slice(-10)
    await modal.locator('.field', { hasText: 'Название' }).locator('input').first().fill(`${TAG} Парацетамол`)
    await modal.locator('input[placeholder="487…"]').fill(code)
    await modal.locator('select').first().selectOption('Таблетки')
    const num = (label) => modal.locator('.field', { hasText: label }).locator('input').first()
    await num('Закупочная цена').fill('60')
    await num('Цена продажи').fill('100')
    await num('Остаток').fill('10')
    await modal.getByRole('button', { name: /^Сохранить$/ }).click()
    await expect(modal).toBeHidden()

    // Продаём его на кассе
    await page.locator('.sidebar').getByRole('link', { name: /Касса/ }).first().click()
    await expect(page.locator('.topbar h1')).toHaveText('Касса')
    await page.locator('.scan-input').fill(code)
    await page.locator('.scan-input').press('Enter')

    // Товар в корзине, кнопка продажи доступна — подписка в порядке
    await expect(page.locator('.kassa-cart')).toContainText(`${TAG} Парацетамол`)
    const payBtn = page.getByRole('button', { name: /Провести продажу/ })
    await expect(payBtn).toBeEnabled()
    await payBtn.click()

    // Чек напечатался — значит продажа состоялась
    await expect(page.locator('.modal')).toContainText(/Чек|Итого/i, { timeout: 30_000 })
  })

  test('уборка: аптека прогона удалена вместе со схемой', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)
    const row = page.locator('tbody tr', { hasText: CODE })
    await expect(row.first()).toBeVisible()
    await row.first().click()

    const card = page.locator('.modal', { hasText: `Аптека ${TAG}` }).first()
    await card.getByRole('button', { name: /Удалить/ }).click()

    // Подтверждение — набрать код аптеки: перепутать строку в списке легко,
    // набрать чужой код руками уже нет
    const ask = page.locator('.modal', { hasText: 'Удалить аптеку?' })
    await expect(ask).toBeVisible()
    await ask.locator('input').first().fill(CODE)
    await ask.getByRole('button', { name: /^Удалить$/ }).click()

    await expect(page.locator('tbody tr', { hasText: CODE })).toHaveCount(0, { timeout: 60_000 })
  })
})

// ── Самый долгий путь и самый деликатный ──
// Заведение с демо-данными: к схеме и миграциям добавляются двадцать товаров
// и полсотни чеков. Раньше это шло около минуты — и прежний срок ожидания обрывал
// работу гарантированно, каждый раз. Теперь, когда база стоит рядом с сервером,
// те же полторы сотни запросов укладываются в несколько секунд.
//
// На этой же аптеке проверяется вход под владельцем: он подменяет токен,
// и ошибка тут означала бы, что владелец сервиса застрял в чужой аптеке.
test.describe('Аптека с демо-данными и вход под её владельцем', () => {
  const CODE2 = TAG + '-d'
  const state2 = { id: null }

  test.afterAll(async () => {
    if (!state2.id) return
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: USER, password: PASS }),
      })
      const { token } = await r.json()
      await fetch(`${API}/admin/pharmacies/${state2.id}?confirm=${CODE2}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      console.log(`  ВНИМАНИЕ: не удалось убрать аптеку ${CODE2}`)
    }
  })

  test('заведение с демо-данными доходит до конца, хотя идёт около минуты', async ({ page }) => {
    test.setTimeout(300_000)
    await signIn(page, USER, PASS)

    await page.getByRole('button', { name: /Завести аптеку/ }).click()
    const form = page.locator('.modal', { hasText: 'Новая аптека' })
    const field = (label) => form.locator('.field', { hasText: label }).locator('input').first()
    await field('Код аптеки').fill(CODE2)
    await field('Название').fill(`Показ ${TAG}`)
    await field('Логин владельца').fill(CODE2 + '-hoz')
    await field('Пароль').fill(OWNER_PASS)
    await form.locator('input[type="checkbox"]').check()

    await form.getByRole('button', { name: /^Завести$/ }).click()
    await expect(form).toBeHidden({ timeout: 3000 })
    // Пометка честно говорит, что работа длиннее обычной
    await expect(page.getByText('заводится с демо-данными…')).toBeVisible()

    const done = page.locator('.modal', { hasText: 'Аптека заведена' })
    await expect(done).toBeVisible({ timeout: 240_000 })
    await done.getByRole('button', { name: /Записал/ }).click()

    const res = await page.request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
    const { token } = await res.json()
    const list = await (await page.request.get(`${API}/admin/pharmacies`, { headers: { Authorization: `Bearer ${token}` } })).json()
    state2.id = list.find((p) => p.code === CODE2)?.id
    expect(state2.id, 'аптека с демо-данными не найдена').toBeTruthy()
  })

  test('в карточке видно, что демо-данные легли в её схему', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)
    await page.locator('tbody tr', { hasText: CODE2 }).first().click()
    const card = page.locator('.modal', { hasText: `Показ ${TAG}` }).first()
    await expect(card).toBeVisible()
    // Читаем именно число, а не ищем подстроку: «не содержит ноль» — негодная
    // проверка, под неё не подходит 40, но подходит 45. И подпись сверяем целиком:
    // «Продаж» иначе совпадает и с «Последняя продажа».
    const value = async (label) => {
      const cards = card.locator('.mini-card')
      for (let i = 0; i < (await cards.count()); i++) {
        const one = cards.nth(i)
        if ((await one.locator('.m-label').innerText()).trim() === label) {
          return Number((await one.locator('.m-value').innerText()).replace(/\D/g, ''))
        }
      }
      return null
    }

    // Двадцать товаров и продажи за десять дней — иначе показывать клиенту нечего.
    // Счётчики приезжают отдельным запросом: за ними надо идти в схему самой аптеки,
    // и держать из-за них весь экран было бы неправильно. Поэтому дожидаемся.
    await expect
      .poll(() => value('Товаров'), { message: 'демо-товары не легли в схему', timeout: 30_000 })
      .toBe(20)
    await expect
      .poll(() => value('Продаж'), { message: 'демо-продаж нет — отчёты будут пустыми', timeout: 30_000 })
      .toBeGreaterThan(0)
  })

  test('срок работы кассы без связи задаётся в карточке аптеки', async ({ page }) => {
    await signIn(page, USER, PASS)
    await page.locator('tbody tr', { hasText: CODE2 }).first().click()
    const card = page.locator('.modal', { hasText: `Показ ${TAG}` }).first()
    await expect(card).toBeVisible()
    const row = card.locator('.kv', { hasText: 'Касса работает без связи' })
    await expect(row).toContainText('7 дн.')

    await card.getByRole('button', { name: /Изменить/ }).click()
    const form = page.locator('.modal', { hasText: 'Изменить аптеку' }).last()
    const days = form.getByTestId('offline-days')
    await expect(days).toHaveValue('7')
    // Негодное число сервер отвергает с объяснением, а не молча обрезает
    await days.fill('45')
    await form.getByRole('button', { name: /Сохранить/ }).click()
    await expect(page.locator('.toast.err')).toContainText('Дней без связи: не больше 30')
    await days.fill('14')
    const saved = page.waitForResponse((r) => r.url().includes('/admin/pharmacies/') && r.request().method() === 'PATCH')
    await form.getByRole('button', { name: /Сохранить/ }).click()
    expect((await saved).ok()).toBe(true)
    await expect(form).toBeHidden()
    await expect(row).toContainText('14 дн.')

    // И аптека получает это число: с ним её касса и будет считать срок без связи
    const owner = await page.request.post(`${API}/auth/login`, { data: { name: CODE2 + '-hoz', password: OWNER_PASS } })
    expect((await owner.json()).user.subscription.offlineDays).toBe(14)
  })

  test('вход под владельцем виден крупно и возврат к себе работает', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)
    await page.locator('tbody tr', { hasText: CODE2 }).first().click()
    const card = page.locator('.modal', { hasText: `Показ ${TAG}` }).first()
    await card.getByRole('button', { name: /Войти под владельцем/ }).click()

    const ask = page.locator('.modal', { hasText: 'Войти под владельцем аптеки?' })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: /^Войти$/ }).click()

    // Попали в чужую аптеку — и это видно постоянной полосой поверх всего
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
    const banner = page.locator('.conn-banner.support')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('чужую аптеку')
    await expect(page.locator('.topbar h1')).toBeVisible()

    // Возврат к себе — одним нажатием, без повторного ввода пароля
    await banner.getByRole('button', { name: /вернуться к себе/ }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Аптеки', { timeout: 30_000 })
    await expect(page.locator('.conn-banner.support')).toHaveCount(0)
  })
})

// Страховка: если проверка оборвалась на середине, схема не должна остаться
test.afterAll(async () => {
  if (!state.pharmacyId) return
  try {
    const login = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: USER, password: PASS }),
    })
    const { token } = await login.json()
    const list = await (await fetch(`${API}/admin/pharmacies`, { headers: { Authorization: `Bearer ${token}` } })).json()
    if (!list.some((p) => p.code === CODE)) return // уже убрано через интерфейс
    await fetch(`${API}/admin/pharmacies/${state.pharmacyId}?confirm=${CODE}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    console.log(`  уборка: аптека ${CODE} удалена — прогон не убрал её сам`)
  } catch (e) {
    console.log(`  ВНИМАНИЕ: не удалось убрать аптеку ${CODE} — ${e.message}`)
  }
})

// ── Сводка для владельца сервиса ──
// Числа, по которым он судит о своём деле. Ошибка здесь ничего не роняет: панель
// просто показывает не ту картину, и заметить это можно только пересчитав вручную.
// А вручную никто не пересчитывает.
test.describe('Аналитика в панели', () => {
  const CODE3 = TAG + '-a'
  const state3 = { id: null }

  test.afterAll(async ({ request }) => {
    if (!state3.id) return
    const res = await request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
    const { token } = await res.json()
    await request
      .delete(`${API}/admin/pharmacies/${state3.id}?confirm=${CODE3}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 180_000,
      })
      .catch(() => {})
  })

  test('сводка и график дохода показаны и не пусты', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)

    const cards = page.locator('.mini-cards').first()
    await expect(cards).toBeVisible({ timeout: 30_000 })
    // Каждое из этих чисел отвечает на отдельный вопрос владельца, и пропажа
    // любого означает, что сводка собралась не полностью
    for (const label of [
      'Доход за этот месяц',
      'Ожидается за 30 дней',
      'Доход за всё время',
      'Платят',
      'Пробный период',
      'Срок вышел',
      'Оплачены, но молчат',
    ]) {
      await expect(cards, `в сводке нет «${label}»`).toContainText(label)
    }

    // График подгружается отдельным куском — ждём именно его, а не просто заголовок
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible({ timeout: 40_000 })
    const bars = page.locator('.recharts-bar-rectangle')
    expect(await bars.count(), 'на графике нет столбиков за двенадцать месяцев').toBe(12)
  })


  test('новый клиент виден в сводке, а отметка о звонке сохраняется', async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page, USER, PASS)

    const cards = page.locator('.mini-cards').first()
    await expect(cards).toBeVisible({ timeout: 30_000 })
    // Ноль клиентов — совершенно законное состояние: у нового сервиса их и нет.
    // Прежде здесь стояло «больше нуля», и на пустой системе проверка падала,
    // хотя проверять она должна другое: что счётчик замечает нового клиента.
    const read = async () => {
      const m = (await cards.innerText()).match(/из\s+(\d+)\s+всего/)
      expect(m, 'в сводке не нашлось числа клиентов').toBeTruthy()
      return Number(m[1])
    }
    const totalBefore = await read()

    // Заводим клиента и убеждаемся, что сводка это заметила
    await page.getByRole('button', { name: /Завести аптеку/ }).click()
    const form = page.locator('.modal', { hasText: 'Новая аптека' })
    const field = (label) => form.locator('.field', { hasText: label }).locator('input').first()
    await field('Код аптеки').fill(CODE3)
    await field('Название').fill(`Аналитика ${TAG}`)
    await field('Пароль').fill('proverka-2026')
    await form.getByRole('button', { name: /^Завести$/ }).click()
    const done = page.locator('.modal', { hasText: 'Аптека заведена' })
    await expect(done).toBeVisible({ timeout: 180_000 })
    await done.getByRole('button', { name: /Записал/ }).click()

    await expect
      .poll(read, { message: 'сводка не заметила нового клиента', timeout: 30_000 })
      .toBe(totalBefore + 1)

    // Запоминаем, что убирать
    const res = await page.request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
    const { token } = await res.json()
    const list = await (await page.request.get(`${API}/admin/pharmacies`, { headers: { Authorization: `Bearer ${token}` } })).json()
    state3.id = list.find((p) => p.code === CODE3)?.id

    // ── Отметка о звонке ──
    await page.locator('tbody tr', { hasText: CODE3 }).first().click()
    const card = page.locator('.modal', { hasText: `Аналитика ${TAG}` }).first()
    await expect(card).toBeVisible()
    await expect(card, 'в карточке нет суммы, которую принёс клиент').toContainText('Принёс за всё время')

    await card.getByRole('button', { name: /Отметить звонок/ }).click()
    const ask = page.locator('.modal', { hasText: 'Отметить звонок' }).last()
    await expect(ask).toBeVisible()
    await ask.locator('input').first().fill('обещал в пятницу')
    await ask.getByRole('button', { name: /Записать/ }).click()
    await page.keyboard.press('Escape')

    // Отметка обязана быть видна прямо в строке — иначе о ней забудут
    const row = page.locator('tbody tr', { hasText: CODE3 }).first()
    await expect(row, 'отметка о звонке не видна в списке').toContainText('обещал в пятницу', { timeout: 30_000 })
  })
  // Идёт ПОСЛЕ проверки, которая заводит клиента: раньше она опиралась на то,
  // что в системе кто-то уже есть, и на пустой системе падала с «список клиентов
  // пуст». Проверка не должна зависеть от того, что осталось от прошлой работы.
  test('карточка сводки раскрывается списком, и из него виден клиент', async ({ page }) => {
    // Число говорит «двое не заплатили», но звонить надо людям. Без списка
    // владельцу пришлось бы искать их глазами по всей таблице.
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)
    const cards = page.locator('.mini-cards').first()
    await expect(cards).toBeVisible({ timeout: 30_000 })

    await cards.getByText('Доход за всё время').click()
    const modal = page.locator('.modal', { hasText: 'Сколько принёс каждый клиент' })
    await expect(modal).toBeVisible({ timeout: 15_000 })
    await expect(modal.locator('tbody tr').first(), 'список клиентов пуст').toBeVisible()

    // Щелчок по строке обязан открывать карточку клиента — увидел и сразу позвонил
    await modal.locator('tbody tr').first().click()
    await expect(page.locator('.modal', { hasText: 'Контакты' }).first()).toBeVisible({ timeout: 15_000 })
  })
})

// ── Панель на телефоне ──
//
// Владелец сервиса чаще смотрит панель с телефона, чем с компьютера: звонить
// клиентам он собирается прямо оттуда. А эта страница — единственная в системе
// без бокового меню, со своей разметкой, и общие правила для узких экранов её
// не спасали: заголовок налезал на кнопки, а таблица из шести колонок на 320
// пикселях не читалась вовсе.
//
// Проверяется не «красиво», а измеримое: ничего не вылезает за край экрана и
// страницу не приходится листать вбок. Именно это и ломается, когда кто-нибудь
// добавит в таблицу колонку или в шапку кнопку.
test.describe('Панель на узком экране', () => {
  // Диапазон взят по живым телефонам: 320 — самый узкий из встречающихся,
  // 425 — граница, после которой места хватает и так
  const ШИРИНЫ = [320, 360, 390, 425]

  // Возвращает всё, что вылезло за правый край или ушло левее нуля
  const вылезло = (page) =>
    page.evaluate(() => {
      const de = document.documentElement
      const bad = []
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect()
        if (b.width === 0 || b.height === 0) continue
        if (b.right > de.clientWidth + 1 || b.left < -1) {
          bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
        }
      }
      return { вбок: Math.max(0, de.scrollWidth - de.clientWidth), элементы: [...new Set(bad)] }
    })

  test('на телефоне ничего не вылезает за край и страница не листается вбок', async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width: 390, height: 780 })
    await signIn(page, USER, PASS)
    await expect(page.locator('.admin-app')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.mini-cards').first()).toBeVisible({ timeout: 30_000 })

    for (const w of ШИРИНЫ) {
      await page.setViewportSize({ width: w, height: 780 })
      await page.waitForTimeout(500)

      const экран = await вылезло(page)
      expect(экран.элементы, `${w}px: за край вылезает ${экран.элементы.join(', ')}`).toEqual([])
      expect(экран.вбок, `${w}px: страница листается вбок на ${экран.вбок}px`).toBe(0)

      // Карточка аптеки — самое плотное окно панели, и оно рисуется порталом
      // в <body>, куда правила страницы не достают. Проверяем отдельно.
      await page.locator('tbody tr').first().click()
      await expect(page.locator('.modal').first()).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(600)
      const окно = await вылезло(page)
      expect(окно.элементы, `${w}px, карточка аптеки: вылезает ${окно.элементы.join(', ')}`).toEqual([])
      expect(окно.вбок, `${w}px, карточка аптеки: листается вбок на ${окно.вбок}px`).toBe(0)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
  })

  test('таблица аптек на телефоне становится карточками с подписями', async ({ page }) => {
    // Без подписей значения были бы безымянными: заголовок таблицы на узком
    // экране не показывается, и «26.08.2026» ничего бы не значило
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 360, height: 780 })
    await signIn(page, USER, PASS)
    const row = page.locator('tbody tr').first()
    await expect(row).toBeVisible({ timeout: 30_000 })

    await expect(page.locator('thead').first(), 'заголовок таблицы занимает место зря').toBeHidden()
    const подпись = await row.locator('td').nth(3).evaluate((td) =>
      getComputedStyle(td, '::before').content,
    )
    expect(подпись, 'у ячейки нет подписи — значение осталось безымянным').toContain('Оплачено до')
  })
})

// ── Тема и язык панели ──
//
// Хранились в одном месте с аптечными. Владелец, посмотрев аптеку в том же
// браузере, получал в панели её тему — а сменить её из панели было нечем.
test.describe('Настройки панели', () => {
  test('тема и язык панели не связаны с аптечными', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, USER, PASS)
    await expect(page.locator('.admin-app')).toBeVisible({ timeout: 30_000 })

    // Аптека этого браузера «выбрала» тёмную и таджикский
    await page.evaluate(() => {
      localStorage.setItem('apteka_theme', 'dark')
      localStorage.setItem('apteka_lang', 'tg')
    })
    await page.reload()
    await expect(page.locator('.admin-app')).toBeVisible({ timeout: 30_000 })

    const тема = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(await тема(), 'панель унаследовала аптечную тему').toBe('light')
    await expect(page.locator('.topbar h1'), 'панель унаследовала аптечный язык').toHaveText('Аптеки')

    // Меняем в панели — аптечная настройка должна остаться нетронутой
    await page.getByTitle('Настройки панели').click()
    const modal = page.locator('.modal', { hasText: 'Настройки панели' })
    await expect(modal).toBeVisible()
    await modal.getByRole('button', { name: 'Тёмная' }).click()
    await expect.poll(тема, { message: 'тема панели не переключилась' }).toBe('dark')
    await modal.getByRole('button', { name: 'Тоҷикӣ' }).click()
    await expect(page.locator('.topbar h1'), 'язык панели не переключился').toHaveText('Дорухонаҳо')

    const чужое = await page.evaluate(() => ({
      тема: localStorage.getItem('apteka_theme'),
      язык: localStorage.getItem('apteka_lang'),
    }))
    expect(чужое, 'панель переписала аптечную настройку').toEqual({ тема: 'dark', язык: 'tg' })

    // Возвращаем панели русский и светлую, чтобы следующие проверки шли с чистого.
    // Окно ищем заново и без опоры на заголовок: он уже по-таджикски
    const окно = page.locator('.modal').first()
    await окно.getByRole('button', { name: 'Русский' }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Аптеки')
    await окно.getByRole('button', { name: 'Светлая' }).click()
    await expect
      .poll(тема, { message: 'панель не вернулась к светлой теме' })
      .toBe('light')
  })
})
