-- ── Коды активации программы без интернета (версия 1.6.0) ──
-- Ключ подписи кодов (один на сервис) и запись о выпущенных кодах

CREATE TABLE "LicenceKey" (
    "id" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LicenceKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LicenceCode" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "computer" TEXT NOT NULL,
    "until" TIMESTAMP(3),
    "registers" INTEGER NOT NULL DEFAULT 0,
    "serial" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "code" TEXT NOT NULL,
    "byAccountId" TEXT,
    "byName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LicenceCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LicenceCode_computer_idx" ON "LicenceCode"("computer");
CREATE INDEX "LicenceCode_createdAt_idx" ON "LicenceCode"("createdAt");
