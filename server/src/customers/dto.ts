import { IsNumber, IsOptional, IsString, Min } from 'class-validator'

export class CreateCustomerDto {
  @IsString() name: string
  @IsOptional() @IsString() phone?: string
  @IsOptional() @IsNumber() @Min(0) debt?: number // начальный долг, сомони
}

export class PayDebtDto {
  @IsNumber() @Min(0.01) amount: number
}
