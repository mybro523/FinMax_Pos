import js from '@eslint/js'
import globals from 'globals'

// ── Проверка кода программы ──
// Те же цели, что и в client/: ловить то, что ломает работу (обращение к тому,
// чего нет, опечатку в имени), а не спорить об оформлении. Основная часть программы
// живёт в Node, поэтому и глобальные объекты здесь его, а не браузера.

export default [
  { ignores: ['node_modules/**', 'renderer/**', 'release/**', 'test-results/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // Пустой catch — намеренный приём: нет файла, нет прав, нет связи. Работе не мешает
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unsafe-optional-chaining': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
    },
  },
  {
    // Мост окна написан в старом стиле (require) — в песочнице иначе нельзя
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // Сквозные проверки управляют окном программы: внутри page.evaluate код
    // выполняется на странице, поэтому браузерные объекты ему доступны
    files: ['e2e/**/*.mjs', 'playwright.config.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
