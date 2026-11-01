import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import { MAX_UPP } from '../common/piece'

const MAX_MONEY = 9_999_999_999.99

export class ArrivalItemDto {
  @IsString() productId: string
  // Целые упаковки (у весового товара без мешка — килограммы). Ноль допустим, когда есть pieces
  @IsInt() @Min(0) qty: number
  // Штуки (граммы) сверх целых упаковок
  @IsOptional() @IsInt() @Min(0) @Max(MAX_UPP) pieces?: number
  // Сколько штук (граммов) в упаковке строки — так окно считало qty и pieces (1.5.12).
  // Прежние окна не шлют: тогда как в карточке, а у весового — килограммами (common/piece, lineUpp)
  @IsOptional() @IsInt() @Min(1) @Max(MAX_UPP) unitsPerPack?: number
  // Упаковку товара поменяли прямо в приходе: карточка получит unitsPerPack строки
  @IsOptional() @IsBoolean() packChanged?: boolean
  // Прежние цены товара были за прежнюю упаковку (за 1 кг) — перевести их на новую (мешок).
  // Нет — цены уже за новую упаковку, числа остаются (arrivals.service, applyPackChanges)
  @IsOptional() @IsBoolean() packScale?: boolean
  // Закупочная цена за упаковку (килограмм) — уже со скидкой поставщика
  @IsNumber() @Min(0) cost: number
  // Скидка поставщика на строку, %. Только для истории: cost уже со скидкой
  @IsOptional() @IsNumber() @Min(0) @Max(100) discount?: number
  // Срок годности партии: обязателен для товаров, необязателен для приборов и расходников
  @IsOptional() @IsString() expiryDate?: string
  // Новая цена продажи товара: владелец назначил её наценкой на закуп этого прихода.
  // Не прислана — цена товара остаётся прежней
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) price?: number
  // Своя цена одной штуки (1.5.11): число — ставим товару; null или 0 — убираем (штука
  // стоит цена упаковки / штук в упаковке). Не прислана — остаётся прежней
  @IsOptional() @IsNumber() @Min(0) @Max(MAX_MONEY) piecePrice?: number | null
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
  @IsOptional() @IsInt() @Min(0) @Max(MAX_UPP) pieces?: number
  @IsNumber() @Min(0) cost: number
  @IsOptional() @IsString() expiryDate?: string
  // Упаковка, по которой окно считало строку (1.5.12); нет — прежнее окно (lineUpp)
  @IsOptional() @IsInt() @Min(1) @Max(MAX_UPP) unitsPerPack?: number
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
