import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator'

// Штуки база хранит обычным целым числом
const MAX_UNITS = 2_000_000_000
// Деньги в базе — до 9 999 999 999,99
const MAX_MONEY = 9_999_999_999.99

export class SkladLineDto {
  @IsString() @MaxLength(64) productId: string
  // Штук (у весового товара — граммов) — как у партий магазина
  @IsInt() @Min(1) @Max(MAX_UNITS) units: number
}

// Перенос со склада в магазин
export class SkladToShopDto {
  // id документа с кассы без связи или повтор запроса с сайта — второй раз не переносится
  @IsOptional() @IsString() @MaxLength(64) clientId?: string
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => SkladLineDto)
  items: SkladLineDto[]
  @IsOptional() @IsString() @MaxLength(500) note?: string
}

// Поставить остаток склада товара = units штук
export class SkladEditDto {
  @IsOptional() @IsString() @MaxLength(64) clientId?: string
  @IsString() @MaxLength(64) productId: string
  @IsInt() @Min(0) @Max(MAX_UNITS) units: number
  // Закупочная за упаковку для прибавки. Нет — нынешняя закупочная товара
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) cost?: number
  // Срок годности прибавки (YYYY-MM-DD)
  @IsOptional() @IsString() @MaxLength(40) expiryDate?: string
  @IsOptional() @IsString() @MaxLength(500) note?: string
}
