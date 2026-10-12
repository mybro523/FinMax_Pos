// ── Как байты попадают в чековый принтер ──
//
// Два пути, оба — «как есть», без рисования страницы:
//   • по сети: у чекового принтера с сетевым гнездом открыт порт 9100, и всё, что
//     туда пришло, он печатает;
//   • через очередь печати Windows: принтер подключён к компьютеру (USB) и заведён
//     в системе; задание уходит в его очередь «сырым» (RAW) — драйвер его не трогает.
//
// Чем открывать соединение и запускать служебный сценарий, передаётся снаружи —
// модуль проверяется обычными тестами.

// Объяснения для человека. Каждое есть в словаре интерфейса (client/src/lib/i18n.js)
// и показывается на выбранном языке — их сверяет проверка. Поэтому в текстах нет
// ничего переменного: коды ошибок уходят в журнал программы, а не на экран.
export const PRINT_MESSAGES = {
  noHost: 'Не указан адрес принтера.',
  silent: 'Принтер не отвечает. Проверьте, что он включён и в той же сети.',
  unreachable: 'Не удалось связаться с принтером. Проверьте адрес и что принтер включён.',
  notChosen: 'Не выбран принтер.',
  noPrinter: 'Принтер с таким именем в Windows не найден.',
  denied: 'Windows не дала доступ к принтеру.',
  refused: 'Принтер не принял задание. Проверьте, что он включён и подключён.',
  failed: 'Не удалось отправить задание на принтер.',
}

// ── Адрес принтера ──
// Чековый принтер стоит в сети аптеки, и адрес у него — четыре числа через точку из
// тех, что бывают только во внутренних сетях: 10.x.x.x, 172.16–31.x.x, 192.168.x.x,
// 169.254.x.x (и сам этот компьютер — 127.x.x.x). Имена и адреса в интернете не
// принимаем. Печать — единственное место, где программа открывает соединение по
// адресу, который назвало окно; окну сеть закрыта целиком, и принтер не должен
// стать для него дорогой наружу: «напечатать» данные аптеки на чужой сервер.
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function checkHost(host) {
  const m = IPV4.exec(String(host || '').trim())
  if (!m) return ''
  const [a, b, c, d] = m.slice(1).map(Number)
  if (a > 255 || b > 255 || c > 255 || d > 255) return ''
  const inside = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127
  // Собираем заново из чисел: «010.0.0.1» не должен прочитаться кем-то как восьмеричный
  return inside ? `${a}.${b}.${c}.${d}` : ''
}

export function checkPort(port) {
  const n = Math.trunc(Number(port))
  return n >= 1 && n <= 65535 ? n : 9100
}

// ── По сети ──
export function sendNetwork({ net, host, port = 9100, bytes, timeoutMs = 6000 }) {
  return new Promise((resolve, reject) => {
    const target = checkHost(host)
    if (!target) return reject(new Error(PRINT_MESSAGES.noHost))
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      socket.destroy()
      err ? reject(err) : resolve()
    }
    const socket = net.connect({ host: target, port: checkPort(port) })
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => finish(new Error(PRINT_MESSAGES.silent)))
    socket.on('error', () => finish(new Error(PRINT_MESSAGES.unreachable)))
    socket.on('connect', () => {
      // Соединение закрываем сами после записи: принтер его не закрывает
      socket.end(bytes, () => finish(null))
    })
  })
}

// ── Через очередь печати Windows ──
// У Node нет своего способа послать «сырое» задание в очередь печати, а ставить ради
// этого библиотеку, которую надо собирать под каждую версию, — лишняя хрупкость.
// Поэтому задание отправляет PowerShell: он есть в каждой Windows. Имя принтера и
// путь к файлу с байтами передаются через окружение, а не в тексте команды: так
// в команду не может попасть ничего постороннего, как бы принтер ни назывался.
export const RAW_PRINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public class AptekaRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static string Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "open:" + Marshal.GetLastWin32Error();
    try {
      DOCINFO info = new DOCINFO();
      info.pDocName = "FinMax POS";
      info.pDataType = "RAW";
      if (StartDocPrinter(h, 1, info) == 0) return "doc:" + Marshal.GetLastWin32Error();
      try {
        if (!StartPagePrinter(h)) return "page:" + Marshal.GetLastWin32Error();
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        int err = Marshal.GetLastWin32Error();
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "write:" + err;
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "ok";
  }
}
'@
Add-Type -TypeDefinition $src
[Console]::Out.Write([AptekaRawPrint]::Send($env:APTEKA_PRINTER, [IO.File]::ReadAllBytes($env:APTEKA_PRINT_FILE)))
`

// Что вернул сценарий → понятное человеку
export function rawPrintError(answer) {
  const text = String(answer || '').trim()
  if (text === 'ok') return ''
  const [step, code] = text.split(':')
  if (step === 'open') return code === '1801' ? PRINT_MESSAGES.noPrinter : PRINT_MESSAGES.denied
  if (step === 'doc' || step === 'page' || step === 'write') return PRINT_MESSAGES.refused
  return PRINT_MESSAGES.failed
}

// run(script, env) → { code, stdout } — запуск PowerShell; подставляется снаружи
export async function sendWindows({ run, fs, tmpFile, printer, bytes }) {
  const name = String(printer || '').trim()
  if (!name || name.length > 220) throw new Error(PRINT_MESSAGES.notChosen)
  fs.writeFileSync(tmpFile, bytes)
  try {
    const r = await run(RAW_PRINT_SCRIPT, { APTEKA_PRINTER: name, APTEKA_PRINT_FILE: tmpFile })
    const problem = r.code === 0 ? rawPrintError(r.stdout) : PRINT_MESSAGES.failed
    if (problem) throw new Error(problem)
  } finally {
    try {
      fs.rmSync(tmpFile, { force: true })
    } catch {
      /* временный файл уберёт система */
    }
  }
}

// ── Настройки печати этого компьютера ──
// mode: system — обычное окно печати Windows (как на сайте); network — чековый
// принтер по сети; windows — чековый принтер, заведённый в Windows.
export const PRINT_DEFAULTS = { mode: 'system', host: '', port: 9100, name: '', width: 32, codepage: 'cp866', cut: true, drawer: false, auto: false, logo: true }

export function sanitizePrint(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const mode = ['system', 'network', 'windows'].includes(v.mode) ? v.mode : 'system'
  return {
    mode,
    host: checkHost(v.host),
    port: checkPort(v.port),
    name: typeof v.name === 'string' ? v.name.slice(0, 220) : '',
    width: [32, 42, 48].includes(Number(v.width)) ? Number(v.width) : 32,
    codepage: v.codepage === 'cp1251' ? 'cp1251' : 'cp866',
    cut: v.cut !== false,
    drawer: v.drawer === true,
    // Печатать чек сразу после продажи, не дожидаясь нажатия «Печать»
    auto: v.auto === true,
    // Эмблема FinMax в начале чека
    logo: v.logo !== false,
  }
}
