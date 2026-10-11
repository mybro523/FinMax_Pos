import { defineConfig, devices } from '@playwright/test'

// ── Проверка интерфейса в настоящем браузере ──
// Тесты в test/ проверяют расчёты, e2e/ в корне — сервер через его API. Здесь
// проверяется то, что видит и нажимает человек: кассир у стойки и владелец,
// смотрящий отчёты. Ровно те ошибки, которые не ловятся ни расчётами, ни API, —
// вроде «кнопка есть, но по ней ничего не происходит».
//
// По умолчанию проверяется работающая система. Другой адрес: APP_URL=…
//
// Запуск:  npm run test:ui

const APP = process.env.APP_URL || 'https://saas-apteka.vercel.app'

export default defineConfig({
  testDir: './e2e-ui',
  testMatch: '**/*.spec.mjs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Один за другим: сценарии работают на общей базе аптеки и мешали бы друг другу
  workers: 1,
  fullyParallel: false,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: APP,
    // ── Приветствие новой аптеки ──
    // Каждый прогон входит в чистом браузере, как новый клиент, и получал окно
    // «Добро пожаловать», которое перекрывает экран и ломает первое же нажатие.
    // Проверкам касс и склада оно не нужно — они считаются «уже видевшими».
    // Сам первый вход стережёт e2e-ui/obuchenie.spec.mjs, сбрасывая это обратно.
    storageState: {
      cookies: [],
      origins: [{ origin: new URL(APP).origin, localStorage: [{ name: 'apteka_obuchenie_videl', value: '1' }] }],
    },
    locale: 'ru-RU',
    timezoneId: 'Asia/Dushanbe',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'Кассовый компьютер', use: { ...devices['Desktop Chrome'] } },
  ],
})
