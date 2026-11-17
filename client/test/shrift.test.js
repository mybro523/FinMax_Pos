// ── Размер шрифта (1.7.7): пределы и шаг, надписи меню не выходят за плитку ──
import test from 'node:test'
import assert from 'node:assert/strict'
import { MENU, SISTEMA, procent } from '../src/lib/shrift.js'
import { hubSizes } from '../src/lib/hubFont.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

test('проценты: в пределах и шагом 10; мусор — 100', () => {
  assert.equal(procent(130, SISTEMA), 130)
  assert.equal(procent(200, SISTEMA), 150)
  assert.equal(procent(50, SISTEMA), 80)
  assert.equal(procent(64, MENU), 70)
  assert.equal(procent(166, MENU), 160)
  assert.equal(procent('мусор', MENU), 100)
  assert.equal(procent(null, SISTEMA), 100)
})

test('надписи меню: крупнее и мельче по настройке, но в плитку помещаются', () => {
  const em = (s) => s.length * 0.62
  const tiles = ['Панель управления', 'Отложенные штрихкоды', 'Инвентаризация', 'Отчёт ОПУ'].map((name) => ({ words: name.split(' ').map(em), badgeEm: null }))
  const box = { w: 220, h: 140 }
  const a = hubSizes({ box, tiles, space: 0.28, gold: null, menu: 1 })
  const big = hubSizes({ box, tiles, space: 0.28, gold: null, menu: 1.6 })
  const small = hubSizes({ box, tiles, space: 0.28, gold: null, menu: 0.7 })
  assert.ok(big.fs > a.fs && big.fs <= big.max, `${big.fs} > ${a.fs}`)
  assert.ok(small.fs < a.fs, `${small.fs} < ${a.fs}`)
})

// ── 17.11.2026: единицы окна под масштабом ──
// «Размер шрифта системы» — zoom у <html>, а zoom увеличивает и vh/vw: при 120 % главное меню и
// касса вылезали за экран. Поэтому в стилях единица окна идёт только через --vh / --vw
// (lib/shrift.js ставит их при масштабе не 100 %; без них — обычные vh и vw)
test('стили: vh и vw только через --vh / --vw (иначе при 120 % меню и касса вылезают за экран)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // комментарии
    .replace(/@supports\s*\([^)]*\)/g, '') // условия @supports (там 100dvh — проверка, а не размер)
    .replace(/var\(--v[hw],\s*1d?v[hw]\)/g, '') // правильная запись
  const bare = css.match(/[\d.]+d?v[hw]\b/g) || []
  assert.deepEqual(bare, [], 'в index.css есть единицы окна мимо --vh / --vw: ' + bare.join(', '))
})
