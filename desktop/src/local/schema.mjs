// ── Устройство локальной базы ──
//
// Правки схемы только дописываются в конец списка: каждая запись — один шаг от
// прежней версии к следующей. База помнит, сколько шагов уже сделано, и при запуске
// новой версии программы проходит недостающие. Менять уже выпущенный шаг нельзя:
// на компьютерах аптек он выполнен, и второй раз не выполнится.

// ── База аптеки ──
// В ней всё, с чем работает касса без интернета. Три правила, на которых она стоит.
//
// 1. Остаток НЕ перезаписывается. Товар лежит партиями — как на сервере: у каждой
//    свой срок годности и своя закупочная цена. У партии два числа: сколько штук
//    было по словам сервера (sUnits) и сколько сейчас с учётом сделанного на этой
//    кассе (units). Всё сделанное здесь и ещё не принятое сервером записано журналом
//    движений (stock_moves). Пришёл свежий остаток с сервера — берём его за основу
//    и проигрываем журнал поверх. Иначе два источника правды затирали бы друг друга:
//    касса присылала бы «поставь остаток 5», пока вторая касса продаёт тот же товар.
//
// 2. С долгом клиента то же самое: что сказал сервер (sDebtC), журнал своих
//    изменений (debt_moves) и итог (debtC).
//
// 3. Документы (чек, возврат, приход, списание, погашение долга, смена) лежат в
//    одной таблице docs в том самом виде, в каком их отдаёт сервер. Интерфейс один
//    на сайт и программу и ждёт именно этот вид; хранить его как есть — значит
//    не переводить туда-обратно и не ошибиться в переводе.
export const PHARMACY_SCHEMA = [
  `
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    -- Место в списке сервера: он отдаёт товары по алфавиту со своими правилами
    -- сравнения букв, и повторять их здесь незачем — проще запомнить порядок
    ord INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    barcode TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Прочее',
    priceC INTEGER NOT NULL DEFAULT 0,
    minStock INTEGER NOT NULL DEFAULT 5,
    unit TEXT NOT NULL DEFAULT 'уп',
    unitsPerPack INTEGER NOT NULL DEFAULT 1,
    dosage TEXT NOT NULL DEFAULT '',
    analogIds TEXT NOT NULL DEFAULT '[]',
    createdAt TEXT NOT NULL,
    -- Закупочная цена упаковки и ближайший срок годности: что сказал сервер (s…)
    -- и что получается с учётом приходов и продаж, сделанных здесь
    sCostC INTEGER NOT NULL DEFAULT 0,
    costC INTEGER NOT NULL DEFAULT 0,
    sExpiry TEXT,
    expiryDate TEXT,
    -- Сколько штук продано сверх того, что было: вторая касса успела продать тот же
    -- товар, пока эта работала без связи. Считается при проигрывании журнала
    oversold INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX products_barcode ON products(barcode);
  CREATE INDEX products_ord ON products(ord);

  CREATE TABLE batches (
    id TEXT PRIMARY KEY,
    productId TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 0,
    -- Пусто — партию завели здесь (приход или возврат без связи), сервер о ней не знает
    sUnits INTEGER,
    costC INTEGER NOT NULL DEFAULT 0,
    expiryDate TEXT,
    arrivalId TEXT,
    note TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  );
  CREATE INDEX batches_product ON batches(productId);

  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    ord INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    noExpiry INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    sDebtC INTEGER NOT NULL DEFAULT 0,
    debtC INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    -- 1 — клиент заведён на этой кассе и сервер о нём ещё не знает
    local INTEGER NOT NULL DEFAULT 0
  );

  -- Отложенные штрихкоды. sync: synced — как на сервере; pending — добавлен здесь;
  -- deleted — убран здесь (строка остаётся, пока сервер не узнает, иначе при
  -- следующей сверке штрихкод «воскрес» бы)
  CREATE TABLE deferred (
    id TEXT PRIMARY KEY,
    barcode TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    sync TEXT NOT NULL DEFAULT 'synced'
  );
  CREATE INDEX deferred_barcode ON deferred(barcode);

  -- Журнал движений товара, сделанных на этой кассе. Записан так, чтобы движение
  -- можно было проиграть заново поверх свежего остатка с сервера: не «из какой
  -- партии взяли», а «сколько и по какому правилу» — партию выберет тот же порядок,
  -- что и на сервере (сначала ближайший срок).
  CREATE TABLE stock_moves (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    opId TEXT NOT NULL,
    productId TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- Штук: плюс — пришло, минус — ушло
    units INTEGER NOT NULL,
    -- Продажа берёт только годное, списание — любое
    skipExpired INTEGER NOT NULL DEFAULT 0,
    -- Для пришедшего товара: цена упаковки, срок и приход, которым заведена партия
    costC INTEGER,
    expiryDate TEXT,
    arrivalId TEXT,
    note TEXT NOT NULL DEFAULT '',
    -- Для прихода: сколько упаковок товара пришло и на какую сумму. По ним заново
    -- считается средняя закупочная цена. Сумма — текстом: она точная, без округления
    wPacks INTEGER,
    wValue TEXT,
    createdAt TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX stock_moves_pending ON stock_moves(seq) WHERE synced = 0;
  CREATE INDEX stock_moves_op ON stock_moves(opId);

  -- Журнал изменений долга, в дирамах: плюс — продали в долг, минус — погасил
  -- или вернул товар
  CREATE TABLE debt_moves (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    opId TEXT NOT NULL,
    customerId TEXT NOT NULL,
    deltaC INTEGER NOT NULL,
    kind TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX debt_moves_pending ON debt_moves(customerId) WHERE synced = 0;
  CREATE INDEX debt_moves_op ON debt_moves(opId);

  -- Документы. kind: sale | return | arrival | writeoff | payment | shift.
  -- sync: synced — пришёл с сервера или уже принят им; pending — сделан здесь и ждёт
  -- отправки; rejected — сервер не принял (остаётся на виду, пока с ним не разберутся).
  CREATE TABLE docs (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    date TEXT NOT NULL,
    shiftId TEXT,
    saleId TEXT,
    clientId TEXT,
    -- На какой кассе открыта смена: у каждой кассы своя
    deviceId TEXT,
    closedAt TEXT,
    body TEXT NOT NULL,
    sync TEXT NOT NULL DEFAULT 'synced',
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX docs_date ON docs(kind, date);
  CREATE INDEX docs_shift ON docs(kind, shiftId);
  CREATE INDEX docs_sale ON docs(kind, saleId);
  CREATE INDEX docs_sync ON docs(sync) WHERE sync <> 'synced';
  -- Ключ повтора: один и тот же чек или возврат второй раз не записывается
  CREATE UNIQUE INDEX docs_client ON docs(kind, clientId) WHERE clientId IS NOT NULL;

  -- Очередь на отправку. Каждая операция — одна строка со своим номером (id), по
  -- которому сервер узнаёт повтор. seq задаёт порядок: возврат не может уйти раньше
  -- чека, по которому он оформлен.
  CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    -- Кто сделал: учётная запись сотрудника
    accountId TEXT,
    payload TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    nextTryAt TEXT,
    error TEXT
  );
  CREATE INDEX outbox_state ON outbox(state, seq);
  `,
  // 2. Расходы аптеки (версия 1.0.1). Сами расходы лежат в docs, как списания
  // (kind = expense); их статьи — отдельным списком.
  //
  // И отметка разделов владельца сбрасывается. Расходы и статьи сервер отдаёт только
  // владельцу и только с этой версии: по прежней отметке «докуда получили» касса не
  // увидела бы ни готовых статей, ни расходов, внесённых до обновления программы.
  // Без отметки владелец при первом же обмене получает всё заново — один раз.
  `
  CREATE TABLE expense_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT ''
  );
  DELETE FROM meta WHERE key = 'wcursor';
  `,
  // 3. Поставщики и сервисы перевода (версия 1.0.2). Внесения и изъятия наличных и
  // оплаты поставщикам лежат в docs (kind = cashmove, supplierpayment).
  //
  // Отметки обмена сбрасываются обе: поставщиков и сервисы сервер отдаёт всем, но
  // касса прежней версии их не брала, а по отметке «докуда получили» они уже прошли.
  // Без отметок касса при первом обмене получает всё заново — один раз.
  //
  // sDebtC — долг по словам сервера, в дирамах. NULL — сервер его не присылал: запись
  // получал кассир, а ему долги не показывают
  `
  CREATE TABLE suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    openingDebtC INTEGER,
    sDebtC INTEGER,
    createdAt TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE pay_services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT ''
  );
  DELETE FROM meta WHERE key IN ('cursor', 'wcursor');
  `,
  `
  -- Фото товара: сжатый кадр строкой, как прислал сервер (пусто — фото нет)
  ALTER TABLE products ADD COLUMN image TEXT;
  `,
  `
  -- Сводке «Долги поставщикам» нужен счётчик долговых приходов и без связи.
  -- NULL — сервер его не присылал (запись получал кассир, деньги не его)
  ALTER TABLE suppliers ADD COLUMN debtArrivals INTEGER;
  `,
]

// ── Общая база программы ──
// То, что относится к компьютеру, а не к одной аптеке: кто входил на этом компьютере
// (для входа без интернета) и счётчик неудачных попыток.
export const CORE_SCHEMA = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    pharmacyCode TEXT NOT NULL,
    pharmacyName TEXT NOT NULL DEFAULT '',
    -- Необратимый отпечаток пароля: по нему проверяется вход без интернета.
    -- Сам пароль не хранится нигде. Отпечаток дополнительно зашифрован средствами
    -- Windows — унести файл и подбирать пароль на другом компьютере не получится.
    -- Пусто — входить без интернета этой учётной записи нельзя.
    verifier TEXT,
    -- Что сервер последним сказал о подписке аптеки
    subStatus TEXT NOT NULL DEFAULT 'active',
    paidUntil TEXT,
    -- Сотрудник в базе аптеки: на него ссылаются чеки и смены (не то же, что id)
    tenantUserId TEXT,
    -- Когда сервер последний раз подтвердил этот вход
    seenAt TEXT NOT NULL
  );

  -- Неудачные попытки входа без интернета. Лежат в базе, а не в памяти: иначе
  -- перезапуск программы обнулял бы счёт, и пароль можно было бы подбирать
  -- пятёрками сколько угодно.
  CREATE TABLE login_fails (
    key TEXT PRIMARY KEY,
    fails INTEGER NOT NULL,
    firstFailAt INTEGER NOT NULL,
    lastFailAt INTEGER NOT NULL,
    blockedUntil INTEGER NOT NULL,
    step INTEGER NOT NULL
  );
  `,
  // 2. Срок работы без связи: когда сервер последний раз подтвердил подписку аптеки
  // и сколько дней он разрешает работать без проверки (см. local/licence.mjs).
  // Запись зашифрована средствами Windows — в открытом виде её можно было бы поправить
  `
  CREATE TABLE licences (
    pharmacyCode TEXT PRIMARY KEY,
    sealed TEXT NOT NULL
  );
  `,
  `
  -- Права из роли и её имя: по ним программа проверяет действия и без связи.
  -- Кассир прежней версии (пустой список) получает права кассира по умолчанию
  ALTER TABLE accounts ADD COLUMN permissions TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN roleName TEXT NOT NULL DEFAULT '';
  `,
]
