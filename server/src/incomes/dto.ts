import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

// Деньги в базе — до 9 999 999 999,99. Больше — заведомо ошибка, а не сумма
const MAX_MONEY = 9_999_999_999.99

export class CreateIncomeDto {
  @IsString() @MinLength(1) @MaxLength(60) category: string // статья дохода — названием
  @IsNumber() @Min(0.01) @Max(MAX_MONEY) amount: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  // День дохода. Не указан — сейчас
  @IsOptional() @IsString() @MaxLength(40) date?: string
  @IsOptional() @IsString() @MaxLength(100) clientId?: string // защита от задвоения при повторе
}

export class UpdateIncomeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) category?: string
  @IsOptional() @IsNumber() @Min(0.01) @Max(MAX_MONEY) amount?: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  @IsOptional() @IsString() @MaxLength(40) date?: string
}

export class CreateIncomeCategoryDto {
  @IsString() @MinLength(1) @MaxLength(60) name: string
}
