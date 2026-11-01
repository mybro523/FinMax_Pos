// ── Ключ кодов активации: один на всё время жизни сервиса (версия 1.6.0) ──
// Открытая половина ключа вшита во все собранные программы и проверяет все выданные коды.
// Потерять запись LicenceKey (переезд сервера, подъём базы из копии) и молча завести новую —
// значит сломать все установленные программы без интернета разом. Поэтому: пока ключ не
// закреплён в исходниках — он заводится сам; закреплён — новый не заводится никогда, а чужой
// или испорченный ключ в базе останавливает выпуск кодов с понятным объяснением.
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')
const { LicencesService } = require('../dist/admin/licences.service')
const L = require('../dist/common/licence-code')

// Поддельная база сервиса: одна запись ключа, коды и журнал
function fakeAdmin(keyRow = null) {
  const state = { key: keyRow, creates: 0, codes: [], audit: [] }
  return {
    state,
    licenceKey: {
      findUnique: async () => state.key,
      create: async ({ data }) => {
        state.creates++
        if (state.key) throw Object.assign(new Error('unique'), { code: 'P2002' })
        state.key = { ...data, createdAt: new Date() }
        return state.key
      },
    },
    licenceCode: {
      count: async () => state.codes.length,
      create: async ({ data }) => {
        const row = { id: 'c' + state.codes.length, createdAt: new Date(), ...data }
        state.codes.push(row)
        return row
      },
    },
    account: { findUnique: async () => ({ login: 'admin' }) },
    auditLog: { create: async ({ data }) => state.audit.push(data) },
  }
}
const quiet = (svc) => {
  const logs = []
  svc.log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }
  return logs
}
const PC = L.computerCodeOf('d1d2d3d4-0000-4000-8000-000000000001')
const yearOn = () => new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)

test('ключ не закреплён: заводится один раз, дальше — тот же', async () => {
  const db = fakeAdmin()
  const svc = new LicencesService(db)
  svc.pin = ''
  const logs = quiet(svc)
  const a = (await svc.publicKey()).key
  const b = (await svc.publicKey()).key
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, b)
  assert.equal(db.state.creates, 1)
  // Заведение нового ключа — громко, с просьбой закрепить
  assert.ok(logs.some((m) => /НОВЫЙ ключ/.test(m) && m.includes(a)))
  // И секретная половина в журнал не попадает
  assert.ok(!logs.some((m) => m.includes(db.state.key.privateKey)))
})

test('ключ закреплён, а записи в базе нет: новый НЕ заводится, коды не выпускаются', async () => {
  const k = L.makeKeys()
  const db = fakeAdmin(null)
  const svc = new LicencesService(db)
  svc.pin = k.publicKey
  const logs = quiet(svc)
  await assert.rejects(svc.publicKey(), (e) => e.getStatus() === 503 && /потерян/.test(e.message))
  await assert.rejects(svc.issue({ computer: PC, kind: 'activate', until: yearOn(), registers: 1 }), (e) => e.getStatus() === 503)
  assert.equal(db.state.creates, 0)
  assert.equal(db.state.key, null)
  assert.ok(logs.some((m) => /потерян/.test(m)))
})

test('в базе чужой ключ или испорченный: выпуск останавливается', async () => {
  const pinned = L.makeKeys()
  const other = L.makeKeys()
  const svc = new LicencesService(fakeAdmin({ id: 'main', ...other }))
  svc.pin = pinned.publicKey
  quiet(svc)
  await assert.rejects(svc.publicKey(), (e) => e.getStatus() === 503 && /не тот/.test(e.message))
  // Половины не сходятся (запись поправили руками)
  const broken = new LicencesService(fakeAdmin({ id: 'main', privateKey: other.privateKey, publicKey: pinned.publicKey }))
  broken.pin = pinned.publicKey
  quiet(broken)
  await assert.rejects(broken.publicKey(), (e) => e.getStatus() === 503 && /испорчен/.test(e.message))
})

test('ключ на месте и закреплён: код выпускается и читается этим ключом', async () => {
  const k = L.makeKeys()
  const db = fakeAdmin({ id: 'main', ...k })
  const svc = new LicencesService(db)
  svc.pin = k.publicKey
  quiet(svc)
  assert.equal((await svc.publicKey()).key, k.publicKey)
  const made = await svc.issue({ computer: PC, kind: 'activate', until: yearOn(), registers: 2 }, 'acc1')
  const read = L.readCode(k.publicKey, L.parseComputerCode(PC), made.code)
  assert.equal(read.ok, true)
  assert.equal(L.dateOfDay(read.fields.until), yearOn())
  assert.equal(db.state.creates, 0)
  assert.equal(db.state.audit.length, 1)
  assert.ok(!JSON.stringify(db.state.audit).includes(k.privateKey))
})

test('дата кода: несуществующий день — отказ, а не другой день; «навсегда» и дата вместе — отказ', async () => {
  const k = L.makeKeys()
  const svc = new LicencesService(fakeAdmin({ id: 'main', ...k }))
  svc.pin = k.publicKey
  quiet(svc)
  const year = new Date().getUTCFullYear() + 1
  for (const bad of [`${year}-02-31`, `${year}-13-01`, `${year}-04-31`, `${year}-00-10`]) {
    await assert.rejects(svc.issue({ computer: PC, kind: 'activate', until: bad, registers: 1 }), (e) => e.getStatus() === 400 && /Такого дня нет/.test(e.message), bad)
  }
  assert.throws(() => L.dayOf('2026-02-29'), /такого дня нет/)
  assert.equal(L.dateOfDay(L.dayOf('2028-02-29')), '2028-02-29')
  await assert.rejects(svc.issue({ computer: PC, kind: 'activate', until: yearOn(), forever: true, registers: 1 }), (e) => e.getStatus() === 400 && /Выберите одно/.test(e.message))
  const forever = await svc.issue({ computer: PC, kind: 'activate', forever: true, registers: 1 })
  assert.equal(forever.until, null)
})
