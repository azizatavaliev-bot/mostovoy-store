// Применяет миграции и первичное наполнение. Повторный запуск безопасен.
// Запуск: npm run migrate
const { getDb, closeDb } = require("../db");
const { seedLegacyProducts } = require("../services/seed");

const db = getDb();
const seeded = seedLegacyProducts(db);
const counts = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM telegram_messages) AS messages`
  )
  .get();

console.log(`Миграции применены. Товаров: ${counts.products} (добавлено из data.js: ${seeded.inserted}), сообщений: ${counts.messages}`);
closeDb();
