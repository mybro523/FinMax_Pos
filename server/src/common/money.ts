import { Prisma } from '@prisma/client'

// Единый конструктор денежной величины (точная десятичная арифметика).
// Деньги в БД хранятся как Decimal(12,2) — без ошибок двоичного float.
export const D = (n: Prisma.Decimal.Value = 0) => new Prisma.Decimal(n ?? 0)
