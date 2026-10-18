// ── Отчёт ОПУ: формулы прибылей и убытков ──
//
// Чистый доход в ОПУ — кассовый: валовой доход минус расходы минус деньги,
// отданные поставщикам. Главные ловушки, которые здесь прибиты:
//   • оплата прихода «из кассы» лежит и в записи оплаты, и в самом приходе —
//     посчитать её дважды нельзя;
//   • расходы раскладываются по статьям по названию без регистра;
//   • «Касса» — только наличные: продажи налом и погашения долгов минус
//     возвраты наличными.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { opuFinance, opuSheet, OPU_ZARPLATA, OPU_NALOGI, OPU_MAGAZIN } from '../src/lib/opu.js'

const from = new Date('2026-01-01T00:00:00Z')
const to = new Date('2026-02-01T00:00:00Z')
const D = '2026-01-10T10:00:00Z' // дата внутри периода
const OUT = '2025-12-20T10:00:00Z' // дата вне периода

const sale = (total, cost, profit, payment = 'cash') => ({ date: D, items: [], total, cost, profit, payment })

test('ОПУ: продажа, себестоимость и валовой доход из общего расчёта', () => {
  const d = opuFinance({ sales: [sale(1000, 600, 400), sale(500, 300, 200, 'card')], from, to })
  assert.equal(d.prodazha, 1500)
  assert.equal(d.sebestoimost, 900)
  assert.equal(d.valovoy, 600)
  assert.equal(d.chistiy, 600) // расходов и оплат нет
  assert.equal(d.kassa, 1000) // наличными была только первая продажа
})

test('ОПУ: расходы раскладываются по статьям, регистр не важен', () => {
  const e = (category, amount) => ({ date: D, category, amount })
  const d = opuFinance({
    sales: [sale(1000, 600, 400)],
    expenses: [e('зарплата', 100), e(OPU_NALOGI, 50), e(OPU_MAGAZIN, 30), e('Реклама', 20), e(OPU_ZARPLATA, 40), { date: OUT, category: OPU_ZARPLATA, amount: 999 }],
    from,
    to,
  })
  assert.equal(d.zarplata, 140)
  assert.equal(d.nalogi, 50)
  assert.equal(d.magazin, 30)
  assert.equal(d.other, 20)
  assert.equal(d.allExpenses, 240)
  assert.equal(d.chistiy, 400 - 240)
})

test('ОПУ: оплата поставщику без двойного счёта', () => {
  // Приход «из кассы» на 200: запись оплаты с clientId=id+':pay' уже есть.
  // Приход «картой» на 300: записи нет — берётся оплаченная часть из прихода.
  // Приход «в долг» на 500 с долгом 450 и оплатой 50 из кассы: тоже уже записан.
  // Погашение старого долга поставщику на 70 — отдельная запись оплаты.
  const d = opuFinance({
    sales: [sale(1000, 600, 400)],
    arrivals: [
      { id: 'a1', date: D, total: 200, debt: 0, payMethod: 'cash' },
      { id: 'a2', date: D, total: 300, debt: 0, payMethod: 'card' },
      { id: 'a3', date: D, total: 500, debt: 450, payMethod: 'debt' },
      { id: 'old', date: OUT, total: 400, debt: 0, payMethod: 'own' },
    ],
    supplierPayments: [
      { clientId: 'a1:pay', amount: 200, date: D },
      { clientId: 'a3:pay', amount: 50, date: D },
      { amount: 70, date: D, note: 'Погашение' },
      { amount: 999, date: OUT },
    ],
    from,
    to,
  })
  // 200 (a1, запись) + 300 (a2, из прихода) + 50 (a3, запись) + 70 (погашение)
  assert.equal(d.supplierPaid, 620)
  assert.equal(d.chistiy, 400 - 620)
})

test('ОПУ: касса — наличные с погашениями долгов и без возвратов налом', () => {
  const d = opuFinance({
    sales: [sale(1000, 600, 400), sale(300, 200, 100, 'card')],
    debtPayments: [{ createdAt: D, amount: 120 }, { createdAt: OUT, amount: 999 }],
    returns: [{ date: D, total: 80, refund: 'cash', items: [] }, { date: D, total: 60, refund: 'card', items: [] }],
    from,
    to,
  })
  assert.equal(d.kassa, 1000 + 120 - 80)
  // возвраты уменьшили и продажу
  assert.equal(d.prodazha, 1300 - 140)
})

test('ОПУ: старый приход без способа оплаты — оплаченная сразу часть идёт поставщику', () => {
  const d = opuFinance({
    sales: [sale(1000, 600, 400)],
    arrivals: [{ id: 'leg', date: D, total: 400, debt: 150, payMethod: '' }],
    from,
    to,
  })
  assert.equal(d.supplierPaid, 250)
})

// ── Лист «Отчёт о прибылях и убытках» для печати ──
// Бумага не должна спорить с экраном: на листе — те же суммы, что в расчёте ОПУ, и
// каждая строка экрана на своём месте

test('лист для печати: все строки таблицы ОПУ и касса, в порядке экрана, с теми же суммами', () => {
  const e = (category, amount) => ({ date: D, category, amount })
  const d = opuFinance({
    sales: [sale(1000, 600, 400), sale(500, 300, 200, 'card')],
    expenses: [e(OPU_MAGAZIN, 30), e(OPU_NALOGI, 50), e(OPU_ZARPLATA, 100), e('Реклама', 20)],
    incomes: [{ date: D, amount: 70, category: 'Аренда' }],
    supplierPayments: [{ date: D, amount: 200 }],
    debtPayments: [{ createdAt: D, amount: 40 }],
    from,
    to,
  })
  const rows = opuSheet(d)
  const value = (label) => rows.find((r) => r.label === label)?.value
  assert.deepEqual(
    rows.filter((r) => r.kind !== 'gap' && r.kind !== 'section').map((r) => r.label),
    ['Продажа', 'Себестоимость', 'Валовой доход', 'Прочие доходы', 'Оплата поставщику', 'Расход магазина', 'Налоги', 'Зарплата', 'Другие расходы', 'Все расходы', 'Чистый доход', 'Касса'],
  )
  assert.equal(value('Продажа'), d.prodazha)
  assert.equal(value('Себестоимость'), d.sebestoimost)
  assert.equal(value('Валовой доход'), d.valovoy)
  assert.equal(value('Прочие доходы'), 70)
  assert.equal(value('Оплата поставщику'), 200)
  assert.equal(value('Все расходы'), 200)
  assert.equal(value('Чистый доход'), d.chistiy)
  assert.equal(value('Касса'), 1000 + 40)
  // Разделы: доходы, затем расходы; внизу — чистый доход и касса крупно
  assert.deepEqual(rows.filter((r) => r.kind === 'section').map((r) => r.label), ['Доходы', 'Расходы'])
  assert.deepEqual(rows.filter((r) => r.kind === 'final').map((r) => r.label), ['Чистый доход', 'Касса'])
})

test('лист для печати: у каждой подписи есть перевод на таджикский', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'i18n.js'), 'utf8')
  const start = src.indexOf('const TG = {')
  const block = src.slice(start, src.indexOf('\n}', start))
  const keys = new Set([...block.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]))
  const missing = opuSheet(opuFinance({ from, to })).filter((r) => r.label && !keys.has(r.label)).map((r) => r.label)
  assert.deepEqual(missing, [])
})
