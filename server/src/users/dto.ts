import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator'

export class CreateUserDto {
  @IsString() name: string
  @IsString() @MinLength(6) password: string
  @IsOptional() @IsIn(['founder', 'cashier']) role?: string
  // Роль магазина или 'owner' — владелец. Не указана — системная роль кассира
  @IsOptional() @IsString() roleId?: string
}

export class UpdateUserDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsBoolean() active?: boolean
  @IsOptional() @IsString() password?: string
  @IsOptional() @IsString() roleId?: string
}
