import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator'

const MAX_MONEY = 9_999_999_999.99

// Как поставщик вернул деньги: в счёт долга, в кассу (ящик открытой смены),
// наличными мимо кассы, на карту
export const REFUNDS = ['debt', 'cash', 'own', 'card'] as const

export class SupplierReturnItemDto {
  @IsString() @MaxLength(64) productId: string
  // Целые упаковки (у весового — килограммы). Ноль допустим, когда есть pieces
  @IsInt() @Min(0) qty: number
  // Штуки (граммы) сверх целых упаковок
  @IsOptional() @IsInt() @Min(0) @Max(99_999) pieces?: number
  // Цена возврата за упаковку (килограмм) — сколько засчитывает поставщик
  @IsNumber() @Min(0) @Max(MAX_MONEY) price: number
}

export class CreateSupplierReturnDto {
  // Возвращают конкретному поставщику — из справочника
  @IsString() @MaxLength(64) supplierId: string
  @IsIn(REFUNDS as unknown as string[]) refund: string
  // В какую открытую смену положили деньги (refund = cash); не задано — смена сайта
  @IsOptional() @IsString() @MaxLength(64) shiftId?: string
  @IsOptional() @IsString() @MaxLength(500) note?: string

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnItemDto)
  items: SupplierReturnItemDto[]
}
