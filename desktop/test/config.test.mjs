// ── Адрес сервера ──
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { normalizeApiUrl, readBuildConfig, resolveApiUrl, serverOrigin } from '../src/config.mjs'

test('адрес приводится к одному виду', () => {
  assert.equal(normalizeApiUrl('https://x.up.railway.app/api'), 'https://x.up.railway.app/api')
  assert.equal(normalizeApiUrl('  https://x.up.railway.app/api///  '), 'https://x.up.railway.app/api')
})

test('только защищённое соединение — кроме сервера на этом же компьютере', () => {
  // По этому адресу идут пароли и продажи
  assert.equal(normalizeApiUrl('http://x.up.railway.app/api'), '')
  assert.equal(normalizeApiUrl('http://192.168.1.10:3000/api'), '')
  assert.equal(normalizeApiUrl('http://localhost:3000/api'), 'http://localhost:3000/api')
  assert.equal(normalizeApiUrl('http://127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api')
})

test('мусор вместо адреса не принимается', () => {
  for (const bad of ['', null, undefined, 'railway', '/api', 'ftp://x/api', 'https://user:pass@x/api', 'https://x/api?a=1', 'https://x/api#y']) {
    assert.equal(normalizeApiUrl(bad), '', String(bad))
  }
})

test('собранная программа берёт адрес только из сборки', () => {
  // Иначе её можно было бы одной переменной направить на подставной сервер,
  // который на любой вопрос о подписке отвечает «оплачено»
  const built = { apiUrl: 'https://real.example/api' }
  const env = { APTEKA_API_URL: 'https://fake.example/api', VITE_API_URL: 'https://fake2.example/api' }
  assert.equal(resolveApiUrl({ packaged: true, env, built }), 'https://real.example/api')
  assert.equal(resolveApiUrl({ packaged: true, env, built: {} }), '')
})

test('при запуске из исходников переменная окружения сильнее сборки', () => {
  const built = { apiUrl: 'https://real.example/api' }
  assert.equal(resolveApiUrl({ packaged: false, env: { APTEKA_API_URL: 'http://localhost:3999/api' }, built }), 'http://localhost:3999/api')
  // Привычное по сайту имя тоже годится
  assert.equal(resolveApiUrl({ packaged: false, env: { VITE_API_URL: 'https://b.example/api' }, built: {} }), 'https://b.example/api')
  // Негодный адрес в окружении не перебивает годный из сборки
  assert.equal(resolveApiUrl({ packaged: false, env: { APTEKA_API_URL: 'ерунда' }, built }), 'https://real.example/api')
  assert.equal(resolveApiUrl({ packaged: false, env: {}, built }), 'https://real.example/api')
})

test('постоянное соединение живёт в корне сервера, а не под /api', () => {
  assert.equal(serverOrigin('https://x.up.railway.app/api'), 'https://x.up.railway.app')
  assert.equal(serverOrigin('http://localhost:3000/api'), 'http://localhost:3000')
  assert.equal(serverOrigin(''), '')
})

test('файл настроек сборки: нет файла или мусор — пустые настройки', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-config-'))
  assert.deepEqual(readBuildConfig(join(dir, 'нет.json')), {})
  fs.writeFileSync(join(dir, 'bad.json'), 'не json')
  assert.deepEqual(readBuildConfig(join(dir, 'bad.json')), {})
  fs.writeFileSync(join(dir, 'null.json'), 'null')
  assert.deepEqual(readBuildConfig(join(dir, 'null.json')), {})
  fs.writeFileSync(join(dir, 'ok.json'), JSON.stringify({ apiUrl: 'https://x/api' }))
  assert.deepEqual(readBuildConfig(join(dir, 'ok.json')), { apiUrl: 'https://x/api' })
})
