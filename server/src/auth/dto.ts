import { IsString, MinLength } from 'class-validator'

export class LoginDto {
  @IsString() name: string
  @IsString() password: string
}

export class ChangePasswordDto {
  @IsString() oldPassword: string
  @IsString() @MinLength(6) newPassword: string
}
