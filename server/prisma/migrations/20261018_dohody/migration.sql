-- ── Доходы вне продаж ──
--
-- Магазин получает деньги не только за товар: сдаёт часть помещения, оказывает
-- услуги, получает бонус от поставщика. Раньше такие деньги в программу было не
-- внести, и чистый доход в отчёте ОПУ получался меньше настоящего. Теперь доходы
-- вносятся так же, как расходы, а отчёт прибавляет их к чистому доходу.
--
-- В денежный ящик смены доход не попадает: наличные, положенные в ящик, вносятся
-- в смене «Внесением». Поэтому у дохода нет ни отметки «из кассы», ни смены.
--
-- ВАЖНО: нынешней программе миграция не мешает. Новые таблицы она не читает.

CREATE TABLE IF NOT EXISTS "Income" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Income_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Income_clientId_key" ON "Income"("clientId");
CREATE INDEX IF NOT EXISTS "Income_date_idx" ON "Income"("date");

DO $$ BEGIN
  ALTER TABLE "Income" ADD CONSTRAINT "Income_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Статьи доходов ──
-- Доход хранит статью названием, как расход. Удалили статью — прежние доходы
-- остаются с её названием: история не меняется задним числом.
CREATE TABLE IF NOT EXISTS "IncomeCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomeCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IncomeCategory_name_key" ON "IncomeCategory"("name");

-- ── Журнал изменений: доходы и статьи доходят до программы для Windows ──
-- Функция журнала заведена в схеме магазина миграцией 20261004 (sync_log_change).
-- Триггеры — до готового списка: тогда и он попадает в журнал как обычное изменение
DROP TRIGGER IF EXISTS "Income_sync_log" ON "Income";
CREATE TRIGGER "Income_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Income"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
DROP TRIGGER IF EXISTS "IncomeCategory_sync_log" ON "IncomeCategory";
CREATE TRIGGER "IncomeCategory_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "IncomeCategory"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();

-- Готовый список, с которого начинает каждый магазин. Заводится один раз: статья,
-- убранная владельцем, при следующем запуске сервера не вернётся
INSERT INTO "IncomeCategory" ("id", "name") VALUES
  ('inccat-arenda', 'Аренда'),
  ('inccat-uslugi', 'Услуги'),
  ('inccat-bonus', 'Бонус от поставщика'),
  ('inccat-prochie', 'Прочие доходы')
ON CONFLICT ("name") DO NOTHING;
