// ── Режим разработки: программа смотрит на живой сервер интерфейса ──
//
// «npm run electron:dev» поднимает сервер интерфейса и открывает программу, которая
// берёт страницу с него, а не из сборки. Этим пользуется тот, кто правит интерфейс.
// Проверяем сам путь: окно открывает страницу с сервера разработки, мост на месте,
// запрос к серверу проходит — и при этом в остальной интернет окну по-прежнему нельзя.
//
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { CLIENT, clientBin } from '../scripts/env.mjs'
import { goTo, launchApp, PASS, signIn, USER } from './app.mjs'

const DEV_URL = 'http://127.0.0.1:5181'
const vite = clientBin('vite', 'bin', 'vite.js')

test.skip(!existsSync(vite), 'сборщик интерфейса не установлен — выполните «npm install» в папке client')

let ui = null
let app = null
let page = null

test.beforeAll(async () => {
  expect(USER && PASS, 'нужны APP_USER и APP_PASS').toBeTruthy()
  ui = spawn(process.execPath, [vite, '--mode', 'desktop'], { cwd: CLIENT, stdio: 'ignore' })
  let up = false
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(DEV_URL)).ok
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  expect(up, 'сервер интерфейса не поднялся').toBe(true)
  ;({ app, page } = await launchApp({ env: { APTEKA_DEV_URL: DEV_URL } }))
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  if (ui && ui.exitCode === null) ui.kill()
})

test('окно открывает страницу с сервера разработки, мост работает', async () => {
  test.setTimeout(180_000)
  await expect(page.locator('.login-card')).toBeVisible({ timeout: 90_000 })
  expect(page.url().startsWith(DEV_URL)).toBe(true)
  await signIn(page)
  // Раздел и здесь пишется после решётки: сборка и разработка ведут себя одинаково
  await goTo(page, 'Касса')
  expect(page.url()).toBe(DEV_URL + '/#/pos')
  expect(await page.evaluate(() => localStorage.getItem('apteka_token'))).toBe('desktop')
})

test('и в разработке окну открыт только сервер интерфейса, а не весь интернет', async () => {
  const net = await page.evaluate(() => fetch('https://example.com/').then(() => 'прошёл', () => 'закрыто'))
  expect(net).toBe('закрыто')
})
