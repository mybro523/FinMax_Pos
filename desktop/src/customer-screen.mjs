// ── Экран покупателя: правила без окон ──
//
// Второй экран моноблока — сторона покупателя: товары в корзине и итог, после оплаты —
// «Спасибо за покупку!» и сдача. Окно кассы присылает сюда готовые строки (с переводом и
// деньгами — как на чеке), программа показывает их на втором экране (customer-window.mjs).
// Здесь — что выбрать и что пропустить; модуль проверяется обычными тестами.

// Где показывать: сам на втором экране, выключен или на выбранном экране
export const SCREEN_MODES = ['auto', 'off', 'pick']

// Настройка этого компьютера (settings.json). Экран — номер экрана Windows строкой
export function sanitizeCustomer(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const mode = SCREEN_MODES.includes(v.mode) ? v.mode : 'auto'
  const display = typeof v.display === 'string' && /^-?\d{1,20}$/.test(v.display) ? v.display : ''
  return { mode, display }
}

// ── Какой экран отдать покупателю ──
// displays — экраны Windows ({ id, bounds }), mainId — экран, на котором окно кассы.
// Экран кассы покупателю не отдаётся никогда: иначе окно покупателя закрыло бы кассу.
// Выбранного экрана больше нет (отключили) — берётся другой свободный
export function pickDisplay(cfg, displays, mainId) {
  const c = sanitizeCustomer(cfg)
  if (c.mode === 'off') return null
  const free = (Array.isArray(displays) ? displays : []).filter((d) => d && d.bounds && String(d.id) !== String(mainId))
  if (c.mode === 'pick') {
    const chosen = free.find((d) => String(d.id) === c.display)
    if (chosen) return chosen
  }
  return free[0] || null
}

// ── Что показать ──
// Только строки и только с пределами: окно покупателя ничего не считает и ничего не
// разбирает — оно показывает то, что собрало окно кассы
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
export const SCREEN_VIEWS = ['idle', 'cart', 'thanks', 'test']
const LABELS = ['welcome', 'total', 'discount', 'thanks', 'change', 'test']
export const MAX_ITEMS = 300

export function sanitizeScreenState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const mode = SCREEN_VIEWS.includes(s.mode) ? s.mode : 'idle'
  const src = s.labels && typeof s.labels === 'object' ? s.labels : {}
  const labels = {}
  for (const k of LABELS) labels[k] = str(src[k], 80)
  const withItems = mode === 'cart' || mode === 'test'
  const items = withItems && Array.isArray(s.items)
    ? s.items.slice(0, MAX_ITEMS).map((i) => ({ name: str(i?.name, 200), sub: str(i?.sub, 160), sum: str(i?.sum, 40) }))
    : []
  return {
    mode,
    // Язык подписей — как в программе (подписи присылает окно кассы уже переведёнными)
    lang: s.lang === 'tj' ? 'tj' : 'ru',
    shop: str(s.shop, 120),
    labels,
    items,
    discount: withItems ? str(s.discount, 40) : '',
    total: mode === 'idle' ? '' : str(s.total, 40),
    change: mode === 'thanks' ? str(s.change, 40) : '',
  }
}
