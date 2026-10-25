// ── Проверка: ничего новее старого движка ──
//
// Программа для Windows 7 и 8 работает на Electron 22: окно — Chrome 108, основная часть —
// Node 16. Возможность, которой у них нет (новый метод массива, новая функция цвета в
// оформлении), сломала бы программу только там — и только у магазина. Эта проверка ищет
// такие возможности в собранных файлах и останавливает сборку для Windows 7 и 8.
//
// Что ищем — по имени, без запуска. Если возможность встречается в библиотеке только
// под проверкой «есть ли она» (заплатка, запасной путь), это разрешено списком ALLOW.

// Окно (Chrome 108): методы и функции, которых в нём нет
export const RENDERER_RULES = [
  { re: /\.toSorted\(/, what: 'Array.prototype.toSorted (Chrome 110)' },
  { re: /\.toReversed\(/, what: 'Array.prototype.toReversed (Chrome 110)' },
  { re: /\.toSpliced\(/, what: 'Array.prototype.toSpliced (Chrome 110)' },
  // Ищем вызовы: проверка «есть ли» (typeof X.y) и заплатка (X.y = …) — не находка
  { re: /Object\.groupBy\(/, what: 'Object.groupBy (Chrome 117)' },
  { re: /Map\.groupBy\(/, what: 'Map.groupBy (Chrome 117)' },
  { re: /Promise\.withResolvers\(/, what: 'Promise.withResolvers (Chrome 119)' },
  { re: /Array\.fromAsync\(/, what: 'Array.fromAsync (Chrome 121)' },
  { re: /\.isWellFormed\(|\.toWellFormed\(/, what: 'String.prototype.isWellFormed (Chrome 111)' },
  { re: /URL\.canParse\(|URL\.parse\(/, what: 'URL.canParse / URL.parse (Chrome 120)' },
  { re: /AbortSignal\.any\(/, what: 'AbortSignal.any (Chrome 116)' },
  { re: /Promise\.try\(/, what: 'Promise.try (Chrome 128)' },
  { re: /\.symmetricDifference\(|\.isSubsetOf\(|\.isSupersetOf\(|\.isDisjointFrom\(/, what: 'методы Set (Chrome 122)' },
  { re: /new Intl\.DurationFormat\(/, what: 'Intl.DurationFormat (Chrome 129)' },
]
// color-mix вне проверки @supports. Запасное объявление рядом не спасает: строка с var()
// принимается при разборе, перебивает запасную и только потом оказывается неверной — цвет
// пропадает совсем. Блоки @supports(…color-mix…){…} вырезаются, в остальном color-mix — находка
export function colorMixOutsideSupports(css) {
  let text = String(css)
  for (;;) {
    const at = text.search(/@supports\s*\([^{]*color-mix[^{]*\{/)
    if (at < 0) break
    let i = text.indexOf('{', at)
    let depth = 0
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}' && --depth === 0) break
    }
    text = text.slice(0, at) + text.slice(i + 1)
  }
  return text.indexOf('color-mix(')
}

// Оформление (Chrome 108)
export const CSS_RULES = [
  { find: colorMixOutsideSupports, what: 'color-mix() вне @supports (Chrome 111)' },
  { re: /light-dark\(/, what: 'light-dark() (Chrome 123)' },
  { re: /@starting-style/, what: '@starting-style (Chrome 117)' },
  { re: /@scope\b/, what: '@scope (Chrome 118)' },
  { re: /\bsubgrid\b/, what: 'subgrid (Chrome 117)' },
  { re: /field-sizing/, what: 'field-sizing (Chrome 123)' },
]
// Основная часть (Node 16)
export const MAIN_RULES = [
  { re: /(?<![.\w$])fetch\(/, what: 'fetch без net (Node 18)' },
  { re: /structuredClone\(/, what: 'structuredClone (Node 17)' },
  { re: /\.findLast(Index)?\(/, what: 'Array.prototype.findLast (Node 18)' },
  { re: /\.toSorted\(|\.toReversed\(|\.toSpliced\(/, what: 'новые методы массива (Node 20)' },
  { re: /Object\.groupBy\(|Map\.groupBy\(/, what: 'Object.groupBy (Node 21)' },
  { re: /Array\.fromAsync\(|Promise\.withResolvers\(/, what: 'Array.fromAsync / Promise.withResolvers (Node 22)' },
  { re: /AbortSignal\.any\(/, what: 'AbortSignal.any (Node 20)' },
  { re: /import\.meta/, what: 'import.meta в CommonJS' },
]

// Разрешённые места: файл (начало имени) и правило — то, что встречается только под
// проверкой наличия (заплатки внутри библиотек)
export const ALLOW = [
  // pdf.js (сборка legacy) сам ставит заплатки на эти методы, если их нет (Promise.try —
  // проверено в Chrome 108); AbortSignal.any ставит программа (client/src/lib/polyfills.js)
  { file: /^pdf(\.worker\.min)?-/, what: /Promise\.withResolvers|Promise\.try|AbortSignal\.any|URL\.canParse|URL\.parse|toSorted|toReversed|toSpliced|Set|groupBy|fromAsync|isWellFormed/ },
]

// Всё, что нашлось в папке сборки: окно (assets/*.js, *.css) и основная часть (src/main.cjs)
export function scanBuild({ readdirSync, readFileSync, join }, legacyDir) {
  const found = []
  const assets = join(legacyDir, 'renderer', 'assets')
  for (const f of readdirSync(assets)) {
    if (/\.m?js$/.test(f)) found.push(...scanText(f, readFileSync(join(assets, f), 'utf8'), RENDERER_RULES))
    if (/\.css$/.test(f)) found.push(...scanText(f, readFileSync(join(assets, f), 'utf8'), CSS_RULES))
  }
  found.push(...scanText('main.cjs', readFileSync(join(legacyDir, 'src', 'main.cjs'), 'utf8'), MAIN_RULES))
  return found
}

// Найти в тексте файла: [{ what, at }] — что и где (кусок вокруг)
export function scanText(name, text, rules) {
  const found = []
  for (const r of rules) {
    // Правило — шаблон (re) или своя проверка (find → место находки или -1)
    const index = r.find ? r.find(text) : (r.re.exec(text)?.index ?? -1)
    if (index < 0) continue
    if (ALLOW.some((a) => a.file.test(name) && a.what.test(r.what))) continue
    found.push({ file: name, what: r.what, at: text.slice(Math.max(0, index - 50), index + 60).replace(/\s+/g, ' ') })
  }
  return found
}
