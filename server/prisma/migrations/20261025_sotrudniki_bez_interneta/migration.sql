-- ── Сотрудники и роли без интернета (версия 1.4.16) ──
-- Сотрудник магазина (имя, ФИО, оклад, бонус, день зарплаты) уходит кассам в обмене —
-- для выдачи зарплаты без связи (раздел staff). Изменения пишутся в журнал, как у товаров.
-- Учётные записи и роли живут в базе панели: их касса получает целиком (раздел team).
DROP TRIGGER IF EXISTS "User_sync_log" ON "User";
CREATE TRIGGER "User_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
