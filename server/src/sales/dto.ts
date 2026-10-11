import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator'

export class SaleItemDto {
  @IsString() productId: string
  @IsInt() @Min(0) qty: number // упаковок (может быть 0, если продаём только штуки)
  @IsOptional() @IsInt() @Min(0) pieces?: number // штук из вскрытой упаковки
  @IsOptional() @IsNumber() @Min(0) discount?: number // скидка на позицию, сомони
}

export class CheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[]

  @IsIn(['cash', 'card', 'debt', 'transfer'])
  payment: 'cash' | 'card' | 'debt' | 'transfer'

  // Через какой сервис пришёл перевод (Alif, DC…). Обязателен при оплате переводом
  @IsOptional() @IsString() @MaxLength(40) payVia?: string

  @IsOptional() @IsString() customerId?: string

  // Ключ повторной отправки: одинаковый у повторов одной и той же продажи
  @IsOptional() @IsString() clientId?: string
}
