import { Type } from 'class-transformer'
import { IsArray, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'

export class CreateInventoryDto {
  @IsOptional() @IsString() scope?: string // 'all' или название категории
  @IsOptional() @IsString() note?: string
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
