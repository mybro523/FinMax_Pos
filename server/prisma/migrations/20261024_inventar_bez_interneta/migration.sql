-- ── Инвентаризация — и без интернета ──
--
-- Программа для Windows теперь заводит, считает и применяет листы пересчёта без связи,
-- а листы, заведённые на сайте, получает обменом. Для этого изменения листов попадают в
-- журнал изменений: сам лист — обычным триггером, а строки листа — триггером, который
-- пишет номер ЛИСТА (касса получает лист целиком). Строк в листе бывают тысячи, поэтому
-- триггер строк — на весь запрос, а не на каждую строку: одна запись журнала на лист,
-- иначе один пересчёт склада переполнял бы журнал и заставлял кассы забирать всё заново.
--
-- ВАЖНО: нынешней программе миграция не мешает: новых данных она не читает.

DROP TRIGGER IF EXISTS "Inventory_sync_log" ON "Inventory";
CREATE TRIGGER "Inventory_sync_log" AFTER INSERT OR UPDATE OR DELETE ON "Inventory"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_change"();

-- Функции — в схеме этого магазина и привязаны к ней (как sync_log_change, миграция 20261004)
DO $do$
DECLARE
  s TEXT := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_inventory_items_new"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      INSERT INTO "ChangeLog" ("tbl", "rowId", "op")
      SELECT DISTINCT 'Inventory', "inventoryId", 'U' FROM new_rows;
      RETURN NULL;
    END
    $body$
  $f$, s);

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_inventory_items_old"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      INSERT INTO "ChangeLog" ("tbl", "rowId", "op")
      SELECT DISTINCT 'Inventory', "inventoryId", 'U' FROM old_rows;
      RETURN NULL;
    END
    $body$
  $f$, s);
END
$do$;

DROP TRIGGER IF EXISTS "InventoryItem_sync_ins" ON "InventoryItem";
CREATE TRIGGER "InventoryItem_sync_ins" AFTER INSERT ON "InventoryItem"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "sync_log_inventory_items_new"();

DROP TRIGGER IF EXISTS "InventoryItem_sync_upd" ON "InventoryItem";
CREATE TRIGGER "InventoryItem_sync_upd" AFTER UPDATE ON "InventoryItem"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "sync_log_inventory_items_new"();

DROP TRIGGER IF EXISTS "InventoryItem_sync_del" ON "InventoryItem";
CREATE TRIGGER "InventoryItem_sync_del" AFTER DELETE ON "InventoryItem"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "sync_log_inventory_items_old"();
