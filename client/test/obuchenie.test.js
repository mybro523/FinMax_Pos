// ── Обучение и туры: у каждого раздела есть урок, у каждой метки — настоящий элемент ──
//
// Обучение живёт отдельным файлом от меню и от страниц, и они обязаны сходиться.
// Добавят новый раздел — он молча останется без объяснения. Переименуют кнопку или
// уберут метку — тур будет подсвечивать пустоту. Эти проверки ловят оба случая.
//
// Запуск: npm test (в папке client)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBUCHENIE, OBSHIY_TUR } from '../src/lib/obuchenie.js'
import { OBUCHENIE_TG } from '../src/lib/obuchenie-tg.js'
import { translate, setLang } from '../src/lib/i18n.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// Адреса разделов вытаскиваем из исходников, а не переписываем сюда руками:
// список, переписанный вручную, устаревает первым
const navBlock = () => {
  const src = read('src/components/Layout.jsx')
  const start = src.indexOf('export const NAV = [')
  return src.slice(start, src.indexOf('\n]', start))
}

const адресаМеню = () => [...navBlock().matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1])
const группыМеню = () => [...navBlock().matchAll(/section:\s*'([^']+)'/g)].map((m) => m[1])
const spec = (s) => (typeof s === 'string' ? { t: s } : s || {})

test('у каждого пункта меню есть свой урок', () => {
  // Сам раздел обучения объяснять не надо — человек уже в нём
  const меню = адресаМеню().filter((to) => to !== '/obuchenie')
  const уроки = OBUCHENIE.map((u) => u.to)
  const без = меню.filter((to) => !уроки.includes(to))
  assert.deepEqual(без, [], `разделы без обучения: ${без.join(', ')}`)
})

test('лишних уроков нет — обучение не рассказывает о несуществующем', () => {
  const меню = адресаМеню()
  const лишние = OBUCHENIE.map((u) => u.to).filter((to) => !меню.includes(to))
  assert.deepEqual(лишние, [], `уроки про исчезнувшие разделы: ${лишние.join(', ')}`)
})

test('права разделов в обучении те же, что в меню', () => {
  // Иначе обучение соврёт кассиру о его правах: расскажет про отчёты,
  // которые он всё равно не откроет
  const праваМеню = Object.fromEntries(
    [...navBlock().matchAll(/to:\s*'([^']+)'[^\n]*?(?:perm:\s*'([^']+)'|(owner): true)/g)].map((m) => [m[1], m[2] || m[3]]),
  )
  const праваУроков = Object.fromEntries(OBUCHENIE.filter((u) => u.perm || u.owner).map((u) => [u.to, u.perm || 'owner']))
  assert.deepEqual(праваУроков, праваМеню, 'обучение и меню по-разному решают, кому что видно')
})

test('в каждом уроке есть все четыре части и они не пустые', () => {
  // Урок из одной строчки бесполезен: человек пришёл именно потому,
  // что короткого объяснения ему не хватило
  assert.ok(OBUCHENIE.length >= 15, `уроков подозрительно мало: ${OBUCHENIE.length}`)
  for (const u of OBUCHENIE) {
    assert.ok(u.zachem && u.zachem.length > 40, `в уроке ${u.to} нет объяснения, зачем раздел`)
    assert.ok(u.ekran.length >= 2, `в уроке ${u.to} объяснено меньше двух элементов`)
    assert.ok(u.shagi.length >= 1, `в уроке ${u.to} нет шагов`)
    assert.ok(u.oshibki.length >= 1, `в уроке ${u.to} нет частых ошибок`)
  }
})

test('уроки написаны по-человечески, без слов из кода', () => {
  // Программистские слова в тексте для продавца — признак, что писали наспех
  const текст = текстВсего().join(' ')
  const плохие = ['localStorage', 'endpoint', 'валидац', 'сущность', 'рендер', 'data-tour']
  for (const w of плохие) {
    assert.ok(!текст.includes(w), `в обучении встретилось слово «${w}» — продавцу оно ничего не говорит`)
  }
})

// ── Метки тура ──
//
// Тур подсвечивает живой элемент по его метке data-tour. Метка в уроке без метки
// в разметке — это шаг, который навсегда покажет «этого на экране нет», хотя
// кнопка на месте. Проверяем по исходникам страниц, а не в браузере: так ошибка
// ловится при каждом прогоне, а не только когда кто-то пройдёт этот тур руками.
const разметка = () => {
  const dir = join(ROOT, 'src')
  return readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith('.jsx'))
    .map((f) => readFileSync(join(dir, String(f)), 'utf8'))
    .join('\n')
}

const меткиТуров = () => {
  const out = new Set(['page.title', 'topbar.help'])
  for (const u of OBUCHENIE) {
    for (const [, , s] of u.ekran) {
      const x = spec(s)
      if (x.t) out.add(x.t)
      if (x.open) out.add(x.open)
    }
  }
  for (const s of OBSHIY_TUR) if (s.t) out.add(s.t)
  return [...out]
}

test('каждая метка тура указывает на настоящий элемент в разметке', () => {
  const src = разметка()
  const адреса = адресаМеню()
  const группы = группыМеню()
  const нет = меткиТуров().filter((id) => {
    // Пункты и группы меню размечаются в цикле по списку меню — сверяем со списком
    if (id.startsWith('nav:')) return !адреса.includes(id.slice(4))
    if (id.startsWith('grp:')) return !группы.includes(id.slice(4))
    // Кнопки разделов настроек размечаются в цикле по списку разделов
    if (id.startsWith('set.nav-')) return !разделыНастроек().includes(id.slice('set.nav-'.length))
    return !src.includes(`data-tour="${id}"`) && !src.includes(`tour="${id}"`)
  })
  assert.deepEqual(нет, [], `тур указывает в пустоту — таких меток нет на страницах: ${нет.join(', ')}`)
})

const разделыНастроек = () => {
  const src = read('src/pages/Settings.jsx')
  assert.ok(src.includes("data-tour={'set.nav-' + r.id}"), 'у кнопок разделов настроек пропала метка тура')
  return [...src.matchAll(/\{ id: '([a-z]+)', label:/g)].map((m) => m[1])
}

test('метки в цикле меню на месте', () => {
  // Метки плиток и групп главного экрана ставятся не буквально, а в цикле — проверяем сам цикл
  const home = read('src/pages/Home.jsx')
  assert.ok(home.includes("data-tour={'nav:' + n.to}"), 'у плиток меню пропала метка тура')
  assert.ok(home.includes('data-tour-grp={g.section}'), 'у заголовков групп меню пропала метка тура')
  assert.ok(home.includes('data-tour-grp={n.группа}'), 'у плиток меню пропала метка группы')
})

test('тур никогда не нажимает кнопки, которые что-то сохраняют', () => {
  // Тур открывает формы кнопкой open. Если в open окажется «Провести продажу»
  // или «Удалить», обучение само проведёт продажу или сотрёт товар
  const опасные = /pay|submit|save|delete|remove|apply|clear|close|export|create|draft|block|password|pick/
  const нажимает = []
  for (const u of OBUCHENIE) {
    for (const [, , s] of u.ekran) {
      const x = spec(s)
      if (x.open && опасные.test(x.open)) нажимает.push(`${u.to}: ${x.open}`)
    }
  }
  assert.deepEqual(нажимает, [], 'тур открывает формы кнопками, которые меняют данные')
})

test('общий тур короткий и начинается с приветствия', () => {
  // Тур на сто шагов при первом входе бросают на тридцатом. Подробности — в турах разделов
  assert.ok(OBSHIY_TUR.length >= 10 && OBSHIY_TUR.length <= 16, `в общем туре ${OBSHIY_TUR.length} шагов`)
  assert.ok(!OBSHIY_TUR[0].t, 'первый шаг общего тура должен стоять по центру — это приветствие')
})

// ── Всё на таджикском ──
//
// Общая проверка перевода видит только надписи прямо в коде страниц. Текст уроков
// и туров подставляется из файла данных, и она его не замечает вовсе: при
// таджикском языке обучение осталось бы русским, и ни одна проверка бы не упала.
function текстВсего() {
  const all = []
  for (const u of OBUCHENIE) {
    all.push(u.zachem)
    for (const [что, зачем, s] of u.ekran) {
      all.push(что, зачем)
      const x = spec(s)
      if (x.missing) all.push(x.missing)
    }
    all.push(...u.shagi, ...u.oshibki)
  }
  for (const s of OBSHIY_TUR) {
    if (s.title) all.push(s.title)
    if (s.text) all.push(s.text)
    if (s.tip) all.push(s.tip)
  }
  return [...new Set(all)]
}

// Слова, которые по-таджикски пишутся ровно так же, как по-русски: заимствования.
// Перевод у них совпадает с исходником не по забывчивости, а по правде языка.
// Список явный и короткий намеренно — «похоже на заимствование» угадывать нельзя,
// иначе под эту гребёнку тихо проскочит настоящая непереведённая фраза
const ОДИНАКОВЫЕ = new Set(['Камера', 'Штрихкод', 'Категория', 'Касса'])

test('весь текст уроков и туров переведён на таджикский', () => {
  setLang('tg')
  try {
    const без = текстВсего().filter((s) => {
      if (ОДИНАКОВЫЕ.has(s)) return false
      const tg = OBUCHENIE_TG[s] ?? translate(s)
      return !tg || tg === s
    })
    assert.deepEqual(без.slice(0, 10), [], `без перевода осталось ${без.length}, например: ${без.slice(0, 3).join(' | ')}`)
  } finally {
    setLang('ru')
  }
})

test('в словаре уроков нет переводов к исчезнувшему тексту', () => {
  // Поправили русскую фразу, а старый перевод остался висеть — и новая фраза
  // уже без перевода. Лишние ключи и есть такие осиротевшие переводы
  const есть = new Set(текстВсего())
  const лишние = Object.keys(OBUCHENIE_TG).filter((k) => !есть.has(k))
  assert.deepEqual(лишние.slice(0, 10), [], `переводы к тексту, которого больше нет: ${лишние.length}`)
})

test('перевод действительно таджикский, а не вставленный русский', () => {
  // Длинная таджикская фраза почти не обходится без ӣ ӯ ҳ қ ҷ ғ. Их отсутствие
  // значит, что в перевод по ошибке вставили исходный русский текст
  const подозрительные = Object.entries(OBUCHENIE_TG)
    .filter(([ru, tg]) => ru.length > 40 && !/[ӣӯҳқҷғӢӮҲҚҶҒ]/.test(tg))
    .map(([ru]) => ru.slice(0, 50))
  assert.deepEqual(подозрительные, [], 'эти переводы не похожи на таджикский')
})
