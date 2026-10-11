// ── Запуск служебного сценария PowerShell ──
//
// Нужен для одного: послать «сырое» задание в очередь печати Windows (transport.mjs).
// Сценарий передаётся закодированным (так PowerShell принимает его целиком, без
// правил кавычек и без файла на диске), и текст его всегда один и тот же. Всё
// переменное — имя принтера, путь к файлу — идёт через окружение: в саму команду
// снаружи подставить нечего.

const TIMEOUT_MS = 20000

export function runPowerShell({ spawn, script, env = {}, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let timer = null
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: out })
    }
    let child
    try {
      // PowerShell ждёт закодированную команду в UTF-16
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return resolve({ code: -1, stdout: '' })
    }
    timer = setTimeout(() => {
      child.kill()
      finish(-1)
    }, timeoutMs)
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}
