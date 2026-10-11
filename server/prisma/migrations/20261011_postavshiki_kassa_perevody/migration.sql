-- ── Поставщики, внесение и изъятие наличных, оплата переводом, история товара ──
--
-- Четыре доработки одной миграцией, потому что выкладываются вместе:
--   1. Долги поставщикам. Приход в долг записывается, а кому и сколько аптека должна —
--      не было нигде. Теперь есть справочник поставщиков с долгом, у прихода — поставщик
--      и неоплаченная часть, у оплаты поставщику — свой журнал.
--   2. Внесение и изъятие наличных в смене. Владелец забрал выручку днём или добавил
--      размен — раньше это нельзя было записать никак, и смена «не сходилась».
--   3. Оплата переводом (Alif, DC, Эсхата…) — четвёртый вид оплаты, со своим сервисом.
--   4. Правки остатка в карточке — журналом, чтобы история движения товара была полной.
--
-- ВАЖНО: нынешней программе миграция не мешает. Новые колонки заполнены по умолчанию,
-- новые таблицы никто не читает. Код, который всем этим пользуется, выкладывается
-- следом — когда миграция пройдёт у всех аптек.

-- ── 1. Поставщики ──
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    -- Долг на момент заведения: то, что аптека задолжала до появления раздела
    "openingDebt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- Текущий долг: начальный + неоплаченная часть приходов − оплаты
    "debt" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- Приход: от кого и сколько из него не оплачено сразу (ноль — оплачен полностью,
-- как и все прежние приходы). Кто принял — для истории движения товара
ALTER TABLE "Arrival" ADD COLUMN "supplierId" TEXT;
ALTER TABLE "Arrival" ADD COLUMN "debt" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Arrival" ADD COLUMN "userId" TEXT;
CREATE INDEX "Arrival_supplierId_idx" ON "Arrival"("supplierId");
ALTER TABLE "Arrival" ADD CONSTRAINT "Arrival_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Arrival" ADD CONSTRAINT "Arrival_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Оплата поставщику. «Из кассы» — деньги взяты из ящика открытой смены
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT NOT NULL DEFAULT '',
    "fromCash" BOOLEAN NOT NULL DEFAULT false,
    "shiftId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierPayment_clientId_key" ON "SupplierPayment"("clientId");
CREATE INDEX "SupplierPayment_supplierId_idx" ON "SupplierPayment"("supplierId");
CREATE INDEX "SupplierPayment_date_idx" ON "SupplierPayment"("date");
CREATE INDEX "SupplierPayment_shiftId_idx" ON "SupplierPayment"("shiftId");
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Внесение и изъятие наличных ──
CREATE TABLE "CashMove" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "shiftId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMove_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CashMove_clientId_key" ON "CashMove"("clientId");
CREATE INDEX "CashMove_shiftId_idx" ON "CashMove"("shiftId");
CREATE INDEX "CashMove_date_idx" ON "CashMove"("date");
ALTER TABLE "CashMove" ADD CONSTRAINT "CashMove_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Смена: суммы, которые ведутся и у открытой смены (их видит кассир и получают кассы)
ALTER TABLE "Shift" ADD COLUMN "cashIn" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Shift" ADD COLUMN "cashOut" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Shift" ADD COLUMN "supplierCash" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Shift" ADD COLUMN "salesTransfer" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- Переводы за смену по сервисам: { "Alif": 120, "DC": 40 } — для сверки с выписками
ALTER TABLE "Shift" ADD COLUMN "transferBy" JSONB;

-- ── 3. Оплата переводом ──
ALTER TABLE "Sale" ADD COLUMN "payVia" TEXT;
ALTER TABLE "SaleReturn" ADD COLUMN "refundVia" TEXT;

CREATE TABLE "PayService" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayService_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayService_name_key" ON "PayService"("name");

-- ── 4. Правки остатка в карточке — журналом ──
CREATE TABLE "StockEdit" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromUnits" INTEGER NOT NULL,
    "toUnits" INTEGER NOT NULL,
    "userId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockEdit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockEdit_productId_idx" ON "StockEdit"("productId");
ALTER TABLE "StockEdit" ADD CONSTRAINT "StockEdit_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockEdit" ADD CONSTRAINT "StockEdit_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Журнал изменений: всё это доходит до программы для Windows ──
-- Функция журнала заведена в схеме аптеки миграцией 20261004 (sync_log_change).
-- Триггеры — до готового списка сервисов: тогда и он попадает в журнал, и кассы,
-- обменивавшиеся до миграции, получат его как обычное изменение
CREATE TRIGGER "Supplier_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Supplier"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "SupplierPayment_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "SupplierPayment"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "CashMove_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "CashMove"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "PayService_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "PayService"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();

-- Готовый список сервисов перевода. Заводится один раз: убранный владельцем сервис
-- при следующем запуске сервера не вернётся
INSERT INTO "PayService" ("id", "name", "ord") VALUES
  ('paysvc-alif', 'Alif', 1),
  ('paysvc-dc', 'DC', 2),
  ('paysvc-eskhata', 'Эсхата', 3),
  ('paysvc-humo', 'Humo', 4),
  ('paysvc-amonat', 'Амонат', 5)
ON CONFLICT DO NOTHING;
