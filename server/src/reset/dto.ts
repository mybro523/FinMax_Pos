import { IsString, MaxLength, MinLength } from 'class-validator'

// Подтверждение очистки: слово из поля «Опасной зоны». Проверку дублирует и сервис
// (ResetService.wipeKeepStaff) — случайный запрос без слова ничего не сотрёт.
export class ResetDataDto {
  @IsString() @MinLength(1) @MaxLength(40) confirm: string
}
