// ── У долгой операции должен быть свой срок ожидания ──
// Обычный запрос обрывается через пятнадцать секунд: если сервер молчит дольше,
// это не «медленно», а «не отвечает», и кассиру надо сказать об этом сразу.
//
// Но есть операции, которые честно идут дольше. Заведение магазина — это двадцать
// таблиц с индексами в новой схеме, пятнадцать секунд ровно на границе. Пересчёт
// склада на сервере имеет три минуты. Выгрузка и восстановление базы — минуты.
//
// Забыть про это легко, и ошибка получается худшего вида: она врёт. Владелец
// сервиса видел «Сервер не отвечает», а магазин к тому моменту уже создавался;
// повторное нажатие давало «магазин с таким кодом уже заведён». Сотрудник,
// считавший склад весь день, получил бы отказ вместо сохранения — при том, что
// сервер сохранил бы всё.
//
// Поэтому проверяем не поведение, а сам код: у каждого такого вызова обязан быть
// указан свой срок.
//
// Запуск: npm test (в папке client).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Операции, которые честно идут долго. Путь описан так, как он выглядит в коде.
const SLOW = [
  { method: 'post', path: "'/inventory'", why: 'лист пересчёта на весь склад — тысячи строк' },
  { method: 'patch', path: '`/inventory/${', why: 'сохранение пересчёта, на сервере ему три минуты' },
  { method: 'post', path: '/apply`', why: 'применение пересчёта, на сервере ему три минуты' },
  { method: 'get', path: "'?wait=1'", why: 'сервер отвечает, только когда закончится идущее применение пересчёта' },
  { method: 'post', path: "'/admin/pharmacies'", why: 'заведение магазина: схема, миграции, настройка' },
  { method: 'del', path: '?confirm=', why: 'удаление магазина стирает всю его схему' },
  { method: 'get', path: "'/backup'", why: 'выгрузка всей базы магазина одним ответом' },
  { method: 'post', path: "'/backup/restore'", why: 'восстановление переписывает все таблицы' },
]

function jsFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...jsFiles(p))
    else if (/\.(jsx|js)$/.test(name)) out.push(p)
  }
  return out
}

// Находим вызов api.<метод>( и его закрывающую скобку, считая вложенность.
// Внутри бывают шаблонные строки и вложенные вызовы, поэтому просто до первой
// скобки читать нельзя.
function apiCalls(code) {
  const out = []
  // Пробелы и переносы между api и методом учитываем обязательно: вызовы
  // с цепочкой .then() записаны как api\n  .post(…), и без этого они терялись —
  // проверка молча пропускала ровно те два места, ради которых писалась
  const re = /\bapi\s*\.\s*(get|post|patch|del)\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')') {
        depth--
        if (depth === 0) {
          out.push({ method: m[1], text: code.slice(m.index, i + 1) })
          break
        }
      }
    }
  }
  return out
}

const calls = jsFiles(SRC).flatMap((f) =>
  apiCalls(readFileSync(f, 'utf8')).map((c) => ({ ...c, where: f.split(/[\\/]/).slice(-2).join('/') })),
)

test('проверка вообще находит вызовы — иначе она бесполезна', () => {
  assert.ok(calls.length > 10, `найдено вызовов: ${calls.length} — разбор сломался`)
})

test('у каждой долгой операции задан свой срок ожидания', () => {
  const bad = []
  for (const slow of SLOW) {
    const found = calls.filter((c) => c.method === slow.method && c.text.includes(slow.path))
    if (!found.length) {
      bad.push(`не найден вызов ${slow.method} ${slow.path} — путь переименовали? (${slow.why})`)
      continue
    }
    for (const c of found) {
      if (!/timeout/.test(c.text)) {
        bad.push(`${c.where}: ${slow.method} ${slow.path} без своего срока — ${slow.why}`)
      }
    }
  }
  assert.deepEqual(bad, [], 'оборвутся на пятнадцатой секунде, хотя сервер доделает работу:\n' + bad.join('\n'))
})

test('обычные вызовы своего срока НЕ задают — короткий срок у них не случайно', () => {
  // Продажа, приход, вход: если сервер молчит пятнадцать секунд, кассиру надо
  // сказать об этом сразу, а не держать его перед замершим экраном
  const ordinary = calls.filter((c) => /'\/sales'|'\/arrivals'|'\/auth\/login'/.test(c.text))
  assert.ok(ordinary.length > 0, 'обычные вызовы не найдены — разбор сломался')
  for (const c of ordinary) {
    assert.ok(!/timeout/.test(c.text), `${c.where}: обычному вызову задан длинный срок — это ошибка`)
  }
})
