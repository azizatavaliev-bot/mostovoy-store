const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { createApp } = require("../server/app");
const { StubResearchService } = require("./helpers");
const {
  recordBuyClick,
  getBuyClickAnalytics,
  recordProductView,
  getProductViewAnalytics,
} = require("../server/services/buy-analytics");

// Два товара в каталоге — минимум, на котором видно и топ, и разбивку.
function seedProducts(db) {
  const insert = db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, price, currency)
     VALUES (?, ?, ?, ?, 'USD')`
  );
  insert.run("iphone-17", "apple|iphone-17|||standard", "iPhone 17", 1000);
  insert.run("airpods-4", "apple|airpods-4|||standard", "AirPods 4", 120);
}

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

test("аналитика считает просмотры карточек товаров", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProducts(db);

  assert.deepEqual(recordProductView(db, { productId: "iphone-17", visitorId: "visitor-a" }), {
    recorded: 1,
    deduped: false,
  });
  recordProductView(db, { productId: "iphone-17", visitorId: "visitor-b", pagePath: "/product.html?id=iphone-17" });
  recordProductView(db, { productId: "airpods-4", visitorId: "visitor-b" });

  const analytics = getProductViewAnalytics(db, 30);
  assert.deepEqual(analytics.summary, { views: 3, visitors: 2, products: 2 });
  assert.deepEqual(analytics.topProducts, [
    { productSlug: "iphone-17", productName: "iPhone 17", views: 2, visitors: 2 },
    { productSlug: "airpods-4", productName: "AirPods 4", views: 1, visitors: 1 },
  ]);
  assert.equal(analytics.trend.length, 1);
  assert.equal(analytics.trend[0].views, 3);
});

test("повторный просмотр того же товара тем же посетителем не удваивает счётчик", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProducts(db);

  recordProductView(db, { productId: "iphone-17", visitorId: "visitor-a" });
  // Перезагрузка страницы внутри окна дедупликации — не новый интерес.
  assert.deepEqual(recordProductView(db, { productId: "iphone-17", visitorId: "visitor-a" }), {
    recorded: 0,
    deduped: true,
  });
  // Другой товар того же посетителя окно не блокирует.
  assert.equal(recordProductView(db, { productId: "airpods-4", visitorId: "visitor-a" }).recorded, 1);
  assert.equal(getProductViewAnalytics(db, 30).summary.views, 2);

  // Возврат к товару позже окна считается новым просмотром.
  db.prepare("UPDATE product_views SET viewed_at = datetime('now', '-2 hours') WHERE product_slug = 'iphone-17'").run();
  assert.equal(recordProductView(db, { productId: "iphone-17", visitorId: "visitor-a" }).recorded, 1);
  assert.equal(getProductViewAnalytics(db, 30).summary.views, 3);
});

test("просмотр несуществующего товара не пишется в базу", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProducts(db);

  assert.throws(() => recordProductView(db, { productId: "no-such-product" }), /Товар не найден/);
  assert.throws(() => recordProductView(db, {}), /Товар не указан/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM product_views").get().n, 0);
});

test("POST /api/analytics/product-view пишет просмотр и отвечает 202", async (t) => {
  const db = createConnection(":memory:");
  seedProducts(db);
  const app = createApp({ db, research: new StubResearchService() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));
  t.after(() => db.close());

  const post = (body) =>
    fetch(`${base}/api/analytics/product-view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const ok = await post({ productId: "iphone-17", visitorId: "visitor-a", pagePath: "/product.html?id=iphone-17" });
  assert.equal(ok.status, 202);
  assert.deepEqual(await ok.json(), { ok: true, recorded: 1 });

  // Повтор в пределах окна — тоже 202, но без новой строки.
  const repeat = await post({ productId: "iphone-17", visitorId: "visitor-a" });
  assert.equal(repeat.status, 202);
  assert.deepEqual(await repeat.json(), { ok: true, recorded: 0 });

  const bad = await post({ productId: "no-such-product" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);

  const row = db.prepare("SELECT * FROM product_views").get();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM product_views").get().n, 1);
  assert.equal(row.product_name, "iPhone 17");
  assert.equal(row.page_path, "/product.html?id=iphone-17");
  assert.equal(row.visitor_id, "visitor-a");
});

test("аналитика магазина отдаёт просмотры и клики раздельно", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  seedProducts(db);
  const { CrmService } = require("../server/services/crm");
  const crm = new CrmService({ db });

  recordProductView(db, { productId: "iphone-17", visitorId: "visitor-a" });
  recordProductView(db, { productId: "airpods-4", visitorId: "visitor-a" });
  recordBuyClick(db, { source: "product", visitorId: "visitor-a", items: [{ productId: "iphone-17", quantity: 1 }] });

  const analytics = crm.getBuyAnalytics(30);
  assert.equal(analytics.summary.clicks, 1);
  assert.equal(analytics.views.summary.views, 2);
  assert.equal(analytics.views.topProducts.length, 2);
  assert.equal(analytics.views.periodDays, 30);
});
