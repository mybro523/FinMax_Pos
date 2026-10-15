// ── Правила содержимого не должны ломать саму программу ──
// Строгие правила — лучшая защита от внедрения чужого кода и самый простой способ
// получить белый экран. Браузер не бросает ошибку на видном месте: он молча
// отказывается загружать то, что не разрешено, и на экране пропадает часть работы.
//
// Опаснее всего сканер камеры: он подгружается отдельным куском и создаёт рабочий
// поток через blob — ровно то, что строгие правила обычно запрещают. Через обычные
// проверки это не всплывает: их сценарии до камеры не доходят.
//
// Здесь каждая жалоба браузера на правила считается провалом.
//
// Запуск:  APP_USER=<логин магазина> APP_PASS=<пароль> npx playwright test e2e-ui/csp.spec.mjs
import { test, expect } from '@playwright/test'

const USER = process.env.APP_USER || 'admin'
const PASS = process.env.APP_PASS || 'admin'

// Ловим всё, на что жалуется браузер: и нарушения правил, и упавший код
function watch(page) {
  const complaints = []
  page.on('console', (m) => {
    const text = m.text()
    if (/Content Security Policy|Refused to|violates the following/i.test(text)) complaints.push(text)
  })
  page.on('pageerror', (e) => complaints.push('ошибка на странице: ' + e.message))
  return complaints
}

async function signIn(page, complaints) {
  await page.goto('/')
  const card = page.locator('.login-card')
  if (await card.isVisible().catch(() => false)) {
    await page.locator('#lg-name').fill(USER)
    await page.locator('#lg-pw').fill(PASS)
    await page.getByRole('button', { name: /Войти/ }).click()
  }
  await expect(page.locator('.sidebar')).toBeVisible()
  expect(complaints, 'браузер пожаловался уже на входе').toEqual([])
}

test('страницы магазины открываются без жалоб браузера', async ({ page }) => {
  test.setTimeout(180_000)
  const complaints = watch(page)
  await signIn(page, complaints)

  // Отчёты тянут за собой отдельный кусок с графиками — их тоже надо проверить
  for (const label of ['Касса', 'Товары', 'Приход товара', 'Срок годности', 'Смена кассы', 'Отчёты', 'Настройки']) {
    await page.locator('.sidebar').getByRole('link', { name: label, exact: false }).first().click()
    await expect(page.locator('.topbar h1')).toBeVisible()
    expect(complaints, `на странице «${label}» браузер пожаловался: ${complaints.join(' | ')}`).toEqual([])
  }
})

test('сканер камеры подгружается и не упирается в правила содержимого', async ({ page, context }) => {
  test.setTimeout(120_000)
  // Разрешение на камеру: без него запуск сорвётся не из-за правил, а из-за отказа
  // в доступе, и проверка ничего не покажет
  await context.grantPermissions(['camera'])
  const complaints = watch(page)
  await signIn(page, complaints)

  await page.locator('.sidebar').getByRole('link', { name: /Касса/ }).first().click()
  await page.getByRole('button', { name: /Камера/ }).click()

  // Ждём, пока подгрузится отдельный кусок распознавания: пока он грузится,
  // на экране надпись про запуск камеры
  await expect(page.locator('.overlay')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(4000)

  // Сама камера в проверочном браузере не работает, и это нормально: важно, что
  // код сканера загрузился и не был отвергнут правилами
  const blocked = complaints.filter((c) => /Content Security Policy|Refused to/i.test(c))
  expect(blocked, `правила содержимого не пускают сканер: ${blocked.join(' | ')}`).toEqual([])
})

test('страница знакомится с сервером заранее', async ({ page }) => {
  // Пока браузер качает и разбирает код, соединения с сервером ещё нет, и первый
  // запрос платит за всё сразу: найти адрес, установить связь, договориться о
  // шифровании. Из Душанбе это около трети секунды при ответе в сто миллисекунд.
  //
  // Строчка вставляется при сборке: адрес сервера известен только тогда. Если
  // переменная на хостинге потеряется, строчки просто не будет — и заметить это
  // можно только здесь.
  await page.goto('/')
  const html = await page.content()
  const links = await page.locator('link[rel="preconnect"]').evaluateAll((ls) => ls.map((l) => l.href))
  const api = links.find((h) => /railway|api/i.test(h))
  expect(api, `нет заблаговременного знакомства с сервером: ${links.join(', ')}`).toBeTruthy()
  expect(html).toContain('preconnect')
})

test('заголовки безопасности реально отдаются сайтом', async ({ page }) => {
  const res = await page.goto('/')
  const h = res.headers()
  expect(h['x-content-type-options'], 'нет запрета угадывать тип содержимого').toBe('nosniff')
  expect(h['x-frame-options'], 'страницу можно вложить в рамку на чужом сайте').toBe('DENY')
  expect(h['strict-transport-security'], 'нет требования защищённого соединения').toBeTruthy()

  const csp = h['content-security-policy'] || ''
  expect(csp, 'нет правил содержимого').toBeTruthy()
  // Три главных запрета: чужие скрипты, рамка и вставка через object
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("object-src 'none'")
  expect(csp, 'разрешены любые встроенные скрипты — правила почти бесполезны').not.toContain("script-src 'self' 'unsafe-inline'")
})
