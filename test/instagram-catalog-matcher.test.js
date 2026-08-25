const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { matchCatalog } = require("../server/services/instagram/catalogMatcher");

function seedProduct(db, { slug, name, brand, category, price, currency = "USD" }) {
  const productId = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, brand, category, price, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
  ).run(slug, slug, name, brand, category, price, currency).lastInsertRowid;
  const messageId = db.prepare(
    `INSERT INTO telegram_messages (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', ?, '2026-08-01T10:00:00.000Z', 'пост', ?, 'ok')`
  ).run(productId, `hash-${slug}`).lastInsertRowid;
  db.prepare("INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, ?, ?, ?, 1, 1)")
    .run(messageId, productId, price, currency);
  return productId;
}

function analysisWith(products, details = []) {
  return { contains_product: true, products_visible: products, important_details: details, visible_text: [], summary: "" };
}

test("находит товар по совпадению категории/бренда/названия", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProduct(db, { slug: "glasses-1", name: "Ray-Ban Meta Gen 2", brand: "Ray-Ban", category: "Очки", price: 300 });
  seedProduct(db, { slug: "iphone-1", name: "iPhone 17 Pro", brand: "Apple", category: "Смартфоны", price: 1200 });

  const analysis = analysisWith([{ name_guess: "чёрные прямоугольные солнцезащитные очки", category: "очки", brand: null, model: null, confidence: 0.9 }], ["чёрная оправа", "прямоугольная форма"]);
  const matches = matchCatalog(db, analysis);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].name, "Ray-Ban Meta Gen 2");
});

test("возвращает несколько кандидатов, если несколько товаров похожи — не выбирает один автоматически", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProduct(db, { slug: "watch-1", name: "Garmin Venu 3S", brand: "Garmin", category: "Часы", price: 400 });
  seedProduct(db, { slug: "watch-2", name: "Garmin Fenix 8", brand: "Garmin", category: "Часы", price: 900 });
  seedProduct(db, { slug: "phone-1", name: "iPhone 17", brand: "Apple", category: "Смартфоны", price: 1000 });

  const analysis = analysisWith([{ name_guess: "спортивные часы Garmin", category: "часы", brand: "Garmin", model: null, confidence: 0.7 }]);
  const matches = matchCatalog(db, analysis);
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.brand === "Garmin"));
});

test("без реального пересечения слов не возвращает ничего (не подсовывает случайные товары)", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProduct(db, { slug: "vacuum-1", name: "Dyson V15", brand: "Dyson", category: "Пылесосы", price: 600 });

  const analysis = analysisWith([{ name_guess: "красная кожаная сумка", category: "сумки", brand: null, model: null, confidence: 0.5 }]);
  assert.deepEqual(matchCatalog(db, analysis), []);
});

test("contains_product=false — поиск даже не запускается", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProduct(db, { slug: "vacuum-1", name: "Dyson V15", brand: "Dyson", category: "Пылесосы", price: 600 });
  assert.deepEqual(matchCatalog(db, { contains_product: false, products_visible: [], important_details: [] }), []);
});

test("дублирующиеся карточки одного названия с разной ценой не дают дублей в совпадениях", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProduct(db, { slug: "iphone-dup-1", name: "iPhone 17 Pro Max", brand: "Apple", category: "Смартфоны", price: 1000 });
  seedProduct(db, { slug: "iphone-dup-2", name: "iPhone 17 Pro Max", brand: "Apple", category: "Смартфоны", price: 1200 });

  const analysis = analysisWith([{ name_guess: "iPhone Pro Max", category: "смартфоны", brand: "Apple", model: null, confidence: 0.8 }]);
  const matches = matchCatalog(db, analysis);
  assert.equal(matches.filter((m) => m.name === "iPhone 17 Pro Max").length, 1);
});
