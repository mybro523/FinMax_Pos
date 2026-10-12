// ── Какие файлы программа отдаёт своему окну ──
//
// Окно получает файлы не с диска напрямую, а через саму программу — по адресу
// app://apteka. Это единственное место, где адрес превращается в имя файла, и
// ошибка здесь означала бы, что страница может прочитать с диска что угодно:
// файл с ключом входа, локальную базу, чужие документы.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import { CSP, isAppUrl, ORIGIN, resolveAsset, START_URL } from '../src/protocol.mjs'

const root = resolve('/prog/renderer')
const fonts = resolve('/prog/assets/fonts')
const at = (url) => resolveAsset({ root, fonts }, url)

test('страница и её файлы находятся', () => {
  assert.deepEqual(at(START_URL), { file: join(root, 'index.html'), type: 'text/html; charset=utf-8', html: true })
  assert.equal(at(ORIGIN + '/').file, join(root, 'index.html'))
  assert.equal(at(ORIGIN).file, join(root, 'index.html'))
  assert.deepEqual(at(ORIGIN + '/assets/index-AbC_1-2.js'), {
    file: join(root, 'assets', 'index-AbC_1-2.js'),
    type: 'text/javascript; charset=utf-8',
    html: false,
  })
  assert.equal(at(ORIGIN + '/assets/index-x.css').type, 'text/css; charset=utf-8')
  // Логотип на экране входа — WebP: без этого типа программа показывала бы битую картинку
  assert.equal(at(ORIGIN + '/assets/logo-320-x.webp').type, 'image/webp')
})

test('хвост адреса (раздел после решётки, параметры) на файл не влияет', () => {
  assert.equal(at(ORIGIN + '/index.html#/pos').file, join(root, 'index.html'))
  assert.equal(at(ORIGIN + '/index.html?x=1#/products').file, join(root, 'index.html'))
})

test('шрифты отдаются из своей папки', () => {
  assert.deepEqual(at(ORIGIN + '/_fonts/inter.css'), { file: join(fonts, 'inter.css'), type: 'text/css; charset=utf-8', html: false })
  assert.equal(at(ORIGIN + '/_fonts/inter-cyrillic-400-normal.woff2').type, 'font/woff2')
})

test('выйти за пределы своих папок нельзя', () => {
  for (const path of [
    '/../session.json',
    '/assets/../../session.json',
    '/%2e%2e/session.json',
    '/..%2fsession.json',
    '/..%5csession.json',
    '/assets/..%5c..%5csession.json',
    '/_fonts/../../src/main.mjs',
    '/_fonts/..%2f..%2fbuild-config.json',
    '/_fonts/%2e%2e/%2e%2e/package.json',
    '//etc/passwd',
    '/C:/Windows/win.ini',
  ]) {
    const hit = at(ORIGIN + path)
    if (hit === null) continue
    // Адрес мог «схлопнуться» в допустимый (разборщик сам убирает «..») — но тогда
    // файл обязан лежать внутри своей папки, а не рядом с ней
    assert.ok(
      hit.file.startsWith(root + sep) || hit.file.startsWith(fonts + sep),
      `по адресу ${path} отдан файл вне папок программы: ${hit.file}`,
    )
  }
})

test('папка с похожим именем своей не считается', () => {
  // «renderer-old» начинается так же, как «renderer»: сравнение без разделителя
  // пропустило бы файл из соседней папки
  const hit = resolveAsset({ root: resolve('/prog/renderer'), fonts }, ORIGIN + '/..%2frenderer-old/index.html')
  assert.equal(hit, null)
})

test('адрес-ловушка с нулевым байтом и кривым кодированием отклоняется', () => {
  assert.equal(at(ORIGIN + '/index.html%00.png'), null)
  assert.equal(at(ORIGIN + '/%E0%A4%A.js'), null)
})

test('неизвестные типы файлов не отдаются', () => {
  // Отдаём только то, из чего состоит интерфейс. Всё прочее окну не нужно
  for (const name of ['/secret.db', '/app.exe', '/notes', '/a.map', '/x.node', '/.env']) {
    assert.equal(at(ORIGIN + name), null, `отдан файл ${name}`)
  }
})

test('чужой адрес своим не считается', () => {
  for (const url of [
    'https://apteka/index.html',
    'app://evil/index.html',
    'file:///C:/prog/renderer/index.html',
    'app://apteka.evil.example/index.html',
    'не адрес',
    '',
  ]) {
    assert.equal(isAppUrl(url), false, url)
    assert.equal(at(url), null, url)
  }
  assert.equal(isAppUrl(START_URL), true)
  assert.equal(isAppUrl(ORIGIN + '/index.html#/pos'), true)
})

// ── Правила страницы ──

test('окну закрыт интернет и чужие сценарии', () => {
  const rules = Object.fromEntries(CSP.split('; ').map((r) => [r.split(' ')[0], r.split(' ').slice(1)]))
  // Главное: окно не может обратиться ни к одному адресу в сети
  assert.deepEqual(rules['connect-src'], ["'self'"])
  assert.deepEqual(rules['default-src'], ["'self'"])
  // Сценарии — только свои файлы: ни встроенных в страницу, ни собранных из строки
  assert.deepEqual(rules['script-src'], ["'self'"])
  assert.equal(CSP.includes('unsafe-eval'), false)
  assert.deepEqual(rules['object-src'], ["'none'"])
  assert.deepEqual(rules['frame-ancestors'], ["'none'"])
  // Ни одного внешнего адреса в правилах нет вовсе
  assert.equal(/https?:|wss?:|\*/.test(CSP), false, 'в правилах страницы остался внешний адрес')
})
