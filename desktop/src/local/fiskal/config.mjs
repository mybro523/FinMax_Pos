// ── Настройки фискального принтера на этом компьютере ──
//
// Лежат в файле настроек рядом с настройками печати (src/settings.mjs). Выключено по
// умолчанию: у кого устройства нет — ничего не меняется. Адрес — только из сети магазина
// (checkHost), как у чекового принтера: окно не должно превратить принтер в дорогу наружу.
import { checkHost } from '../../print/transport.mjs'
import { isCommodity, isTaxType, isVatCode } from './map.mjs'

export const FISKAL_DEFAULTS = {
  enabled: false,
  host: '',
  port: 8002,
  // Режим налогообложения магазина (СНО) и ставка НДС — один на всё (решение владельца).
  // Предмет расчёта по умолчанию — товар.
  taxType: 'GENERAL',
  vatCode: 'STANDARD',
  commodity: 'GOODS',
}

const portOf = (p) => {
  const n = Math.trunc(Number(p))
  return n >= 1 && n <= 65535 ? n : 8002
}

export function sanitizeFiskal(raw) {
  const v = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: v.enabled === true,
    host: checkHost(v.host),
    port: portOf(v.port),
    taxType: isTaxType(v.taxType) ? v.taxType : 'GENERAL',
    vatCode: isVatCode(v.vatCode) ? v.vatCode : 'STANDARD',
    commodity: isCommodity(v.commodity) ? v.commodity : 'GOODS',
  }
}
