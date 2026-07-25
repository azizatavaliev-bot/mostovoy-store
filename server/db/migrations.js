// Миграции. Только добавление — существующие не редактируем, дописываем новые в конец.
// Применяются по имени, повторный запуск безопасен.

module.exports = [
  {
    name: "001_init",
    sql: `
      -- Товар. normalized_key — ключ сопоставления вида sony|playstation-5-slim|||standard
      CREATE TABLE products (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        slug                  TEXT NOT NULL UNIQUE,
        normalized_key        TEXT NOT NULL UNIQUE,
        official_name         TEXT NOT NULL,
        brand                 TEXT,
        model                 TEXT,
        category              TEXT,
        variant               TEXT,
        storage               TEXT,
        color                 TEXT,
        price                 REAL,
        currency              TEXT,
        available             INTEGER NOT NULL DEFAULT 1,
        description           TEXT,
        specifications        TEXT NOT NULL DEFAULT '{}',
        main_image_url        TEXT,
        image_urls            TEXT NOT NULL DEFAULT '[]',
        image_source_url      TEXT,
        source_page_url       TEXT,
        image_is_external     INTEGER NOT NULL DEFAULT 1,
        image_last_checked_at TEXT,
        status                TEXT NOT NULL DEFAULT 'active',
        confidence            REAL,
        research_status       TEXT NOT NULL DEFAULT 'pending',
        researched_at         TEXT,
        origin                TEXT NOT NULL DEFAULT 'telegram',
        last_sync_status      TEXT,
        last_sync_error       TEXT,
        last_synced_at        TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_products_status ON products(status);
      CREATE INDEX idx_products_brand ON products(brand);

      -- Разговорные написания: «Sony 5 slim», «PS5 slim» → один товар.
      CREATE TABLE product_aliases (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        alias            TEXT NOT NULL,
        alias_normalized TEXT NOT NULL UNIQUE,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_aliases_product ON product_aliases(product_id);

      -- Публикация канала. Пара (chat_id, message_id) уникальна.
      CREATE TABLE telegram_messages (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_chat_id            TEXT NOT NULL,
        telegram_message_id         INTEGER NOT NULL,
        telegram_message_updated_at TEXT,
        telegram_original_text      TEXT NOT NULL DEFAULT '',
        telegram_text_hash          TEXT NOT NULL,
        last_sync_status            TEXT NOT NULL DEFAULT 'pending',
        last_sync_error             TEXT,
        last_synced_at              TEXT,
        is_deleted                  INTEGER NOT NULL DEFAULT 0,
        created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at                  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (telegram_chat_id, telegram_message_id)
      );

      -- Связь «публикация → товар». Одна публикация даёт много товаров,
      -- один товар может встречаться в нескольких публикациях.
      CREATE TABLE message_products (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id  INTEGER NOT NULL REFERENCES telegram_messages(id) ON DELETE CASCADE,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        source_name TEXT,
        price       REAL,
        currency    TEXT,
        available   INTEGER NOT NULL DEFAULT 1,
        active      INTEGER NOT NULL DEFAULT 1,
        position    INTEGER NOT NULL DEFAULT 0,
        confidence  REAL,
        warning     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (message_id, product_id)
      );
      CREATE INDEX idx_mp_product ON message_products(product_id);

      -- Кеш исследования нового товара: не ищем одно и то же дважды.
      CREATE TABLE research_cache (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_key TEXT NOT NULL UNIQUE,
        provider       TEXT NOT NULL,
        payload        TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Очередь фоновой обработки. Вебхук только кладёт задачу сюда.
      CREATE TABLE sync_jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        message_id  INTEGER NOT NULL,
        event_type  TEXT NOT NULL,
        payload     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        run_after   TEXT NOT NULL DEFAULT (datetime('now')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_jobs_status ON sync_jobs(status, run_after);

      -- Идемпотентность вебхука: Telegram повторяет доставку при таймауте.
      CREATE TABLE telegram_updates (
        update_id  INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Журнал синхронизации.
      CREATE TABLE sync_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        level      TEXT NOT NULL,
        event      TEXT NOT NULL,
        chat_id    TEXT,
        message_id INTEGER,
        product_id INTEGER,
        details    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_sync_log_created ON sync_log(created_at);
    `,
  },
  {
    // Второй ключ сопоставления, устойчивый к перестановке признаков между
    // полями model/color/variant. Без него повторный разбор того же поста
    // создавал дубликаты: модель то кладёт «Starfish» в color, то в variant.
    // Не UNIQUE: у исторических записей возможны коллизии, разбираем их в коде.
    name: "002_match_key",
    sql: `
      ALTER TABLE products ADD COLUMN match_key TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_products_match_key ON products(match_key);
    `,
  },
];
