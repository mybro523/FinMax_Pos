// ── Чью смену можно закрыть ──
// Свою — всегда, если есть право открывать и закрывать смены. Чужую — только с правом
// «Смена кассы: закрыть смену другого сотрудника»; владелец может всегда. Сервер и
// программа для Windows проверяют то же самое (server/src/shifts/closer.ts,
// desktop/src/local/ops/shift.mjs) — здесь лишь прячется кнопка, которая всё равно
// получила бы отказ.

// Открыл ли смену этот сотрудник. Смена хранит сотрудника магазина (userId) и его имя;
// только что открытая на сайте, ещё без ответа сервера, — номер учётной записи
export function isOwnShift(shift, user) {
  if (!shift || !user) return false
  if (shift.userId && (shift.userId === user.tenantUserId || shift.userId === user.id)) return true
  const opener = shift.user?.name
  return !!opener && opener === user.name
}

// can — проверка прав вошедшего (useCan)
export function canCloseShift(shift, user, can) {
  if (!shift || !user || !can('shift.open')) return false
  if (can('shift.closeAny')) return true
  // Кто открыл — неизвестно (смена из прежней версии): закрыть может любой, кому можно
  if (!shift.userId && !shift.user) return true
  return isOwnShift(shift, user)
}

// Кто открыл смену — для подсказки «закрыть её может он сам или владелец»
export const shiftOpenerName = (shift) => shift?.user?.name || ''
