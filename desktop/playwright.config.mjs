import { defineConfig } from '@playwright/test'

// ── Проверка программы целиком ──
// Обычные тесты (test/) проверяют части по отдельности. Здесь запускается сама
// программа — настоящее окно, настоящая основная часть, настоящий сервер — и
// проверяется то, что видит человек: вход, касса, чек, выход.
//
// Перед запуском интерфейс должен быть собран:  npm run electron:build -- --dir
// Запуск:  APP_USER=<логин владельца аптеки> APP_PASS=<пароль> npm run test:app
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Программа одна на компьютер (вторую копию она сама не запускает) — по очереди
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
})
