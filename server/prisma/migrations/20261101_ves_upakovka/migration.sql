-- ── Весовой товар в упаковке (версия 1.5.12) ──
-- Мешок муки 50 кг: в упаковке 50 000 граммов, мешок продаётся по цене мешка, отдельные
-- килограммы — по своей цене за 1 кг или по расчёту (common/piece.ts).
--
-- Строка чека помнит единицу товара (снимок): своя цена дробного товара — за килограмм, а
-- считается она на грамм. Без единицы строку удалённого товара было бы не прочесть.
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "unit" TEXT;

-- Строки прихода и возврата поставщику помнят, сколько штук (граммов) было в упаковке, когда
-- их записали. Иначе смена упаковки (килограмм → мешок 50 кг) задним числом превращала бы
-- «100 кг» прежнего прихода в 100 мешков: при правке прихода и при пересчёте остатка.
ALTER TABLE "ArrivalItem" ADD COLUMN IF NOT EXISTS "unitsPerPack" INTEGER;
ALTER TABLE "SupplierReturnItem" ADD COLUMN IF NOT EXISTS "unitsPerPack" INTEGER;

-- Уже записанные строки — по нынешней упаковке товара: так их и читали до этой версии
UPDATE "ArrivalItem" ai SET "unitsPerPack" = GREATEST(1, p."unitsPerPack")
FROM "Product" p WHERE ai."productId" = p."id" AND ai."unitsPerPack" IS NULL;
UPDATE "SupplierReturnItem" si SET "unitsPerPack" = GREATEST(1, p."unitsPerPack")
FROM "Product" p WHERE si."productId" = p."id" AND si."unitsPerPack" IS NULL;
