-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "roleId" TEXT;

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "system" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Role_pharmacyId_idx" ON "Role"("pharmacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_pharmacyId_name_key" ON "Role"("pharmacyId", "name");

-- CreateIndex
CREATE INDEX "Account_roleId_idx" ON "Account"("roleId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

