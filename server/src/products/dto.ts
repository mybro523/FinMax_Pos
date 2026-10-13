import { Matches, MaxLength, IsArray, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator'

export class CreateProductDto {
  @IsString() name: string
  @IsString() barcode: string
  @IsOptional() @IsString() category?: string
  // Отрицательная цена молча ломает всю денежную часть: такой товар уводит
  // в минус выручку, прибыль и стоимость склада
  @IsOptional() @IsNumber() @Min(0) cost?: number
  @IsOptional() @IsNumber() @Min(0) price?: number
  @IsOptional() @IsInt() @Min(0) stock?: number
  @IsOptional() @IsInt() @Min(0) minStock?: number
  @IsOptional() @IsString() unit?: string
  // Сверху — столько же, сколько принимает обмен с кассами (sync/payload.ts): чек с
  // товаром, у которого штук в упаковке больше, касса прислала бы — и получила бы отказ
  @IsOptional() @IsInt() @Min(1) @Max(100_000) unitsPerPack?: number // штук в упаковке
  @IsOptional() @IsInt() @Min(0) looseUnits?: number // штук во вскрытой упаковке
  @IsOptional() @IsString() dosage?: string // дозировка
  @IsOptional() @IsString() expiryDate?: string // срок годности (ISO-дата или пусто)
  @IsOptional() @IsArray() @IsString({ each: true }) analogIds?: string[] // аналоги (id товаров)
  // Фото: сжатый кадр data:image/…;base64 или пустая строка «фото убрали».
  // Предел длины согласован с клиентом (lib/foto.js) — крупнее сюда не присылают
  @IsOptional() @IsString() @MaxLength(200_000) @Matches(/^$|^data:image\/(jpeg|png|webp);base64,/) image?: string
}

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsString() barcode?: string
  @IsOptional() @IsString() category?: string
  // Отрицательная цена молча ломает всю денежную часть: такой товар уводит
  // в минус выручку, прибыль и стоимость склада
  @IsOptional() @IsNumber() @Min(0) cost?: number
  @IsOptional() @IsNumber() @Min(0) price?: number
  @IsOptional() @IsInt() @Min(0) stock?: number
  @IsOptional() @IsInt() @Min(0) minStock?: number
  @IsOptional() @IsString() unit?: string
  @IsOptional() @IsInt() @Min(1) @Max(100_000) unitsPerPack?: number
  @IsOptional() @IsInt() @Min(0) looseUnits?: number
  @IsOptional() @IsString() dosage?: string
  @IsOptional() @IsString() expiryDate?: string
  @IsOptional() @IsArray() @IsString({ each: true }) analogIds?: string[]
}
