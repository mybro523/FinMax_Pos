import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator'

const MAX_MONEY = 9_999_999_999.99

export class ArrivalItemDto {
  @IsString() productId: string
  // Целые упаковки (у весового товара — килограммы). Ноль допустим, когда есть pieces
  @IsInt() @Min(0) qty: number
  // Штуки (граммы) сверх целых упаковок
  @IsOptional() @IsInt() @Min(0) @Max(99_999) pieces?: number
  @IsNumber() @Min(0) cost: number
  // Срок годности партии: обязателен для лекарств, необязателен для приборов и расходников
  @IsOptional() @IsString() expiryDate?: string
}

export class CreateArrivalDto {
  @IsOptional() @IsString() supplier?: string
  // Поставщик из справочника и сколько из суммы прихода НЕ оплачено сразу — это
  // становится долгом перед ним. Не указано — приход оплачен полностью
  @IsOptional() @IsString() @MaxLength(64) supplierId?: string
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) debt?: number
  // Чем заплатили поставщику: из кассы, своими наличными, картой или в долг
  @IsOptional() @IsIn(['', 'cash', 'own', 'card', 'debt']) payMethod?: string
  // Сколько из оплаченного взято из денежного ящика (создаётся оплата поставщику
  // «наличными из кассы» — она видна в Z-отчёте и в журнале оплат)
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) paidCash?: number
  // Из какой открытой смены берутся деньги; не задано — смена сайта
  @IsOptional() @IsString() @MaxLength(64) shiftId?: string

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ArrivalItemDto)
  items: ArrivalItemDto[]
}

// ── Правка прихода ──
// Строки присылаются целиком, каждая со своим id: так сервер видит и то, что
// изменили, и то, что убрали. Количество может быть нулём — это значит «строку
// убрать»; но обнулить все строки нельзя, для этого есть удаление прихода.
export class UpdateArrivalItemDto {
  @IsString() id: string
  @IsInt() @Min(0) qty: number
  @IsOptional() @IsInt() @Min(0) @Max(99_999) pieces?: number
  @IsNumber() @Min(0) cost: number
  @IsOptional() @IsString() expiryDate?: string
}

export class UpdateArrivalDto {
  @IsOptional() @IsString() supplier?: string
  // Пустая строка — убрать поставщика; не прислано — оставить как было
  @IsOptional() @IsString() @MaxLength(64) supplierId?: string
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) debt?: number

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateArrivalItemDto)
  items: UpdateArrivalItemDto[]
}
