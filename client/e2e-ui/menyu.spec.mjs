// ── Меню слева не прыгает вверх после нажатия ──
// На невысоком экране меню длиннее окна и листается. Раньше после перехода в раздел
// оно оказывалось пролистанным в самый верх: нажал внизу «Сотрудники» — и пункт, по
// которому только что нажал, уехал за край. Листать меню приходилось после каждого
// нажатия. Здесь проверяется то, что видит человек: меню остаётся на месте, а пункт
// открытого раздела всегда на экране — и на компьютере, и на телефоне.
import { test, expect } from '@playwright/test'
import { login } from './helpers.mjs'

const menu = (page) => page.locator('.sidebar nav')
const item = (page, name) => page.locator('.sidebar').getByRole('link', { name, exact: false }).first()

// Где сейчас меню и виден ли в нём пункт открытого раздела
const look = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector('.sidebar nav')
    const active = nav.querySelector('a.active')
    const box = nav.getBoundingClientRect()
    const a = active?.getBoundingClientRect()
    return {
      top: Math.round(nav.scrollTop),
      max: Math.round(nav.scrollHeight - nav.clientHeight),
      active: active?.textContent?.trim() || '',
      // Пункт целиком внутри видимой части меню
      visible: !!a && a.top >= box.top - 1 && a.bottom <= box.bottom + 1,
    }
  })
const scrollMenu = (page, to) =>
  page.evaluate((y) => {
    const nav = document.querySelector('.sidebar nav')
    nav.scrollTop = y === 'bottom' ? nav.scrollHeight : y
  }, to)

test('после нажатия на нижний пункт меню остаётся на месте — и так при каждом переходе', async ({ page }) => {
  // Невысокое окно: меню не помещается и листается
  await page.setViewportSize({ width: 1280, height: 520 })
  await login(page)
  const start = await look(page)
  expect(start.max, 'меню должно быть длиннее окна, иначе проверять нечего').toBeGreaterThan(150)

  await scrollMenu(page, 'bottom')
  const before = await look(page)
  expect(before.top).toBe(before.max)

  await item(page, 'Сотрудники').click()
  await expect(page.locator('.topbar h1')).toHaveText('Сотрудники')
  const after = await look(page)
  expect(after.active).toContain('Сотрудники')
  expect(after.visible, 'пункт, по которому нажали, должен остаться на экране').toBe(true)
  expect(after.top, 'меню не должно уезжать наверх').toBe(before.top)

  // Следующий переход — то же самое: меню стоит, где стояло
  await item(page, 'Настройки').click()
  await expect(page.locator('.topbar h1')).toHaveText('Настройки')
  const next = await look(page)
  expect([next.top, next.visible, next.active.includes('Настройки')]).toEqual([before.top, true, true])

  // И наверху — тоже: нажали верхний пункт, меню вниз не уехало
  await scrollMenu(page, 0)
  await item(page, 'Касса').click()
  await expect(page.locator('.scan-input')).toBeVisible()
  const top = await look(page)
  expect([top.top, top.visible]).toEqual([0, true])
})

test('в раздел попали не из меню — меню само докручивается до его пункта', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 })
  await login(page)
  // По прямому адресу, как по закладке или после перезагрузки страницы
  await page.goto('/employees')
  await expect(page.locator('.topbar h1')).toHaveText('Сотрудники')
  const there = await look(page)
  expect(there.active).toContain('Сотрудники')
  expect(there.visible, 'пункт открытого раздела должен быть виден без прокрутки руками').toBe(true)
  expect(there.top).toBeGreaterThan(0)

  // Пролистали меню наверх и перешли кнопкой внутри страницы — пункт снова на экране
  await scrollMenu(page, 0)
  await page.goBack().catch(() => {})
  await page.goto('/settings')
  await expect(page.locator('.topbar h1')).toHaveText('Настройки')
  expect((await look(page)).visible).toBe(true)
})

test('на телефоне меню открывается там же, где его закрыли', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await login(page)
  await page.locator('.burger').click()
  await expect(page.locator('.sidebar.open')).toBeVisible()
  await scrollMenu(page, 'bottom')
  const before = await look(page)
  expect(before.max, 'на телефоне меню тоже длиннее экрана').toBeGreaterThan(100)

  await item(page, 'Сотрудники').click()
  await expect(page.locator('.topbar h1')).toHaveText('Сотрудники')
  await expect(page.locator('.sidebar.open')).toHaveCount(0)

  await page.locator('.burger').click()
  await expect(page.locator('.sidebar.open')).toBeVisible()
  const again = await look(page)
  expect(again.top, 'меню открылось пролистанным туда же').toBe(before.top)
  expect([again.visible, again.active.includes('Сотрудники')]).toEqual([true, true])
  // На экране нет горизонтальной прокрутки: меню не раздвинуло страницу
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await expect(menu(page)).toBeVisible()
})
