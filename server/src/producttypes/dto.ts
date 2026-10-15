import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateProductTypeDto {
  @IsString() @MinLength(1) @MaxLength(40) name: string
  // Показывать в карточке товара поле «Аналоги» (лекарства и всё, у чего есть замены)
  @IsOptional() @IsBoolean() analogs?: boolean
}

export class UpdateProductTypeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string
  @IsOptional() @IsBoolean() analogs?: boolean
}
