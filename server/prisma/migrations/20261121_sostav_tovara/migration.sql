-- ── Состав товара (сырьё), версия 1.8.5 ──
-- Составной товар собирается из сырья — других товаров. При продаже списываются
-- ингредиенты, а не остаток самого товара. forSale = false — сырьё/полуфабрикат:
-- в кассе такого товара нет, но он участвует в приходе, остатках и в составе.

ALTER TABLE "Product" ADD COLUMN "forSale" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "RecipeItem" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "ord" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecipeItem_productId_idx" ON "RecipeItem"("productId");
CREATE INDEX "RecipeItem_ingredientId_idx" ON "RecipeItem"("ingredientId");

ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecipeItem" ADD CONSTRAINT "RecipeItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Смена состава помечает САМ товар изменённым: касса (и сайт) перечитают товар уже с
-- новым составом. Запись идёт в журнал этой же аптеки (функция в её схеме).
DO $do$
DECLARE
  s TEXT := current_schema();
BEGIN
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I."sync_log_recipe"() RETURNS trigger
    LANGUAGE plpgsql SET search_path = %1$I, pg_temp AS $body$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO "ChangeLog" ("tbl", "rowId", "op") VALUES ('Product', OLD."productId", 'U');
      ELSE
        INSERT INTO "ChangeLog" ("tbl", "rowId", "op") VALUES ('Product', NEW."productId", 'U');
      END IF;
      RETURN NULL;
    END
    $body$
  $f$, s);
END
$do$;

CREATE TRIGGER "RecipeItem_sync_recipe" AFTER INSERT OR UPDATE OR DELETE ON "RecipeItem"
  FOR EACH ROW EXECUTE FUNCTION "sync_log_recipe"();
