// ── Номер компьютера для кода активации (версия 1.6.0) ──
// Номер — MachineGuid Windows. Его читает reg.exe — только полным путём из папки Windows: просто
// «reg» Windows ищет сначала в текущей папке, и подложенный туда reg.exe назвал бы чужой номер
// (один код активации подошёл бы к любому компьютеру).
import test from 'node:test'
import assert from 'node:assert/strict'
import { machineIdOf, readMachineGuid, regExe } from '../src/machine.mjs'

const OUT = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F\r\n'

test('reg.exe — полным путём из папки Windows, не из текущей папки', () => {
  const calls = []
  const exec = (file, args) => {
    calls.push({ file, args })
    return OUT
  }
  assert.equal(readMachineGuid({ exec, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }), 'c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f')
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\reg.exe')
  // Сначала — 64-разрядный вид реестра (программа для Windows 7 и 8 бывает 32-разрядной)
  assert.equal(calls[0].args.at(-1), '/reg:64')
  assert.equal(regExe({}), 'C:\\Windows\\System32\\reg.exe')
  assert.equal(regExe({ windir: 'D:\\Win' }), 'D:\\Win\\System32\\reg.exe')
  assert.equal(readMachineGuid({ exec, platform: 'linux' }), null)
})

test('64-разрядный вид не ответил — обычный; оба не ответили — номера нет', () => {
  let n = 0
  const exec = () => {
    n++
    if (n === 1) throw new Error('нет /reg:64')
    return OUT
  }
  assert.equal(readMachineGuid({ exec, platform: 'win32', env: {} }), 'c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f')
  assert.equal(readMachineGuid({ exec: () => 'мусор', platform: 'win32', env: {} }), null)
})

test('реестр не ответил — запомненный номер; ответил — он главнее и запоминается', () => {
  let saved = ''
  assert.equal(machineIdOf({ read: () => null, remembered: 'abc', remember: (v) => (saved = v) }), 'abc')
  assert.equal(saved, '')
  assert.equal(machineIdOf({ read: () => 'new', remembered: 'abc', remember: (v) => (saved = v) }), 'new')
  assert.equal(saved, 'new')
  assert.equal(machineIdOf({ read: () => null, remembered: '' }), null)
  // Подмена номера — только для проверок из исходников
  assert.equal(machineIdOf({ read: () => 'real', override: 'test-machine' }), 'test-machine')
})
