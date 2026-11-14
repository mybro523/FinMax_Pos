// ── Сайт без интернета: список файлов service worker (lib/swFiles.js, 14.11.2026) ──
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { swEntries, swVersion, swScript, HEAVY } from '../src/lib/swFiles.js'
import { swAllowed } from '../src/lib/swRegister.js'

const FILES = [
  { path: 'index.html', hash: 'aaa111' },
  { path: 'assets/index-AbC123.js', hash: 'x' },
  { path: 'assets/Pos-Zz9.js', hash: 'y' },
  { path: 'assets/index-B1.css', hash: 'z' },
  { path: 'assets/pdf.worker.min-rsCe.mjs', hash: 'h1' },
  { path: 'assets/pdf-DfaD.js', hash: 'h2' },
  { path: 'assets/exceljs.min-UZ.js', hash: 'h3' },
  { path: 'assets/index-AbC123.js.map', hash: 'm' },
  { path: 'fonts/inter-latin.woff2', hash: 'f1' },
  { path: 'menu\\pos.png', hash: 'p1' },
  { path: 'pokupatel/index.html', hash: 'k1' },
  { path: 'sw.js', hash: 's' },
  { path: '.well-known/x', hash: 'w' },
]

test('в список — страница, код, стили, шрифты, картинки; без тяжёлого (PDF, Excel), карт и самого sw.js', () => {
  const e = swEntries(FILES)
  const urls = e.map((x) => x.url)
  assert.deepEqual(urls, [
    '/assets/Pos-Zz9.js',
    '/assets/index-AbC123.js',
    '/assets/index-B1.css',
    '/fonts/inter-latin.woff2',
    '/index.html',
    '/menu/pos.png',
    '/pokupatel/index.html',
  ])
  assert.ok(HEAVY.length >= 3)
})

test('у файлов с отпечатком в имени (assets) свой отпечаток не нужен, у остальных — есть', () => {
  const e = Object.fromEntries(swEntries(FILES).map((x) => [x.url, x.rev]))
  assert.equal(e['/assets/index-AbC123.js'], '')
  assert.equal(e['/index.html'], 'aaa111')
  assert.equal(e['/menu/pos.png'], 'p1')
})

test('номер версии: тот же список — тот же номер; изменился любой файл — другой', () => {
  const a = swEntries(FILES)
  assert.equal(swVersion(a), swVersion(swEntries([...FILES].reverse())))
  const changedPage = swEntries(FILES.map((f) => (f.path === 'index.html' ? { ...f, hash: 'bbb222' } : f)))
  const changedCode = swEntries(FILES.map((f) => (f.path === 'assets/Pos-Zz9.js' ? { ...f, path: 'assets/Pos-Qq1.js' } : f)))
  assert.notEqual(swVersion(a), swVersion(changedPage))
  assert.notEqual(swVersion(a), swVersion(changedCode))
  assert.match(swVersion(a), /^[0-9a-f]{16}$/)
})

test('sw.js: первой строкой — список и номер версии, дальше сам service worker', () => {
  const e = swEntries(FILES)
  const s = swScript('// тело', e)
  const first = s.split('\n')[0]
  assert.ok(first.startsWith('self.__FINMAX_SW__ = '))
  const m = JSON.parse(first.slice('self.__FINMAX_SW__ = '.length, -1))
  assert.equal(m.version, swVersion(e))
  assert.deepEqual(m.entries, e)
  assert.ok(s.endsWith('// тело'))
})

test('service worker подключается только у собранного сайта по https или на своём компьютере', () => {
  const base = { prod: true, mode: 'production', desktop: false, hasSW: true, protocol: 'https:', hostname: 'www.finmaxpos.tj' }
  assert.equal(swAllowed(base), true)
  assert.equal(swAllowed({ ...base, protocol: 'http:', hostname: '127.0.0.1' }), true)
  assert.equal(swAllowed({ ...base, protocol: 'http:', hostname: 'localhost' }), true)
  assert.equal(swAllowed({ ...base, protocol: 'http:', hostname: '192.168.1.5' }), false)
  assert.equal(swAllowed({ ...base, prod: false }), false)
  assert.equal(swAllowed({ ...base, mode: 'desktop' }), false)
  assert.equal(swAllowed({ ...base, desktop: true }), false)
  assert.equal(swAllowed({ ...base, hasSW: false }), false)
})
