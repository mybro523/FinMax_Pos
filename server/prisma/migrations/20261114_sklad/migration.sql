-- ── Склад (1.8.0) ──
--
-- Свой склад магазина: товар, который не помещается в зал. Это отдельный запас —
-- магазин (Product.stock, Batch) его не видит: продажи, сроки, списания и пересчёт
-- работают как прежде. На склад товар попадает приходом «Куда: Склад», в магазин —
-- переносом («приход со своего склада»).
--
-- ВАЖНО: прежним программам миграция не мешает: новые таблицы они не читают, а у
-- прихода новое поле со значением по умолчанию «shop» — как было.

ALTER TABLE "Arrival" ADD COLUMN IF NOT EXISTS "place" TEXT NOT NULL DEFAULT 'shop';

CREATE TABLE IF NOT EXISTS "SkladBatch" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expiryDate" TIMESTAMP(3),
    "arrivalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkladBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SkladBatch_productId_idx" ON "SkladBatch"("productId");
CREATE INDEX IF NOT EXISTS "SkladBatch_arrivalId_idx" ON "SkladBatch"("arrivalId");

DO $$ BEGIN
  ALTER TABLE "SkladBatch" ADD CONSTRAINT "SkladBatch_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SkladMove" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "kind" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL DEFAULT '[]',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "SkladMove_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SkladMove_clientId_key" ON "SkladMove"("clientId");
CREATE INDEX IF NOT EXISTS "SkladMove_date_idx" ON "SkladMove"("date");

DO $$ BEGIN
  ALTER TABLE "SkladMove" ADD CONSTRAINT "SkladMove_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Журнал изменений: склад доходит до программы для Windows ──
-- Функция журнала заведена в схеме магазина миграцией 20261004 (sync_log_change)
DROP TRIGGER IF EXISTS "SkladBatch_sync_log" ON "SkladBatch";
CREATE TRIGGER "SkladBatch_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "SkladBatch"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
DROP TRIGGER IF EXISTS "SkladMove_sync_log" ON "SkladMove";
CREATE TRIGGER "SkladMove_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "SkladMove"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
