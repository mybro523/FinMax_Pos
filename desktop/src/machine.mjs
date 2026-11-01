// ── Постоянный номер этого компьютера (версия 1.6.0) ──
//
// По нему считается «код компьютера» для активации без интернета (local/licence-code.mjs).
// Номер — MachineGuid Windows: он задаётся при установке Windows и не меняется, пока её не
// переустановят. Копия базы, перенесённая на другой компьютер, там свой номер и встретит —
// код активации к ней не подойдёт.
//
// Программа для Windows 7 и 8 бывает 32-разрядной: на 64-разрядной Windows её запрос к
// реестру уводится в 32-разрядный раздел, где номера нет. Поэтому сначала — явный запрос к
// 64-разрядному виду реестра (/reg:64), потом обычный.
import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

const GUID = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

// reg.exe — полным путём из папки Windows. Просто «reg» Windows ищет сначала в текущей папке
// (часто это папка программы, куда можно писать без прав администратора): подложенный туда
// reg.exe назвал бы чужой номер — и один код активации подошёл бы к любому компьютеру
export const regExe = (env = process.env) => win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe')

export function readMachineGuid({ exec = execFileSync, platform = process.platform, log = null, env = process.env } = {}) {
  if (platform !== 'win32') return null
  const base = ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']
  for (const extra of [['/reg:64'], []]) {
    try {
      const out = exec(regExe(env), [...base, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
      const m = GUID.exec(String(out))
      if (m) return m[1].toLowerCase()
    } catch (e) {
      log?.warn?.('номер компьютера: реестр не ответил' + (extra.length ? ' (64-разрядный вид)' : ''), e)
    }
  }
  return null
}

// Номер для кода компьютера: из реестра; не прочитался (реестр не ответил вовремя) — тот, что
// прочитался в прошлый раз на этом же компьютере. Запомненный годится только как запасной:
// прочитанный из реестра всегда главнее, поэтому перенос базы на другой компьютер код не переносит
export function machineIdOf({ read = readMachineGuid, remembered = '', remember = () => {}, override = '' } = {}) {
  // Только для проверок из исходников: две «машины» на одном компьютере
  if (override) return override
  const id = read()
  if (id) {
    if (id !== remembered) remember(id)
    return id
  }
  return remembered || null
}
