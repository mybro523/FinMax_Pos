// ── Подделки токена: все способы обязаны получать отказ ──
//
// Токен — единственный пропуск в данные магазина, и схема базы берётся из него.
// Поэтому каждый известный способ подделки прибит здесь тестом: сломанная
// подпись, подпись чужим ключом, перешитая схема внутри, истёкший срок,
// мусор вместо токена. Пропустить любую из этих строк — значит открыть дверь.
//
// Запуск: npm test (в папке server)
const test = require('node:test')
const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'LzYWQDeljex41vT2QJ05i5dFyxiFemsOfSDJiw38B99L'
const { AuthService } = require('../dist/auth/auth.service')

const svc = new AuthService({}, {})
const payload = { sub: 'acc1', sch: 'tenant_demo', role: 'founder' }

const forge = (body, secret) => {
  const b = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', secret).update(b).digest('base64url')
  return `${b}.${sig}`
}

test('настоящий токен проходит', () => {
  const t = svc.sign(payload)
  const p = svc.verify(t)
  assert.ok(p && p.sub === 'acc1' && p.sch === 'tenant_demo')
})

test('подпись чужим ключом — отказ (чужой сервер не выпишет нам пропуск)', () => {
  const t = forge({ ...payload, iat: Date.now() }, 'another-secret-another-secret-123456')
  assert.equal(svc.verify(t), null)
})

test('перешитая схема внутри токена ломает подпись — отказ', () => {
  // Самая опасная подделка: взять свой честный токен и поменять в нём схему
  // на чужой магазин. Подпись перестаёт сходиться — и это единственная защита,
  // которая обязана держать удар
  const honest = svc.sign(payload)
  const [body, sig] = honest.split('.')
  const data = JSON.parse(Buffer.from(body, 'base64url').toString())
  data.sch = 'tenant_chuzhoy'
  const evil = Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig
  assert.equal(svc.verify(evil), null)
})

test('повреждённая подпись — отказ', () => {
  const t = svc.sign(payload)
  const broken = t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa')
  assert.equal(svc.verify(broken), null)
})

test('истёкший токен (8 дней) — отказ: срок жизни 7 дней', () => {
  const t = svc.sign(payload, Date.now() - 8 * 24 * 3600 * 1000)
  assert.equal(svc.verify(t), null)
  // а 6-дневный ещё жив — касса без интернета неделю не остаётся за бортом
  const alive = svc.sign(payload, Date.now() - 6 * 24 * 3600 * 1000)
  assert.ok(svc.verify(alive))
})

test('особый срок (exp) сильнее общего', () => {
  const t = svc.sign({ ...payload, exp: Date.now() - 1000 })
  assert.equal(svc.verify(t), null)
})

test('мусор вместо токена — отказ без исключений', () => {
  for (const bad of ['', 'abc', 'a.b.c', 'Bearer x', '..', 'ðŸ”¥', 'null.null', forge(payload, '')]) {
    assert.equal(svc.verify(bad), null, `пропущен мусорный токен: ${bad}`)
  }
})

test('токен без iat — отказ (возраст обязан проверяться)', () => {
  const t = forge({ ...payload }, process.env.AUTH_SECRET)
  assert.equal(svc.verify(t), null)
})
