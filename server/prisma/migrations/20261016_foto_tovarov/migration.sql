-- Фото товара: сжатый кадр строкой data:image/jpeg (пусто -- фото нет)
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "image" TEXT NOT NULL DEFAULT '';
