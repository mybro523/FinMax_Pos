-- Аналитика клиентов для владельца сервиса.
--
-- lastSaleAt   — дата последнего чека в самой аптеке. За ней надо ходить в схему
--                аптеки, поэтому раз в час фоновый обход записывает её сюда:
--                на списке из трёхсот клиентов иначе выходило бы триста запросов.
-- lastSaleSeen — когда обход в последний раз доходил до этой аптеки. Без него
--                «не торгует» не отличить от «ещё ни разу не считали».
-- calledAt,
-- callNote     — когда звонили и что обещали. Без отметки владелец сервиса звонит
--                одному дважды, а другому не звонит вовсе.
--
-- Все столбцы необязательные или со значением по умолчанию: существующие записи
-- не трогаются, простоя нет.
ALTER TABLE "Pharmacy" ADD COLUMN "lastSaleAt" TIMESTAMP(3);
ALTER TABLE "Pharmacy" ADD COLUMN "lastSaleSeen" TIMESTAMP(3);
ALTER TABLE "Pharmacy" ADD COLUMN "calledAt" TIMESTAMP(3);
ALTER TABLE "Pharmacy" ADD COLUMN "callNote" TEXT NOT NULL DEFAULT '';
