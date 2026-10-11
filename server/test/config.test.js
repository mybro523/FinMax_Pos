// Тесты проверки настроек перед запуском. Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { configProblems, assertSecureConfig, ConfigError, DEV_SECRET } = require('../dist/common/config')

const GOOD = 'LzYWQDeljex41vT2QJ05i5dFyxiFemsOfSDJiw38B99L'
const DB = 'postgresql://user:pw@host:5432/apteka'
const env = (over = {}) => ({ AUTH_SECRET: GOOD, DATABASE_URL: DB, ...over })

// Логгер-заглушка: молча собирает предупреждения
const quietLog = () => {
  const warns = []
  return { warns, log: () => {}, warn: (m) => warns.push(m) }
}

test('нормальные настройки не вызывают нареканий', () => {
  assert.deepEqual(configProblems(env()), [])
})

test('ключ подписи не задан — это проблема', () => {
  const p = configProblems(env({ AUTH_SECRET: undefined }))
  assert.equal(p.length, 1)
  assert.match(p[0], /AUTH_SECRET не задан/)
  assert.match(p[0], /подделать/, 'объясняем последствие, а не просто «не задан»')
})

test('пустая строка и пробелы считаются как «не задан»', () => {
  assert.match(configProblems(env({ AUTH_SECRET: '' }))[0], /не задан/)
  assert.match(configProblems(env({ AUTH_SECRET: '   ' }))[0], /не задан/)
})

test('ключ из репозитория распознаётся', () => {
  const p = configProblems(env({ AUTH_SECRET: DEV_SECRET }))
  assert.match(p[0], /по умолчанию/)
})

test('короткий ключ не годится', () => {
  const p = configProblems(env({ AUTH_SECRET: 'apteka123' }))
  assert.match(p[0], /слишком короткий/)
})

test('база данных обязательна', () => {
  const p = configProblems(env({ DATABASE_URL: undefined }))
  assert.match(p[0], /DATABASE_URL/)
})

test('проблем может быть несколько сразу', () => {
  assert.equal(configProblems({}).length, 2)
})

test('на сервере небезопасные настройки останавливают запуск', () => {
  process.env.NODE_ENV = 'production'
  try {
    assert.throws(
      () => assertSecureConfig(quietLog(), env({ AUTH_SECRET: undefined })),
      (e) => {
        assert.ok(e instanceof ConfigError, 'должна быть именно ошибка настроек')
        assert.match(e.message, /Сервер не запущен/)
        assert.match(e.message, /randomBytes/, 'в сообщении есть готовая команда для ключа')
        return true
      },
    )
  } finally {
    delete process.env.NODE_ENV
  }
})

test('на сервере правильные настройки запуску не мешают', () => {
  process.env.NODE_ENV = 'production'
  try {
    assert.doesNotThrow(() => assertSecureConfig(quietLog(), env()))
  } finally {
    delete process.env.NODE_ENV
  }
})

test('в разработке предупреждаем, но работать не мешаем', () => {
  const log = quietLog()
  assert.doesNotThrow(() => assertSecureConfig(log, env({ AUTH_SECRET: DEV_SECRET })))
  assert.equal(log.warns.length, 1)
  assert.match(log.warns[0], /Небезопасные настройки/)
})
