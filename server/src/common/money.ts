import { Prisma } from '@prisma/client'

// Единый конструктор денежной величины (точная десятичная арифметика).
// Деньги в БД хранятся как Decimal(12,2) — без ошибок двоичного float.
export const D = (n: Prisma.Decimal.Value = 0) => new Prisma.Decimal(n ?? 0)

// Скидка поставщика на строку прихода, % — от 0 до 100, до сотых. Только для истории:
// закупочная цена строки приходит уже со скидкой
export const discountOf = (v: unknown) => D(Math.min(100, Math.max(0, Number(v) || 0))).toDecimalPlaces(2)
