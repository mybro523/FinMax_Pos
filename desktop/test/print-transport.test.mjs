// ── Печать на чековом принтере: как байты доходят до принтера ──
//
// По сети проверяется по-настоящему: вместо принтера — слушатель на этом же
// компьютере, и сверяется, что до него дошло ровно то, что отправили.
// Очередь печати Windows — настолько, насколько можно без принтера: сам служебный
// сценарий запускается и честно говорит, что такого принтера нет.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { checkHost, checkPort, PRINT_DEFAULTS, PRINT_MESSAGES, RAW_PRINT_SCRIPT, rawPrintError, sanitizePrint, sendNetwork, sendWindows } from '../src/print/transport.mjs'
import { runPowerShell } from '../src/print/powershell.mjs'

// «Принтер»: принимает соединение и запоминает всё, что в него прислали
function fakePrinter() {
  const got = []
  const server = net.createServer((socket) => {
    const chunks = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => got.push(Buffer.concat(chunks)))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, got, close: () => new Promise((r) => server.close(r)) })))
}

test('по сети: до принтера доходит ровно то, что отправили', async () => {
  const printer = await fakePrinter()
  const bytes = Buffer.from([0x1b, 0x40, 0x80, 0x81, 0x0a, 0x1d, 0x56, 0x42, 0x00])
  await sendNetwork({ net, host: '127.0.0.1', port: printer.port, bytes })
  await sendNetwork({ net, host: '127.0.0.1', port: printer.port, bytes: Buffer.from('второй чек') })
  for (let i = 0; i < 50 && printer.got.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(printer.got.length, 2)
  assert.deepEqual([...printer.got[0]], [...bytes])
  await printer.close()
})

test('по сети: принтер выключен или адрес не тот — понятный отказ, а не зависание', async () => {
  const printer = await fakePrinter()
  const port = printer.port
  await printer.close()
  await assert.rejects(() => sendNetwork({ net, host: '127.0.0.1', port, bytes: Buffer.from('x') }), /Не удалось связаться с принтером/)
  await assert.rejects(() => sendNetwork({ net, host: '', port, bytes: Buffer.from('x') }), /Не указан адрес принтера/)
  // Адрес молчит — ждём недолго и говорим, что делать
  const silent = { connect: () => ({ setTimeout: () => {}, on: (ev, fn) => ev === 'timeout' && setTimeout(fn, 5), destroy() {} }) }
  await assert.rejects(() => sendNetwork({ net: silent, host: '10.0.0.1', bytes: Buffer.from('x') }), /Принтер не отвечает/)
})

test('адрес принтера — только из сети магазина: печать не должна стать дорогой в интернет', () => {
  // Внутренние сети — и сам этот компьютер
  for (const ok of ['192.168.1.50', '10.0.0.7', '172.16.0.1', '172.31.255.254', '169.254.10.20', '127.0.0.1']) {
    assert.equal(checkHost(ok), ok, ok)
  }
  assert.equal(checkHost(' 192.168.1.50 '), '192.168.1.50', 'пробелы по краям — не беда')
  assert.equal(checkHost('010.000.000.007'), '10.0.0.7', 'нули впереди убираются: адрес не должен прочитаться как восьмеричный')
  // Адреса в интернете и имена: окну сеть закрыта, и через «принтер» она не откроется
  for (const bad of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '1.2.3.4', 'printer.local', 'collector.example.org', 'localhost']) {
    assert.equal(checkHost(bad), '', bad)
  }
  // Мусор
  for (const bad of ['192.168.1.50; calc', 'http://192.168.1.50', '192.168.1', '192.168.1.256', '192.168.1.50.1', '192.168.1.-5', '::1', '', null, undefined, 42]) {
    assert.equal(checkHost(bad), '', String(bad))
  }
  assert.equal(sanitizePrint({ mode: 'network', host: 'collector.example.org', port: 443 }).host, '', 'и в настройки такой адрес не попадает')
  assert.equal(checkPort(9100), 9100)
  assert.equal(checkPort('515'), 515)
  assert.equal(checkPort(0), 9100)
  assert.equal(checkPort(70000), 9100)
  assert.equal(checkPort('мусор'), 9100)
})

test('настройки печати: что попало в файл настроек, то и приводится к допустимому', () => {
  assert.deepEqual(sanitizePrint(null), PRINT_DEFAULTS)
  assert.deepEqual(sanitizePrint({ mode: 'laser', width: 100, codepage: 'koi8', port: -1, host: 'a b', name: 5, cut: 'да', drawer: 1, auto: 'yes' }), PRINT_DEFAULTS)
  assert.deepEqual(
    sanitizePrint({ mode: 'network', host: '192.168.1.50', port: 9100, width: 48, codepage: 'cp1251', cut: false, drawer: true, auto: true }),
    { mode: 'network', host: '192.168.1.50', port: 9100, name: '', width: 48, codepage: 'cp1251', cut: false, drawer: true, auto: true },
  )
  assert.equal(sanitizePrint({ mode: 'windows', name: 'XP-58 (копия 1)' }).name, 'XP-58 (копия 1)')
  // Отметка эмблемы из настроек старых версий (до 1.5.2) просто отбрасывается
  assert.equal('logo' in sanitizePrint({ logo: true }), false)
})

test('очередь Windows: ответ сценария переводится в понятные слова', () => {
  assert.equal(rawPrintError('ok'), '')
  assert.match(rawPrintError('open:1801'), /не найден/)
  assert.match(rawPrintError('open:5'), /не дала доступ/)
  assert.match(rawPrintError('write:6'), /не принял задание/)
  assert.match(rawPrintError(''), /Не удалось/)
})

test('очередь Windows: имя принтера и файл передаются через окружение, файл убирается за собой', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-print-'))
  const tmpFile = join(dir, 'chek.bin')
  const calls = []
  const run = async (script, env) => {
    calls.push({ script, env, bytes: fs.readFileSync(env.APTEKA_PRINT_FILE) })
    return { code: 0, stdout: 'ok' }
  }
  const name = 'XP-58"; Remove-Item C:\\ -Recurse #'
  await sendWindows({ run, fs, tmpFile, printer: name, bytes: Buffer.from([1, 2, 3]) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].env.APTEKA_PRINTER, name)
  assert.deepEqual([...calls[0].bytes], [1, 2, 3])
  // В тексте самой команды имени принтера нет: что бы в нём ни стояло, оно не исполнится
  assert.equal(calls[0].script, RAW_PRINT_SCRIPT)
  assert.equal(calls[0].script.includes('Remove-Item'), false)
  assert.equal(fs.existsSync(tmpFile), false, 'временный файл с чеком остался на диске')

  await assert.rejects(() => sendWindows({ run: async () => ({ code: 0, stdout: 'open:1801' }), fs, tmpFile, printer: 'Нет такого', bytes: Buffer.from([1]) }), /не найден/)
  await assert.rejects(() => sendWindows({ run: async () => ({ code: 1, stdout: '' }), fs, tmpFile, printer: 'XP', bytes: Buffer.from([1]) }), /Не удалось отправить/)
  await assert.rejects(() => sendWindows({ run, fs, tmpFile, printer: '  ', bytes: Buffer.from([1]) }), /Не выбран принтер/)
  assert.equal(fs.existsSync(tmpFile), false)
})

test('у каждого объяснения про печать есть таджикский перевод в интерфейсе', () => {
  const dict = fs.readFileSync(join(import.meta.dirname, '..', '..', 'client', 'src', 'lib', 'i18n.js'), 'utf8')
  for (const text of Object.values(PRINT_MESSAGES)) {
    assert.ok(dict.includes(`'${text}':`), `нет перевода для «${text}»`)
    assert.ok(!/[0-9]/.test(text), 'в объяснении не должно быть кодов и чисел — оно переводится целиком: ' + text)
  }
})

test('очередь Windows по-настоящему: сценарий запускается и говорит, что такого принтера нет', { skip: process.platform !== 'win32' && 'только Windows', timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-print-'))
  const run = (script, env) => runPowerShell({ spawn, script, env })
  await assert.rejects(
    () => sendWindows({ run, fs, tmpFile: join(dir, 'chek.bin'), printer: 'Магазин: такого принтера точно нет', bytes: Buffer.from([0x1b, 0x40]) }),
    /Принтер с таким именем в Windows не найден/,
  )
})
