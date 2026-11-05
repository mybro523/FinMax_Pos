// ── Логотип магазина: что сервер принимает (src/admin/logo.ts) ──
//
// Картинку присылает панель владельца сервиса, уже уменьшенной. Сервер проверяет её сам:
// тип — по первым байтам, а не по подписи; размер файла и размер в точках. Логотип уходит
// на кассы всех магазинов и печатается там — мусор или огромная картинка не должны пройти.
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')

const { checkLogo, sniffImage, imageSize, LOGO_MAX_BYTES } = require('../dist/admin/logo')

// Настоящий PNG заданного размера: сплошной белый, без прозрачности
function png(width, height) {
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
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
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xff)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// JPEG: начало файла, метка APP0 и заголовок кадра SOF0 с размером
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(40), Buffer.from([0xff, 0xd9])])
}

// WebP трёх видов: расширенный (VP8X), без потерь (VP8L) и с потерями (VP8)
function webp(kind, width, height) {
  let chunk
  if (kind === 'VP8X') {
    chunk = Buffer.alloc(10)
    chunk.writeUIntLE(width - 1, 4, 3)
    chunk.writeUIntLE(height - 1, 7, 3)
  } else if (kind === 'VP8L') {
    chunk = Buffer.alloc(10)
    chunk[0] = 0x2f
    chunk.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1)
  } else {
    chunk = Buffer.alloc(14)
    chunk[3] = 0x9d
    chunk[4] = 0x01
    chunk[5] = 0x2a
    chunk.writeUInt16LE(width, 6)
    chunk.writeUInt16LE(height, 8)
  }
  const head = Buffer.alloc(8)
  head.write(kind.padEnd(4, ' '), 0, 'latin1')
  head.writeUInt32LE(chunk.length, 4)
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), head, chunk])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`

test('тип картинки — по первым байтам', () => {
  assert.equal(sniffImage(png(4, 3)), 'png')
  assert.equal(sniffImage(jpeg(10, 20)), 'jpeg')
  assert.equal(sniffImage(webp('VP8X', 5, 6)), 'webp')
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImage(Buffer.alloc(40)), null)
})

test('размер в точках — из заголовка файла', () => {
  assert.deepEqual(imageSize(png(640, 320), 'png'), { width: 640, height: 320 })
  assert.deepEqual(imageSize(jpeg(1024, 768), 'jpeg'), { width: 1024, height: 768 })
  assert.deepEqual(imageSize(webp('VP8X', 720, 360), 'webp'), { width: 720, height: 360 })
  assert.deepEqual(imageSize(webp('VP8L', 300, 120), 'webp'), { width: 300, height: 120 })
  assert.deepEqual(imageSize(webp('VP8 ', 500, 250), 'webp'), { width: 500, height: 250 })
})

test('годная картинка (PNG, JPEG) проходит как есть; пусто — «убрать», нет поля — «не трогать»', () => {
  const ok = url('image/png', png(64, 32))
  assert.equal(checkLogo(ok), ok)
  assert.equal(checkLogo('  ' + ok + '\n'), ok)
  assert.equal(checkLogo(url('image/jpeg', jpeg(300, 100))), url('image/jpeg', jpeg(300, 100)))
  // WebP не хранится: программа для Windows (Electron, nativeImage) его не раскрывает — логотип
  // молча пропал бы с ленты. Панель сама переводит выбранный WebP в PNG или JPG
  assert.throws(() => checkLogo(url('image/webp', webp('VP8L', 300, 120))), /нужна картинка PNG или JPG/)
  assert.equal(checkLogo(''), '')
  assert.equal(checkLogo('   '), '')
  assert.equal(checkLogo(undefined), undefined)
  assert.equal(checkLogo(null), undefined)
})

test('не картинка, не та подпись, SVG и мусор — отказ', () => {
  const bad = [
    123,
    { logo: 1 },
    'просто текст',
    'data:image/png;base64,',
    'data:image/png;base64,!!!',
    'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'),
    'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
    // PNG, подписанный как JPEG, и наоборот
    url('image/jpeg', png(10, 10)),
    url('image/png', jpeg(10, 10)),
    // Подпись PNG, а внутри обрезок без заголовка
    url('image/png', png(10, 10).subarray(0, 12)),
    // Перевод строки внутри base64
    'data:image/png;base64,' + png(4, 4).toString('base64').replace(/(.{8})/, '$1\n'),
  ]
  for (const v of bad) assert.throws(() => checkLogo(v), (e) => e.getStatus?.() === 400, String(v).slice(0, 40))
})

test('огромная по точкам или по весу — отказ с объяснением', () => {
  assert.throws(() => checkLogo(url('image/png', png(2001, 10))), /не больше 2000 точек/)
  assert.throws(() => checkLogo(url('image/jpeg', jpeg(10, 4000))), /не больше 2000 точек/)
  assert.throws(() => checkLogo(url('image/webp', webp('VP8X', 5000, 5000))), /нужна картинка PNG или JPG/)
  // Файл тяжелее 300 КБ (PNG с «хвостом»): и строкой, и после расшифровки
  const heavy = Buffer.concat([png(10, 10), Buffer.alloc(LOGO_MAX_BYTES)])
  assert.throws(() => checkLogo(url('image/png', heavy)), /до 300 КБ/)
  // Ровно 300 КБ — ещё проходит
  const small = png(10, 10)
  const edge = Buffer.concat([small, Buffer.alloc(LOGO_MAX_BYTES - small.length)])
  assert.equal(edge.length, LOGO_MAX_BYTES)
  assert.equal(checkLogo(url('image/png', edge)), url('image/png', edge))
})

test('касса получает логотип своего магазина: контроллер берёт pharmacyId — его кладёт в req.user AuthGuard', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const guard = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth', 'auth.guard.ts'), 'utf8')
  assert.match(guard, /pharmacyId: acc\.pharmacyId/, 'AuthGuard перестал класть pharmacyId в req.user')
  const { ShopController } = require('../dist/shop/shop.controller')
  const calls = []
  const c = new ShopController({ shopLogo: (id, known) => (calls.push([id, known]), { logo: '', at: null }) })
  c.logo({ sub: 'acc-1', pharmacyId: 'ph-1', code: 'shifo', ph: 'не-то' })
  c.logo({ pharmacyId: 'ph-1' }, '2026-11-01T15:00:00.000Z')
  c.logo(undefined, '')
  assert.deepEqual(calls, [['ph-1', undefined], ['ph-1', '2026-11-01T15:00:00.000Z'], [undefined, undefined]])
})

test('логотип для кассы: та же отметка — короткий ответ без картинки; нет логотипа — пусто', async () => {
  const { PharmaciesService } = require('../dist/admin/pharmacies.service')
  const AT = new Date('2026-11-01T15:00:00.000Z')
  const db = { 'ph-1': { logoAt: AT, data: 'data:image/png;base64,AAAA' }, 'ph-2': { logoAt: null, data: null } }
  const reads = []
  const admin = {
    pharmacy: { findUnique: async ({ where }) => (db[where.id] ? { logoAt: db[where.id].logoAt } : null) },
    pharmacyLogo: {
      findUnique: async ({ where }) => {
        reads.push(where.pharmacyId)
        return db[where.pharmacyId]?.data ? { data: db[where.pharmacyId].data } : null
      },
    },
  }
  const svc = new PharmaciesService(admin)
  assert.deepEqual(await svc.shopLogo('ph-1'), { logo: 'data:image/png;base64,AAAA', at: AT.toISOString() })
  assert.deepEqual(await svc.shopLogo('ph-1', AT.toISOString()), { at: AT.toISOString(), same: true })
  assert.deepEqual(await svc.shopLogo('ph-1', '2026-10-01T00:00:00.000Z'), { logo: 'data:image/png;base64,AAAA', at: AT.toISOString() })
  assert.deepEqual(await svc.shopLogo('ph-2', AT.toISOString()), { logo: '', at: null })
  assert.deepEqual(await svc.shopLogo('нет-такого'), { logo: '', at: null })
  assert.deepEqual(await svc.shopLogo(undefined), { logo: '', at: null })
  // Картинка читается только тогда, когда её действительно отдают
  assert.deepEqual(reads, ['ph-1', 'ph-1'])
})
