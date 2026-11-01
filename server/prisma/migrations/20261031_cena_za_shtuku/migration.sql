-- ── Своя цена за 1 шт (версия 1.5.11) ──
-- Владелец задаёт цену одной штуки сам — в приходе или в карточке товара. Целые упаковки
-- продаются по цене упаковки, отдельные штуки — по своей цене. Пусто — как раньше: цена
-- упаковки / штук в упаковке (common/piece.ts).
-- Чек помнит цену штуки, по которой продал (снимок): возврат и отчёты считают по ней.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "piecePrice" DECIMAL(12,2);
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "piecePrice" DECIMAL(12,2);

-- История цен помнит и цену штуки: чек кассы без интернета, пробитый по прежней цене
-- штуки, сверяется с ценой, которая действовала в момент продажи (sync, checkPrices)
ALTER TABLE "PriceLog" ADD COLUMN IF NOT EXISTS "piecePrice" DECIMAL(12,2);

DO $do$
DECLARE
  s TEXT := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_price"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        DELETE FROM "PriceLog" WHERE "productId" = OLD."id";
      ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack", "piecePrice")
        VALUES (NEW."id", NEW."price", GREATEST(1, NEW."unitsPerPack"), NEW."piecePrice");
      ELSIF NEW."price" <> OLD."price" OR NEW."unitsPerPack" <> OLD."unitsPerPack"
         OR NEW."piecePrice" IS DISTINCT FROM OLD."piecePrice" THEN
        INSERT INTO "PriceLog" ("productId", "price", "unitsPerPack", "piecePrice")
        VALUES (NEW."id", NEW."price", GREATEST(1, NEW."unitsPerPack"), NEW."piecePrice");
      END IF;
      RETURN NULL;
    END
    $body$
  $f$, s);
END
$do$;
