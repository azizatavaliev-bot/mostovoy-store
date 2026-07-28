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
  {
    // Группа для сайдбар-фильтра витрины (Гаджеты/Игры/Аксессуары/Другое),
    // доступные цвета (swatches — как у легаси-телефонов, [[название, hex]]),
    // и наложенная акция — процент скидки с опциональной подписью.
    name: "003_group_swatches_discount",
    sql: `
      ALTER TABLE products ADD COLUMN product_group TEXT;
      ALTER TABLE products ADD COLUMN swatches TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE products ADD COLUMN discount_percent REAL;
      ALTER TABLE products ADD COLUMN discount_label TEXT;
      CREATE INDEX idx_products_group ON products(product_group);
    `,
  },
  {
    // Новости магазина. Отдельно от каталога: своя таблица, свой публичный
    // эндпоинт, своя вкладка в админке.
    name: "004_posts",
    sql: `
      CREATE TABLE posts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        slug          TEXT NOT NULL UNIQUE,
        title         TEXT NOT NULL,
        body          TEXT NOT NULL,
        image         TEXT,
        status        TEXT NOT NULL DEFAULT 'published',
        published_at  TEXT NOT NULL DEFAULT (datetime('now')),
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_posts_published ON posts(status, published_at);
    `,
  },
  {
    // Журнал изменений цены — для вкладки «Обновления» в админке: когда,
    // у какого товара и из какого источника (Telegram / админка) изменилась
    // цена. Название и слаг денормализованы: товар мог быть переименован
    // или скрыт, а запись в истории должна оставаться читаемой как есть.
    name: "005_price_history",
    sql: `
      CREATE TABLE price_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_slug  TEXT,
        product_name  TEXT NOT NULL,
        old_price     REAL,
        new_price     REAL NOT NULL,
        currency      TEXT NOT NULL,
        source        TEXT NOT NULL, -- telegram | admin
        changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_price_history_changed ON price_history(changed_at);
    `,
  },
  {
    // Единый inbox магазина: личные сообщения Telegram и WhatsApp из amoCRM.
    // Секреты интеграций остаются в переменных окружения, здесь только диалоги.
    name: "006_crm",
    sql: `
      CREATE TABLE crm_conversations (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        external_key         TEXT NOT NULL UNIQUE,
        source               TEXT NOT NULL,
        external_chat_id     TEXT NOT NULL,
        external_lead_id     TEXT,
        external_contact_id  TEXT,
        customer_name        TEXT,
        customer_username    TEXT,
        customer_phone       TEXT,
        ai_enabled           INTEGER NOT NULL DEFAULT 1,
        unread_count         INTEGER NOT NULL DEFAULT 0,
        notes                TEXT,
        status               TEXT NOT NULL DEFAULT 'open',
        last_message_at      TEXT NOT NULL DEFAULT (datetime('now')),
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_crm_conversations_last ON crm_conversations(last_message_at DESC);
      CREATE INDEX idx_crm_conversations_source ON crm_conversations(source);

      CREATE TABLE crm_messages (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id      INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
        external_message_id  TEXT,
        direction            TEXT NOT NULL,
        sender               TEXT NOT NULL,
        text                 TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'stored',
        raw_payload          TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, external_message_id, direction)
      );
      CREATE INDEX idx_crm_messages_conversation ON crm_messages(conversation_id, created_at, id);

      CREATE TABLE crm_settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    // Подтверждённые продажи из CRM. Название, цена и валюта сохраняются
    // снимком, чтобы историческая аналитика не менялась после правки товара.
    name: "007_crm_sales",
    sql: `
      CREATE TABLE crm_sales (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  INTEGER REFERENCES crm_conversations(id) ON DELETE SET NULL,
        product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_slug     TEXT,
        product_name     TEXT NOT NULL,
        quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        unit_price       REAL NOT NULL CHECK (unit_price >= 0),
        currency         TEXT NOT NULL,
        total_amount     REAL NOT NULL CHECK (total_amount >= 0),
        note             TEXT,
        sold_at          TEXT NOT NULL DEFAULT (datetime('now')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_crm_sales_sold_at ON crm_sales(sold_at DESC);
      CREATE INDEX idx_crm_sales_product ON crm_sales(product_id, product_slug);
      CREATE INDEX idx_crm_sales_conversation ON crm_sales(conversation_id);
    `,
  },
  {
    // Реальный интерес покупателей: нажатия кнопки, которая открывает
    // WhatsApp. Одна группа — один переход, в корзине у неё несколько товаров.
    name: "008_buy_clicks",
    sql: `
      CREATE TABLE buy_clicks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        click_group   TEXT NOT NULL,
        product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_slug  TEXT,
        product_name  TEXT NOT NULL,
        quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
        source        TEXT NOT NULL,
        page_path     TEXT,
        visitor_id    TEXT,
        clicked_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_buy_clicks_clicked ON buy_clicks(clicked_at DESC);
      CREATE INDEX idx_buy_clicks_product ON buy_clicks(product_id, product_slug);
      CREATE INDEX idx_buy_clicks_group ON buy_clicks(click_group);
    `,
  },
  {
    // Human-in-the-loop для ответов бота и наблюдаемость его CRM-пайплайна.
    // Ответ сначала сохраняется черновиком, менеджер принимает/редактирует/
    // отклоняет его в админке, и только после принятия он уходит клиенту.
    name: "009_bot_control",
    sql: `
      CREATE TABLE bot_approvals (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id      INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
        incoming_message_id  INTEGER REFERENCES crm_messages(id) ON DELETE SET NULL,
        customer_message     TEXT NOT NULL,
        ai_reply             TEXT NOT NULL,
        edited_reply         TEXT,
        conversation_summary TEXT,
        model                TEXT,
        status               TEXT NOT NULL DEFAULT 'pending',
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at           TEXT
      );
      CREATE UNIQUE INDEX idx_bot_approvals_message ON bot_approvals(incoming_message_id);
      CREATE INDEX idx_bot_approvals_status ON bot_approvals(status, created_at DESC);

      CREATE TABLE bot_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id  INTEGER REFERENCES crm_conversations(id) ON DELETE SET NULL,
        level            TEXT NOT NULL DEFAULT 'info',
        stage            TEXT NOT NULL,
        event            TEXT NOT NULL,
        message          TEXT,
        details          TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_bot_events_created ON bot_events(created_at DESC);
      CREATE INDEX idx_bot_events_level ON bot_events(level, created_at DESC);
    `,
  },
  {
    // Точечные исправления каталога, которые должны переживать рестарт:
    // одинаковая фотография линейки MacBook Pro для Silver и корректный
    // Ray-Ban Gen 2. Общую безцветную позицию MacBook скрываем — это дубль
    // более точных SKU MGEA4/MGE44.
    name: "010_catalog_asset_fixes",
    sql: `
      UPDATE products
      SET main_image_url = '/uploads/2561a2970e4752658c238501518ba456.jpg',
          updated_at = datetime('now')
      WHERE slug = 'macbook-pro-16-m5-pro-1-tb-silver-24-gb-ram-mge44';

      UPDATE products
      SET main_image_url = 'https://images2.ray-ban.com//prod-onecp-record-files/pieyewear/797a843b-283b-433a-9fe2-b37000960f0d/0RW4006__601S1M__P21__shad__qt.png?impolicy=RB_Product_clone&width=700&bgc=%23f2f2f2',
          updated_at = datetime('now')
      WHERE slug = 'meta-ray-ban-wayfarer-gen-2-matte-black-transition-graph-gray-razmery-50-53';

      UPDATE products
      SET status = 'hidden', available = 0, updated_at = datetime('now')
      WHERE slug = 'macbook-pro-16-m5-pro-1-tb-24-gb-ram';
    `,
  },
  {
    // Обучение на решениях менеджера и фактический расход DeepSeek по
    // отдельным этапам пайплайна.
    name: "011_bot_learning_and_usage",
    sql: `
      ALTER TABLE bot_approvals ADD COLUMN reject_reason TEXT;

      CREATE TABLE bot_training_examples (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id       INTEGER NOT NULL UNIQUE REFERENCES bot_approvals(id) ON DELETE CASCADE,
        conversation_id   INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
        customer_message  TEXT NOT NULL,
        ai_reply          TEXT NOT NULL,
        final_reply       TEXT,
        was_edited        INTEGER NOT NULL DEFAULT 0,
        quality_label     TEXT NOT NULL CHECK (quality_label IN ('accepted', 'rejected')),
        reject_reason     TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_bot_training_quality ON bot_training_examples(quality_label, created_at DESC);

      CREATE TABLE ai_usage (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id    INTEGER REFERENCES crm_conversations(id) ON DELETE SET NULL,
        task               TEXT NOT NULL,
        model              TEXT NOT NULL,
        prompt_tokens      INTEGER NOT NULL DEFAULT 0,
        completion_tokens  INTEGER NOT NULL DEFAULT 0,
        total_tokens       INTEGER NOT NULL DEFAULT 0,
        input_cost_usd     REAL NOT NULL DEFAULT 0,
        output_cost_usd    REAL NOT NULL DEFAULT 0,
        total_cost_usd     REAL NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ai_usage_created ON ai_usage(created_at DESC);
      CREATE INDEX idx_ai_usage_task ON ai_usage(task, created_at DESC);
    `,
  },
  {
    // Старые позиции из первоначального каталога раньше показывали буквенный
    // плейсхолдер. Локальные файлы взяты из официального Apple Compare.
    name: "012_legacy_iphone_images",
    sql: `
      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-se.jpg',
          updated_at = datetime('now')
      WHERE slug = 'se';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-13.jpg',
          updated_at = datetime('now')
      WHERE slug = '13';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-14.jpg',
          updated_at = datetime('now')
      WHERE slug = '14';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-15.jpg',
          updated_at = datetime('now')
      WHERE slug = '15';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-15-pro.jpg',
          updated_at = datetime('now')
      WHERE slug = '15-pro';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-16.jpg',
          updated_at = datetime('now')
      WHERE slug = '16';

      UPDATE products
      SET main_image_url = '/images/products/apple/iphone-16-plus.jpg',
          updated_at = datetime('now')
      WHERE slug = '16-plus';
    `,
  },
  {
    // Обе версии Magic Mouse USB-C используют переданное владельцем фото.
    // Миграция обновляет уже существующие товары в production-базе.
    name: "013_magic_mouse_images",
    sql: `
      UPDATE products
      SET main_image_url = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQFC7E3rE1RGRYYpx7AUfYwskDhP3Odv7XKINDtTfOIpfMDIWUtk5slf04&s=10',
          updated_at = datetime('now')
      WHERE slug IN ('magic-mouse-usb-c-white', 'magic-mouse-usb-c-black');
    `,
  },
];
