-- Весовой товар: строка прихода хранит и штуки (граммы) сверх целых упаковок
ALTER TABLE "ArrivalItem" ADD COLUMN IF NOT EXISTS "pieces" INTEGER NOT NULL DEFAULT 0;
