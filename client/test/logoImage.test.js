// ── Логотип магазина: подготовка картинки в панели (lib/logoImage.js, 1.6.4) ──
//
// Владелец сервиса выбирает файл — панель обрезает пустые поля, вписывает картинку в 720×360
// (без увеличения) и проверяет файл по заголовку: тот же разбор, что и на сервере. Здесь —
// расчёты без браузера; сама картинка проверяется в живой проверке панели.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { fitBox, trimBox, headerSize, dataUrlBytes, LOGO_BOX, LOGO_TYPES } from '../src/lib/logoImage.js'
import { cleanLogo } from '../src/lib/logoClean.js'

test('вписать в 720×360: пропорции сохраняются, мелкое не растягивается', () => {
  assert.deepEqual(LOGO_BOX, { width: 720, height: 360 })
  assert.deepEqual(fitBox(1440, 720), { width: 720, height: 360 })
  assert.deepEqual(fitBox(2000, 500), { width: 720, height: 180 }) // широкий — по ширине
  assert.deepEqual(fitBox(500, 2000), { width: 90, height: 360 }) // высокий — по высоте
  assert.deepEqual(fitBox(300, 100), { width: 300, height: 100 }) // мелкий — как есть
  assert.deepEqual(fitBox(0, 0), { width: 1, height: 1 })
  assert.deepEqual(fitBox(4000, 3000, 2000, 2000), { width: 2000, height: 1500 })
})

// Картинка w×h, залитая фоном, с прямоугольником «чернил» внутри
function picture(w, h, bg, ink, box) {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
      px.set(inside ? ink : bg, (y * w + x) * 4)
    }
  }
  return px
}
const CLEAR = [0, 0, 0, 0]
const WHITE = [255, 255, 255, 255]
const BLUE = [0, 53, 159, 255]

test('пустые поля обрезаются: прозрачные и белые, с запасом в 2 %', () => {
  // Прозрачный фон, логотип 50×20 в середине картинки 200×100
  const r = trimBox(picture(200, 100, CLEAR, BLUE, { x: 70, y: 40, w: 50, h: 20 }), 200, 100)
  assert.deepEqual(r, { x: 69, y: 39, width: 52, height: 22 })
  // Белый фон — так же
  const w = trimBox(picture(200, 100, WHITE, BLUE, { x: 10, y: 10, w: 100, h: 50 }), 200, 100)
  assert.deepEqual(w, { x: 8, y: 8, width: 104, height: 54 })
  // Логотип упирается в угол: фон — по трём остальным; запас не выходит за края картинки
  const edge = trimBox(picture(100, 50, CLEAR, BLUE, { x: 0, y: 0, w: 60, h: 10 }), 100, 50)
  assert.deepEqual(edge, { x: 0, y: 0, width: 61, height: 11 })
})

test('фон не однородный, картинка пустая или данных мало — без обрезки', () => {
  // Цветной фон (углы синие) — это часть логотипа, не поля
  assert.deepEqual(trimBox(picture(40, 20, BLUE, WHITE, { x: 5, y: 5, w: 5, h: 5 }), 40, 20), { x: 0, y: 0, width: 40, height: 20 })
  // Совсем пустая (прозрачная) — вся картинка, а не «ничего»
  assert.deepEqual(trimBox(picture(40, 20, CLEAR, CLEAR, null), 40, 20), { x: 0, y: 0, width: 40, height: 20 })
  assert.deepEqual(trimBox(new Uint8ClampedArray(8), 40, 20), { x: 0, y: 0, width: 40, height: 20 })
  // Почти белое (сжатие JPG даёт 250–254) — тоже фон
  const jpgWhite = [252, 251, 253, 255]
  assert.deepEqual(trimBox(picture(100, 100, jpgWhite, BLUE, { x: 40, y: 40, w: 20, h: 20 }), 100, 100), { x: 39, y: 39, width: 22, height: 22 })
})

// Настоящий PNG (белый) заданного размера
function png(width, height) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('размер по заголовку файла: PNG, JPG и WebP; не картинка — null', () => {
  assert.deepEqual(headerSize(png(640, 320)), { width: 640, height: 320 })
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, ...new Array(20).fill(0)])
  assert.deepEqual(headerSize(jpg), { width: 600, height: 300 })
  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBPVP8X', 8, 'latin1')
  webp.writeUIntLE(799, 24, 3)
  webp.writeUIntLE(199, 27, 3)
  assert.deepEqual(headerSize(webp), { width: 800, height: 200 })
  assert.equal(headerSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(headerSize(new Uint8Array(0)), null)
  assert.deepEqual(LOGO_TYPES, ['image/png', 'image/jpeg', 'image/webp'])
})

test('вес картинки по строке data URL', () => {
  const buf = png(30, 10)
  assert.equal(dataUrlBytes('data:image/png;base64,' + buf.toString('base64')), buf.length)
  assert.equal(dataUrlBytes('data:image/png;base64,' + Buffer.from('ab').toString('base64')), 2)
  assert.equal(dataUrlBytes(''), 0)
})

test('в чек и на печать идёт только картинка data URL нужного вида', () => {
  const ok = 'data:image/png;base64,' + png(4, 4).toString('base64')
  assert.equal(cleanLogo(ok), ok)
  assert.equal(cleanLogo('data:image/jpeg;base64,/9j/4AAQ'), 'data:image/jpeg;base64,/9j/4AAQ')
  // WebP не хранится (программа для Windows не напечатала бы его на ленте) — как «логотипа нет»
  assert.equal(cleanLogo('data:image/webp;base64,UklGRg=='), '')
  for (const bad of ['', null, undefined, 42, 'https://evil.example/logo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'javascript:alert(1)', ok + '"']) {
    assert.equal(cleanLogo(bad), '', String(bad))
  }
})
