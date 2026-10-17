-- ── Бонус от продаж за выбранные дни ──
--
-- Месяц зарплаты бывает не календарным: сотрудник вышел 10-го, или в магазине
-- зарплату считают с 10-го по 9-е. У сотрудника — с какого числа начинается его
-- месяц (1–28, по умолчанию 1-го), у выдачи зарплаты — за какие дни считали бонус.
--
-- ВАЖНО: нынешней программе миграция не мешает: новые столбцы она не читает.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "salaryDay" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "bonusFrom" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "bonusTo" TEXT NOT NULL DEFAULT '';
