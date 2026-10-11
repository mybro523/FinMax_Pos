// ── Отказы проверки полей должны быть на языке программы ──
// Проверка входных данных отвечает своими текстами, и они английские. Это уходило
// прямо на экран кассиру: «password must be longer than or equal to 6 characters»
// в программе, которая целиком на русском и таджикском.
//
// Перевод сделан по формулам, а не по списку полей: иначе первое же новое поле
// снова заговорило бы по-английски. Здесь и проверяется, что формулы разобраны.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')

const { ruValidation, ruValidationList } = require('../dist/common/validation-ru')

const latin = /[A-Za-z]{4,}/ // осталось английское слово

test('сообщения проверки переводятся, а поля называются по-человечески', () => {
  const cases = [
    ['password must be longer than or equal to 6 characters', /Пароль.*не короче 6/],
    ['newPassword must be longer than or equal to 6 characters', /Новый пароль/],
    ['months must not be greater than 60', /Число месяцев.*не больше 60/],
    ['amount must not be less than 0.01', /Сумма.*не меньше 0\.01/],
    ['qty must be an integer number', /Количество.*целое/],
    ['name should not be empty', /Название.*пуст/],
    ['items must contain at least 1 elements', /Позиции/],
    ['expiryDate must be a valid ISO 8601 date string', /Срок годности.*дат/],
  ]
  for (const [en, ru] of cases) {
    const out = ruValidation(en)
    assert.match(out, ru, `не переведено: ${en} → ${out}`)
    assert.doesNotMatch(out, latin, `в переводе осталось английское слово: ${out}`)
  }
})

test('незнакомое сообщение возвращается как есть, а не теряется', () => {
  // Показать английский текст неприятно, но потерять смысл отказа — хуже
  assert.equal(ruValidation('нечто совершенно новое'), 'нечто совершенно новое')
  assert.equal(ruValidation(''), '')
})

test('список сообщений переводится целиком', () => {
  const out = ruValidationList([
    'password must be longer than or equal to 6 characters',
    'name should not be empty',
  ])
  assert.equal(out.length, 2)
  for (const m of out) assert.doesNotMatch(m, latin, `не переведено: ${m}`)
})

test('поле без перевода показывается своим именем, а не пропадает', () => {
  const out = ruValidation('sovsemNovoePole must be a string')
  assert.match(out, /sovsemNovoePole/, 'имя поля потеряно — понять, что исправлять, нельзя')
  assert.match(out, /текст/, 'сама формула не переведена')
})
