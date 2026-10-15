// ── Подпись запросов к хранилищу копий ──
// Копии уезжают во внешнее S3-совместимое хранилище, а туда пускают только по
// подписи. Ошибка в подписи выглядит одинаково при любой причине: «отказано»,
// без объяснений. Разбираться с этим ночью, когда копии молча перестали
// сниматься, — худшее из возможных занятий.
//
// Поэтому вывод ключа сверяется с примером из документации AWS: если наша
// реализация верна, значение совпадёт до последнего знака.
//
// Запуск: npm test (в папке server).
process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/apteka'

const test = require('node:test')
const assert = require('node:assert/strict')

const { signingKey, signPut, backupTarget } = require('../dist/backup/backup-storage')

test('вывод ключа подписи совпадает с примером из документации AWS', () => {
  // Опубликованный AWS пример для проверки реализации Signature V4
  const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam')
  assert.equal(key.toString('hex'), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
})

const CFG = {
  endpoint: 'https://acc.r2.cloudflarestorage.com',
  bucket: 'apteka-kopii',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'auto',
}
const AT = new Date('2026-08-22T03:00:00.000Z')
const BODY = Buffer.from('копия магазина', 'utf8')

test('заголовки запроса собраны так, как ждёт хранилище', () => {
  const { url, headers } = signPut(CFG, 'apteka/shifo/den-05.json.gz', BODY, 'application/gzip', AT)

  assert.equal(url, 'https://acc.r2.cloudflarestorage.com/apteka-kopii/apteka/shifo/den-05.json.gz')
  assert.equal(headers['x-amz-date'], '20260822T030000Z', 'время в неверном виде')
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260822\/auto\/s3\/aws4_request/)
  assert.match(headers.Authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/)
  assert.match(headers.Authorization, /Signature=[0-9a-f]{64}$/, 'подпись не шестнадцатеричная или обрезана')
  // Отпечаток тела обязателен: без него хранилище не примет запрос
  assert.match(headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/)
})

test('подпись повторяема — иначе разбираться в отказах было бы нечем', () => {
  const a = signPut(CFG, 'k', BODY, 'application/gzip', AT)
  const b = signPut(CFG, 'k', BODY, 'application/gzip', AT)
  assert.equal(a.headers.Authorization, b.headers.Authorization)
})

test('подпись меняется от каждой мелочи — значит она правда о содержимом', () => {
  const base = signPut(CFG, 'k', BODY, 'application/gzip', AT).headers.Authorization
  const other = [
    signPut(CFG, 'other', BODY, 'application/gzip', AT),
    signPut(CFG, 'k', Buffer.from('другое тело'), 'application/gzip', AT),
    signPut(CFG, 'k', BODY, 'application/json', AT),
    signPut(CFG, 'k', BODY, 'application/gzip', new Date(AT.getTime() + 1000)),
    signPut({ ...CFG, secretKey: 'другой-секрет' }, 'k', BODY, 'application/gzip', AT),
  ].map((r) => r.headers.Authorization)

  for (const [i, sig] of other.entries()) {
    assert.notEqual(sig, base, `подпись не изменилась при изменении #${i + 1} — она что-то не учитывает`)
  }
})

// ── Куда складывать копии ──
// Самое важное здесь — что при отсутствии настроек мы НЕ выбираем «куда-нибудь».
// Копии, которые пишутся на исчезающий диск, хуже отсутствующих: в них верят.
test('без настроек хранилище не выбирается вовсе', () => {
  assert.equal(backupTarget({}), null)
  assert.equal(backupTarget({ BACKUP_S3_ENDPOINT: 'https://x', BACKUP_S3_BUCKET: 'b' }), null, 'половина настроек — это не настройки')
})

test('внешнее хранилище предпочитается папке', () => {
  const t = backupTarget({
    BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
    BACKUP_S3_BUCKET: 'kopii',
    BACKUP_S3_KEY: 'k',
    BACKUP_S3_SECRET: 's',
    BACKUP_DIR: '/data/backups',
  })
  assert.equal(t.kind, 'S3', 'папка на диске не должна перебивать внешнее хранилище')
})

test('папка годится, когда внешнего хранилища нет', () => {
  const t = backupTarget({ BACKUP_DIR: '/data/backups' })
  assert.equal(t.kind, 'папка')
  assert.equal(t.where, '/data/backups')
})
