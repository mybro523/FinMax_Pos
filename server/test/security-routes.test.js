// ── Статический аудит защит на маршрутах ──
//
// Глобальный guard закрывает всё, что не помечено @Public(). Этот тест прибивает
// правила, которые нельзя нарушать молча:
//   • @Public() разрешён только белому списку (вход и проверка живости) —
//     новый «открытый» маршрут обязан попасть сюда осознанно, через правку теста;
//   • всё в src/admin — только для владельца сервиса (@Roles('superadmin')),
//     кроме явно service-wide разделов самой учётки;
//   • разделы с чужими деньгами и настройками несут @Perm на классе или методах.
//
// Запуск: npm test (в папке server)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'src')
const controllers = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.controller.ts')) controllers.push(p)
  }
})(SRC)

const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(p, 'utf8')

test('контроллеры вообще нашлись (иначе проверки ниже проверяют пустоту)', () => {
  assert.ok(controllers.length >= 15, `найдено ${controllers.length}`)
})

test('@Public() только у белого списка', () => {
  // Открытые без входа: корень/health и сам вход. Всё.
  const ALLOWED = new Set(['app.controller.ts', 'auth/auth.controller.ts'])
  const offenders = controllers.filter((p) => read(p).includes('@Public(') && !ALLOWED.has(rel(p)))
  assert.deepEqual(offenders.map(rel), [], 'новый @Public() маршрут — осознанное решение: добавьте его в белый список этого теста')
})

test('всё в admin/ — только владельцу сервиса', () => {
  const offenders = controllers
    .filter((p) => rel(p).startsWith('admin/'))
    .filter((p) => !read(p).includes("@Roles('superadmin')"))
  assert.deepEqual(offenders.map(rel), [], 'контроллер панели без @Roles(superadmin) открыт любой аптеке')
})

test('чувствительные разделы закрыты правами (@Perm)', () => {
  // У этих корней каждое действие обязано спрашивать право: деньги, сотрудники,
  // роли, копии, настройки, устройства
  const MUST = ['users/', 'roles/', 'backup/backup.controller.ts', 'expenses/', 'suppliers/', 'categories/']
  const offenders = []
  for (const p of controllers) {
    const r = rel(p)
    if (!MUST.some((m) => r.startsWith(m))) continue
    const code = read(p)
    const classPerm = /@Perm\([^)]*\)\s*(?:@[A-Za-z]+\([^)]*\)\s*)*export class/.test(code) || /@Controller\([^)]*\)\s*(?:@[A-Za-z()'",.\s]+)*@Perm\(/.test(code)
    if (classPerm || code.includes('@Roles(')) continue
    // Каждый ИЗМЕНЯЮЩИЙ метод обязан нести @Perm. Чтение своей аптеки остаётся
    // за глобальным guard: список категорий, к примеру, нужен кассиру на кассе
    const mutators = [...code.matchAll(/@(Post|Patch|Delete)\(/g)].length
    const perms = [...code.matchAll(/@Perm\(/g)].length
    if (perms < mutators) offenders.push(`${r}: изменяющих методов ${mutators}, @Perm ${perms}`)
  }
  assert.deepEqual(offenders, [], 'метод без @Perm в чувствительном разделе')
})

test('схема аптеки нигде не берётся из параметров запроса', () => {
  // Схему диктует ТОЛЬКО подписанный токен (TenantContextMiddleware).
  // Любое runInTenant с чем-то из req — дыра между аптеками.
  const offenders = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
        const code = read(p)
        for (const m of code.matchAll(/runInTenant\(\s*([^,)]+)/g)) {
          const arg = m[1].trim()
          if (/req\.|body|params|query|headers/i.test(arg)) offenders.push(`${rel(p)}: runInTenant(${arg})`)
        }
      }
    }
  })(SRC)
  assert.deepEqual(offenders, [], 'схема из запроса вместо токена')
})
