// ── Страховка от забытых оповещений ──
// Каждое решение владельца сервиса должно доходить до магазина и до самой панели
// в тот же миг. Забыть строчку рассылки легко и совершенно незаметно: запрос
// проходит, в базе всё правильно, ошибок нет. Просто на чужом экране остаётся
// прежнее — до перезагрузки страницы, то есть иногда до завтра.
//
// Проверяем не поведение, а сам код: читаем исходник панели и смотрим, что
// в каждом действии есть рассылка. Через обычные проверки такое не всплывает —
// они смотрят ответ сервера, а не чужой экран.
//
// Запуск: npm test (в папке server).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// На Windows строки в файлах заканчиваются возвратом каретки, и поиск по концу
// метода не находил бы ничего — проверка молча проходила бы мимо всего
const SRC = fs
  .readFileSync(path.join(__dirname, '..', 'src', 'admin', 'pharmacies.service.ts'), 'utf8')
  .split(String.fromCharCode(13))
  .join('')

// Тело метода: от `async имя(` до строки, где закрывающая скобка стоит в начале
// с тем же отступом, что и объявление
function methodBody(name) {
  const at = SRC.search(new RegExp('^  (?:async )?' + name + '[(]', 'm'))
  assert.notEqual(at, -1, `метод ${name}() пропал из панели — проверка устарела`)
  const end = SRC.indexOf('\n  }\n', at)
  assert.notEqual(end, -1, `не нашёл конец метода ${name}()`)
  return SRC.slice(at, end)
}

test('панель узнаёт о каждом изменении списка магазинов', () => {
  // Владелец сервиса держит панель открытой весь день. Что бы ни случилось —
  // с другого устройства, от другого сотрудника, — список обязан обновиться сам.
  for (const m of ['create', 'extend', 'setBlocked', 'update', 'remove']) {
    assert.match(methodBody(m), /this\.events\.toService\('pharmacies'/, `${m}(): панель не узнает об изменении`)
  }
})

test('продление доходит до кассы клиента', () => {
  // Клиент заплатил, ему продлили — а у него всё ещё висит предупреждение
  // и не работает продажа. Он позвонит второй раз, и будет прав.
  assert.match(methodBody('extend'), /this\.events\.subscriptionChanged\(/, 'магазин не узнает о продлении')
})

test('исправленный вручную срок оплаты тоже доходит до кассы', () => {
  assert.match(methodBody('update'), /this\.events\.subscriptionChanged\(/, 'магазин не узнает о новом сроке')
})

test('приостановка и возобновление доходят до кассы', () => {
  const body = methodBody('setBlocked')
  assert.match(body, /this\.events\.suspendPharmacy\(/, 'магазин отключают молча')
  assert.match(body, /this\.events\.subscriptionChanged\(/, 'магазин не узнает, что работу вернули')
})

test('перед удалением магазину говорят, что происходит', () => {
  // Схемы сейчас не станет, и все её соединения оборвутся. Без объяснения это
  // выглядит как поломка программы, а не как решение поставщика.
  const body = methodBody('remove')
  assert.match(body, /this\.events\.suspendPharmacy\(/, 'магазин удаляют молча')

  // И именно ДО того, как рвать подключение к базе: после — говорить уже некому
  const say = body.indexOf('suspendPharmacy')
  const drop = body.indexOf('this.pool.close')
  assert.ok(say < drop, 'прощаемся уже после обрыва — сообщение никто не получит')
})
