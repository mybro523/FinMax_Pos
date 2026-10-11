import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator'

export class CreatePharmacyDto {
  // Код: латиница, цифры и дефис. Проверку по существу делает сервис — здесь только
  // то, что нужно отсечь до него: пустое и заведомо не строку
  @IsString() code: string
  @IsString() @MinLength(1) name: string

  @IsOptional() @IsString() ownerName?: string
  @IsOptional() @IsString() phone?: string
  @IsOptional() @IsString() city?: string
  @IsOptional() @IsString() note?: string

  // Пробный период. Год — уже не проба, а бесплатная работа
  @IsOptional() @IsInt() @Min(1) @Max(365) trialDays?: number

  @IsOptional() @IsString() ownerLogin?: string
  @IsOptional() @IsString() @MinLength(6) ownerPassword?: string

  // Заполнить демонстрационными товарами и продажами — для показа программы
  @IsOptional() @IsBoolean() demo?: boolean
}

export class ExtendPharmacyDto {
  // Больше пяти лет вперёд — это уже опечатка, а не оплата
  @IsOptional() @IsInt() @Min(1) @Max(60) months?: number
  @IsOptional() @IsNumber() @Min(0) amount?: number
  @IsOptional() @IsIn(['cash', 'transfer', 'other']) method?: string
  @IsOptional() @IsString() note?: string
}

export class UpdatePharmacyDto {
  @IsOptional() @IsString() @MinLength(1) name?: string
  @IsOptional() @IsString() ownerName?: string
  @IsOptional() @IsString() phone?: string
  @IsOptional() @IsString() city?: string
  @IsOptional() @IsString() note?: string
  // Код и схему менять нельзя ни при каких обстоятельствах: на них завязаны данные
  @IsOptional() @IsDateString() paidUntil?: string
  @IsOptional() @IsBoolean() trial?: boolean
  // Сколько дней касса может работать без связи с сервером (см. subscription.ts)
  @IsOptional() @IsInt() @Min(1) @Max(30) offlineDays?: number
}
