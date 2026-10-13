// ── Весы с печатью этикеток ──
//
// Магазинные весы печатают этикетку со штрихкодом EAN-13, в котором зашито не
// «что за товар», а конкретное взвешивание: ПП ККККК ВВВВВ К — префикс, код
// товара (как он вбит в весы), вес в граммах и контрольная цифра. Касса узнаёт
// такие коды по префиксу, находит весовой товар по коду и кладёт в чек точный вес.
//
// Настройка живёт на этом устройстве (localStorage): весы общие на точку, и
// задать префикс нужно один раз на каждой кассе — как и принтер.
//
// Расширение в пути указано намеренно: файл загружается и проверками, без сборщика.
import { isVesovoy } from './units.js'

const KEY = 'apteka_vesy'

export const VESY_PUSTO = { on: false, prefix: '22', codeLen: 5 }

const chislo = (v, def) => (Number.isInteger(Number(v)) ? Number(v) : def)

function chistka(v) {
  const r = v && typeof v === 'object' ? v : {}
  const prefix = /^\d{2}$/.test(String(r.prefix)) ? String(r.prefix) : VESY_PUSTO.prefix
  const codeLen = [4, 5, 6].includes(chislo(r.codeLen, 5)) ? chislo(r.codeLen, 5) : 5
  return { on: r.on === true, prefix, codeLen }
}

export function getVesy() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? chistka(JSON.parse(raw)) : { ...VESY_PUSTO }
  } catch {
    return { ...VESY_PUSTO } // приватный режим или испорченная запись
  }
}

export function saveVesy(v) {
  const clean = chistka(v)
  try {
    localStorage.setItem(KEY, JSON.stringify(clean))
  } catch {
    /* негде хранить — настройка просто не переживёт перезапуск */
  }
  return clean
}

// Разобрать штрихкод с этикетки весов. Не этикетка — null, и касса ищет товар
// как обычно. Контрольную цифру не перепроверяем: её уже проверил сканер.
export function parseVesEtiketku(raw, cfg = getVesy()) {
  if (!cfg?.on) return null
  const s = String(raw || '').trim()
  if (!/^\d{13}$/.test(s) || !s.startsWith(cfg.prefix)) return null
  const code = s.slice(cfg.prefix.length, cfg.prefix.length + cfg.codeLen)
  const grams = parseInt(s.slice(cfg.prefix.length + cfg.codeLen, 12), 10)
  if (!grams || grams <= 0) return null
  return { code, grams }
}

// Весовой товар по коду с этикетки. В весы код вбивают без ведущих нулей,
// а в штрихкоде они есть — принимаем оба написания
export function productPoVesKodu(products, code) {
  const bezNuley = String(code).replace(/^0+/, '') || String(code)
  return (
    (products || []).find(
      (p) => isVesovoy(p) && (String(p.barcode) === bezNuley || String(p.barcode) === String(code)),
    ) || null
  )
}
