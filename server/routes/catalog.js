// Публичный API витрины. Витрина читает /api/catalog вместо статического data.js.
const express = require("express");
const config = require("../config");
const { buildContactLink, buildWhatsappLink, GENERIC_MESSAGE } = require("../lib/contact");

// Статусы, которые показываем на сайте. hidden и sync_error — не показываем.
const VISIBLE_STATUSES = ["active", "needs_research"];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Цена со скидкой — если акция наложена, иначе null. Скидка не меняет
// хранимую цену: снять акцию — значит вернуть исходную, не пересчитывать.
function salePriceOf(row) {
  return row.discount_percent
    ? Math.round(row.price * (1 - row.discount_percent / 100) * 100) / 100
    : null;
}

function toPublic(row) {
  const salePrice = salePriceOf(row);
  return {
    id: row.slug,
    name: row.official_name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    group: row.product_group,
    variant: row.variant,
    storage: row.storage,
    color: row.color,
    swatches: parseJson(row.swatches, []),
    price: row.price,
    currency: row.currency,
    discountPercent: row.discount_percent ?? null,
    discountLabel: row.discount_label,
    salePrice,
    available: Boolean(row.available),
    description: row.description,
    specifications: parseJson(row.specifications, {}),
    image: row.main_image_url,
    images: parseJson(row.image_urls, []),
    sourcePage: row.source_page_url,
    status: row.status,
    needsResearch: row.status === "needs_research",
    updatedAt: row.updated_at,
  };
}

function createCatalogRouter({ db }) {
  const router = express.Router();
  const contactUser = config.contact.telegram;

  router.get("/health", (req, res) => {
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM products) AS products,
           (SELECT COUNT(*) FROM products WHERE status = 'needs_research') AS needs_research,
           (SELECT COUNT(*) FROM telegram_messages) AS messages,
           (SELECT COUNT(*) FROM sync_jobs WHERE status = 'pending') AS pending_jobs,
           (SELECT COUNT(*) FROM sync_jobs WHERE status = 'failed') AS failed_jobs`
      )
      .get();
    res.json({ ok: true, features: config.features, counts });
  });

  router.get("/catalog", (req, res) => {
    const placeholders = VISIBLE_STATUSES.map(() => "?").join(",");
    const rows = db
      .prepare(
        // id ASC сохраняет исходный порядок каталога; новые товары из Telegram
        // получают больший id и встают в конец. Отсутствующие — всегда внизу.
        `SELECT * FROM products
         WHERE status IN (${placeholders})
         ORDER BY available DESC, id ASC`
      )
      .all(...VISIBLE_STATUSES);

    res.json({
      products: rows.map(toPublic),
      contact: {
        // Заказы — в WhatsApp, вопросы — в Telegram.
        whatsapp: config.contact.whatsapp,
        whatsappUrl: `https://wa.me/${config.contact.whatsapp}`,
        telegram: contactUser,
        url: `https://t.me/${contactUser}`,
        channel: config.contact.channel,
        channelUrl: `https://t.me/${config.contact.channel}`,
        phones: config.contact.phones,
        genericMessage: GENERIC_MESSAGE,
      },
      // Курсы только для показа. Цена товара в базе не меняется.
      rates: config.rates,
      updatedAt: new Date().toISOString(),
    });
  });

  router.get("/products/:slug", (req, res) => {
    const row = db.prepare("SELECT * FROM products WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found" });
    const product = toPublic(row);
    // Сообщения магазину называют ту цену, которую реально заплатят —
    // со скидкой, если акция активна.
    const priced = product.salePrice != null ? { ...row, price: product.salePrice } : row;
    res.json({
      product,
      order: buildWhatsappLink(config.contact.whatsapp, priced),
      contact: buildContactLink(contactUser, priced),
      sources: db
        .prepare(
          `SELECT m.telegram_message_id, m.telegram_message_updated_at, mp.price, mp.currency, mp.active, mp.available
           FROM message_products mp
           JOIN telegram_messages m ON m.id = mp.message_id
           WHERE mp.product_id = ?
           ORDER BY mp.updated_at DESC`
        )
        .all(row.id),
    });
  });

  router.get("/news", (req, res) => {
    const rows = db
      .prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 50")
      .all();
    res.json({
      posts: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        body: r.body,
        image: r.image,
        publishedAt: r.published_at,
      })),
    });
  });

  return router;
}

module.exports = { createCatalogRouter, toPublic, salePriceOf, VISIBLE_STATUSES };
