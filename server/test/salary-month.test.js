// ── Зарплата частями: месяц выдачи ──
//
// Зарплату выдают частями, и «сколько осталось» считается по месяцу, за который
// выдача. Месяц приходит строкой «ГГГГ-ММ»; всё остальное — понятный отказ, а не
// молча записанная ерунда, по которой остаток потом не сойдётся.
//
// Запуск: npm test (в папке server)
require('reflect-metadata')
const test = require('node:test')
const assert = require('node:assert/strict')
const { validate } = require('class-validator')
const { plainToInstance } = require('class-transformer')
const { CreateExpenseDto, UpdateExpenseDto } = require('../dist/expenses/dto')
const { CreateUserDto, UpdateUserDto } = require('../dist/users/dto')

const base = { category: 'Зарплата', amount: 1800, employeeId: 'u1' }
const errorsOf = async (cls, body) => validate(plainToInstance(cls, body))

test('месяц зарплаты: «ГГГГ-ММ» или пусто', async () => {
  for (const ok of ['2026-10', '2026-01', '2026-12', '']) {
    assert.equal((await errorsOf(CreateExpenseDto, { ...base, salaryMonth: ok })).length, 0, ok)
  }
  // Не прислан вовсе — тоже можно: старые программы его не знают
  assert.equal((await errorsOf(CreateExpenseDto, base)).length, 0)
})

test('непонятный месяц — отказ по-русски, и при создании, и при правке', async () => {
  for (const bad of ['2026-13', '2026-00', '10.2026', 'октябрь', '2026-1', '2026-10-01']) {
    const errs = await errorsOf(CreateExpenseDto, { ...base, salaryMonth: bad })
    assert.equal(errs.length, 1, bad)
    assert.match(Object.values(errs[0].constraints).join(' '), /ГГГГ-ММ/)
  }
  // Правка принимает то же поле и проверяет так же — иначе сервер молча выбросил бы его
  assert.equal((await errorsOf(UpdateExpenseDto, { salaryMonth: '2026-10' })).length, 0)
  assert.equal((await errorsOf(UpdateExpenseDto, { salaryMonth: '2026-13' })).length, 1)
})

test('дни бонуса: «ГГГГ-ММ-ДД» или пусто, и при создании, и при правке', async () => {
  const ok = await errorsOf(CreateExpenseDto, { ...base, salaryMonth: '2026-10', bonusFrom: '2026-10-10', bonusTo: '2026-11-09' })
  assert.equal(ok.length, 0)
  assert.equal((await errorsOf(CreateExpenseDto, { ...base, bonusFrom: '', bonusTo: '' })).length, 0)
  for (const bad of ['10.10.2026', '2026-10-32', '2026-13-01', '2026-10-1', 'вчера']) {
    const errs = await errorsOf(CreateExpenseDto, { ...base, bonusFrom: bad, bonusTo: '2026-11-09' })
    assert.equal(errs.length, 1, bad)
    assert.match(Object.values(errs[0].constraints).join(' '), /ГГГГ-ММ-ДД/)
  }
  assert.equal((await errorsOf(UpdateExpenseDto, { bonusTo: '2026-11-09' })).length, 0)
  assert.equal((await errorsOf(UpdateExpenseDto, { bonusTo: '09.11.2026' })).length, 1)
})

test('с какого числа месяц зарплаты: целое от 1 до 28', async () => {
  const user = { name: 'kassa2', password: 'secret12' }
  for (const ok of [1, 10, 28]) assert.equal((await errorsOf(CreateUserDto, { ...user, salaryDay: ok })).length, 0, String(ok))
  for (const bad of [0, 29, 31, 10.5, '10']) assert.equal((await errorsOf(CreateUserDto, { ...user, salaryDay: bad })).length, 1, String(bad))
  assert.equal((await errorsOf(UpdateUserDto, { salaryDay: 15 })).length, 0)
  assert.equal((await errorsOf(UpdateUserDto, { salaryDay: 29 })).length, 1)
})
