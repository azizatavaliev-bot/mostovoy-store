// Сопоставление распознанного товара с тем, что уже есть в базе.
// Порядок: точный ключ → алиас → нечёткое сходство → (при неоднозначности) LLM.
// Задача — не плодить дубликаты при каждом редактировании поста и при этом
// не склеить два разных товара.
const logger = require("../logger");
const { normalizedKey, matchKey, normalizeText, normalizeStorage, similarity } = require("../lib/normalize");
const { validateMatchChoice } = require("../lib/validate");
const { MATCH_SYSTEM, buildMatchUser } = require("../prompts");

// Выше — уверенное совпадение, ниже AMBIGUOUS — точно разные товары.
const AUTO_MATCH = 0.88;
const AMBIGUOUS = 0.7;

function findByKey(db, key) {
  return db.prepare("SELECT * FROM products WHERE normalized_key = ?").get(key) || null;
}

function findByMatchKey(db, key) {
  if (!key) return null;
  return db.prepare("SELECT * FROM products WHERE match_key = ? ORDER BY id LIMIT 1").get(key) || null;
}

function findByAlias(db, name) {
  const row = db
    .prepare(
      `SELECT p.* FROM product_aliases a
       JOIN products p ON p.id = a.product_id
       WHERE a.alias_normalized = ?`
    )
    .get(normalizeText(name));
  return row || null;
}

// Память/цвет/вариант — различающие признаки. Kindle Jade и Kindle Raspberry
// похожи по названию на 95%, но это разные товары, поэтому они обязаны совпасть.
function variantsEqual(a, b) {
  const norm = (v) => (v == null || v === "" ? "" : normalizeText(String(v)));
  return (
    norm(normalizeStorage(a.storage) || "") === norm(normalizeStorage(b.storage) || "") &&
    norm(a.color) === norm(b.color) &&
    norm(a.variant) === norm(b.variant)
  );
}

// Кандидаты для нечёткого сравнения: тот же бренд либо похожая категория.
function candidatePool(db, product, limit = 40) {
  const rows = db
    .prepare(
      `SELECT * FROM products
       WHERE status != 'hidden'
         AND (
           (? IS NOT NULL AND lower(brand) = lower(?))
           OR (? IS NOT NULL AND lower(category) = lower(?))
         )
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(product.brand, product.brand, product.category, product.category, limit);
  if (rows.length) return rows;
  // Бренд/категория не заданы — берём последние товары как узкий пул.
  return db.prepare("SELECT * FROM products WHERE status != 'hidden' ORDER BY updated_at DESC LIMIT ?").all(limit);
}

function scoreCandidates(product, pool) {
  return pool
    .map((row) => {
      if (!variantsEqual(product, row)) return { row, score: 0 };
      const byName = Math.max(
        similarity(product.official_name, row.official_name),
        similarity(product.model || product.official_name, row.model || row.official_name)
      );
      return { row, score: byName };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * @returns {{ row: object|null, method: string, score: number }}
 */
async function matchProduct(db, product, { deepseek } = {}) {
  const key = normalizedKey(product);

  const exact = findByKey(db, key);
  if (exact) return { row: exact, method: "normalized_key", score: 1 };

  // Тот же набор признаков, но разложенный моделью по другим полям.
  const byTokens = findByMatchKey(db, matchKey(product));
  if (byTokens) return { row: byTokens, method: "match_key", score: 1 };

  // Алиас — это дословная строка из поста. Если она уже привязана к товару,
  // это тот же товар, даже если модель иначе разложила признаки по полям,
  // поэтому variantsEqual здесь намеренно не проверяем.
  const byAlias = findByAlias(db, product.source_name || product.official_name);
  if (byAlias) return { row: byAlias, method: "alias", score: 1 };

  const scored = scoreCandidates(product, candidatePool(db, product));
  const best = scored[0];
  if (!best) return { row: null, method: "none", score: 0 };

  if (best.score >= AUTO_MATCH) return { row: best.row, method: "fuzzy", score: best.score };

  if (best.score >= AMBIGUOUS && deepseek?.enabled) {
    // Отдаём модели только несколько кандидатов, а не весь каталог.
    const candidates = scored.slice(0, 5).map((c) => ({
      normalized_key: c.row.normalized_key,
      official_name: c.row.official_name,
      brand: c.row.brand,
      storage: c.row.storage,
      color: c.row.color,
      variant: c.row.variant,
    }));
    try {
      const choice = validateMatchChoice(
        await deepseek.chatJson({
          system: MATCH_SYSTEM,
          user: buildMatchUser(product, candidates),
        })
      );
      if (choice.normalized_key && choice.confidence >= 0.7) {
        const row = findByKey(db, choice.normalized_key);
        if (row && variantsEqual(product, row)) {
          return { row, method: "llm", score: choice.confidence };
        }
      }
    } catch (e) {
      logger.warn("match.llm_failed", { error: e.message });
    }
  }

  return { row: null, method: "none", score: best.score };
}

module.exports = {
  matchProduct,
  findByKey,
  findByMatchKey,
  findByAlias,
  variantsEqual,
  scoreCandidates,
  AUTO_MATCH,
  AMBIGUOUS,
};
