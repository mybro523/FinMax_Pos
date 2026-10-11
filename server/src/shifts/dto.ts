import { IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

export class OpenShiftDto {
  @IsNumber() @Min(0) openingCash: number
}

export class CloseShiftDto {
  @IsNumber() @Min(0) countedCash: number
}

// Внесение (размен) или изъятие (забрали выручку) наличных в открытой смене
export class CashMoveDto {
  @IsIn(['in', 'out']) kind: 'in' | 'out'
  @IsNumber() @Min(0.01) @Max(9_999_999_999.99) amount: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  // Из какой кассы (её открытая смена). Не указана — смена сайта
  @IsOptional() @IsString() @MaxLength(64) shiftId?: string
  @IsOptional() @IsString() @MaxLength(100) clientId?: string // защита от задвоения при повторе
}
