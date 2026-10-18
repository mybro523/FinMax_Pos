-- ── Возврат товара поставщику ──
--
-- Просрочку, брак или пересорт отдают поставщику назад. Товар уходит со склада, а
-- деньги поставщик возвращает одним из способов: в счёт долга, в кассу (наличные в
-- ящик смены), наличными мимо кассы или на карту. Для денег «в кассу» у смены своя
-- сумма — supplierRefund: она прибавляется к наличным, которые ждут при закрытии.
--
-- ВАЖНО: нынешней программе миграция не мешает. Новые таблицы и столбец она не читает.

CREATE TABLE IF NOT EXISTS "SupplierReturn" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierId" TEXT,
    "supplier" TEXT NOT NULL DEFAULT '—',
    "total" DECIMAL(12,2) NOT NULL,
    "refund" TEXT NOT NULL DEFAULT 'debt',
    "shiftId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierReturn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupplierReturn_date_idx" ON "SupplierReturn"("date");
CREATE INDEX IF NOT EXISTS "SupplierReturn_supplierId_idx" ON "SupplierReturn"("supplierId");
CREATE INDEX IF NOT EXISTS "SupplierReturn_shiftId_idx" ON "SupplierReturn"("shiftId");

DO $$ BEGIN
  ALTER TABLE "SupplierReturn" ADD CONSTRAINT "SupplierReturn_supplierId_fkey"
    FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierReturn" ADD CONSTRAINT "SupplierReturn_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SupplierReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "pieces" INTEGER NOT NULL DEFAULT 0,
    "price" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "batches" JSONB,

    CONSTRAINT "SupplierReturnItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupplierReturnItem_returnId_idx" ON "SupplierReturnItem"("returnId");
CREATE INDEX IF NOT EXISTS "SupplierReturnItem_productId_idx" ON "SupplierReturnItem"("productId");

DO $$ BEGIN
  ALTER TABLE "SupplierReturnItem" ADD CONSTRAINT "SupplierReturnItem_returnId_fkey"
    FOREIGN KEY ("returnId") REFERENCES "SupplierReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "SupplierReturnItem" ADD CONSTRAINT "SupplierReturnItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Вернули поставщики наличными в эту кассу
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "supplierRefund" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- ── Журнал изменений: возвраты доходят до программы для Windows ──
-- Функция журнала заведена в схеме магазина миграцией 20261004 (sync_log_change).
-- Строки возврата меняются только вместе с ним, поэтому триггер — на самом возврате
DROP TRIGGER IF EXISTS "SupplierReturn_sync_log" ON "SupplierReturn";
CREATE TRIGGER "SupplierReturn_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "SupplierReturn"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
