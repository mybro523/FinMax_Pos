import { IsString, MinLength } from 'class-validator'

export class CreateDeferredDto {
  @IsString() @MinLength(3) barcode: string
}
