// ── Ключи входа ──
//
// На сайте ключ входа лежит в хранилище браузера, и прочитать его может любой
// сценарий на странице. В программе он живёт здесь, в основной части, и в окно
// не попадает вовсе: окно знает только, что вход выполнен.
//
// На диск ключи пишутся зашифрованными средствами самой Windows (DPAPI): открыть
// файл может только та же учётная запись Windows на том же компьютере. Скопировать
// файл на флешку и войти с него в другом месте не получится.
//
// ── Почему ключей несколько и почему выход их не стирает ──
// Касса работает и без интернета: сотрудник входит по паролю, который проверяется
// на месте, и нового ключа при этом не получает — его выдаёт только сервер.
// Чтобы сделанное без связи потом ушло на сервер, программе нужен ключ этого
// сотрудника, полученный при прошлом входе с интернетом. Поэтому хранится ключ
// каждого, кто входил на этом компьютере, а выход убирает только пометку «сейчас
// работает такой-то».
//
// Окну от этого не легче: без пометки основная часть не выполняет ни одного его
// запроса, а поставить пометку можно только верным паролем.
//
// Шифровальщик передаётся снаружи — так этот модуль проверяется без запуска программы.

const VERSION = 2

export function createSessionStore({ file, cipher, fs }) {
  let active = ''
  let tokens = {}

  // Прочитать сохранённое при запуске. Любая неудача — «входа нет»: файл могли
  // перенести с другого компьютера, повредить или оставить от прежней версии.
  // Падать из-за этого нельзя — человек просто войдёт заново.
  function load() {
    active = ''
    tokens = {}
    try {
      if (!cipher.available()) return ''
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw?.v !== VERSION || typeof raw.data !== 'string') return ''
      const data = JSON.parse(cipher.decrypt(Buffer.from(raw.data, 'base64')))
      if (data && typeof data === 'object' && data.tokens && typeof data.tokens === 'object') {
        for (const [id, token] of Object.entries(data.tokens)) {
          if (typeof token === 'string' && token) tokens[id] = token
        }
        if (typeof data.active === 'string') active = data.active
      }
    } catch {
      active = ''
      tokens = {}
    }
    return get()
  }

  function save() {
    // Шифрования нет (такого на Windows быть не должно) — всё остаётся только
    // в памяти и проживёт до закрытия программы. Открытым текстом на диск не пишем
    // никогда: лучше попросить пароль ещё раз, чем оставить ключ лежать в файле.
    if (!cipher.available()) return
    try {
      if (!active && !Object.keys(tokens).length) {
        for (const f of [file, file + '.tmp']) fs.rmSync(f, { force: true })
        return
      }
      const data = cipher.encrypt(JSON.stringify({ active, tokens })).toString('base64')
      // Сначала во временный файл, потом подмена: если программу закроют посреди
      // записи, прежний файл останется целым
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, data }), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch {
      /* диск недоступен — состояние остаётся в памяти до закрытия программы */
    }
  }

  // Ключ того, кто сейчас работает. Пусто — никто не вошёл или ключа у него нет
  const get = () => (active && tokens[active]) || ''

  return {
    load,
    get,
    // Вошёл ли кто-нибудь. Ключа при этом может и не быть: вход без интернета
    has: () => !!active,
    activeId: () => active,
    tokenOf: (id) => tokens[id] || '',

    // Сервер выдал ключ этому сотруднику
    setToken(id, token) {
      if (!id) return
      if (typeof token === 'string' && token) tokens[id] = token
      else delete tokens[id]
      save()
    },

    // Этот сотрудник вошёл и работает
    activate(id) {
      active = typeof id === 'string' ? id : ''
      save()
    },

    // Выход: за кассой больше никого. Ключи остаются — ими уйдёт на сервер то,
    // что было сделано без связи
    deactivate() {
      if (!active) return
      active = ''
      save()
    },

    // Сервер больше не принимает ключ этого сотрудника (сменили пароль, закрыли
    // учётную запись, вышел срок). Держать его незачем
    drop(id) {
      delete tokens[id]
      if (active === id) active = ''
      save()
    },

    // Стереть всё — для проверок и на случай, когда программу отдают другой аптеке
    clear() {
      active = ''
      tokens = {}
      save()
    },
  }
}
