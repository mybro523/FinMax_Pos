// ── Упаковки и штуки ──
//
// Та же арифметика, что на сервере (server/src/common/stock.ts) и в интерфейсе
// (client/src/lib/units.js): остаток считается в ШТУКАХ, а упаковки и «вскрытая»
// получаются из него делением. Три копии одной формулы — плохо, но у каждой свой
// дом: сервер, окно и основная часть программы друг друга не видят. Чтобы копии
// не разъехались, их сверяет проверка (test/local-units.test.mjs).

export const uppOf = (p) => Math.max(1, Math.trunc(Number(p?.unitsPerPack)) || 1)

// Штуки → «целых упаковок» и «штук во вскрытой». Меньше нуля не бывает:
// отрицательный остаток показывать нечем, а считать с ним дальше нельзя
export function splitUnits(units, upp) {
  const u = Math.max(0, Math.trunc(Number(units)) || 0)
  const p = Math.max(1, Math.trunc(Number(upp)) || 1)
  return { stock: Math.floor(u / p), looseUnits: u % p }
}

export const packsToUnits = (stock, looseUnits, upp) =>
  (Math.trunc(Number(stock)) || 0) * Math.max(1, Math.trunc(Number(upp)) || 1) + (Math.trunc(Number(looseUnits)) || 0)

// Целое число не меньше нуля из того, что прислало окно
export const wholeNonNeg = (v) => Math.max(0, Math.trunc(Number(v) || 0))
