-- ── Модули магазина (1.8.1) ──
-- Выключенные разделы магазина и кода активации. Пусто — всё включено: магазины и коды,
-- заведённые раньше, работают как прежде

ALTER TABLE "Pharmacy" ADD COLUMN "modulesOff" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "LicenceCode" ADD COLUMN "modulesOff" TEXT[] DEFAULT ARRAY[]::TEXT[];
