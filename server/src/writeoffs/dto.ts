import { Type } from 'class-transformer'
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator'

export class WriteOffItemDto {
  @IsString() productId: string
  @IsInt() @Min(1) units: number // сколько штук списываем
}

export class CreateWriteOffDto {
  @IsOptional() @IsIn(['expired', 'damaged', 'lost', 'other']) reason?: string
  @IsOptional() @IsString() note?: string

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WriteOffItemDto)
  items: WriteOffItemDto[]
}
