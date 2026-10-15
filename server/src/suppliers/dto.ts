import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

// Деньги в базе — до 9 999 999 999,99. Больше — заведомо ошибка, а не сумма
const MAX_MONEY = 9_999_999_999.99

export class CreateSupplierDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string
  @IsOptional() @IsString() @MaxLength(60) phone?: string
  @IsOptional() @IsString() @MaxLength(500) note?: string
  // Долг на момент заведения — то, что магазин задолжал до появления раздела.
  // Учитывается только у владельца: кассир заводит поставщика ради прихода
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) openingDebt?: number
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string
  @IsOptional() @IsString() @MaxLength(60) phone?: string
  @IsOptional() @IsString() @MaxLength(500) note?: string
}

export class PaySupplierDto {
  @IsNumber() @Min(0.01) @Max(MAX_MONEY) amount: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  // Деньги взяты из ящика открытой смены — наличные в ней уменьшаются
  @IsOptional() @IsBoolean() fromCash?: boolean
  // Из какой кассы (её открытая смена). Не указана — смена сайта
  @IsOptional() @IsString() @MaxLength(64) shiftId?: string
  @IsOptional() @IsString() @MaxLength(100) clientId?: string // защита от задвоения при повторе
}
