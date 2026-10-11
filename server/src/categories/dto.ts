import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

export class CreateCategoryDto {
  @IsString() @MinLength(1) @MaxLength(40) name: string
  // Срок годности при приёмке не спрашиваем (бинты, вата, приборы)
  @IsOptional() @IsBoolean() noExpiry?: boolean
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) name?: string
  @IsOptional() @IsBoolean() noExpiry?: boolean
}
