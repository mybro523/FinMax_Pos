-- ── Тип товара, данные сотрудника для зарплаты, зарплата по сотруднику ──
--
-- Три доработки одной миграцией, потому что выкладываются вместе:
--   1. Тип товара (медицинский, продукты, бытовая химия…). Список ведёт владелец, как
--      категории. Отметка «с аналогами» решает, показывать ли в карточке поле аналогов:
--      у лекарства аналоги есть, у шампуня их не ищут.
--   2. Данные сотрудника для зарплаты: ФИО, оклад и бонус — процент от его продаж.
--   3. Зарплата по сотруднику: у расхода «Зарплата» запоминается, кому её выдали.
--
-- ВАЖНО: нынешней программе миграция не мешает. Новые колонки заполнены по умолчанию,
-- новую таблицу прежняя программа не читает.

-- ── 1. Тип товара ──
CREATE TABLE IF NOT EXISTS "ProductType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    -- Показывать в карточке товара поле «Аналоги»
    "analogs" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductType_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductType_name_key" ON "ProductType"("name");

-- Тип у товара хранится названием, как категория. Пусто — тип не выбран
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT '';

-- ── 2. Данные сотрудника ──
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fullName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "salary" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- Бонус — процент от суммы его продаж за месяц
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bonusPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- ── 3. Кому выдана зарплата ──
-- Имя запоминается снимком: сотрудника могут переименовать или удалить, а в истории
-- расходов должно остаться, кому выдали деньги тогда
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "employeeId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "employeeName" TEXT NOT NULL DEFAULT '';

-- ── Журнал изменений: список типов доходит до программы для Windows ──
-- Функция журнала заведена в схеме магазина миграцией 20261004 (sync_log_change).
-- Триггер — до готового списка: тогда и он попадает в журнал как обычное изменение
DROP TRIGGER IF EXISTS "ProductType_sync_log" ON "ProductType";
CREATE TRIGGER "ProductType_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "ProductType"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();

-- Готовый список типов. Заводится один раз: тип, убранный владельцем, при следующем
-- запуске сервера не вернётся
INSERT INTO "ProductType" ("id", "name", "analogs") VALUES
  ('pt_med', 'Медицинский', true),
  ('pt_produkty', 'Продукты', false),
  ('pt_himiya', 'Бытовая химия', false),
  ('pt_kosmetika', 'Косметика', false),
  ('pt_hoz', 'Хозтовары', false),
  ('pt_elektronika', 'Электроника', false),
  ('pt_prochee', 'Прочее', false)
ON CONFLICT ("name") DO NOTHING;
