import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import hooks from 'eslint-plugin-react-hooks'

// ── Проверка кода перед сборкой ──
// Сборщик не ругается на переменную, которой нет: в браузере это обычное обращение
// к глобальному объекту. Поэтому опечатка в импорте доживает до прода и падает
// прямо под рукой у кассира — так «Выгрузить заявку» молча ничего не делала,
// потому что забыли внести serverNow в список импортов.
//
// Правила намеренно строгие только там, где ошибка ломает работу, и мягкие
// в вопросах оформления: цель — ловить баги, а не спорить о кавычках.

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': hooks },
    settings: { react: { version: 'detect' } },
    rules: {
      // Главное правило: обращение к тому, чего нет
      'no-undef': 'error',
      // Неиспользуемое — предупреждение: мешает читать, но работу не ломает.
      // Аргументы и «пойманные» ошибки не считаем: catch (e) {} — нормальный приём.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      // Хуки React: неверный порядок вызовов ломает состояние экрана
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // JSX-разметка
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      'react/jsx-key': 'error',
      'react/no-unescaped-entities': 'off',
      // Пустой catch — намеренный приём проекта: приватный режим браузера, нет
      // доступа к хранилищу, звук не завёлся. Работе это не мешает, падать незачем.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Сканеры штрихкодов присылают служебные символы (GS/FNC1), и разбор кода
      // обязан их искать — см. lib/scan.js
      'no-control-regex': 'off',
      // Частые опечатки, которые тихо ничего не делают
      'no-unsafe-optional-chaining': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
    },
  },
  {
    // Тесты и их настройка живут в Node: там свои глобальные объекты.
    // Браузерные проверки — тоже: сам сценарий исполняется в Node и управляет
    // браузером снаружи, поэтому process и прочее ему доступны.
    files: ['test/**/*.js', 'e2e-ui/**/*.mjs', 'playwright.config.mjs'],
    // Браузерные глобальные нужны для page.evaluate: код внутри неё выполняется
    // не здесь, а на странице, но лежит в этом же файле
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
