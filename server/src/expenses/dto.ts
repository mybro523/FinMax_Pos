import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

// Деньги в базе — до 9 999 999 999,99. Больше — заведомо ошибка, а не сумма
const MAX_MONEY = 9_999_999_999.99

export class CreateExpenseDto {
  @IsString() @MinLength(1) @MaxLength(60) category: string // статья расхода — названием
  @IsNumber() @Min(0.01) @Max(MAX_MONEY) amount: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  // День расхода. Не указан — сейчас. У расхода «из кассы» дата всегда «сейчас»
  @IsOptional() @IsString() @MaxLength(40) date?: string
  // Оплачен наличными из кассы — уменьшает ожидаемые наличные в смене
  @IsOptional() @IsBoolean() fromCash?: boolean
  // Из какой кассы взяты деньги (её открытая смена). Не указана — смена сайта
  @IsOptional() @IsString() @MaxLength(64) shiftId?: string
  @IsOptional() @IsString() @MaxLength(100) clientId?: string // защита от задвоения при повторе
  // Зарплата: кому выдана (сотрудник в схеме магазина). Имя сервер берёт сам
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string
}

// Отметку «из кассы» и смену задним числом не меняют: это уже другая операция.
// Ошиблись — расход удаляют и вносят заново
export class UpdateExpenseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) category?: string
  @IsOptional() @IsNumber() @Min(0.01) @Max(MAX_MONEY) amount?: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  @IsOptional() @IsString() @MaxLength(40) date?: string
  // Пустая строка — убрать сотрудника; не прислано — оставить как было
  @IsOptional() @IsString() @MaxLength(64) employeeId?: string
}

export class CreateExpenseCategoryDto {
  @IsString() @MinLength(1) @MaxLength(60) name: string
}
