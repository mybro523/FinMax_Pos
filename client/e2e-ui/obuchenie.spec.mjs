// ── Туры по программе, настоящим браузером ──
//
// Тур подсвечивает живые кнопки страницы, поэтому проверять его можно только
// в браузере: расчётами не увидеть, что рамка стоит мимо кнопки, карточка уехала
// за край экрана, а форма, открытая туром, так и осталась висеть.
//
// Все остальные проверки входят «уже видевшими» общий тур — иначе он перекрывал
// бы экран и ломал каждое нажатие. Первый вход здесь проверяется в чистом браузере,
// ровно как у настоящего нового клиента.
//
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npx playwright test e2e-ui/obuchenie.spec.mjs
import { test, expect } from '@playwright/test'

const USER = process.env.APP_USER || 'admin'
const PASS = process.env.APP_PASS || 'admin'
const API = process.env.API_URL || 'https://saasapteka-production.up.railway.app/api'

async function signIn(page) {
  await page.goto('/')
  await page.locator('#lg-name').fill(USER)
  await page.locator('#lg-pw').fill(PASS)
  await page.getByRole('button', { name: /Войти/ }).click()
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
}

const card = (page) => page.locator('.tur-card')

// «3 / 14» → [3, 14]
async function счётчик(page) {
  const txt = await card(page).locator('.tur-count').innerText()
  const [a, b] = txt.split('/').map((x) => Number(x.trim()))
  return [a, b]
}

// Карточка и рамка обязаны быть на экране. Рамка может быть больше экрана (меню,
// длинная таблица) — тогда достаточно, чтобы она его пересекала
async function наЭкране(page, где) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const c = document.querySelector('.tur-card')?.getBoundingClientRect()
    const s = document.querySelector('.tur-spot')?.getBoundingClientRect()
    return {
      карточка: c ? c.left >= -1 && c.top >= -1 && c.right <= vw + 1 && c.bottom <= vh + 1 : false,
      рамка: s ? s.right > 0 && s.bottom > 0 && s.left < vw && s.top < vh : null,
      нетЭлемента: !!document.querySelector('.tur-missing'),
    }
  })
  expect(r.карточка, `${где}: карточка тура вылезла за край экрана`).toBe(true)
  if (r.рамка !== null) expect(r.рамка, `${где}: рамка подсвечивает место за пределами экрана`).toBe(true)
  return r
}

async function пройтиДоКонца(page, где) {
  await expect(card(page)).toBeVisible({ timeout: 30_000 })
  const [, всего] = await счётчик(page)
  for (let i = 1; i <= всего; i++) {
    await expect(card(page).locator('.tur-count')).toHaveText(`${i} / ${всего}`, { timeout: 15_000 })
    // Шаг ищет свой элемент до полутора секунд — даём ему найтись, прежде чем мерить
    await page.waitForTimeout(250)
    await наЭкране(page, `${где}, шаг ${i}`)
    const кнопка = card(page).locator('.tur-foot .btn').last()
    await кнопка.click()
  }
  await expect(page.locator('.tur-root'), `${где}: тур не закрылся после «Готово»`).toHaveCount(0, { timeout: 15_000 })
}

test.describe('Первый вход', () => {
  // Сбрасываем то, что настройки прогона кладут всем остальным проверкам
  test.use({ storageState: { cookies: [], origins: [] } })

  test('новая аптека сразу получает общий тур, и после «Пропустить» он не повторяется', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page)

    await expect(card(page), 'новому клиенту не показали общий тур').toBeVisible({ timeout: 20_000 })
    await expect(card(page)).toContainText('Как устроена система')
    const [первый, всего] = await счётчик(page)
    expect(первый).toBe(1)
    expect(всего, 'общий тур должен быть коротким').toBeLessThanOrEqual(16)

    await card(page).getByRole('button', { name: 'Пропустить' }).click()
    await expect(page.locator('.tur-root')).toHaveCount(0)

    // Закрыл — больше само не выскакивает: напоминать тому, кто уже решил, — раздражать
    await page.reload()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.waitForTimeout(2500)
    await expect(page.locator('.tur-root'), 'общий тур выскочил снова после «Пропустить»').toHaveCount(0)
    await expect(page.locator('.sidebar').getByRole('link', { name: /Обучение/ })).toBeVisible()
  })

  test('общий тур проходится до конца, рамка и карточка всегда на экране', async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    await пройтиДоКонца(page, 'общий тур')
  })

  test('клавиши: → вперёд, ← назад, Esc закрывает, и по странице ничего не набирается', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page)
    await expect(card(page)).toBeVisible({ timeout: 20_000 })

    await page.keyboard.press('ArrowRight')
    await expect(card(page).locator('.tur-count')).toHaveText(/^2 \//)
    await page.keyboard.press('ArrowLeft')
    await expect(card(page).locator('.tur-count')).toHaveText(/^1 \//)

    // Буквы, набранные во время тура, не должны уйти в поле сканера кассы
    await page.keyboard.type('абв')
    await page.keyboard.press('Escape')
    await expect(page.locator('.tur-root')).toHaveCount(0)
    const scan = page.locator('.scan-input')
    if (await scan.count()) expect(await scan.inputValue(), 'буквы из тура попали в сканер').toBe('')
  })
})

test.describe('Туры разделов', () => {
  test('тур каждого раздела проходится целиком и ничего не сохраняет', async ({ page, request }) => {
    test.setTimeout(900_000)

    // Сколько товаров и приходов было до туров: тур открывает формы, но не сохраняет их
    const вход = await request.post(`${API}/auth/login`, { data: { name: USER, password: PASS } })
    const h = { Authorization: `Bearer ${(await вход.json()).token}` }
    const сколько = async () => ({
      товаров: (await (await request.get(`${API}/products`, { headers: h })).json()).length,
      приходов: (await (await request.get(`${API}/arrivals`, { headers: h })).json()).length,
    })
    const до = await сколько()

    await signIn(page)
    const разделы = await page
      .locator('.sidebar a[data-tour^="nav:"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('data-tour').slice(4)).filter((to) => to !== '/obuchenie'))
    expect(разделы.length, 'в меню подозрительно мало разделов').toBeGreaterThan(8)

    for (const to of разделы) {
      await page.goto(to)
      const кнопка = page.locator('[data-tour="topbar.help"]')
      await expect(кнопка, `в разделе ${to} нет кнопки тура`).toBeVisible({ timeout: 30_000 })
      await кнопка.click()
      await пройтиДоКонца(page, `тур ${to}`)
      // Форма, открытая туром, обязана закрыться вместе с ним
      await expect(page.locator('.overlay'), `после тура ${to} осталось открытое окно`).toHaveCount(0)
    }

    const после = await сколько()
    expect(после, 'тур что-то сохранил в базу').toEqual(до)
  })

  test('тур по товарам сам открывает форму и объясняет её поля', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page)
    await page.goto('/products')
    await page.locator('[data-tour="topbar.help"]').click()
    await expect(card(page)).toBeVisible()

    // Листаем до шага про название товара — он живёт внутри формы
    for (let i = 0; i < 30; i++) {
      if ((await card(page).locator('h3').innerText()) === 'Название') break
      await card(page).locator('.tur-foot .btn').last().click()
      await page.waitForTimeout(200)
    }
    await expect(card(page).locator('h3')).toHaveText('Название')
    await expect(page.locator('.modal'), 'тур не открыл форму товара').toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.tur-spot'), 'поле формы не подсвечено').toBeVisible()

    // Закрыли тур посреди формы — форма закрывается вместе с ним
    await page.keyboard.press('Escape')
    await expect(page.locator('.tur-root')).toHaveCount(0)
    await expect(page.locator('.overlay'), 'форма, открытая туром, осталась висеть').toHaveCount(0)
  })

  test('при переходе к шагу без элемента рамка не остаётся на прошлой кнопке', async ({ page }) => {
    // Живой проверкой поймано: пока тур ищет элемент, которого нет (до полутора
    // секунд), рамка стояла на кнопке прошлого шага, а карточка уже говорила про
    // новую. Человек смотрел не туда. Касса с пустой корзиной — ровно этот случай:
    // после «Корзины» идёт шаг про строки корзины, а строк нет
    test.setTimeout(120_000)
    await signIn(page)
    await page.goto('/pos')
    await page.locator('[data-tour="topbar.help"]').click()
    await expect(card(page)).toBeVisible()
    for (let i = 0; i < 10; i++) {
      if ((await card(page).locator('h3').innerText()) === 'Корзина') break
      await card(page).locator('.tur-foot .btn').last().click()
      await page.waitForTimeout(250)
    }
    await expect(card(page).locator('h3')).toHaveText('Корзина')
    await expect(page.locator('.tur-spot'), 'корзина должна быть подсвечена').toBeVisible()

    await card(page).locator('.tur-foot .btn').last().click()
    // Рамка обязана уйти сразу, а не через полторы секунды поиска
    await expect(page.locator('.tur-spot'), 'рамка осталась на прошлой кнопке').toHaveCount(0, { timeout: 400 })
    await expect(card(page).locator('.tur-missing')).toBeVisible({ timeout: 5_000 })
    await page.keyboard.press('Escape')
  })

  test('тур на таджикском показывает таджикский текст', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page)
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Тоҷикӣ' }).click()
    await page.goto('/pos')
    await page.locator('[data-tour="topbar.help"]').click()
    await expect(card(page)).toBeVisible()
    await card(page).locator('.tur-foot .btn').last().click()
    const текст = await card(page).locator('.tur-body').innerText()
    expect(текст, 'тур на таджикском показал русский текст').toMatch(/[ӣӯҳқҷғ]/)
    await page.keyboard.press('Escape')
    // Возвращаем русский, чтобы следующие проверки шли с чистого
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Русский' }).click()
  })
})

test.describe('Телефон', () => {
  // Самый узкий из встречающихся телефонов, и в чистом браузере — общий тур стартует сам
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true, storageState: { cookies: [], origins: [] } })

  test('на узком экране кнопки тура помещаются в карточку', async ({ page }) => {
    // Живой проверкой поймано: на 360 пикселях «Дальше» вылезал за край карточки
    test.setTimeout(120_000)
    await page.goto('/')
    await page.locator('#lg-name').fill(USER)
    await page.locator('#lg-pw').fill(PASS)
    await page.getByRole('button', { name: /Войти/ }).click()
    await expect(card(page)).toBeVisible({ timeout: 60_000 })

    for (let i = 0; i < 4; i++) {
      const r = await page.evaluate(() => {
        const c = document.querySelector('.tur-card').getBoundingClientRect()
        const вылезли = [...document.querySelectorAll('.tur-foot .btn')]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.left < c.left - 1 || b.right > c.right + 1).length
        return { вылезли, вКарточке: c.left >= 0 && c.right <= innerWidth + 1 }
      })
      expect(r.вылезли, `шаг ${i + 1}: кнопки тура вылезли за карточку`).toBe(0)
      expect(r.вКарточке, `шаг ${i + 1}: карточка вылезла за экран`).toBe(true)
      await card(page).locator('.tur-foot .btn').last().click()
      await page.waitForTimeout(400)
    }
  })
})

test.describe('Тур по кассе на телефоне', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true })

  // На телефоне касса показывает либо чек, либо каталог, а карточка тура закрывает
  // нижнюю половину экрана. Живой проверкой поймано два провала разом: тур
  // рассказывал про каталог, пока на экране был чек, а итог и кнопку оплаты —
  // последние элементы страницы — подсвечивал прямо под собственной карточкой.
  test('тур сам переключает чек и каталог, а подсвеченное не прячется под карточкой', async ({ page }) => {
    test.setTimeout(240_000)
    await signIn(page)
    await page.goto('/pos')
    await expect(page.locator('.scan-input')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-tour="topbar.help"]').click()
    await expect(card(page)).toBeVisible()
    const [, всего] = await счётчик(page)

    const было = []
    for (let i = 1; i <= всего; i++) {
      await expect(card(page).locator('.tur-count')).toHaveText(`${i} / ${всего}`, { timeout: 15_000 })
      // Шаг ищет свой элемент и прокручивает страницу — даём ему закончить
      await page.waitForTimeout(700)
      const шаг = await page.evaluate(() => {
        const c = document.querySelector('.tur-card').getBoundingClientRect()
        const s = document.querySelector('.tur-spot')?.getBoundingClientRect()
        return {
          title: document.querySelector('.tur-body h3').innerText,
          // Над карточкой видно хотя бы сорок пикселей подсвеченного элемента
          видно: s ? s.top < c.top - 40 && s.bottom > 0 : null,
          каталог: !!document.querySelector('.kassa.pane-catalog'),
        }
      })
      было.push(шаг.title)
      if (шаг.видно !== null) expect(шаг.видно, `шаг «${шаг.title}»: подсвеченное место скрыто карточкой тура`).toBe(true)
      if (шаг.title === 'Каталог товаров' || шаг.title === 'Категории') {
        expect(шаг.каталог, `шаг «${шаг.title}» идёт, а на экране чек`).toBe(true)
      }
      if (шаг.title === 'Корзина' || шаг.title === 'Итого') {
        expect(шаг.каталог, `шаг «${шаг.title}» идёт, а на экране каталог`).toBe(false)
      }
      await card(page).locator('.tur-foot .btn').last().click()
    }
    await expect(page.locator('.tur-root')).toHaveCount(0, { timeout: 15_000 })

    // Переключатель объясняют там, где он есть, а клавиши — там, где есть клавиатура
    expect(было, 'на телефоне не объяснили переключатель «Чек | Каталог»').toContain('Переключатель «Чек | Каталог»')
    expect(было, 'на телефоне рассказали про клавиши, которых там нет').not.toContain('Клавиши')
    // После тура касса снова показывает чек, а запас внизу страницы убран
    await expect(page.locator('.kassa.pane-check')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.classList.contains('tur-uzko'))).toBe(false)
  })
})

test.describe('Тур по кассе на большом экране', () => {
  test('про клавиши рассказывают, а про переключатель, которого нет, — нет', async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    await page.goto('/pos')
    await expect(page.locator('.scan-input')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-tour="topbar.help"]').click()
    await expect(card(page)).toBeVisible()
    const [, всего] = await счётчик(page)
    const было = []
    for (let i = 1; i <= всего; i++) {
      await expect(card(page).locator('.tur-count')).toHaveText(`${i} / ${всего}`, { timeout: 15_000 })
      было.push(await card(page).locator('h3').innerText())
      await card(page).locator('.tur-foot .btn').last().click()
    }
    await expect(page.locator('.tur-root')).toHaveCount(0, { timeout: 15_000 })
    expect(было).toContain('Клавиши')
    expect(было).toContain('Получено и сдача')
    expect(было).toContain('Отложенные чеки')
    expect(было, 'на большом экране рассказали про переключатель, которого там нет').not.toContain('Переключатель «Чек | Каталог»')
  })
})
