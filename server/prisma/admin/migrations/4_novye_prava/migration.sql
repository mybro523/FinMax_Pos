-- ── Новые права: доходы, смена своего пароля, закрытие чужой смены ──
--
-- Роль хранит права списком ключей. Новые права появляются в «Ролях и правах», но в
-- уже заведённых ролях их нет. Без этой миграции заведующий, например, перестал бы
-- менять свой пароль и не увидел бы доходов. Поэтому новое право добавляется туда,
-- где было соответствующее прежнее:
--   • доходы — как у расходов: журнал, внести, изменить и удалить; статьи доходов —
--     как у статей расходов;
--   • смена своего пароля — всем ролям, кроме системной роли кассира: кассиру
--     владелец попросил её закрыть;
--   • закрыть смену другого сотрудника — ролям, которые и открывают смены, и видят
--     смены других кассиров (у наблюдателя права открывать смену нет).

UPDATE "Role" SET "permissions" = array_append("permissions", 'incomes.view')
  WHERE 'expenses.view' = ANY("permissions") AND NOT ('incomes.view' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'incomes.create')
  WHERE 'expenses.create' = ANY("permissions") AND NOT ('incomes.create' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'incomes.edit')
  WHERE 'expenses.edit' = ANY("permissions") AND NOT ('incomes.edit' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'settings.incomeCategories')
  WHERE 'settings.expenseCategories' = ANY("permissions") AND NOT ('settings.incomeCategories' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'profile.password')
  WHERE ("system" IS NULL OR "system" <> 'cashier') AND NOT ('profile.password' = ANY("permissions"));

UPDATE "Role" SET "permissions" = array_append("permissions", 'shift.closeAny')
  WHERE 'shift.others' = ANY("permissions") AND 'shift.open' = ANY("permissions")
    AND NOT ('shift.closeAny' = ANY("permissions"));
