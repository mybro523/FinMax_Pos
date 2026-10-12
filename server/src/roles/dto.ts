import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator'

export class CreateRoleDto {
  @IsString() @MaxLength(40) name: string
  @IsOptional() @IsString() @MaxLength(200) description?: string
  @IsArray() @IsString({ each: true }) permissions: string[]
}

export class UpdateRoleDto {
  @IsOptional() @IsString() @MaxLength(40) name?: string
  @IsOptional() @IsString() @MaxLength(200) description?: string
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[]
}
