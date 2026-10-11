// ── Хранение ключей входа ──
//
// Ключ входа — это доступ ко всей аптеке на тридцать дней. На диске он обязан
// лежать зашифрованным, а любая беда с файлом (чужой компьютер, оборванная запись,
// мусор) должна кончаться обычным «войдите заново», а не падением программы.
//
// Ключей может быть несколько — по одному на каждого, кто входил на этом компьютере:
// ими уходит на сервер сделанное без связи. «Кто сейчас за кассой» — отдельная
// пометка, и выход снимает только её.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createSessionStore } from '../src/session.mjs'

// Шифровальщик-заглушка. Настоящий (DPAPI) доступен только внутри программы;
// здесь важно лишь, что на диск попадает НЕ исходная строка и что чужой
// шифровальщик прочитать её не может.
function fakeCipher(key = 7, available = true) {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from([...Buffer.from(text, 'utf8')].map((b) => b ^ key)),
    decrypt: (buf) => {
      const out = Buffer.from([...buf].map((b) => b ^ key)).toString('utf8')
      if (!out.startsWith('{')) throw new Error('не расшифровалось')
      return out
    },
  }
}

function tempFile() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'apteka-session-'))
  return { dir, file: join(dir, 'session.json') }
}

const open = (file, cipher = fakeCipher()) => {
  const s = createSessionStore({ file, fs, cipher })
  s.load()
  return s
}

test('вход переживает перезапуск программы', () => {
  const { file } = tempFile()
  const a = open(file)
  assert.equal(a.get(), '')
  assert.equal(a.has(), false)
  a.setToken('acc-1', 'ключ:abc.def')
  a.activate('acc-1')
  assert.equal(a.get(), 'ключ:abc.def')

  // «Перезапуск»: новое хранилище читает тот же файл
  const b = createSessionStore({ file, fs, cipher: fakeCipher() })
  assert.equal(b.load(), 'ключ:abc.def')
  assert.equal(b.has(), true)
  assert.equal(b.activeId(), 'acc-1')
})

test('на диске ключ лежит зашифрованным, а не как есть', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('acc-1', 'ключ:очень-секретный')
  s.activate('acc-1')
  const raw = fs.readFileSync(file, 'utf8')
  assert.equal(raw.includes('очень-секретный'), false, 'ключ записан открытым текстом')
  assert.equal(raw.includes(Buffer.from('ключ:очень-секретный').toString('base64')), false, 'ключ записан просто в base64')
  assert.equal(raw.includes('acc-1'), false, 'даже кто входил — посторонним знать незачем')
})

test('выход убирает только пометку «за кассой»: окно без неё бессильно, ключ остаётся для отправки', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('acc-1', 'ключ:1')
  s.activate('acc-1')
  s.deactivate()
  assert.equal(s.has(), false)
  assert.equal(s.get(), '', 'после выхода запросы окна не должны получать ключ')
  assert.equal(s.tokenOf('acc-1'), 'ключ:1', 'ключ нужен, чтобы отправить сделанное без связи')
  // И после перезапуска — то же самое
  const again = open(file)
  assert.equal(again.has(), false)
  assert.equal(again.get(), '')
  assert.equal(again.tokenOf('acc-1'), 'ключ:1')
  // Повторный выход — не ошибка
  assert.doesNotThrow(() => s.deactivate())
})

test('у каждого сотрудника свой ключ; работает тот, кто сейчас за кассой', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('kassir', 'ключ:кассира')
  s.setToken('vladelec', 'ключ:владельца')
  s.activate('kassir')
  assert.equal(s.get(), 'ключ:кассира')
  s.activate('vladelec')
  assert.equal(s.get(), 'ключ:владельца')
  assert.equal(s.tokenOf('kassir'), 'ключ:кассира')
  // Вошёл без интернета тот, чьего ключа нет: вход есть, ключа нет
  s.activate('novyj')
  assert.equal(s.has(), true)
  assert.equal(s.get(), '')
})

test('сервер отозвал ключ — он стирается, а работавший под ним перестаёт быть «за кассой»', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('a', 'ключ:a')
  s.setToken('b', 'ключ:b')
  s.activate('a')
  s.drop('a')
  assert.equal(s.has(), false)
  assert.equal(s.tokenOf('a'), '')
  assert.equal(s.tokenOf('b'), 'ключ:b', 'чужой ключ не должен пострадать')
  // Отозвали ключ того, кто не за кассой, — работающего это не касается
  s.activate('b')
  s.setToken('a', 'ключ:a2')
  s.drop('a')
  assert.equal(s.activeId(), 'b')
  assert.equal(s.get(), 'ключ:b')
  assert.equal(open(file).tokenOf('a'), '')
})

test('полная очистка стирает всё и убирает файл', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('a', 'ключ:a')
  s.activate('a')
  assert.equal(fs.existsSync(file), true)
  s.clear()
  assert.equal(s.get(), '')
  assert.equal(s.tokenOf('a'), '')
  assert.equal(fs.existsSync(file), false)
  assert.doesNotThrow(() => s.clear())
})

test('пустой ключ равносилен его удалению', () => {
  const { file } = tempFile()
  const s = open(file)
  s.setToken('a', 'ключ:a')
  s.setToken('a', '')
  assert.equal(s.tokenOf('a'), '')
  s.setToken('a', 'ключ:a')
  s.setToken('a', null)
  assert.equal(s.tokenOf('a'), '')
  assert.equal(fs.existsSync(file), false, 'пустое хранилище не оставляет файла')
  // Ключ ни для кого — не записывается
  s.setToken('', 'ключ:ничей')
  assert.equal(fs.existsSync(file), false)
})

test('файл с другого компьютера не читается — человек просто входит заново', () => {
  const { file } = tempFile()
  const mine = open(file, fakeCipher(7))
  mine.setToken('a', 'ключ:abc')
  mine.activate('a')
  // Другая учётная запись Windows — другой шифровальщик
  const other = createSessionStore({ file, fs, cipher: fakeCipher(99) })
  assert.equal(other.load(), '')
  assert.equal(other.has(), false)
  assert.equal(other.tokenOf('a'), '')
})

test('испорченный файл и файл прежней версии не роняют программу', () => {
  const { file } = tempFile()
  const junk = ['', 'не json', '{"v":2}', '{"v":1,"token":"AAAA"}', '{"v":2,"data":5}', '{"v":2,"data":"AAAA"}', '[]', 'null']
  for (const text of junk) {
    fs.writeFileSync(file, text)
    const s = createSessionStore({ file, fs, cipher: fakeCipher() })
    assert.equal(s.load(), '', `на содержимом: ${text}`)
    assert.equal(s.has(), false)
  }
  // Расшифровалось, но внутри не то, что мы писали
  const c = fakeCipher()
  for (const inner of ['{"active":"a"}', '{"active":"a","tokens":"нет"}', '{"active":5,"tokens":{"a":7}}']) {
    fs.writeFileSync(file, JSON.stringify({ v: 2, data: c.encrypt(inner).toString('base64') }))
    const s = createSessionStore({ file, fs, cipher: c })
    assert.equal(s.load(), '', `на содержимом: ${inner}`)
    assert.equal(s.tokenOf('a'), '')
  }
})

test('без шифрования на диск не пишется ничего', () => {
  // Открытым текстом не храним никогда: лучше попросить пароль при следующем запуске
  const { file } = tempFile()
  const s = open(file, fakeCipher(7, false))
  s.setToken('a', 'ключ:abc')
  s.activate('a')
  assert.equal(s.get(), 'ключ:abc', 'до закрытия программы вход должен действовать')
  assert.equal(fs.existsSync(file), false)
  assert.equal(createSessionStore({ file, fs, cipher: fakeCipher(7, false) }).load(), '')
})

test('после записи не остаётся временного файла', () => {
  const { dir, file } = tempFile()
  const s = open(file)
  s.setToken('a', 'ключ:1')
  s.activate('a')
  s.setToken('a', 'ключ:2')
  assert.deepEqual(fs.readdirSync(dir), ['session.json'])
  assert.equal(createSessionStore({ file, fs, cipher: fakeCipher() }).load(), 'ключ:2')
})

test('диск недоступен — вход всё равно работает до закрытия программы', () => {
  const broken = {
    readFileSync: () => {
      throw new Error('EACCES')
    },
    writeFileSync: () => {
      throw new Error('EACCES')
    },
    renameSync: () => {
      throw new Error('EACCES')
    },
    rmSync: () => {
      throw new Error('EACCES')
    },
  }
  const s = createSessionStore({ file: 'x:/нет/session.json', fs: broken, cipher: fakeCipher() })
  assert.equal(s.load(), '')
  assert.doesNotThrow(() => s.setToken('a', 'ключ:abc'))
  assert.doesNotThrow(() => s.activate('a'))
  assert.equal(s.get(), 'ключ:abc')
  assert.doesNotThrow(() => s.clear())
  assert.equal(s.get(), '')
})
