// ── Выгрузка в Excel в программе ──
// Окно передаёт готовый файл, основная часть сохраняет его туда, куда скажет человек.
// Здесь проверяется то, что основная часть принимает от окна: имя и сами байты.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { safeXlsxName, xlsxBytes, MAX_XLSX_BYTES } from '../src/files.mjs'

test('имя файла: обычное имя раздела остаётся как есть и получает .xlsx', () => {
  assert.equal(safeXlsxName('Долги клиентов'), 'Долги клиентов.xlsx')
  assert.equal(safeXlsxName('Расходы.xlsx'), 'Расходы.xlsx', 'расширение не задваивается')
  assert.equal(safeXlsxName('Отчёт ОПУ.XLSX'), 'Отчёт ОПУ.xlsx')
})

test('имя файла: путей и запрещённых в Windows знаков в нём нет', () => {
  for (const bad of ['..\\..\\Windows\\system32\\x', '../../etc/passwd', 'C:\\Users\\x', 'a<b>c:d"e|f?g*h', 'отчёт\u0000\u0007']) {
    const name = safeXlsxName(bad)
    assert.equal([...name].some((ch) => ch.charCodeAt(0) < 32 || ('<>:"/|?*' + String.fromCharCode(92)).includes(ch)), false, name)
    assert.ok(name.endsWith('.xlsx'), name)
  }
  assert.equal(safeXlsxName('../../etc/passwd'), 'etc passwd.xlsx')
})

test('имя файла: пустое, из точек или слишком длинное — разумное имя', () => {
  assert.equal(safeXlsxName(''), 'FinMax.xlsx')
  assert.equal(safeXlsxName(null), 'FinMax.xlsx')
  assert.equal(safeXlsxName(' ... '), 'FinMax.xlsx')
  assert.ok(safeXlsxName('я'.repeat(500)).length <= 125)
})

test('файл: принимается только похожее на .xlsx (zip) разумного размера', () => {
  const ok = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])
  const buf = xlsxBytes(ok)
  assert.ok(Buffer.isBuffer(buf))
  assert.equal(buf.length, 7)
  assert.equal(xlsxBytes(new Uint8Array([1, 2, 3, 4])), null, 'не zip')
  assert.equal(xlsxBytes(new Uint8Array([0x50, 0x4b])), null, 'слишком короткий')
  assert.equal(xlsxBytes('PK..'), null, 'строка, а не байты')
  assert.equal(xlsxBytes(null), null)
  const big = new Uint8Array(MAX_XLSX_BYTES + 1)
  big[0] = 0x50
  big[1] = 0x4b
  assert.equal(xlsxBytes(big), null, 'больше 25 МБ')
})
