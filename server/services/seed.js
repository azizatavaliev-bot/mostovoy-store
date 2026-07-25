// Первичное наполнение каталога из data.js, чтобы витрина не была пустой
// до первого поста в канале. data.js — браузерный файл без экспортов,
// поэтому читаем его через vm (так же, как это делает проверка синтаксиса).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const logger = require("../logger");
const { normalizedKey, matchKey, slugify } = require("../lib/normalize");

// Читает data.js и photos.js в одной песочнице: PHONES + window.PHOTOS.
function readLegacyPhones(dir = path.join(__dirname, "..", "..")) {
  const dataFile = path.join(dir, "data.js");
  if (!fs.existsSync(dataFile)) return { phones: [], photos: {} };
  const sandbox = { window: {}, __out: {} };
  vm.createContext(sandbox);
  for (const name of ["data.js", "photos.js"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      // Эпилог в том же скрипте: `const PHONES` — лексическая переменная,
      // сама по себе она не становится свойством global в песочнице.
      const source =
        fs.readFileSync(file, "utf8") +
        "\n;try { __out.PHONES = typeof PHONES !== 'undefined' ? PHONES : __out.PHONES; } catch (e) {}";
      vm.runInContext(source, sandbox, { timeout: 2000 });
    } catch (e) {
      logger.warn("seed.legacy_file_failed", { file: name, error: e.message });
    }
  }
  return {
    phones: Array.isArray(sandbox.__out.PHONES) ? sandbox.__out.PHONES : [],
    photos: sandbox.window.PHOTOS || {},
  };
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
     ON CONFLICT(normalized_key) DO NOTHING`
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
