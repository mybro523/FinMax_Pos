import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'

// Сколько товаров можно отобрать сканером в один лист «Выбранные товары»
export const MAX_PICKED = 10000

export class CreateInventoryDto {
  @IsOptional() @IsString() scope?: string // 'all' или название категории
  @IsOptional() @IsString() note?: string
  // Лист из отобранных товаров (1.7.2): их id в том порядке, в каком их сканировали.
  // Есть — scope не смотрится, лист называется «Выбранные товары»
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_PICKED) @IsString({ each: true }) productIds?: string[]
}

export class CountItemDto {
  @IsString() id: string // строка листа
  // Сверху — предел того, что база хранит целым числом. Без него штрихкод, считанный
  // сканером в поле «по факту», проходил проверку и падал уже в базе — с невнятной
  // «ошибкой запроса», из которой не понять, в какой строке дело
  @IsOptional() @IsInt() @Min(0) @Max(2_000_000_000) actualUnits?: number | null // сколько насчитали, штук
}

export class SaveCountDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountItemDto)
  items: CountItemDto[]
}

// Применение листа. Насчитанное можно прислать тут же — тогда оно сначала сохраняется.
// Без него лист применяется по тому, что сохранено раньше (так шлёт прежняя страница)
export class ApplyInventoryDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountItemDto)
  items?: CountItemDto[]
}
