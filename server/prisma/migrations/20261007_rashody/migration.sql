-- ── Расходы аптеки ──
--
-- Отчёты показывали прибыль от продаж: выручка минус закупочная цена, минус возвраты и
-- списания. Но аптека тратит деньги и помимо товара — аренда, зарплата, свет, налоги, —
-- и настоящий заработок владелец считал на бумажке. Теперь расходы вносятся в программу,
-- а отчёты показывают чистую прибыль.
--
-- Расход бывает оплачен наличными из кассы. Тогда этих денег в ящике нет, и смена
-- обязана это знать — иначе при закрытии она «не сходится» ровно на сумму расхода.
-- Для этого у расхода есть отметка и смена, а у смены — сумма таких расходов.
--
-- ВАЖНО: эта миграция ничего не меняет в работе нынешней программы. Новая колонка
-- равна нулю, новые таблицы никто не читает. Код, который всем этим пользуется,
-- выкладывается следом — когда миграция пройдёт у всех аптек.

-- ── 1. Смена: сколько наличных ушло из кассы на расходы ──
ALTER TABLE "Shift" ADD COLUMN "expenseCash" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- ── 2. Расходы ──
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "fromCash" BOOLEAN NOT NULL DEFAULT false,
    "shiftId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Expense_clientId_key" ON "Expense"("clientId");
CREATE INDEX "Expense_date_idx" ON "Expense"("date");
CREATE INDEX "Expense_shiftId_idx" ON "Expense"("shiftId");

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. Статьи расходов ──
-- Расход хранит статью названием — как товар хранит категорию. Удалили статью —
-- прежние расходы остаются с её названием: история не должна меняться задним числом.
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- Готовый список, с которого начинает каждая аптека. Заводится здесь, один раз: если
-- владелец уберёт ненужную статью, она не вернётся сама при следующем запуске сервера.
INSERT INTO "ExpenseCategory" ("id", "name") VALUES
  ('expcat-arenda', 'Аренда'),
  ('expcat-zarplata', 'Зарплата'),
  ('expcat-kommunalnye', 'Коммунальные услуги'),
  ('expcat-nalogi', 'Налоги'),
  ('expcat-transport', 'Транспорт'),
  ('expcat-reklama', 'Реклама'),
  ('expcat-hoz', 'Хозяйственные нужды'),
  ('expcat-drugoe', 'Другое')
ON CONFLICT DO NOTHING;

-- ── 4. Журнал изменений: расходы и статьи доходят до программы для Windows ──
-- Функция журнала заведена в схеме аптеки предыдущей миграцией (sync_log_change)
CREATE TRIGGER "Expense_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "ExpenseCategory_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "ExpenseCategory"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
