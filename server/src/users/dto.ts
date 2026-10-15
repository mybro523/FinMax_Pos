import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

// Деньги в базе — до 9 999 999 999,99
const MAX_MONEY = 9_999_999_999.99

export class CreateUserDto {
  @IsString() name: string
  @IsString() @MinLength(6) password: string
  @IsOptional() @IsIn(['founder', 'cashier']) role?: string
  // Роль магазина или 'owner' — владелец. Не указана — системная роль кассира
  @IsOptional() @IsString() roleId?: string
  // Для зарплаты: ФИО, оклад и бонус — процент от его продаж за месяц
  @IsOptional() @IsString() @MaxLength(120) fullName?: string
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) salary?: number
  @IsOptional() @IsNumber() @Min(0) @Max(100) bonusPercent?: number
}

export class UpdateUserDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsString() password?: string
  @IsOptional() @IsString() roleId?: string
  @IsOptional() @IsString() @MaxLength(120) fullName?: string
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) salary?: number
  @IsOptional() @IsNumber() @Min(0) @Max(100) bonusPercent?: number
}
