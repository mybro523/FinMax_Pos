import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator'

// Номер кассы и номера операций создаёт программа на компьютере магазина. Это
// обычные UUID; проверяем вид, чтобы в базу не попало ничего, кроме букв, цифр и дефисов
const ID = /^[A-Za-z0-9_:.-]{1,64}$/

export class PushOpDto {
  @IsString() @Matches(ID) id: string
  @IsString() @MaxLength(40) type: string
  // Кто сделал операцию. Пусто — тот же, кто её прислал
  @IsOptional() @IsString() @Matches(ID) accountId?: string
  // Когда она случилась на кассе
  @IsString() @MaxLength(40) createdAt: string
  // Содержимое разбирается отдельно и целиком — см. payload.ts
  @IsObject() payload: Record<string, any>
}

export class PushDto {
  @IsString() @Matches(ID) deviceId: string
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string

  // Пачка небольшая намеренно: оборвалась связь — повторить придётся не всё
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PushOpDto)
  ops: PushOpDto[]
}

export class RenameDeviceDto {
  @IsString() @MaxLength(40) name: string
}

export class CloseDeviceShiftDto {
  @IsNumber() @Min(0) @Max(9_999_999_999.99) countedCash: number
}

export class PullQuery {
  @IsString() @Matches(ID) deviceId: string
  // Отметка прошлого обмена. Пусто — касса просит всё с нуля
  @IsOptional() @IsString() @MaxLength(20) cursor?: string
  // Отметка журнала списаний: его касса получает только при владельце и помнит,
  // докуда он у неё верен, отдельно
  @IsOptional() @IsString() @MaxLength(20) wcursor?: string
  @IsOptional() @IsString() @MaxLength(40) appVersion?: string
  // Номера операций через запятую: касса отправляла их, а ответа не дождалась, и
  // спрашивает, приняты ли они
  @IsOptional() @IsString() @MaxLength(8000) ops?: string
  // Отпечаток списка сотрудников и ролей, который касса получила в прошлый раз
  @IsOptional() @IsString() @MaxLength(40) teamv?: string
  // Отметка сотрудников с окладами: их касса получает только при том, кто выдаёт зарплату
  @IsOptional() @IsString() @MaxLength(20) scursor?: string
}
