// Проверка перевода. Забыть перевести надпись легко: интерфейс не ломается, просто
// при таджикском языке остаётся русский текст — и заметить это можно только глазами.
// Тест ловит такое сразу.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translate, setLang } from '../src/lib/i18n.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Все надписи, которые код прогоняет через t('…') или tr('…')
function usedStrings() {
  const out = new Map()
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(jsx|js)$/.test(f) && !p.endsWith('i18n.js')) {
        const code = readFileSync(p, 'utf8')
        for (const m of code.matchAll(/\bt(?:r)?\(\s*'((?:[^'\\]|\\.)*)'/g)) {
          if (!out.has(m[1])) out.set(m[1], p.split(/[\\/]/).slice(-2).join('/'))
        }
      }
    }
  }
  walk(SRC)
  return out
}

// Ключи словаря читаем из исходника: сравнивать перевод с оригиналом нельзя —
// «Касса», «Маржа», «Телефон» в таджикском пишутся так же и выглядели бы пропущенными.
function dictionaryKeys() {
  const src = readFileSync(join(SRC, 'lib', 'i18n.js'), 'utf8')
  const start = src.indexOf('const TG = {')
  const block = src.slice(start, src.indexOf('\n}', start))
  return new Set([...block.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]))
}

test('у каждой надписи интерфейса есть запись в таджикском словаре', () => {
  const keys = dictionaryKeys()
  const missing = []
  for (const [s, where] of usedStrings()) {
    if (!keys.has(s)) missing.push(`${where}: ${JSON.stringify(s)}`)
  }
  assert.deepEqual(missing, [], `без перевода осталось ${missing.length}:\n` + missing.join('\n'))
})

test('русский язык отдаёт исходный текст', () => {
  setLang('ru')
  assert.equal(translate('Касса'), 'Касса')
  assert.equal(translate('Возвраты и потери'), 'Возвраты и потери')
})

test('таджикский язык подставляет перевод', () => {
  setLang('tg')
  assert.equal(translate('Касса'), 'Касса')
  assert.equal(translate('Прибыль'), 'Фоида')
  assert.equal(translate('Возвраты и потери'), 'Баргардонидан ва талафот')
  assert.equal(translate('Долг клиента'), 'Қарзи мизоҷ')
})

test('незнакомый текст возвращается как есть, а не пустым', () => {
  setLang('tg')
  assert.equal(translate('Такой надписи в словаре нет'), 'Такой надписи в словаре нет')
})
