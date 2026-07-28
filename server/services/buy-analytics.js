const crypto = require("crypto");

function recordBuyClick(db, payload = {}) {
  const source = ["product", "cart", "credit"].includes(payload.source) ? payload.source : "cart";
  const items = Array.isArray(payload.items) ? payload.items.slice(0, 20) : [];
  const slugs = [...new Set(items.map((item) => String(item?.productId || "").trim()).filter(Boolean))];
  if (!slugs.length) throw new Error("Товары не указаны");
  const placeholders = slugs.map(() => "?").join(",");
  const products = db.prepare(
    `SELECT id, slug, official_name FROM products WHERE slug IN (${placeholders})`
  ).all(...slugs);
  const bySlug = new Map(products.map((product) => [product.slug, product]));
  const clickGroup = crypto.randomUUID();
  const insert = db.prepare(
    `INSERT INTO buy_clicks
      (click_group, product_id, product_slug, product_name, quantity, source, page_path, visitor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let recorded = 0;
  for (const item of items) {
    const product = bySlug.get(String(item?.productId || ""));
    if (!product) continue;
    const quantity = Math.min(100, Math.max(1, Math.floor(Number(item?.quantity) || 1)));
    insert.run(
      clickGroup,
      product.id,
      product.slug,
      product.official_name,
      quantity,
      source,
      String(payload.pagePath || "").slice(0, 300) || null,
      String(payload.visitorId || "").slice(0, 100) || null
    );
    recorded++;
  }
  if (!recorded) throw new Error("Товары не найдены");
  return { clickGroup, recorded };
}

function getBuyClickAnalytics(db, days = 30) {
  const periodDays = [7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
  const since = `-${periodDays - 1} days`;
  const summary = db.prepare(
    `SELECT COUNT(DISTINCT click_group) AS clicks,
            COALESCE(SUM(quantity), 0) AS units,
            COUNT(DISTINCT NULLIF(visitor_id, '')) AS visitors
     FROM buy_clicks WHERE clicked_at >= datetime('now', ?)`
  ).get(since);
  const topProducts = db.prepare(
    `SELECT product_slug, product_name,
            COUNT(DISTINCT click_group) AS clicks, SUM(quantity) AS units
     FROM buy_clicks WHERE clicked_at >= datetime('now', ?)
     GROUP BY product_slug, product_name
     ORDER BY clicks DESC, units DESC, product_name ASC LIMIT 12`
  ).all(since).map((row) => ({
    productSlug: row.product_slug,
    productName: row.product_name,
    clicks: Number(row.clicks),
    units: Number(row.units),
  }));
  const trend = db.prepare(
    `SELECT date(clicked_at) AS day, COUNT(DISTINCT click_group) AS clicks
     FROM buy_clicks WHERE clicked_at >= datetime('now', ?)
     GROUP BY date(clicked_at) ORDER BY day ASC`
  ).all(since).map((row) => ({ day: row.day, clicks: Number(row.clicks) }));
  const sources = db.prepare(
    `SELECT source, COUNT(DISTINCT click_group) AS clicks
     FROM buy_clicks WHERE clicked_at >= datetime('now', ?)
     GROUP BY source ORDER BY clicks DESC, source ASC`
  ).all(since).map((row) => ({ source: row.source, clicks: Number(row.clicks) }));
  const recent = db.prepare(
    `SELECT click_group, source, page_path, visitor_id, MAX(clicked_at) AS clicked_at
     FROM buy_clicks WHERE clicked_at >= datetime('now', ?)
     GROUP BY click_group, source, page_path, visitor_id
     ORDER BY clicked_at DESC LIMIT 20`
  ).all(since).map((click) => {
    const items = db.prepare(
      `SELECT product_slug, product_name, quantity FROM buy_clicks
       WHERE click_group = ? ORDER BY id`
    ).all(click.click_group).map((item) => ({
      productSlug: item.product_slug,
      productName: item.product_name,
      quantity: Number(item.quantity),
    }));
    return {
      id: click.click_group,
      source: click.source,
      pagePath: click.page_path,
      visitorId: click.visitor_id,
      clickedAt: click.clicked_at,
      items,
    };
  });
  return {
    periodDays,
    summary: {
      clicks: Number(summary.clicks),
      units: Number(summary.units),
      visitors: Number(summary.visitors),
    },
    topProducts,
    trend,
    sources,
    recent,
  };
}

module.exports = { recordBuyClick, getBuyClickAnalytics };
