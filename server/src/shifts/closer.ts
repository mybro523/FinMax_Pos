import { hasPerm } from '../auth/permissions'

// ── Кто может закрыть смену ──
// Тот, кто её открыл, или сотрудник с правом «Смена кассы: закрыть смену другого
// сотрудника». Владелец магазина может всегда. Иначе кассир закрыл бы смену владельца
// (или соседа) и подписал бы своим пересчётом чужие деньги.
//
// Смена без открывшего (открыта до того, как это запоминалось, или сотрудника уже
// удалили) закрывается любым, кому можно закрывать смены: иначе её не закрыл бы никто.
export const NOT_YOUR_SHIFT = 'Эту смену открыл другой сотрудник. Закрыть её может он сам или владелец.'

export type ShiftCloser = { role?: string; permissions?: string[]; tenantUserId?: string | null }

export function mayCloseShift(shift: { userId: string | null }, actor: ShiftCloser): boolean {
  if (hasPerm(actor, 'shift.closeAny')) return true
  if (!shift.userId) return true
  return !!actor.tenantUserId && shift.userId === actor.tenantUserId
}
