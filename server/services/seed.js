// Первичное наполнение каталога из frontend/src/data/phones.json, чтобы
// витрина не была пустой до первого поста в канале. Тот же JSON читает и
// фронт (frontend/src/data.ts) — единый источник данных для backend и UI.
const fs = require("fs");
const path = require("path");
const logger = require("../logger");
const { normalizedKey, matchKey, slugify } = require("../lib/normalize");

function readLegacyPhones(dir = path.join(__dirname, "..", "..", "frontend", "src", "data")) {
  const phonesFile = path.join(dir, "phones.json");
  const photosFile = path.join(dir, "photos.json");
  let phones = [];
  let photos = {};
  try {
    if (fs.existsSync(phonesFile)) phones = JSON.parse(fs.readFileSync(phonesFile, "utf8"));
    if (fs.existsSync(photosFile)) photos = JSON.parse(fs.readFileSync(photosFile, "utf8"));
  } catch (e) {
    logger.warn("seed.legacy_file_failed", { error: e.message });
  }
  return { phones: Array.isArray(phones) ? phones : [], photos };
}

// Цены в data.js — демо в рублях, поэтому валюта RUB.
function seedLegacyProducts(db, { dir } = {}) {
  const { phones, photos } = readLegacyPhones(dir);
  if (!phones.length) return { inserted: 0 };

  const insert = db.prepare(
    `INSERT INTO products
       (slug, normalized_key, match_key, official_name, brand, model, category, storage,
        price, currency, available, description, specifications,
        main_image_url, image_urls, status, confidence, research_status, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'active', 1, 'skipped', 'legacy')
     ON CONFLICT DO NOTHING`
  );

  let inserted = 0;
  for (const p of phones) {
    const key = normalizedKey({ brand: p.brand, model: p.name, variant: "standard" });
    const specs = {
      Дисплей: p.display,
      Процессор: p.chip,
      Камера: p.camera,
      Батарея: p.battery,
      Корпус: p.material,
      Защита: p.water,
      Разъём: p.connector,
      Память: p.storage,
      Вес: p.weight,
      ОС: p.os,
      Цвета: p.colors,
    };
    const res = insert.run(
      slugify(p.id),
      key,
      matchKey({ brand: p.brand, model: p.name }),
      p.name,
      p.brand,
      p.name,
      "Смартфоны",
      // В data.js в storage лежит СПИСОК вариантов («128 ГБ / 256 ГБ»), а колонка
      // storage — различающий признак товара. Список остаётся в характеристиках.
      null,
      p.price,
      "RUB",
      p.desc || null,
      JSON.stringify(specs),
      p.img || photos[p.id] || null,
      JSON.stringify([]),
    );
    if (res.changes) inserted++;
  }
  logger.info("seed.legacy_products", { inserted, total: phones.length });
  return { inserted };
}

module.exports = { seedLegacyProducts, readLegacyPhones };
