// ── Выкладка новой версии: выпуск заводится черновиком и открывается в конце ──
//
// Первая настоящая выкладка оборвалась на одном файле из трёх: упаковщик двумя
// потоками создавал один и тот же выпуск, и второй поток получил от GitHub отказ. А
// выпуск к этой минуте уже был открыт. Здесь стережётся порядок, который этого не
// допускает: выпуск один, заводится заранее и черновиком, а открывается, только когда
// в нём всё, без чего программа в магазине не обновится.
//
// GitHub здесь — заглушка: настоящего ключа и сети проверке не нужно.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkFeedFile, createReleases, expectedAssets, legacyAssets, modernAssets, tagOf } from '../scripts/github-release.mjs'

const TOKEN = 'github_pat_SEKRET-kotoryj-nelzya-pokazyvat'

// Маленький GitHub в памяти: выпуски одного репозитория
function github({ releases = [], status = null } = {}) {
  const g = { releases: releases.map((r) => ({ assets: [], prerelease: false, ...r })), calls: [], nextId: 100 }
  g.fetch = async (url, init = {}) => {
    const method = init.method || 'GET'
    // Загрузка файла в выпуск — на отдельный адрес GitHub
    const up = url.match(/^https:\/\/uploads\.github\.com\/repos\/vladelec\/ustanovshchiki\/releases\/(\d+)\/assets\?name=(.+)$/)
    if (up) {
      g.calls.push({ method, path: 'upload:' + decodeURIComponent(up[2]), type: init.headers?.['Content-Type'] })
      const rel = g.releases.find((r) => r.id === Number(up[1]))
      const name = decodeURIComponent(up[2])
      if (!rel) return { status: 404, text: async () => '{"message":"Not Found"}' }
      if (rel.assets.some((a) => a.name === name)) return { status: 422, text: async () => '{"message":"already_exists"}' }
      const a = { id: g.nextId++, name, size: init.body.length, state: 'uploaded' }
      rel.assets.push(a)
      return { status: 201, text: async () => JSON.stringify(a) }
    }
    const path = url.replace('https://api.github.com/repos/vladelec/ustanovshchiki', '')
    g.calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization })
    const reply = (code, data) => ({ status: code, text: async () => JSON.stringify(data) })
    if (status) return reply(status, { message: 'Bad credentials' })
    if (method === 'GET' && path.startsWith('/releases?')) return reply(200, g.releases)
    if (method === 'POST' && path === '/releases') {
      const body = JSON.parse(init.body)
      // Как настоящий GitHub: открытых выпусков с одной меткой не бывает
      if (!body.draft && g.releases.some((r) => r.tag_name === body.tag_name && !r.draft)) return reply(422, { message: 'Validation Failed' })
      const id = g.nextId++
      const made = { id, assets: [], html_url: `https://github.com/vladelec/ustanovshchiki/releases/tag/${body.tag_name}`, upload_url: `https://uploads.github.com/repos/vladelec/ustanovshchiki/releases/${id}/assets{?name,label}`, ...body }
      g.releases.push(made)
      return reply(201, made)
    }
    const del = path.match(/^\/releases\/assets\/(\d+)$/)
    if (method === 'DELETE' && del) {
      for (const r of g.releases) r.assets = r.assets.filter((a) => a.id !== Number(del[1]))
      return { status: 204, text: async () => '' }
    }
    const m = path.match(/^\/releases\/(\d+)$/)
    if (method === 'PATCH' && m) {
      const rel = g.releases.find((r) => r.id === Number(m[1]))
      if (!rel) return reply(404, { message: 'Not Found' })
      Object.assign(rel, JSON.parse(init.body))
      return reply(200, rel)
    }
    return reply(404, { message: 'Not Found' })
  }
  return g
}
// Паузы между повторами в проверках не ждём — только записываем
const make = (g, pauses = []) => createReleases({ owner: 'vladelec', repo: 'ustanovshchiki', token: TOKEN, fetchImpl: g.fetch, pause: async (ms) => void pauses.push(ms) })
const asset = (name, size = 1000, state = 'uploaded') => ({ name, size, state })
const full = (version) => expectedAssets(version).map((name) => asset(name))

test('выпуск заводится один раз и черновиком — упаковщику остаётся только положить в него файлы', async () => {
  const g = github()
  const r = make(g)
  const first = await r.prepare('1.2.0')
  assert.equal(first.draft, true, 'пока файлы не выложены, магазины выпуск видеть не должны')
  assert.equal(first.tag_name, 'v1.2.0')
  assert.equal(tagOf('1.2.0'), 'v1.2.0')
  // Выкладка оборвалась и её повторили — берётся тот же черновик, второго не заводится
  const again = await r.prepare('1.2.0')
  assert.equal(again.id, first.id)
  assert.equal(g.calls.filter((c) => c.method === 'POST').length, 1)
  assert.deepEqual(g.releases.map((x) => [x.tag_name, x.draft]), [['v1.2.0', true]])
})

test('уже выложенную версию подменить нельзя — нужен новый номер', async () => {
  const g = github({ releases: [{ id: 7, tag_name: 'v1.2.0', draft: false, assets: full('1.2.0') }] })
  await assert.rejects(() => make(g).prepare('1.2.0'), /Версия 1\.2\.0 уже выложена[\s\S]*Увеличьте номер версии/)
  assert.equal(g.calls.filter((c) => c.method !== 'GET').length, 0, 'ничего не создано и не изменено')
  // Другой номер — можно
  assert.equal((await make(g).prepare('1.2.1')).tag_name, 'v1.2.1')
})

test('выпуск открывается, только когда в нём установщик, его карта и описание версии', async () => {
  for (const [what, assets] of [
    ['ничего не выложено', []],
    ['нет описания версии', full('1.2.0').filter((a) => a.name !== 'latest.yml')],
    ['нет установщика', full('1.2.0').filter((a) => !a.name.endsWith('.exe'))],
    ['установщик не докачан', full('1.2.0').map((a) => (a.name.endsWith('.exe') ? { ...a, state: 'starter' } : a))],
    ['пустой файл', full('1.2.0').map((a) => (a.name === 'latest.yml' ? { ...a, size: 0 } : a))],
  ]) {
    const g = github({ releases: [{ id: 7, tag_name: 'v1.2.0', draft: true, assets }] })
    await assert.rejects(() => make(g).publish('1.2.0'), /не открыт: в нём не хватает файлов/, what)
    assert.equal(g.releases[0].draft, true, what + ': выпуск остался черновиком')
    assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 0, what)
  }

  const g = github({ releases: [{ id: 7, tag_name: 'v1.2.0', draft: true, assets: full('1.2.0'), html_url: 'https://github.com/x/y/releases/tag/v1.2.0' }] })
  const done = await make(g).publish('1.2.0')
  assert.equal(done.draft, false)
  assert.deepEqual(g.calls.at(-1), { method: 'PATCH', path: '/releases/7', body: { draft: false, make_latest: 'true' }, auth: 'Bearer ' + TOKEN })
  // Повторный вызов ничего не ломает: выпуск уже открыт
  assert.equal((await make(g).publish('1.2.0')).draft, false)
  assert.equal(g.calls.filter((c) => c.method === 'PATCH').length, 1)
})

test('открывать нечего — так и сказано', async () => {
  await assert.rejects(() => make(github()).publish('1.2.0'), /Выпуск версии 1\.2\.0 не найден/)
})

test('GitHub отказал: причина сказана словами, а ключ в сообщение не попадает', async () => {
  for (const [code, re] of [
    [401, /не принял ключ из GH_TOKEN/],
    [403, /Ключу из GH_TOKEN не разрешено/],
    [404, /Ключу из GH_TOKEN не разрешено/],
    [500, /GitHub отказался показать выпуски \(ответ 500/],
  ]) {
    const g = github({ status: code })
    const err = await make(g).prepare('1.2.0').then(() => null, (e) => e)
    assert.ok(err, 'ответ ' + code)
    assert.match(err.message, re)
    assert.ok(!err.message.includes(TOKEN) && !err.message.includes('SEKRET'), 'ключ попал в сообщение об ошибке')
  }
  // Сети нет вовсе: несколько попыток с паузами — и честный отказ
  const pauses = []
  let tries = 0
  const offline = createReleases({
    owner: 'a', repo: 'b', token: TOKEN, pause: async (ms) => void pauses.push(ms),
    fetchImpl: async () => {
      tries++
      throw new TypeError('fetch failed')
    },
  })
  const err = await offline.prepare('1.2.0').then(() => null, (e) => e)
  assert.match(err.message, /GitHub не отвечает/)
  assert.ok(!err.message.includes('SEKRET'))
  assert.equal(tries, 4, 'первая попытка и три повтора')
  assert.deepEqual(pauses, [2000, 5000, 10000])
})

test('связь моргнула на последнем шаге — выкладка не бросается, запрос повторяется', async () => {
  // Так и вышло при первой настоящей выкладке: все три файла загрузились, а запрос
  // «открыть выпуск» сразу после долгой загрузки не прошёл
  const g = github({ releases: [{ id: 7, tag_name: 'v1.2.0', draft: true, assets: full('1.2.0') }] })
  const real = g.fetch
  let blinks = 2
  g.fetch = async (...args) => {
    if (blinks-- > 0) throw new TypeError('fetch failed')
    return real(...args)
  }
  const pauses = []
  const done = await make(g, pauses).publish('1.2.0')
  assert.equal(done.draft, false, 'выпуск открыт')
  assert.deepEqual(pauses, [2000, 5000])
  // Отказ GitHub — это ответ, а не обрыв: его не повторяют
  const refused = github({ status: 401 })
  const none = []
  await assert.rejects(() => make(refused, none).prepare('1.2.0'), /не принял ключ/)
  assert.deepEqual(none, [])
  assert.equal(refused.calls.length, 1)
})

test('в выпуске ждём обе программы: обычную (latest.yml) и для Windows 7 и 8 (legacy.yml)', () => {
  assert.deepEqual(modernAssets('1.0.0'), ['FinMax-POS-Setup-1.0.0.exe', 'FinMax-POS-Setup-1.0.0.exe.blockmap', 'latest.yml'])
  assert.deepEqual(legacyAssets('1.0.0'), ['FinMax-POS-Setup-1.0.0-Windows-7-8.exe', 'FinMax-POS-Setup-1.0.0-Windows-7-8.exe.blockmap', 'legacy.yml'])
  assert.deepEqual(expectedAssets('1.0.0'), [...modernAssets('1.0.0'), ...legacyAssets('1.0.0')])
})

test('установщик для Windows 7 и 8 кладётся в черновик; без него выпуск не открывается', async () => {
  const g = github()
  const r = make(g)
  await r.prepare('1.5.0')
  const rel = g.releases[0]
  // Упаковщик положил только обычную программу — открывать нельзя
  rel.assets.push(...modernAssets('1.5.0').map((n) => ({ id: g.nextId++, ...asset(n) })))
  await assert.rejects(() => r.publish('1.5.0'), /не хватает файлов — FinMax-POS-Setup-1\.5\.0-Windows-7-8\.exe, FinMax-POS-Setup-1\.5\.0-Windows-7-8\.exe\.blockmap, legacy\.yml/)
  assert.equal(rel.draft, true, 'магазины такой выпуск не видят')
  // Кладём файлы для Windows 7 и 8
  for (const n of legacyAssets('1.5.0')) await r.upload('1.5.0', n, Buffer.alloc(n.endsWith('.yml') ? 300 : 5000), n.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream')
  assert.deepEqual(g.calls.filter((c) => c.path.startsWith('upload:')).map((c) => [c.path, c.type]), [
    ['upload:FinMax-POS-Setup-1.5.0-Windows-7-8.exe', 'application/octet-stream'],
    ['upload:FinMax-POS-Setup-1.5.0-Windows-7-8.exe.blockmap', 'application/octet-stream'],
    ['upload:legacy.yml', 'text/yaml'],
  ])
  // Повтор выкладки: такой же файл уже лежит — второй раз не кладётся
  await r.upload('1.5.0', 'legacy.yml', Buffer.alloc(300), 'text/yaml')
  assert.equal(g.calls.filter((c) => c.path === 'upload:legacy.yml').length, 1)
  // Недокачанный (другого размера) — убирается и кладётся заново
  rel.assets.find((a) => a.name === 'legacy.yml').size = 10
  await r.upload('1.5.0', 'legacy.yml', Buffer.alloc(300), 'text/yaml')
  assert.equal(g.calls.filter((c) => c.method === 'DELETE').length, 1)
  assert.equal(rel.assets.find((a) => a.name === 'legacy.yml').size, 300)
  // Всё на месте — выпуск открывается
  const done = await r.publish('1.5.0')
  assert.equal(done.draft, false)
  // В открытый выпуск подкладывать нельзя
  await assert.rejects(() => r.upload('1.5.0', 'legacy.yml', Buffer.alloc(1)), /уже открыт/)
})

test('описания версий сверяются: та версия и тот установщик — иначе выпуск не выкладывается', () => {
  const latest = 'version: 1.5.0\nfiles:\n  - url: FinMax-POS-Setup-1.5.0.exe\npath: FinMax-POS-Setup-1.5.0.exe\nsha512: x\n'
  const legacy = 'version: 1.5.0\nfiles:\n  - url: FinMax-POS-Setup-1.5.0-Windows-7-8.exe\npath: FinMax-POS-Setup-1.5.0-Windows-7-8.exe\n'
  assert.equal(checkFeedFile(latest, { version: '1.5.0', installer: 'FinMax-POS-Setup-1.5.0.exe' }), '')
  assert.equal(checkFeedFile(legacy, { version: '1.5.0', installer: 'FinMax-POS-Setup-1.5.0-Windows-7-8.exe' }), '')
  // Перепутали: под именем latest.yml — описание программы для Windows 7 и 8
  assert.match(checkFeedFile(legacy, { version: '1.5.0', installer: 'FinMax-POS-Setup-1.5.0.exe' }), /установщик «FinMax-POS-Setup-1\.5\.0-Windows-7-8\.exe»/)
  // Старое описание от прошлой сборки
  assert.match(checkFeedFile(latest.replace('version: 1.5.0', 'version: 1.4.19'), { version: '1.5.0', installer: 'FinMax-POS-Setup-1.5.0.exe' }), /версия 1\.4\.19/)
  assert.match(checkFeedFile('', { version: '1.5.0', installer: 'x' }), /не указана/)
})
