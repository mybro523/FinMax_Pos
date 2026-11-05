// ── Основной или запасной адрес сервера в программе (apibase.mjs, 1.6.5) ──
//
// 04.11.2026 у регистратора домена отказали DNS: api.finmaxpos.tj перестал находиться, и кассы
// остались без связи, хотя сервер работал под своим именем у OVH. Программа, как и сайт,
// спрашивает оба адреса и работает через тот, что ответил. Выбор адреса — один файл на сайт и
// программу; подробно его поведение проверяет client/test/apiBase.test.js, здесь — что файлы
// не разошлись, и главное в двух словах.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBaseChooser } from '../src/apibase.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Переводы строк git может заменить при выгрузке — сравниваем текст, а не байты
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const P = 'https://api.finmaxpos.tj/api'
const F = 'https://vps-04688c58.vps.ovh.net/api'
const never = () => new Promise(() => {})

test('выбор адреса в программе — тот же файл, что на сайте', () => {
  assert.equal(
    text(join(here, '..', 'src', 'apibase.mjs')),
    text(join(here, '..', '..', 'client', 'src', 'db', 'apiBase.js')),
    'desktop/src/apibase.mjs и client/src/db/apiBase.js разошлись — скопируйте исправленный в другой',
  )
})

test('основной не находится — запасной; оба молчат — «сервер недоступен»', async () => {
  const c1 = createBaseChooser({ primary: P, fallback: F, probe: (b) => (b === F ? true : Promise.reject(new TypeError('net::ERR_NAME_NOT_RESOLVED'))) })
  assert.equal(await c1.ready(), F)
  assert.equal(c1.reachable(), true)
  c1.stop()

  const c2 = createBaseChooser({ primary: P, fallback: F, probe: () => false })
  assert.equal(await c2.ready(), P)
  assert.equal(c2.reachable(), false)
})

test('основной «висит», как при сбое DNS, — запасной после короткой форы', async () => {
  const c = createBaseChooser({ primary: P, fallback: F, probe: (b) => (b === F ? true : never()) })
  const t0 = Date.now()
  assert.equal(await c.ready(), F)
  assert.ok(Date.now() - t0 < 1000, 'ждали ' + (Date.now() - t0) + ' мс')
  c.stop()
})
