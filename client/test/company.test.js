// Страница «О компании»: данные с сайта FinMax. Тексты идут через t(переменная), и
// общий тест перевода их не видит — забытый перевод заметили бы только глазами на
// таджикском. Этот тест проверяет данные сам.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPANY, COMPANY_CONTACTS } from '../src/lib/company.js'
import { translate, setLang } from '../src/lib/i18n.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

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
