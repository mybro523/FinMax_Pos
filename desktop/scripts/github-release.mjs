// ── Выпуск на GitHub: завести заранее, открыть в конце ──
//
// Упаковщик (electron-builder) выкладывает файлы несколькими потоками, и каждый, не
// найдя выпуска с нужной меткой, создаёт его сам. Первый создаёт, второй получает от
// GitHub отказ («Published releases must have a valid tag») — и выкладка обрывается на
// полпути: в выпуске один файл из трёх. А выпуск к этой минуте уже открыт, и программы
// в аптеках видят «новую версию», в которой нет установщика.
//
// Поэтому порядок такой:
//   1) до упаковки выпуск заводится здесь, один раз и ЧЕРНОВИКОМ. Потоки упаковщика
//      находят его и только кладут в него файлы;
//   2) после упаковки проверяется, что в выпуске лежит всё, без чего программа не
//      обновится;
//   3) и только тогда черновик открывается. Аптеки видят версию целиком или не видят
//      вовсе.
//
// Чем ходить в сеть, передаётся снаружи — модуль проверяется без GitHub.
// Ключ в сообщения об ошибках не попадает: их читают с экрана и копируют в чат.

const API = 'https://api.github.com'
// Связь с GitHub может моргнуть — особенно сразу после долгой загрузки установщика.
// Из-за одной неудачной попытки бросать выкладку незачем: пробуем ещё, с паузой
const RETRY_PAUSES_MS = [2000, 5000, 10000]

export const tagOf = (version) => 'v' + version

// Без чего программы в магазинах не обновятся. Обычная (Windows 10 и 11) — установщик, его
// «карта» для докачки изменившихся кусков и описание версии latest.yml. Программа для
// Windows 7 и 8 — свои установщик, карта и legacy.yml: с 1.5.0 каждый выпуск несёт обе.
// Без legacy.yml программы на Windows 7 молча перестали бы обновляться
export const modernAssets = (version) => [`FinMax-POS-Setup-${version}.exe`, `FinMax-POS-Setup-${version}.exe.blockmap`, 'latest.yml']
export const legacyAssets = (version) => [`FinMax-POS-Setup-${version}-Windows-7-8.exe`, `FinMax-POS-Setup-${version}-Windows-7-8.exe.blockmap`, 'legacy.yml']
export const expectedAssets = (version) => [...modernAssets(version), ...legacyAssets(version)]

// Описание версии (latest.yml / legacy.yml): та ли в нём версия и тот ли установщик.
// Перепутать их — значит отправить программам на Windows 10 старый движок или программам
// на Windows 7 — новый, который там не запустится. Пусто — всё верно
export function checkFeedFile(text, { version, installer }) {
  const v = /^version:\s*(.+)$/m.exec(String(text || ''))?.[1]?.trim()
  const p = /^path:\s*(.+)$/m.exec(String(text || ''))?.[1]?.trim()
  if (v !== version) return `в нём версия ${v || '— (не указана)'}, а выкладывается ${version}`
  if (p !== installer) return `в нём установщик «${p || '— (не указан)'}», а должен быть «${installer}»`
  return ''
}

export function createReleases({ owner, repo, token, fetchImpl = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const where = `${owner}/${repo}`

  async function call(method, path, body) {
    let res
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchImpl(`${API}/repos/${where}${path}`, {
          method,
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'apteka-desktop-build',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        })
        break
      } catch (e) {
        // Повторяем только то, что не дошло вовсе. Ответ GitHub, каким бы он ни был,
        // — это ответ: его разбирают ниже
        if (attempt >= RETRY_PAUSES_MS.length) throw new Error(`GitHub не отвечает (${e?.message || e}). Проверьте интернет и повторите.`)
        await pause(RETRY_PAUSES_MS[attempt])
      }
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return { status: res.status, data }
  }

  const said = (r) => (r.data?.message ? `: ${r.data.message}` : '')
  function refuse(r, what) {
    if (r.status === 401) return new Error('GitHub не принял ключ из GH_TOKEN: он неверный или его срок истёк. Создайте новый ключ.')
    if (r.status === 403 || r.status === 404) {
      return new Error(`Ключу из GH_TOKEN не разрешено ${what} в репозитории ${where}. Нужен доступ к этому репозиторию с правом «Contents: Read and write».`)
    }
    return new Error(`GitHub отказался ${what} (ответ ${r.status}${said(r)}).`)
  }

  // Выпуск этой версии, если он уже есть. Черновики видны только с ключом
  async function find(version) {
    const tag = tagOf(version)
    for (let page = 1; page <= 5; page++) {
      const r = await call('GET', `/releases?per_page=100&page=${page}`)
      if (r.status !== 200 || !Array.isArray(r.data)) throw refuse(r, 'показать выпуски')
      const hit = r.data.find((x) => x.tag_name === tag)
      if (hit) return hit
      if (r.data.length < 100) break
    }
    return null
  }

  // Завести черновик выпуска — или взять уже начатый (выкладка оборвалась посередине)
  async function prepare(version) {
    const found = await find(version)
    if (found && !found.draft) {
      throw new Error(
        `Версия ${version} уже выложена (${where}). Программы в аптеках могли её скачать, и подменять её файлы нельзя.\n` +
          'Увеличьте номер версии в desktop/package.json (или задайте APTEKA_VERSION) и выложите заново.',
      )
    }
    if (found) return found
    const made = await call('POST', '/releases', { tag_name: tagOf(version), name: version, draft: true, prerelease: false })
    if (made.status !== 201) throw refuse(made, 'завести выпуск')
    return made.data
  }

  // Открыть выпуск аптекам — только когда в нём всё на месте
  async function publish(version) {
    const rel = await find(version)
    if (!rel) throw new Error(`Выпуск версии ${version} не найден в ${where} — выкладывать нечего.`)
    if (!rel.draft) return rel
    const have = new Map((rel.assets || []).map((a) => [a.name, a]))
    const missing = expectedAssets(version).filter((name) => !(have.get(name)?.state === 'uploaded' && have.get(name).size > 0))
    if (missing.length) {
      throw new Error(`Выпуск ${version} не открыт: в нём не хватает файлов — ${missing.join(', ')}.\nОн остался черновиком, аптеки его не видят. Повторите выкладку.`)
    }
    const done = await call('PATCH', `/releases/${rel.id}`, { draft: false, make_latest: 'true' })
    if (done.status !== 200 || done.data?.draft) throw refuse(done, 'открыть выпуск')
    return done.data
  }

  // Положить файл в черновик. Установщик для Windows 7 и 8 собирается отдельно, и в выпуск
  // его кладёт сценарий выкладки, а не упаковщик. Такой же файл уже лежит — не трогаем;
  // недокачанный (оборвалось посередине) — убираем и кладём заново. Не повторяем сами:
  // оборванная загрузка оставляет недокачанный файл, повтор разберётся с ним при новом запуске
  async function upload(version, name, bytes, type = 'application/octet-stream') {
    const rel = await find(version)
    if (!rel) throw new Error(`Выпуск версии ${version} не найден в ${where} — класть файл ${name} некуда.`)
    if (!rel.draft) throw new Error(`Выпуск ${version} уже открыт — подкладывать в него файлы нельзя.`)
    const same = (rel.assets || []).find((a) => a.name === name)
    if (same && same.state === 'uploaded' && same.size === bytes.length) return same
    if (same) {
      const gone = await call('DELETE', `/releases/assets/${same.id}`)
      if (gone.status !== 204) throw refuse(gone, `убрать недокачанный файл ${name}`)
    }
    const url = String(rel.upload_url || '').split('{')[0] + '?name=' + encodeURIComponent(name)
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'apteka-desktop-build', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': type },
        body: bytes,
      })
    } catch (e) {
      throw new Error(`GitHub не отвечает (${e?.message || e}). Проверьте интернет и повторите выкладку.`)
    }
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (res.status !== 201) throw refuse({ status: res.status, data }, `положить файл ${name}`)
    return data
  }

  return { find, prepare, publish, upload }
}
