-- Журнал приходов запрашивают за период: без индекса это перебор всей таблицы
CREATE INDEX "Arrival_date_idx" ON "Arrival"("date");
