// Сопоставление StoryAnalysis с каталогом товаров. Никогда не выбирает
// «тот самый» товар автоматически — только отдаёт до нескольких кандидатов
// с ненулевым совпадением, решение остаётся за основным AI-менеджером
// (и в конечном счёте за клиентом).
function tokenize(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .match(/[a-zа-я0-9]+/gu) || [];
}

function searchTokens(storyAnalysis) {
  const words = new Set();
  for (const product of storyAnalysis?.products_visible || []) {
    for (const token of tokenize(product.name_guess)) words.add(token);
    for (const token of tokenize(product.category)) words.add(token);
    for (const token of tokenize(product.brand)) words.add(token);
  }
  for (const detail of storyAnalysis?.important_details || []) {
    for (const token of tokenize(detail)) words.add(token);
  }
  // Общие слова не несут сигнала и раздувают ложные совпадения.
  const stop = new Set(["и", "в", "на", "с", "для", "the", "and", "or", "черный", "черные", "черная"]);
  return [...words].filter((token) => token.length >= 3 && !stop.has(token));
}

/**
 * @param {object} db — node:sqlite DatabaseSync
 * @param {object} storyAnalysis — нормализованный StoryAnalysis (см. storyAnalyzer.js)
 * @param {{ limit?: number }} opts
 * @returns {Array<{id:number, name:string, brand:string|null, category:string|null, price:number, currency:string, priceKgs:number|null}>}
 */
function matchCatalog(db, storyAnalysis, { limit = 3 } = {}) {
  if (!storyAnalysis?.contains_product) return [];
  const tokens = searchTokens(storyAnalysis);
  if (!tokens.length) return [];

  const rows = db.prepare(
    `SELECT p.id, p.official_name AS name, p.brand, p.category, mp.price, mp.currency
       FROM products p
       JOIN message_products mp ON mp.product_id = p.id
       JOIN telegram_messages tm ON tm.id = mp.message_id
      WHERE p.status != 'hidden' AND mp.active = 1 AND tm.is_deleted = 0 AND mp.price IS NOT NULL
        AND tm.id = (
          SELECT tm2.id FROM message_products mp2 JOIN telegram_messages tm2 ON tm2.id = mp2.message_id
           WHERE mp2.product_id = p.id AND mp2.active = 1 AND tm2.is_deleted = 0 AND mp2.price IS NOT NULL
           ORDER BY COALESCE(tm2.telegram_message_updated_at, tm2.updated_at, tm2.created_at) DESC, tm2.id DESC
           LIMIT 1
        )
      ORDER BY tm.telegram_message_updated_at DESC, tm.id DESC`
  ).all();

  // Та же дедупликация по названию, что и в основном каталоге для ИИ —
  // синк иногда заводит несколько product_id под одним official_name.
  const seenNames = new Set();
  const deduped = rows.filter((row) => {
    if (seenNames.has(row.name)) return false;
    seenNames.add(row.name);
    return true;
  });

  const scored = deduped
    .map((row) => {
      const haystack = tokenize(`${row.name} ${row.brand || ""} ${row.category || ""}`);
      const haystackSet = new Set(haystack);
      const score = tokens.reduce((total, token) => total + (haystackSet.has(token) ? 1 : 0), 0);
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ row }) => ({
    id: Number(row.id),
    name: row.name,
    brand: row.brand || null,
    category: row.category || null,
    price: Number(row.price),
    currency: row.currency,
  }));
}

module.exports = { matchCatalog };
