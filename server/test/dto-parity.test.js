// ── Паритет полей «создание» и «правка» ──
//
// Сервер отбрасывает неизвестные поля запроса МОЛЧА (whitelist в ValidationPipe).
// Если поле добавили в создание и забыли в правку, получается худший вид ошибки:
// «Товар обновлён» — а фото тихо пропало. Ровно так и случилось с фото товара.
//
// Этот тест закрывает весь класс таких ошибок: каждое поле создания обязано
// приниматься и правкой — кроме явно перечисленных исключений, у каждого из
// которых есть причина. Новое поле, забытое в Update-классе, валит тест.
//
// Запуск: npm test (в папке server)
require('reflect-metadata') // декораторы DTO (@Type) требуют его до загрузки классов
const test = require('node:test')
const assert = require('node:assert/strict')
const { getMetadataStorage } = require('class-validator')

const products = require('../dist/products/dto')
const categories = require('../dist/categories/dto')
const suppliers = require('../dist/suppliers/dto')
const expenses = require('../dist/expenses/dto')
const roles = require('../dist/roles/dto')
const users = require('../dist/users/dto')
const admin = require('../dist/admin/dto')
const arrivals = require('../dist/arrivals/dto')

const fieldsOf = (cls) =>
  [...new Set(getMetadataStorage().getTargetValidationMetadatas(cls, null, false, false).map((m) => m.propertyName))]

// только_при_создании: поля, которые правка НЕ принимает намеренно, с причиной
const PAIRS = [
  { name: 'товар', create: products.CreateProductDto, update: products.UpdateProductDto, только_при_создании: {} },
  { name: 'категория', create: categories.CreateCategoryDto, update: categories.UpdateCategoryDto, только_при_создании: {} },
  { name: 'роль', create: roles.CreateRoleDto, update: roles.UpdateRoleDto, только_при_создании: {} },
  {
    name: 'поставщик',
    create: suppliers.CreateSupplierDto,
    update: suppliers.UpdateSupplierDto,
    только_при_создании: { openingDebt: 'начальный долг вводится один раз; дальше долг меняют приходы и оплаты' },
  },
  {
    name: 'расход',
    create: expenses.CreateExpenseDto,
    update: expenses.UpdateExpenseDto,
    только_при_создании: {
      fromCash: 'деньги смены правкой не трогаются — иначе пересчёт закрытых смен',
      shiftId: 'смена расхода назначается при создании',
      clientId: 'ключ от задвоения нужен только при создании',
    },
  },
  {
    name: 'сотрудник',
    create: users.CreateUserDto,
    update: users.UpdateUserDto,
    только_при_создании: { role: 'старое поле первой версии; правка назначает роль через roleId' },
  },
  {
    name: 'аптека (панель)',
    create: admin.CreatePharmacyDto,
    update: admin.UpdatePharmacyDto,
    только_при_создании: {
      code: 'код аптеки — это имя её схемы в базе, после создания не меняется',
      trialDays: 'пробный срок задаётся при создании; дальше — продлениями',
      ownerLogin: 'учётка владельца заводится один раз',
      ownerPassword: 'учётка владельца заводится один раз',
      demo: 'демо-наполнение только при создании',
    },
  },
  {
    name: 'приход',
    create: arrivals.CreateArrivalDto,
    update: arrivals.UpdateArrivalDto,
    только_при_создании: {
      payMethod: 'чем заплатили — выбирается при приходе и в правке показывается как есть',
      paidCash: 'оплата из кассы уже записана в смену — правкой её не переиграть',
      shiftId: 'смена оплаты назначается при создании',
    },
  },
]

test('каждое поле создания принимается и правкой (кроме объяснённых исключений)', () => {
  for (const p of PAIRS) {
    const create = fieldsOf(p.create)
    const update = new Set(fieldsOf(p.update))
    const allowed = new Set(Object.keys(p.только_при_создании))
    const потеряны = create.filter((f) => !update.has(f) && !allowed.has(f))
    assert.deepEqual(
      потеряны,
      [],
      `${p.name}: правка молча выбросит поля ${потеряны.join(', ')} — добавьте их в Update-класс или в исключения с причиной`,
    )
    // исключение, которое вдруг появилось в правке, — устаревшая запись: уберите её
    const лишние = [...allowed].filter((f) => update.has(f))
    assert.deepEqual(лишние, [], `${p.name}: исключения уже есть в правке — ${лишние.join(', ')}`)
  }
})

test('фото товара принимается правкой — тот самый случай', () => {
  assert.ok(fieldsOf(products.UpdateProductDto).includes('image'), 'image пропал из UpdateProductDto')
})
