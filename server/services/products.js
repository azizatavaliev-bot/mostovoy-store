// Операции с таблицей products, общие для синхронизации из Telegram и админки.
const { slugify, normalizeText } = require("../lib/normalize");

// Слаг товара для product.html?id=<slug>. При коллизии добавляет -2, -3…
function uniqueSlug(db, base) {
  const root = slugify(base);
  let slug = root;
  let i = 2;
  while (db.prepare("SELECT 1 FROM products WHERE slug = ?").get(slug)) {
    slug = `${root}-${i++}`;
  }
  return slug;
}

// Слаг из названия + различающих признаков, но только тех, которых ещё нет
// в названии — иначе получается «steam-deck-oled-512-gb-512-gb».
function slugForProduct(db, { name, storage, color, variant }) {
  const nameNorm = normalizeText(name);
  const extra = [storage, color, variant]
    .filter((v) => v && !nameNorm.includes(normalizeText(String(v))))
    .join(" ");
  return uniqueSlug(db, [name, extra].filter(Boolean).join(" "));
}

module.exports = { uniqueSlug, slugForProduct };
