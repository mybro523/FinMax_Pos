-- ── Основа для касс, которые работают без интернета ──
--
-- Программа для Windows продаёт и без связи, а на сервер присылает сделанное позже,
-- пачками. Чтобы это принять и ничего не задвоить, серверу нужны шесть вещей:
--   1) смена своя у каждой кассы — без связи касса не знает, открыта ли смена на соседней;
--   2) список касс;
--   3) память о принятых операциях: повторная отправка той же операции ничего не меняет;
--   4) журнал движений товара: остаток — это сумма движений, а не число, которое
--      кто-то записал последним;
--   5) журнал изменений: касса спрашивает «что изменилось с прошлого раза» и получает
--      только это, а не все товары и чеки заново;
--   6) история цен: по ней видно, была ли у товара цена из чека в момент продажи.
--
-- ВАЖНО: эта миграция ничего не меняет в работе нынешней программы. Новая колонка
-- пуста, новые таблицы никто не читает, журналы пишутся сами. Код, который всем
-- этим пользуется, выкладывается следом — когда миграция пройдёт у всех аптек.

-- ── 1. Смена: у каждой кассы своя ──
-- Пусто — смена открыта на сайте (как раньше, одна на аптеку). Заполнено — на кассе
-- с таким номером.
ALTER TABLE "Shift" ADD COLUMN "deviceId" TEXT;

-- Прежний запрет «одна открытая смена на всю аптеку» заменяется двумя:
-- одна открытая смена на сайте и по одной на каждую кассу.
DROP INDEX IF EXISTS "Shift_one_open_idx";

-- Если в аптеке уже открыто несколько смен (такое бывало до появления запрета),
-- индекс построить нельзя. Пропускаем: аптека остаётся в том же состоянии, что и была.
DO $$
BEGIN
  IF (SELECT count(*) FROM "Shift" WHERE "closedAt" IS NULL AND "deviceId" IS NULL) <= 1 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_web_idx"
      ON "Shift" ((("closedAt" IS NULL))) WHERE "closedAt" IS NULL AND "deviceId" IS NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "Shift_one_open_device_idx"
  ON "Shift" ("deviceId") WHERE "closedAt" IS NULL AND "deviceId" IS NOT NULL;

-- ── 2. Кассы ──
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL DEFAULT '',
    "lastLogin" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- ── 3. Принятые операции ──
-- Номер операции создаётся на кассе. Пришла второй раз — сервер видит номер и
-- отвечает тем же, чем в первый: ни второго чека, ни второго списания.
CREATE TABLE "SyncOp" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "accountId" TEXT,
    "submittedBy" TEXT,
    "docId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SyncOp_deviceId_appliedAt_idx" ON "SyncOp"("deviceId", "appliedAt");

-- ── Расхождения ──
-- Операция кассы уже случилась: товар отдан, деньги взяты. Сервер её не «разрешает»,
-- а записывает. Но если записанное не сходится с тем, что знает он сам, владелец
-- должен это увидеть. Сюда попадает:
--   sale     — продано больше, чем было (две кассы без связи продали одну и ту же
--              последнюю упаковку);
--   writeoff — списано больше, чем числилось;
--   price    — цена в чеке не та, что была в базе в момент продажи (цену сменили,
--              пока касса была без связи, — или кассир продал не по той цене);
--   return   — по чеку вернули больше, чем по нему продали.
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 0,
    "checkPrice" DECIMAL(12,2),
    "basePrice" DECIMAL(12,2),
    "docId" TEXT,
    "deviceId" TEXT,
    "userId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Discrepancy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Discrepancy_resolvedAt_date_idx" ON "Discrepancy"("resolvedAt", "date");

-- ── 4. Журнал движений товара ──
-- Каждое изменение количества в партии — строка: сколько прибавилось или убыло.
-- Пишет его сама база, поэтому мимо журнала не пройдёт ни продажа, ни приход, ни
-- правка остатка руками — какой бы частью программы это ни делалось.
--
-- Время в журналах (здесь и ниже) ставит сама база, и оно всемирное — как во всех
-- остальных таблицах. Обычное «сейчас» дало бы местное время сервера, и журнал
-- разошёлся бы с документами на разницу часовых поясов.
CREATE TABLE "StockMove" (
    "seq" BIGSERIAL NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "units" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("seq")
);
CREATE INDEX "StockMove_productId_seq_idx" ON "StockMove"("productId", "seq");

-- Журнал начинается с того, что лежит на полке сейчас: с этой строки сумма движений
-- товара равна его остатку — и остаётся равной после любой операции.
INSERT INTO "StockMove" ("productId", "batchId", "delta", "units")
SELECT "productId", "id", "units", "units" FROM "Batch" WHERE "units" <> 0;

-- ── 5. Журнал изменений ──
-- Что и в какой записи менялось. txid — номер транзакции: по нему касса получает
-- изменения строго по порядку завершения и ничего не пропускает, даже когда две
-- операции шли одновременно и закончились не в том порядке, в каком начались.
CREATE TABLE "ChangeLog" (
    "seq" BIGSERIAL NOT NULL,
    "txid" BIGINT NOT NULL DEFAULT txid_current(),
    "tbl" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("seq")
);
CREATE INDEX "ChangeLog_txid_idx" ON "ChangeLog"("txid");
CREATE INDEX "ChangeLog_at_idx" ON "ChangeLog"("at");

-- ── 6. История цен ──
-- Касса без интернета продаёт по цене, которую знала в момент продажи, а чек
-- присылает позже. Чтобы его проверить, серверу мало нынешней цены: её могли
-- сменить уже после продажи. Поэтому каждая смена цены записывается — и по чеку
-- видно, была ли у товара в тот момент такая цена.
CREATE TABLE "PriceLog" (
    "seq" BIGSERIAL NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "unitsPerPack" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),

    CONSTRAINT "PriceLog_pkey" PRIMARY KEY ("seq")
);
CREATE INDEX "PriceLog_productId_at_idx" ON "PriceLog"("productId", "at");

-- История начинается с нынешних цен: считаем, что они действуют с заведения товара
INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack", "at")
SELECT "id", "price", GREATEST(1, "unitsPerPack"), "createdAt" FROM "Product";

-- Служебные отметки синхронизации: до какой транзакции журнал уже подчищен
CREATE TABLE "SyncMeta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SyncMeta_pkey" PRIMARY KEY ("key")
);

-- ── Функции, которые ведут журналы ──
-- Создаются в схеме этой аптеки и к ней же привязаны: откуда бы ни пришло изменение,
-- запись ляжет в журнал своей аптеки, а не чужой.
DO $do$
DECLARE
  s TEXT := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_change"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO "ChangeLog" ("tbl", "rowId", "op") VALUES (TG_TABLE_NAME, OLD."id", 'D');
      ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO "ChangeLog" ("tbl", "rowId", "op") VALUES (TG_TABLE_NAME, NEW."id", 'I');
      ELSE
        INSERT INTO "ChangeLog" ("tbl", "rowId", "op") VALUES (TG_TABLE_NAME, NEW."id", 'U');
      END IF;
      RETURN NULL;
    END
    $body$
  $f$, s);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_stock"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."units" <> 0 THEN
          INSERT INTO "StockMove" ("productId", "batchId", "delta", "units")
          VALUES (NEW."productId", NEW."id", NEW."units", NEW."units");
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW."units" <> OLD."units" THEN
          INSERT INTO "StockMove" ("productId", "batchId", "delta", "units")
          VALUES (NEW."productId", NEW."id", NEW."units" - OLD."units", NEW."units");
        END IF;
      ELSE
        IF OLD."units" <> 0 THEN
          INSERT INTO "StockMove" ("productId", "batchId", "delta", "units")
          VALUES (OLD."productId", OLD."id", -OLD."units", 0);
        END IF;
      END IF;
      RETURN NULL;
    END
    $body$
  $f$, s);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_price"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        DELETE FROM "PriceLog" WHERE "productId" = OLD."id";
      ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack")
        VALUES (NEW."id", NEW."price", GREATEST(1, NEW."unitsPerPack"));
      ELSIF NEW."price" <> OLD."price" OR NEW."unitsPerPack" <> OLD."unitsPerPack" THEN
        INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack")
        VALUES (NEW."id", NEW."price", GREATEST(1, NEW."unitsPerPack"));
      END IF;
      RETURN NULL;
    END
    $body$
  $f$, s);
END
$do$;

CREATE TRIGGER "Batch_sync_stock" AFTER INSERT OR UPDATE OR DELETE ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_stock"();

CREATE TRIGGER "Product_sync_price" AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_price"();

CREATE TRIGGER "Product_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Batch_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Batch"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Category_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Category"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Customer_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Customer"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "DeferredBarcode_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "DeferredBarcode"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Sale_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Sale"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "SaleReturn_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "SaleReturn"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Arrival_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Arrival"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "WriteOff_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "WriteOff"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "DebtPayment_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "DebtPayment"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
CREATE TRIGGER "Shift_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Shift"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();
