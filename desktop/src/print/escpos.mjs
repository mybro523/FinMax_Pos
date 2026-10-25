// ── Язык чековых принтеров (ESC/POS) ──
//
// Обычная печать идёт через окно печати Windows: программа рисует страницу, система
// отдаёт её принтеру. Чековому принтеру так неудобно — лист у него бесконечный, а
// окно печати на каждый чек никому не нужно. У таких принтеров свой язык: им шлют
// не картинку, а текст вперемешку с короткими командами («жирный», «по центру»,
// «отрезать»). Язык называется ESC/POS; его понимают почти все чековые принтеры.
//
// Здесь — только составление байтов: что именно уйдёт в принтер. Как оно туда
// попадёт (по сети или через очередь печати Windows), решается отдельно
// (transport.mjs). Модуль ни от чего не зависит и проверяется обычными тестами.

// ── Буквы ──
// Принтер не знает Юникода: у него таблица на 256 знаков, и какая именно — выбирают
// командой. Русские буквы есть в двух ходовых таблицах; какую понимает конкретный
// принтер, видно по пробной печати.
//   cp866  — «DOS», её знают практически все;
//   cp1251 — «Windows», встречается у части моделей.
export const CODEPAGES = {
  cp866: { n: 17, label: 'CP866' },
  cp1251: { n: 46, label: 'CP1251' },
}

// Таджикских букв в этих таблицах нет вовсе. Печатаем ближайшую русскую: «Қ» → «К».
// Чек остаётся читаемым, а пустые квадраты вместо букв — нет.
const TAJIK = { Ғ: 'Г', ғ: 'г', Ӣ: 'И', ӣ: 'и', Қ: 'К', қ: 'к', Ӯ: 'У', ӯ: 'у', Ҳ: 'Х', ҳ: 'х', Ҷ: 'Ч', ҷ: 'ч' }
// Типографские знаки, которых у принтера тоже нет
const PLAIN = { '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', '’': "'", '‘': "'", '—': '-', '–': '-', '−': '-', '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', '×': 'x' }

function cyr866(code) {
  if (code >= 0x410 && code <= 0x43f) return code - 0x410 + 0x80 // А…п
  if (code >= 0x440 && code <= 0x44f) return code - 0x440 + 0xe0 // р…я
  if (code === 0x401) return 0xf0 // Ё
  if (code === 0x451) return 0xf1 // ё
  if (code === 0x2116) return 0xfc // №
  if (code === 0xb7) return 0xfa // ·
  if (code === 0xb0) return 0xf8 // °
  return -1
}

function cyr1251(code) {
  if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0 // А…я
  if (code === 0x401) return 0xa8
  if (code === 0x451) return 0xb8
  if (code === 0x2116) return 0xb9
  if (code === 0xb7) return 0xb7
  if (code === 0xb0) return 0xb0
  return -1
}

// Привести строку к тому, что принтер сможет напечатать
export function printable(text) {
  let out = ''
  for (const ch of String(text ?? '')) out += TAJIK[ch] ?? PLAIN[ch] ?? ch
  return out
}

// Строка → байты в выбранной таблице. Чего в таблице нет — печатается знаком вопроса
export function encode(text, codepage = 'cp866') {
  const map = codepage === 'cp1251' ? cyr1251 : cyr866
  const bytes = []
  for (const ch of printable(text)) {
    const code = ch.codePointAt(0)
    if (code === 0x0a) bytes.push(0x0a)
    else if (code >= 0x20 && code < 0x7f) bytes.push(code)
    else {
      const b = map(code)
      bytes.push(b >= 0 ? b : 0x3f)
    }
  }
  return Buffer.from(bytes)
}

// ── Ширина ленты в знаках ──
// 58 мм — 32 знака; 80 мм — 48 (у части моделей 42)
export const WIDTHS = [32, 42, 48]

// Разбить строку на куски не длиннее ширины ленты — по словам, где получается
export function wrap(text, width) {
  const out = []
  for (const para of printable(text).split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      let w = word
      // Слово длиннее строки режем как есть
      while (w.length > width) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(w.slice(0, width))
        w = w.slice(width)
      }
      if (!line) line = w
      else if (line.length + 1 + w.length <= width) line += ' ' + w
      else {
        out.push(line)
        line = w
      }
    }
    out.push(line)
  }
  return out
}

// Две колонки в одну строку: слева подпись, справа число. Не помещается — подпись
// переносится, число остаётся в последней строке у правого края
export function twoColumns(left, right, width) {
  const r = printable(right)
  const room = Math.max(1, width - r.length - 1)
  const lines = wrap(left, room)
  const last = lines.pop() ?? ''
  return [...lines, last + ' '.repeat(Math.max(1, width - last.length - r.length)) + r]
}

// ── Составитель команд ──
export function escpos({ codepage = 'cp866', width = 32 } = {}) {
  const page = CODEPAGES[codepage] ? codepage : 'cp866'
  const chunks = []
  const raw = (...bytes) => {
    chunks.push(Buffer.from(bytes))
    return api
  }
  const api = {
    width,
    // Сброс принтера, выключение «китайского режима» и выбор таблицы букв.
    // Китайские принтеры (XPrinter, Rongta, Gprinter…) с завода часто включены в режим
    // иероглифов: каждые два байта русского текста они печатают одним китайским знаком, а
    // сброс (ESC @) возвращает их к заводским настройкам — то есть к тому же режиму. FS .
    // его выключает; принтеры без такого режима команду пропускают
    init: () => raw(0x1b, 0x40, 0x1c, 0x2e, 0x1b, 0x74, CODEPAGES[page].n),
    align: (how) => raw(0x1b, 0x61, how === 'center' ? 1 : how === 'right' ? 2 : 0),
    bold: (on) => raw(0x1b, 0x45, on ? 1 : 0),
    // Двойная высота: строка заметнее, а в ширину помещается столько же
    tall: (on) => raw(0x1d, 0x21, on ? 0x01 : 0x00),
    // Белым по чёрному (GS B): так на ленте печатаются название магазина и итог.
    // Принтер, который этого не умеет, напечатает обычным шрифтом — тоже читается
    invert: (on) => raw(0x1d, 0x42, on ? 1 : 0),
    text(s) {
      chunks.push(encode(s, page))
      return api
    },
    line: (s = '') => api.text(s).raw(0x0a),
    lines(list) {
      for (const s of list) api.line(s)
      return api
    },
    rule: (ch = '-') => api.line(ch.repeat(width)),
    feed: (n = 1) => raw(0x1b, 0x64, Math.max(0, Math.min(10, n))),
    // Отрезать ленту (с подачей до ножа)
    cut: () => raw(0x1d, 0x56, 0x42, 0x00),
    // Открыть денежный ящик, подключённый к принтеру
    drawer: () => raw(0x1b, 0x70, 0x00, 0x19, 0xfa),
    raw,
    // Готовые байты (картинка) — отдельным куском, без перекодировки
    blob(buf) {
      chunks.push(buf)
      return api
    },
    bytes: () => Buffer.concat(chunks),
  }
  return api
}

// ── Эмблема ──
// GS v 0 — растровая картинка: 1 бит = одна точка, строки упакованы по 8 точек
// в байт (print/logo.mjs). Битый блок не печатаем вовсе: кривая картинка на ленте
// хуже, чем её отсутствие.
export function rasterImage(img) {
  const width = Number(img?.width) || 0
  const height = Number(img?.height) || 0
  const bits = Buffer.from(String(img?.data || ''), 'base64')
  const perRow = Math.ceil(width / 8)
  if (!perRow || !height || height > 1024 || bits.length !== perRow * height) return Buffer.alloc(0)
  return Buffer.concat([
    Buffer.from([0x1d, 0x76, 0x30, 0x00, perRow & 0xff, (perRow >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]),
    bits,
  ])
}

// ── Что печатаем ──
// Окно программы присылает уже готовые слова и числа (на выбранном языке, с деньгами
// в принятом виде): { head: [строки], docAt, rows: [{ name, sub, value }],
// totals: [{ label, value, big }], tail: [строки] }. Здесь это только раскладывается
// по ленте. Размеры ограничены: чек на тысячу строк — это ошибка, а не чек.
// docAt — какая строка шапки называет документ («Чек № …»): она печатается жирной
const MAX_LINES = 400
const MAX_TEXT = 200
const str = (v) => String(v ?? '').slice(0, MAX_TEXT)

export function sanitizeTicket(raw) {
  const t = raw && typeof raw === 'object' ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.slice(0, MAX_LINES) : [])
  return {
    head: list(t.head).map(str),
    docAt: Number.isInteger(t.docAt) ? t.docAt : -1,
    rows: list(t.rows).map((r) => ({ name: str(r?.name), sub: str(r?.sub), value: str(r?.value) })),
    totals: list(t.totals).map((r) => ({ label: str(r?.label), value: str(r?.value), big: !!r?.big })),
    tail: list(t.tail).map(str),
  }
}

// Строка по центру, дополненная пробелами до края: белым по чёрному печатается вся
// ширина ленты, а не только буквы
export function fullCenter(text, width) {
  const s = printable(text)
  const left = Math.max(0, Math.floor((width - s.length) / 2))
  return (' '.repeat(left) + s).padEnd(width, ' ')
}

// ── Раскладка чека по строкам ленты ──
// То, что уйдёт на принтер, строка за строкой: текст и как его печатать (по центру,
// жирно, крупно, белым по чёрному). По этой же раскладке экран печати программы
// показывает ленту — поэтому предпросмотр совпадает с бумагой строка в строку.
// Фирменный вид — как на экране и в PDF, только чёрным: название магазина и итог на
// чёрной полосе во всю ширину ленты, строка документа — жирная
export function layoutTicket(ticket, { width = 32 } = {}) {
  const t = sanitizeTicket(ticket)
  const out = []
  const push = (text, how = {}) => out.push({ text, ...how })
  const rule = () => push('-'.repeat(width))

  t.head.forEach((line, n) => {
    if (n === 0) {
      // Полоса: по пробелу с каждой стороны, чтобы буквы не упирались в край чёрного
      for (const l of wrap(line, width - 2)) push(fullCenter(l, width), { bold: true, tall: true, invert: true })
    } else {
      for (const l of wrap(line, width)) push(l, { center: true, bold: n === t.docAt })
    }
  })

  if (t.rows.length) {
    rule()
    for (const r of t.rows) {
      for (const l of wrap(r.name, width)) push(l)
      // Количество и цена — с отступом под названием, сумма — у правого края
      for (const l of twoColumns(r.sub, r.value, width - 2)) push('  ' + l)
    }
  }

  if (t.totals.length) {
    rule()
    for (const r of t.totals) {
      if (r.big) {
        for (const l of twoColumns(r.label, r.value, width - 2)) push(' ' + l + ' ', { bold: true, tall: true, invert: true })
      } else {
        for (const l of twoColumns(r.label, r.value, width)) push(l)
      }
    }
  }

  if (t.tail.length) {
    rule()
    for (const line of t.tail) for (const l of wrap(line, width)) push(l, { center: true })
  }
  return out
}

export function renderTicket(ticket, { width = 32, codepage = 'cp866', cut = true, drawer = false, logo = null } = {}) {
  const p = escpos({ codepage, width }).init()
  if (drawer) p.drawer()

  // Эмблема — первой, по центру ленты
  if (logo) {
    const img = rasterImage(logo)
    if (img.length) p.align('center').blob(img).feed(1)
  }

  for (const l of layoutTicket(ticket, { width })) {
    p.align(l.center ? 'center' : 'left')
    if (l.bold) p.bold(true)
    if (l.tall) p.tall(true)
    if (l.invert) p.invert(true)
    p.line(l.text)
    if (l.invert) p.invert(false)
    if (l.tall) p.tall(false)
    if (l.bold) p.bold(false)
  }
  p.align('left')

  // Лента должна выйти из-под ножа, иначе последняя строка останется внутри
  p.feed(3)
  if (cut) p.cut()
  return p.bytes()
}
