const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { recordBuyClick, getBuyClickAnalytics } = require("../server/services/buy-analytics");

test("аналитика считает переходы в WhatsApp и товары из корзины", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insert = db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, price, currency)
     VALUES (?, ?, ?, ?, 'USD')`
  );
  insert.run("iphone-17", "apple|iphone-17|||standard", "iPhone 17", 1000);
  insert.run("airpods-4", "apple|airpods-4|||standard", "AirPods 4", 120);

  recordBuyClick(db, {
    source: "product",
    visitorId: "visitor-a",
    items: [{ productId: "iphone-17", quantity: 1 }],
  });
  recordBuyClick(db, {
    source: "cart",
    visitorId: "visitor-a",
    items: [
      { productId: "iphone-17", quantity: 2 },
      { productId: "airpods-4", quantity: 1 },
    ],
  });
  recordBuyClick(db, {
    source: "credit",
    visitorId: "visitor-b",
    items: [{ productId: "iphone-17", quantity: 1 }],
  });

  const analytics = getBuyClickAnalytics(db, 30);
  assert.deepEqual(analytics.summary, { clicks: 3, units: 5, visitors: 2 });
  assert.deepEqual(analytics.topProducts[0], {
    productSlug: "iphone-17",
    productName: "iPhone 17",
    clicks: 3,
    units: 4,
  });
  assert.deepEqual(analytics.sources, [
    { source: "cart", clicks: 1 },
    { source: "credit", clicks: 1 },
    { source: "product", clicks: 1 },
  ]);
  assert.equal(analytics.recent.length, 3);
});
