// Самообновление: программа должна узнавать свою версию в HTML сайта и
// откладывать перезагрузку, пока идёт продажа.
import test from 'node:test'
import assert from 'node:assert/strict'
import { entryFromHtml, blockUpdate, isUpdateHeld } from '../src/lib/version.js'

test('имя сборки достаётся из настоящей страницы сайта', () => {
  const html = `<!doctype html><html lang="ru"><head><meta charset="UTF-8" />
    <title>Аптека</title>
    <script type="module" crossorigin src="/assets/index-DkVwnwae.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-DfJLc9lx.js">
    <link rel="stylesheet" crossorigin href="/assets/index-CWQEPmNz.css">
    </head><body><div id="root"></div></body></html>`
  assert.equal(entryFromHtml(html), 'index-DkVwnwae.js')
})

test('файл стилей за версию не принимается', () => {
  const html = '<link rel="stylesheet" href="/assets/index-CWQEPmNz.css">'
  assert.equal(entryFromHtml(html), null)
})

test('пустой или битый ответ не ломает проверку', () => {
  assert.equal(entryFromHtml(''), null)
  assert.equal(entryFromHtml(null), null)
  assert.equal(entryFromHtml('<html><body>сервер прилёг</body></html>'), null)
})

test('пока держат защиту, перезагрузка отложена', () => {
  assert.equal(isUpdateHeld(), false)
  const release = blockUpdate()
  assert.equal(isUpdateHeld(), true, 'корзина не пуста — перезагружать нельзя')
  release()
  assert.equal(isUpdateHeld(), false, 'корзину очистили — можно')
})

test('две защиты сразу: отпускаем по одной', () => {
  const a = blockUpdate()
  const b = blockUpdate()
  a()
  assert.equal(isUpdateHeld(), true, 'вторая ещё держит')
  b()
  assert.equal(isUpdateHeld(), false)
})

test('повторное освобождение не уводит счётчик в минус', () => {
  const release = blockUpdate()
  release()
  release()
  release()
  const other = blockUpdate()
  assert.equal(isUpdateHeld(), true, 'счётчик не сломался лишними вызовами')
  other()
  assert.equal(isUpdateHeld(), false)
})
