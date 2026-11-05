-- ── Логотип магазина (1.6.4) ──
-- Когда поставили логотип (пусто — логотипа нет) и сама картинка — отдельной таблицей:
-- список магазинов и вход читают Pharmacy постоянно, а картинка нужна только кассам

ALTER TABLE "Pharmacy" ADD COLUMN "logoAt" TIMESTAMP(3);

CREATE TABLE "PharmacyLogo" (
    "pharmacyId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PharmacyLogo_pkey" PRIMARY KEY ("pharmacyId")
);

ALTER TABLE "PharmacyLogo" ADD CONSTRAINT "PharmacyLogo_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
