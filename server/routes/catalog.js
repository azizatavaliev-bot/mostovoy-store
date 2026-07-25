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

function toPublic(row) {
  return {
    id: row.slug,
    name: row.official_name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    variant: row.variant,
    storage: row.storage,
    color: row.color,
    price: row.price,
    currency: row.currency,
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
    res.json({
      product,
      order: buildWhatsappLink(config.contact.whatsapp, row),
      contact: buildContactLink(contactUser, row),
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

  return router;
}

module.exports = { createCatalogRouter, toPublic, VISIBLE_STATUSES };
