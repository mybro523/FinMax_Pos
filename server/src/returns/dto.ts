import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'

export class ReturnItemDto {
  @IsString() productId: string
  @IsInt() @Min(1) units: number // сколько штук возвращают
  @IsOptional() @IsBoolean() restock?: boolean // true — обратно в продажу, false — списать
  // Срок годности с упаковки — если кассир его вписал. Пусто — срок ставит сервер
  @IsOptional() @IsString() expiryDate?: string
}

export class CreateReturnDto {
  @IsOptional() @IsString() saleId?: string // чек, по которому возврат
  @IsOptional() @IsIn(['cash', 'card', 'debt', 'transfer']) refund?: 'cash' | 'card' | 'debt' | 'transfer'
  // Через какой сервис вернули деньги переводом. Пусто — тот же, каким платили
  @IsOptional() @IsString() @MaxLength(40) refundVia?: string
  @IsOptional() @IsString() note?: string
  @IsOptional() @IsString() clientId?: string // защита от задвоения при повторе

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[]
}
