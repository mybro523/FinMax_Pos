// ── Файлы окна на новом и на старом движке ──
//
// На Electron 25 и новее окно получает свои файлы через protocol.handle. В Windows 7 и 8
// программа работает на Electron 22 — там этого ещё нет, и те же файлы отдаются через
// registerBufferProtocol. Ответы должны совпадать до заголовка: тип файла, правила
// безопасности страницы (CSP), «не выйти за свою папку».
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CSP, ORIGIN, registerAppProtocol } from '../src/protocol.mjs'

function folders() {
  const base = mkdtempSync(join(tmpdir(), 'proto-'))
  const root = join(base, 'renderer')
  const fonts = join(base, 'fonts')
  const screen = join(base, 'screen')
  for (const d of [root, join(root, 'assets'), fonts, screen]) mkdirSync(d, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>FinMax</title>')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'assets', 'pdf.worker.min.mjs'), 'self.onmessage=null')
  writeFileSync(join(base, 'secret.txt'), 'ключ входа')
  writeFileSync(join(screen, 'customer.html'), '<!doctype html><title>Покупатель</title>')
  return { root, fonts, screen }
}

// Старый движок: ответ registerBufferProtocol
function viaBuffer(where) {
  let handler = null
  const protocol = { registerBufferProtocol: (scheme, fn) => ((handler = fn), assert.equal(scheme, 'app')) }
  assert.equal(registerAppProtocol({ protocol, readFile, ...where }), 'buffer')
  return (url, method = 'GET') => new Promise((resolve) => handler({ url, method }, resolve))
}

// Новый движок: ответ protocol.handle
function viaHandle(where) {
  let handler = null
  const protocol = { handle: (scheme, fn) => ((handler = fn), assert.equal(scheme, 'app')), registerBufferProtocol: () => assert.fail('на новом движке — только handle') }
  assert.equal(registerAppProtocol({ protocol, readFile, ...where }), 'handle')
  return async (url, method = 'GET') => {
    const res = await handler({ url, method })
    return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), data: Buffer.from(await res.arrayBuffer()) }
  }
}

const header = (h, name) => Object.entries(h || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]

for (const [name, make] of [['старый движок (Windows 7/8)', viaBuffer], ['новый движок', viaHandle]]) {
  test(`${name}: страница, сценарии, рабочий поток pdf.js, экран покупателя — с нужным типом и CSP`, async () => {
    const get = make(folders())
    const page = await get(`${ORIGIN}/index.html`)
    assert.equal(page.statusCode, 200)
    assert.match(header(page.headers, 'content-type'), /^text\/html/)
    assert.equal(header(page.headers, 'content-security-policy'), CSP)
    assert.equal(header(page.headers, 'cache-control'), 'no-cache')
    assert.equal(page.data.toString(), '<!doctype html><title>FinMax</title>')
    const js = await get(`${ORIGIN}/assets/app.js`)
    assert.equal(js.statusCode, 200)
    assert.match(header(js.headers, 'content-type'), /^text\/javascript/)
    assert.equal(header(js.headers, 'x-content-type-options'), 'nosniff')
    assert.equal(header(js.headers, 'content-security-policy'), undefined, 'CSP — у страниц, не у сценариев')
    const worker = await get(`${ORIGIN}/assets/pdf.worker.min.mjs`)
    assert.match(header(worker.headers, 'content-type'), /^text\/javascript/, 'модульный поток грузится только с типом сценария')
    const scr = await get(`${ORIGIN}/_screen/customer.html`)
    assert.equal(scr.statusCode, 200)
    assert.equal(header(scr.headers, 'content-security-policy'), CSP)
    // Корень — главная страница
    assert.equal((await get(`${ORIGIN}/`)).statusCode, 200)
  })

  test(`${name}: чужое не отдаётся — выход из папки, запись, неизвестный файл, чужой адрес`, async () => {
    const get = make(folders())
    for (const url of [`${ORIGIN}/../secret.txt`, `${ORIGIN}/%2e%2e/secret.txt`, `${ORIGIN}/assets/..%2f..%2fsecret.txt`, `${ORIGIN}/nope.js`, 'app://other/index.html']) {
      const r = await get(url)
      assert.equal(r.statusCode, 404, url)
      assert.doesNotMatch(r.data.toString(), /ключ/)
    }
    assert.equal((await get(`${ORIGIN}/index.html`, 'POST')).statusCode, 404)
  })
}
