// ── Сборка для Windows 7 и 8: подготовка папки desktop/legacy ──
//
// Та же программа на старом движке: Electron 22 — последняя версия, которая работает в
// Windows 7, 8 и 8.1. Исходники общие (desktop/src). Отличия старого движка:
//   • он не запускает основную часть из модулей .mjs — она собирается в один файл
//     src/main.cjs для Node 16 (esbuild, тот же, что собирает интерфейс);
//   • у него нет protocol.handle и net.fetch — для этого в исходниках есть запасные пути
//     (protocol.mjs, fetch-compat.mjs), они включаются сами;
//   • файл базы данных (better-sqlite3) — своей версии, под Electron 22 (legacy/package.json).
// Всё остальное — интерфейс, окно покупателя, шрифты, значки — кладётся сюда как есть.
import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const LEGACY_ELECTRON = '22.3.27'
// Что сценарий кладёт в папку старой сборки (и стирает перед каждой сборкой)
export const GENERATED = ['src', 'renderer', 'assets', 'build-config.json']

// Основная часть одним файлом для Node 16 (Electron 22). Пакеты из node_modules не
// вшиваются: у старой сборки они свои (legacy/node_modules). import.meta.url в CommonJS
// нет — подставляется адрес самого файла, и пути программы считаются как раньше
export function bundleOptions({ desktop, legacy }) {
  return {
    entryPoints: [join(desktop, 'src', 'main.mjs')],
    outfile: join(legacy, 'src', 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node16.17',
    packages: 'external',
    define: { 'import.meta.url': '__finmaxMetaUrl' },
    banner: { js: "const __finmaxMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  }
}

export async function prepareLegacy({ desktop, client, legacy, buildConfig }) {
  for (const g of GENERATED) rmSync(join(legacy, g), { recursive: true, force: true })
  const esbuild = createRequire(join(client, 'package.json'))('esbuild')
  await esbuild.build(bundleOptions({ desktop, legacy }))
  // Окна загружают эти файлы сами (preload, страница экрана покупателя) — как есть
  for (const f of ['preload.cjs', 'customer-preload.cjs']) cpSync(join(desktop, 'src', f), join(legacy, 'src', f))
  cpSync(join(desktop, 'src', 'screen'), join(legacy, 'src', 'screen'), { recursive: true })
  cpSync(join(desktop, 'renderer'), join(legacy, 'renderer'), { recursive: true })
  cpSync(join(desktop, 'assets', 'fonts'), join(legacy, 'assets', 'fonts'), { recursive: true })
  for (const f of ['icon.png', 'icon.ico']) cpSync(join(desktop, 'assets', f), join(legacy, 'assets', f))
  writeFileSync(join(legacy, 'build-config.json'), JSON.stringify(buildConfig, null, 2) + '\n', 'utf8')
}
