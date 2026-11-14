// ── Вход на сайте без интернета: запись, зашифрованная паролем (lib/offlineLogin.js, 14.11.2026) ──
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  saveOfflineLogin,
  openOfflineLogin,
  hasOfflineLogin,
  forgetOfflineLogin,
  STORE_KEY,
  MAX_RECORDS,
  RECORD_DAYS,
} from '../src/lib/offlineLogin.js'

function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  }
}
const USER = { id: 'u1', name: 'kassir1', role: 'cashier', permissions: ['pos.sell'], pharmacy: { code: 'demo', name: 'Шифо' } }

test('верный пароль открывает запись: тот же ключ и «кто я»; логин без учёта регистра и пробелов', async () => {
  const storage = memStorage()
  assert.equal(await saveOfflineLogin({ login: ' Kassir1 ', password: 'kassa12345', token: 'tok-1', user: USER }, { storage }), true)
  assert.equal(hasOfflineLogin('KASSIR1', { storage }), true)
  const r = await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage })
  assert.equal(r.token, 'tok-1')
  assert.deepEqual(r.user, USER)
})

test('ключ входа в хранилище не лежит открытым текстом', async () => {
  const storage = memStorage()
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'SECRET-TOKEN-XYZ', user: USER }, { storage })
  const raw = storage.getItem(STORE_KEY)
  assert.ok(raw && !raw.includes('SECRET-TOKEN-XYZ') && !raw.includes('kassa12345') && !raw.includes('pos.sell'))
})

test('неверный пароль — отказ «password», запись остаётся', async () => {
  const storage = memStorage()
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-1', user: USER }, { storage })
  const r = await openOfflineLogin({ login: 'kassir1', password: 'kassa1234' }, { storage })
  assert.deepEqual(r, { error: 'password' })
  assert.equal(hasOfflineLogin('kassir1', { storage }), true)
})

test('нет записи — «none»; чужой логин — «none»', async () => {
  const storage = memStorage()
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'x' }, { storage }), { error: 'none' })
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-1', user: USER }, { storage })
  assert.deepEqual(await openOfflineLogin({ login: 'kassir2', password: 'kassa12345' }, { storage }), { error: 'none' })
  assert.equal(hasOfflineLogin('kassir2', { storage }), false)
})

test('испорченная запись: битые поля — «broken» и запись убрана; подменённый шифр — как неверный пароль', async () => {
  const storage = memStorage()
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-1', user: USER }, { storage })
  const all = JSON.parse(storage.getItem(STORE_KEY))
  // Подмена байта шифра: AES-GCM это видит
  const d = atob(all.kassir1.data)
  all.kassir1.data = btoa(String.fromCharCode(d.charCodeAt(0) ^ 1) + d.slice(1))
  storage.setItem(STORE_KEY, JSON.stringify(all))
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage }), { error: 'password' })
  // Битые поля
  all.kassir1.iv = '%%%'
  storage.setItem(STORE_KEY, JSON.stringify(all))
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage }), { error: 'broken' })
  assert.equal(hasOfflineLogin('kassir1', { storage }), false)
  // Мусор вместо всего хранилища — не падаем
  storage.setItem(STORE_KEY, '{не json')
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage }), { error: 'none' })
  assert.equal(await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-2', user: USER }, { storage }), true)
  assert.equal((await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage })).token, 'tok-2')
})

test(`не больше ${MAX_RECORDS} записей: уходят самые давние`, async () => {
  const storage = memStorage()
  let t = 1_000_000
  const now = () => t
  for (let i = 1; i <= MAX_RECORDS + 2; i++) {
    t += 1000
    await saveOfflineLogin({ login: 'k' + i, password: 'pw' + i, token: 'tok' + i, user: { ...USER, name: 'k' + i } }, { storage, now })
  }
  const all = JSON.parse(storage.getItem(STORE_KEY))
  assert.equal(Object.keys(all).length, MAX_RECORDS)
  assert.equal('k1' in all || 'k2' in all, false)
  assert.equal((await openOfflineLogin({ login: 'k12', password: 'pw12' }, { storage, now })).token, 'tok12')
})

test(`запись старше ${RECORD_DAYS} дней не открывается; новый вход с интернетом её обновляет`, async () => {
  const storage = memStorage()
  let t = 5_000_000
  const now = () => t
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-1', user: USER }, { storage, now })
  t += (RECORD_DAYS + 1) * 86400000
  assert.equal(hasOfflineLogin('kassir1', { storage, now }), false)
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage, now }), { error: 'none' })
  await saveOfflineLogin({ login: 'kassir1', password: 'kassa12345', token: 'tok-2', user: USER }, { storage, now })
  assert.equal((await openOfflineLogin({ login: 'kassir1', password: 'kassa12345' }, { storage, now })).token, 'tok-2')
})

test('владельцу сервиса записи нет; без пароля или ключа — тоже', async () => {
  const storage = memStorage()
  assert.equal(await saveOfflineLogin({ login: 'admin', password: 'admin12345', token: 't', user: { role: 'superadmin' } }, { storage }), false)
  assert.equal(await saveOfflineLogin({ login: 'k', password: '', token: 't', user: USER }, { storage }), false)
  assert.equal(await saveOfflineLogin({ login: 'k', password: 'p', token: '', user: USER }, { storage }), false)
  assert.equal(storage.getItem(STORE_KEY), null)
})

test('сменили пароль — запись под новым паролем, старым не открыть; «забыть» убирает', async () => {
  const storage = memStorage()
  await saveOfflineLogin({ login: 'kassir1', password: 'old-pass', token: 'tok-1', user: USER }, { storage })
  await saveOfflineLogin({ login: 'kassir1', password: 'new-pass', token: 'tok-2', user: USER }, { storage })
  assert.deepEqual(await openOfflineLogin({ login: 'kassir1', password: 'old-pass' }, { storage }), { error: 'password' })
  assert.equal((await openOfflineLogin({ login: 'kassir1', password: 'new-pass' }, { storage })).token, 'tok-2')
  forgetOfflineLogin('kassir1', { storage })
  assert.equal(hasOfflineLogin('kassir1', { storage }), false)
})
