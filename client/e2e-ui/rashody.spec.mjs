// ── Расходы аптеки ──
// Владелец вносит аренду и зарплату, берёт деньги на такси из ящика кассы — и хочет
// видеть в отчётах, сколько аптека заработала на самом деле. Здесь проходится то же,
// что делает он: внести расход, поправить, удалить; взять деньги из кассы и закрыть
// смену; завести свою статью; посмотреть чистую прибыль. В конце — то же с телефона.
import { test, expect } from '@playwright/test'
import { login, goTo, withServer, tag, moneyValue } from './helpers.mjs'

const TAG = tag()

test.describe.configure({ mode: 'serial' })

const metric = (page, label) => page.locator('.cards .metric').filter({ has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) })
const metricValue = async (page, label) => moneyValue(await metric(page, label).locator('.value').innerText())
const historyRow = (page, text) => page.locator('[data-tour="exp.history"] tbody tr', { hasText: text })

// Заполнить форму «Новый расход» и нажать «Добавить расход»
async function addExpense(page, { category, amount, note, fromCash = false }) {
  await page.locator('#expCategory').selectOption({ label: category })
  await page.locator('#expAmount').fill(String(amount))
  await page.locator('#expNote').fill(note)
  if (fromCash) await page.getByLabel('Оплачен из кассы').check()
  await withServer(page, '/expenses', () => page.getByRole('button', { name: 'Добавить расход' }).click())
  await expect(page.locator('.toast').last()).toContainText('Расход добавлен')
  await expect(historyRow(page, note)).toBeVisible()
}

async function removeExpense(page, note) {
  const row = historyRow(page, note)
  await row.getByRole('button', { name: 'Удалить' }).click()
  const dialog = page.locator('.overlay .modal', { hasText: 'Удалить расход?' })
  await withServer(page, '/expenses/', () => dialog.getByRole('button', { name: 'Удалить', exact: true }).click(), 'DELETE')
  await expect(row).toHaveCount(0)
}

// Расходы приходят с сервера не мгновенно: в чистом браузере ячейки отчёта сначала
// показывают ноль. Прочитанное в этот миг «до» испортило бы сравнение — в аптеке, где
// расходы за сегодня уже есть, разница вышла бы больше внесённого. Поэтому запоминаем,
// что список расходов дошёл, и читаем числа, только когда они перестали меняться
function watchExpenses(page) {
  page.expensesLoaded = new Promise((resolve) => {
    page.on('response', (r) => {
      if (r.request().method() === 'GET' && /\/expenses\?/.test(r.url()) && r.ok()) resolve()
    })
  })
}

// Отчёты за сегодня: расходы, прибыль и чистая прибыль
async function todayNumbers(page) {
  await goTo(page, 'Отчёты')
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
  await expect(metric(page, 'Чистая прибыль')).toBeVisible()
  await page.expensesLoaded
  const read = async () => ({
    expenses: await metricValue(page, 'Расходы'),
    profit: await metricValue(page, 'Прибыль'),
    net: await metricValue(page, 'Чистая прибыль'),
  })
  let prev = await read()
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400)
    const next = await read()
    if (JSON.stringify(next) === JSON.stringify(prev)) return next
    prev = next
  }
  return prev
}

test('расход вносится, виден в истории и уменьшает чистую прибыль в отчётах', async ({ page }) => {
  watchExpenses(page)
  await login(page)
  const before = await todayNumbers(page)
  expect(Math.abs(before.profit - before.expenses - before.net), 'чистая прибыль = прибыль − расходы').toBeLessThan(0.02)

  await goTo(page, 'Расходы')
  await expect(page.locator('.topbar h1')).toHaveText('Расходы')
  // Готовые статьи есть сразу, без настройки
  for (const name of ['Аренда', 'Зарплата', 'Коммунальные услуги', 'Налоги', 'Транспорт', 'Реклама', 'Хозяйственные нужды', 'Другое']) {
    await expect(page.locator('#expCategory option', { hasText: name })).toHaveCount(1)
  }

  // Без статьи и без суммы расход не записывается — и объясняется почему
  await page.getByRole('button', { name: 'Добавить расход' }).click()
  await expect(page.locator('.toast').last()).toContainText('Выберите статью расхода')
  await page.locator('#expCategory').selectOption({ label: 'Аренда' })
  await page.getByRole('button', { name: 'Добавить расход' }).click()
  await expect(page.locator('.toast').last()).toContainText('Укажите сумму расхода')

  const note = TAG + ' аренда'
  await addExpense(page, { category: 'Аренда', amount: '123.45', note })
  const row = historyRow(page, note)
  await expect(row).toContainText('Аренда')
  await expect(row).toContainText('123,45')
  // Поля суммы и примечания очищены — следующий расход не уйдёт с прежней суммой
  await expect(page.locator('#expAmount')).toHaveValue('')
  await expect(page.locator('#expNote')).toHaveValue('')

  const after = await todayNumbers(page)
  expect(after.expenses - before.expenses).toBeCloseTo(123.45, 2)
  expect(before.net - after.net).toBeCloseTo(123.45, 2)
  expect(after.profit, 'прибыль на товаре расходы не трогают').toBeCloseTo(before.profit, 2)

  // Разбивка по статьям — по нажатию на «Расходы»
  await metric(page, 'Расходы').click()
  const modal = page.locator('.modal', { hasText: 'Всего расходов' })
  await expect(modal.locator('.total-row', { hasText: 'Аренда' })).toBeVisible()
  await modal.getByRole('link', { name: 'Открыть раздел' }).click()
  await expect(page.locator('.topbar h1')).toHaveText('Расходы')

  // Поправили сумму — история и отчёты идут следом
  await historyRow(page, note).getByRole('button', { name: 'Изменить' }).click()
  const edit = page.locator('.modal', { hasText: 'Изменить расход' })
  await edit.locator('#expEditAmount').fill('100')
  await withServer(page, '/expenses/', () => edit.getByRole('button', { name: 'Сохранить', exact: true }).click(), 'PATCH')
  await expect(edit).toBeHidden()
  await expect(historyRow(page, note)).toContainText('100 сомони')
  expect((await todayNumbers(page)).expenses - before.expenses).toBeCloseTo(100, 2)

  // Удалили — расход ушёл и из истории, и из отчётов
  await goTo(page, 'Расходы')
  await removeExpense(page, note)
  const back = await todayNumbers(page)
  expect(back.expenses).toBeCloseTo(before.expenses, 2)
  expect(back.net).toBeCloseTo(before.net, 2)
})

test('расход из кассы уменьшает наличные в смене, а после её закрытия больше не меняется', async ({ page }) => {
  await login(page)
  await goTo(page, 'Смена кассы')
  // Смена могла остаться открытой от прежней работы — тогда берём её
  const openBox = page.locator('[data-tour="shift.open"]')
  const expectedCard = page.locator('[data-tour="shift.expected"]')
  await expect(openBox.or(expectedCard).first()).toBeVisible()
  // Пока смены не загрузились, страница рисует форму открытия — даём данным дойти
  await expectedCard.waitFor({ timeout: 4000 }).catch(() => {})
  if (await openBox.isVisible()) {
    await page.locator('#openCash').fill('100')
    await withServer(page, '/shifts/open', () => openBox.getByRole('button', { name: 'Открыть смену' }).click())
  }
  await expect(expectedCard).toBeVisible()
  const expectedBefore = moneyValue(await expectedCard.locator('.value').innerText())

  await goTo(page, 'Расходы')
  const note = TAG + ' такси'
  // Отметка «из кассы» доступна: смена открыта
  await expect(page.getByLabel('Оплачен из кассы')).toBeEnabled()
  await page.getByLabel('Оплачен из кассы').check()
  // Дата такого расхода — сегодня, её не выбирают
  await expect(page.locator('#expDate')).toBeDisabled()
  await addExpense(page, { category: 'Транспорт', amount: '40', note })
  await expect(historyRow(page, note)).toContainText('из кассы')
  // Отметка снята — следующий расход случайно из кассы не уйдёт
  await expect(page.getByLabel('Оплачен из кассы')).not.toBeChecked()

  await goTo(page, 'Смена кассы')
  await expect(page.locator('[data-tour="shift.expenses"]')).toBeVisible()
  await expect.poll(async () => moneyValue(await expectedCard.locator('.value').innerText())).toBeCloseTo(expectedBefore - 40, 2)

  // Закрываем смену с той суммой, что ждёт программа, — расхождения нет
  await page.getByRole('button', { name: 'Закрыть смену' }).first().click()
  const dialog = page.locator('.overlay .modal', { hasText: 'Закрытие смены' })
  await expect(dialog).toContainText('расходы и оплаты поставщикам из кассы')
  await withServer(page, '/shifts/close', () => dialog.getByRole('button', { name: 'Закрыть смену' }).click())
  const z = page.locator('.modal', { hasText: 'Z-отчёт смены' })
  await expect(z.locator('.total-row', { hasText: 'Расходы из кассы' })).toBeVisible()
  await expect(z.locator('.note.info')).toBeHidden({ timeout: 20000 })
  const diff = moneyValue(await z.locator('.total-row.big', { hasText: 'Расхождение' }).locator('span').last().innerText())
  expect(Math.abs(diff), 'смена сошлась: расход из кассы учтён').toBeLessThan(0.02)
  await z.getByRole('button', { name: 'Готово' }).click()

  // Расход вошёл в отчёт закрытой смены: править и удалять его больше нельзя
  await goTo(page, 'Расходы')
  const row = historyRow(page, note)
  await expect(row).toContainText('в отчёте смены')
  await expect(row.getByRole('button', { name: 'Изменить' })).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Удалить' })).toHaveCount(0)
  // Смены нет — отметка «из кассы» недоступна, и сказано, что делать
  await expect(page.getByLabel('Оплачен из кассы')).toBeDisabled()
  await expect(page.locator('[data-tour="exp.cash"]')).toContainText('Нет открытой смены')
  await expect(page.locator('[data-tour="exp.cash"]').getByRole('link', { name: 'Откройте смену' })).toBeVisible()
})

test('своя статья расходов добавляется в настройках и остаётся в прежних расходах, когда её убрали', async ({ page }) => {
  const article = TAG + ' Охрана'
  const note = TAG + ' сторож'
  await login(page)
  await goTo(page, 'Настройки')
  const panel = page.locator('[data-tour="set.expcats"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('tbody tr', { hasText: 'Аренда' })).toBeVisible()

  await panel.locator('#expCatName').fill(article)
  await withServer(page, '/expense-categories', () => panel.getByRole('button', { name: 'Добавить' }).click())
  await expect(panel.locator('tbody tr', { hasText: article })).toBeVisible()
  // Вторая с тем же названием не заводится
  await panel.locator('#expCatName').fill(article.toUpperCase())
  await panel.getByRole('button', { name: 'Добавить' }).click()
  await expect(page.locator('.toast').last()).toContainText('Такая статья расходов уже есть')

  await goTo(page, 'Расходы')
  await addExpense(page, { category: article, amount: '55', note })

  await goTo(page, 'Настройки')
  await panel.locator('tbody tr', { hasText: article }).getByRole('button').click()
  const dialog = page.locator('.overlay .modal', { hasText: 'Убрать статью расходов?' })
  await withServer(page, '/expense-categories/', () => dialog.getByRole('button', { name: 'Убрать', exact: true }).click(), 'DELETE')
  await expect(panel.locator('tbody tr', { hasText: article })).toHaveCount(0)

  // В списке для новых расходов статьи нет, а прежний расход хранит её название
  await goTo(page, 'Расходы')
  await expect(page.locator('#expCategory option', { hasText: article })).toHaveCount(0)
  await expect(historyRow(page, note)).toContainText(article)
  // И править такой расход можно: статья у него остаётся своей
  await historyRow(page, note).getByRole('button', { name: 'Изменить' }).click()
  const edit = page.locator('.modal', { hasText: 'Изменить расход' })
  await expect(edit.locator('#expEditCategory')).toHaveValue(article)
  await edit.locator('#expEditAmount').fill('60')
  await withServer(page, '/expenses/', () => edit.getByRole('button', { name: 'Сохранить', exact: true }).click(), 'PATCH')
  await expect(historyRow(page, note)).toContainText('60 сомони')

  await removeExpense(page, note)
})

test('на телефоне: раздел открывается из меню, расход вносится, страница не шире экрана', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 })
  await login(page)
  await page.locator('.burger').click()
  await page.locator('.sidebar').getByRole('link', { name: 'Расходы' }).click()
  await expect(page.locator('.topbar h1')).toHaveText('Расходы')
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  expect(await fits(), 'страница расходов не должна быть шире экрана телефона').toBe(true)

  const note = TAG + ' с телефона'
  await addExpense(page, { category: 'Налоги', amount: '7.5', note })
  await expect(historyRow(page, note)).toContainText('7,5')
  expect(await fits()).toBe(true)

  // Правка открывается листом снизу и помещается на экране
  await historyRow(page, note).getByRole('button', { name: 'Изменить' }).click()
  const edit = page.locator('.modal', { hasText: 'Изменить расход' })
  await expect(edit.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport()
  await edit.getByRole('button', { name: 'Отмена' }).click()
  await removeExpense(page, note)

  // Отчёты на телефоне: обе новые цифры на месте, страница не раздвинута
  await page.locator('.burger').click()
  await page.locator('.sidebar').getByRole('link', { name: 'Отчёты' }).click()
  await expect(metric(page, 'Чистая прибыль')).toBeVisible()
  await expect(metric(page, 'Расходы')).toBeVisible()
  expect(await fits(), 'отчёты с новыми цифрами не должны быть шире экрана').toBe(true)
})

test('на таджикском раздел расходов переведён целиком', async ({ page }) => {
  await login(page)
  await goTo(page, 'Настройки')
  await page.locator('[data-tour="set.lang"]').getByRole('button', { name: 'Тоҷикӣ' }).click()
  try {
    await page.locator('.sidebar').getByRole('link', { name: 'Хароҷот' }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Хароҷот')
    await expect(page.getByRole('button', { name: 'Илова кардани хароҷот' })).toBeVisible()
    await expect(page.locator('#expCategory option', { hasText: 'Иҷора' })).toHaveCount(1)
    await expect(page.getByLabel('Аз касса пардохт шуд')).toBeVisible()
    // Русских слов раздела на экране не осталось
    const text = await page.locator('.content').innerText()
    for (const ru of ['Новый расход', 'Статья расхода', 'История расходов', 'Оплачен из кассы', 'Добавить расход']) {
      expect(text.includes(ru), `на таджикском экране осталось «${ru}»`).toBe(false)
    }
  } finally {
    await page.locator('.sidebar').getByRole('link', { name: 'Танзимот' }).click()
    await page.locator('[data-tour="set.lang"]').getByRole('button', { name: 'Русский' }).click()
    await expect(page.locator('.topbar h1')).toHaveText('Настройки')
  }
})
