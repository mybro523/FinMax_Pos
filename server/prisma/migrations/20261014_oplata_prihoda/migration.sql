-- Приход помнит, чем заплатили: из кассы, наличными, картой или в долг
ALTER TABLE "Arrival" ADD COLUMN IF NOT EXISTS "payMethod" TEXT NOT NULL DEFAULT '';
