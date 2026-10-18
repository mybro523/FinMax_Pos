// Страница «О компании»: данные с сайта FinMax. Тексты идут через t(переменная), и
// общий тест перевода их не видит — забытый перевод заметили бы только глазами на
// таджикском. Этот тест проверяет данные сам.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPANY, COMPANY_CONTACTS, ICONS8 } from '../src/lib/company.js'
import { translate, setLang } from '../src/lib/i18n.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const DESKTOP_MAIN = join(SRC, '..', '..', 'desktop', 'src', 'main.mjs')

// Ключи словаря — из исходника, как в i18n.test.js: «Контроль» или «Мурод Давлатов»
// могли бы совпасть с переводом и выглядеть пропущенными
function dictionaryKeys() {
  const src = readFileSync(join(SRC, 'lib', 'i18n.js'), 'utf8')
  const start = src.indexOf('const TG = {')
  const block = src.slice(start, src.indexOf('\n}', start))
  return new Set([...block.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]))
}

function pageTexts() {
  return [
    COMPANY.tagline, COMPANY.about, COMPANY.motto,
    ...COMPANY.stats.map((s) => s.label),
    ...COMPANY.services.flatMap((s) => [s.title, s.text, ...s.points]),
    ...COMPANY.automation.flatMap((s) => [s.title, s.text]),
    ...COMPANY.systems,
    COMPANY.founder.name, COMPANY.founder.role, COMPANY.founder.quote,
    ...COMPANY_CONTACTS.map((c) => c.label),
  ]
}

test('услуги — как на сайте: 12 по финансам с двумя пунктами, 4 направления автоматизации', () => {
  assert.equal(COMPANY.services.length, 12)
  assert.equal(new Set(COMPANY.services.map((s) => s.key)).size, 12)
  for (const s of COMPANY.services) {
    assert.ok(s.title && s.text, s.key)
    assert.equal(s.points.length, 2, s.key)
  }
  assert.equal(COMPANY.automation.length, 4)
  assert.equal(new Set(COMPANY.automation.map((s) => s.key)).size, 4)
  for (const s of COMPANY.automation) assert.ok(s.title && s.text, s.key)
})

test('название компании везде пишется FinMax', () => {
  for (const s of pageTexts()) assert.ok(!/финмакс/i.test(s), s)
})

test('у каждого текста страницы есть перевод на таджикский', () => {
  const keys = dictionaryKeys()
  const missing = pageTexts().filter((s) => !keys.has(s))
  assert.deepEqual(missing, [], `без перевода: ${missing.join(' | ')}`)
})

test('у каждой услуги есть свой значок', () => {
  const code = readFileSync(join(SRC, 'pages', 'About.jsx'), 'utf8')
  const map = (name) => {
    const m = code.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))
    assert.ok(m, name)
    return new Set([...m[1].matchAll(/(\w+):/g)].map((x) => x[1]))
  }
  const service = map('SERVICE_ICONS')
  const automation = map('AUTOMATION_ICONS')
  for (const s of COMPANY.services) assert.ok(service.has(s.key), s.key)
  for (const s of COMPANY.automation) assert.ok(automation.has(s.key), s.key)
})

// Программа для Windows открывает ссылки по имени из своего списка (desktop/src/main.mjs):
// поменяли адрес только здесь — в программе осталась бы старая ссылка
test('ссылки «О компании» в программе для Windows ведут туда же, что на сайте', { skip: !existsSync(DESKTOP_MAIN) }, () => {
  const main = readFileSync(DESKTOP_MAIN, 'utf8')
  const start = main.indexOf('const COMPANY_LINKS = {')
  const block = main.slice(start, main.indexOf('\n}', start))
  const links = Object.fromEntries([...block.matchAll(/^\s*(\w+): '([^']+)'/gm)].map((m) => [m[1], m[2]]))
  for (const c of [...COMPANY_CONTACTS, ICONS8]) assert.equal(links[c.key], c.href, c.key)
})

// Картинки главного меню — Icons8 по бесплатной лицензии, а она требует ссылку на их сайт
test('ссылка на Icons8 стоит на странице «О компании»', () => {
  assert.equal(ICONS8.href, 'https://icons8.com')
  const about = readFileSync(join(SRC, 'pages', 'About.jsx'), 'utf8')
  assert.ok(about.includes('href={ICONS8.href}'))
})

test('заголовки блоков делятся на две части — вторая золотом — и по-таджикски тоже', () => {
  for (const lang of ['ru', 'tg']) {
    setLang(lang)
    for (const title of ['Финансовому|управлению', 'Автоматизация|под ваш бизнес']) {
      const parts = translate(title).split('|')
      assert.equal(parts.length, 2, `${lang}: ${translate(title)}`)
      assert.ok(parts.every((p) => p.trim()), `${lang}: ${translate(title)}`)
    }
  }
  setLang('ru')
})
