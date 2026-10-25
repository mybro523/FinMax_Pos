// ── Сборка для Windows 7 и 8 ──
//
// Основная часть собирается в один файл CommonJS для Node 16 (Electron 22 не запускает
// модули .mjs), пакеты берутся из node_modules старой сборки. Проверка «ничего новее
// старого движка» ловит методы и оформление, которых нет в Chrome 108 и Node 16.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleOptions, GENERATED, LEGACY_ELECTRON } from '../scripts/legacy.mjs'
import { CSS_RULES, MAIN_RULES, RENDERER_RULES, scanText } from '../scripts/compat-scan.mjs'
import { CLIENT, DESKTOP } from '../scripts/env.mjs'

test('основная часть для старого движка: один файл CommonJS для Node 16, пакеты — свои', () => {
  const o = bundleOptions({ desktop: '/d', legacy: '/d/legacy' })
  assert.equal(o.format, 'cjs')
  assert.equal(o.platform, 'node')
  assert.equal(o.target, 'node16.17')
  assert.equal(o.bundle, true)
  assert.equal(o.packages, 'external', 'better-sqlite3, electron-updater и прочие — из node_modules старой сборки')
  assert.equal(o.define['import.meta.url'], '__finmaxMetaUrl')
  assert.match(o.banner.js, /pathToFileURL\(__filename\)/)
  assert.match(o.outfile.split('\\').join('/'), /legacy\/src\/main\.cjs$/)
  assert.equal(LEGACY_ELECTRON, '22.3.27')
  assert.deepEqual(GENERATED, ['src', 'renderer', 'assets', 'build-config.json'])
})

test('основная часть и правда собирается для Node 16 — без import.meta и новых методов', async (t) => {
  const req = createRequire(join(CLIENT, 'package.json'))
  let esbuild
  try {
    esbuild = req('esbuild')
  } catch {
    t.skip('нет esbuild (не установлены пакеты client)')
    return
  }
  const out = mkdtempSync(join(tmpdir(), 'legacy-bundle-'))
  const opts = { ...bundleOptions({ desktop: DESKTOP, legacy: out }), logLevel: 'silent' }
  await esbuild.build(opts)
  const file = join(out, 'src', 'main.cjs')
  assert.ok(existsSync(file))
  const code = readFileSync(file, 'utf8')
  assert.deepEqual(scanText('main.cjs', code, MAIN_RULES), [], 'ничего новее Node 16')
  assert.match(code, /require\("electron"\)/)
  assert.match(code, /require\("better-sqlite3"\)/)
  assert.doesNotMatch(code, /^import /m)
})

test('проверка старого движка: находит новое, пропускает заплатки pdf.js и net.fetch', () => {
  assert.equal(scanText('index-1.js', 'a.toSorted((x,y)=>x-y)', RENDERER_RULES)[0]?.what, 'Array.prototype.toSorted (Chrome 110)')
  assert.equal(scanText('index-1.js', 'Object.groupBy(list, f)', RENDERER_RULES).length, 1)
  assert.equal(scanText('index-1.js', 'Promise.try(f)', RENDERER_RULES).length, 1, 'в нашем коде — нельзя')
  assert.deepEqual(scanText('pdf-AbC.js', 'Promise.try(f); AbortSignal.any([a])', RENDERER_RULES), [], 'в pdf.js — заплатки есть')
  assert.deepEqual(scanText('index-1.js', 'a.sort(); b.at(-1); structuredClone(x)', RENDERER_RULES), [], 'это в Chrome 108 есть')
  // Заплатка (client/src/lib/polyfills.js) и проверка наличия — не находка, вызов — находка
  assert.deepEqual(scanText('index-1.js', 'typeof AbortSignal.any!="function"&&(AbortSignal.any=function(e){})', RENDERER_RULES), [])
  assert.equal(scanText('index-1.js', 'const s=AbortSignal.any([a,b])', RENDERER_RULES).length, 1)
  assert.equal(scanText('index-1.css', '.a{color:light-dark(#000,#fff)}', CSS_RULES).length, 1)
  // color-mix: только под @supports — запасное объявление рядом в Chrome 108 не спасает
  assert.equal(scanText('index-1.css', '.a{background:red;background:color-mix(in srgb,var(--x) 50%,transparent)}', CSS_RULES).length, 1)
  assert.deepEqual(scanText('index-1.css', '.a{background:red}@supports (color:color-mix(in srgb,red,red)){.a{background:color-mix(in srgb,var(--x) 50%,transparent)}.b{color:color-mix(in srgb,red,blue)}}.c{color:red}', CSS_RULES), [])
  assert.equal(scanText('index-1.css', '@supports (color:color-mix(in srgb,red,red)){.a{color:red}}.d{color:color-mix(in srgb,red,blue)}', CSS_RULES).length, 1, 'после блока — снова находка')
  assert.equal(scanText('main.cjs', 'await fetch(url)', MAIN_RULES).length, 1, 'fetch без net в Node 16 нет')
  assert.deepEqual(scanText('main.cjs', 'net.fetch(url); x.fetch(y)', MAIN_RULES), [])
  assert.equal(scanText('main.cjs', 'const u = import.meta.url', MAIN_RULES).length, 1)
})
