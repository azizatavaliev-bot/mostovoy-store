// Синхронизация публикации Telegram → каталог.
//
// Модель одного источника: товар может встречаться в НЕСКОЛЬКИХ публикациях.
// Связь message_products описывает «этот пост сейчас продаёт этот товар».
// Итоговое наличие = есть хотя бы одна активная связь с available=1
// в неудалённом сообщении. Товар, пропавший из одного поста, не исчезает
// с витрины, если он есть в другом актуальном посте.
const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");
const { transaction, logSync, logPriceChange } = require("../db");
const { normalizedKey, matchKey, normalizeStorage, normalizeText, looksUnavailable } = require("../lib/normalize");
const { validateExtraction } = require("../lib/validate");
const { EXTRACT_SYSTEM, buildExtractUser } = require("../prompts");
const { matchProduct } = require("./matcher");
const { slugForProduct } = require("./products");

const MIN_CONFIDENCE_FOR_ACTIVE = 0.75;

const hashText = (text) => crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");

// Цена обязана буквально встречаться в тексте поста — защита от того,
// что модель подставит «рыночную» цену из своих знаний.
function priceAppearsInText(price, text) {
  if (price == null) return false;
  const haystack = String(text).replace(/[\s '`]/g, "");
  const asInt = String(Math.round(price));
  if (haystack.includes(asInt)) return true;
  const asFloat = String(price);
  if (haystack.includes(asFloat)) return true;
  return haystack.includes(asFloat.replace(".", ","));
}

function addAlias(db, productId, alias) {
  if (!alias) return;
  const norm = normalizeText(alias);
  if (!norm) return;
  db.prepare(
    `INSERT INTO product_aliases (product_id, alias, alias_normalized)
     VALUES (?, ?, ?)
     ON CONFLICT(alias_normalized) DO NOTHING`
  ).run(productId, alias, norm);
}

// Наличие пересчитывается по всем активным источникам сразу.
function recomputeAvailability(db, productId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message_products mp
       JOIN telegram_messages m ON m.id = mp.message_id
       WHERE mp.product_id = ? AND mp.active = 1 AND mp.available = 1 AND m.is_deleted = 0`
    )
    .get(productId);
  const links = db
    .prepare("SELECT COUNT(*) AS n FROM message_products WHERE product_id = ?")
    .get(productId);
  // Товары без единой связи (импортированные из data.js) наличие не теряют.
  if (links.n === 0) return;
  db.prepare("UPDATE products SET available = ?, updated_at = datetime('now') WHERE id = ?").run(
    row.n > 0 ? 1 : 0,
    productId
  );
}

function decideStatus({ confidence, research, hasImage, hasDescription }) {
  if (confidence < MIN_CONFIDENCE_FOR_ACTIVE) return "needs_research";
  if (research === "skipped" || research === "failed") return "needs_research";
  if (!hasImage || !hasDescription) return "needs_research";
  return "active";
}

class SyncService {
  constructor({ db, deepseek, research }) {
    this.db = db;
    this.deepseek = deepseek;
    this.research = research;
  }

  /**
   * Обрабатывает публикацию канала (новую или отредактированную).
   * Идемпотентна: тот же текст второй раз не создаёт записей и не зовёт ИИ.
   */
  async syncMessage({ chatId, messageId, text, messageUpdatedAt, isDeleted = false, force = false }) {
    const db = this.db;
    const textHash = hashText(text);

    const existing = db
      .prepare("SELECT * FROM telegram_messages WHERE telegram_chat_id = ? AND telegram_message_id = ?")
      .get(String(chatId), Number(messageId));

    if (existing && existing.telegram_text_hash === textHash && existing.last_sync_status === "ok" && !force && !isDeleted) {
      logger.info("sync.skipped_unchanged", { chatId, messageId });
      return { status: "skipped", reason: "unchanged", messageId, created: 0, updated: 0, deactivated: 0 };
    }

    const messageRowId = transaction(db, () => {
      if (existing) {
        db.prepare(
          `UPDATE telegram_messages
           SET telegram_original_text = ?, telegram_text_hash = ?, telegram_message_updated_at = ?,
               is_deleted = ?, last_sync_status = 'pending', updated_at = datetime('now')
           WHERE id = ?`
        ).run(String(text ?? ""), textHash, messageUpdatedAt || null, isDeleted ? 1 : 0, existing.id);
        return existing.id;
      }
      db.prepare(
        `INSERT INTO telegram_messages
           (telegram_chat_id, telegram_message_id, telegram_message_updated_at,
            telegram_original_text, telegram_text_hash, last_sync_status, is_deleted)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(String(chatId), Number(messageId), messageUpdatedAt || null, String(text ?? ""), textHash, isDeleted ? 1 : 0);
      return db.prepare("SELECT last_insert_rowid() AS id").get().id;
    });

    // Пост удалён — гасим все его связи, товары остаются, если есть в других постах.
    if (isDeleted) {
      const affected = this._deactivateAllLinks(messageRowId);
      this._finishMessage(messageRowId, "ok", null);
      return { status: "ok", messageId, created: 0, updated: 0, deactivated: affected.length };
    }

    let extraction;
    try {
      extraction = await this._extract(text);
    } catch (e) {
      this._finishMessage(messageRowId, "error", e.message);
      logSync(db, { level: "error", event: "extract_failed", chatId, messageId, details: { error: e.message } });
      throw e;
    }

    const stats = { created: 0, updated: 0, failed: 0, deactivated: 0, needsResearch: 0 };
    const touchedProductIds = [];

    // Каждый товар обрабатывается отдельно: одна ошибка не роняет остальные.
    for (const [index, item] of extraction.products.entries()) {
      try {
        const outcome = await this._syncProduct({ item, index, messageRowId, text, chatId, messageId });
        touchedProductIds.push(outcome.productId);
        if (outcome.created) stats.created++;
        else stats.updated++;
        if (outcome.status === "needs_research") stats.needsResearch++;
      } catch (e) {
        stats.failed++;
        logger.error("sync.product_failed", { name: item.official_name, error: e.message });
        logSync(db, {
          level: "error",
          event: "product_failed",
          chatId,
          messageId,
          details: { product: item.official_name, error: e.message },
        });
      }
    }

    // Товары, пропавшие из ЭТОГО сообщения, гасим только в рамках этого источника.
    const removed = transaction(db, () => {
      const placeholders = touchedProductIds.map(() => "?").join(",") || "NULL";
      const stale = db
        .prepare(
          `SELECT product_id FROM message_products
           WHERE message_id = ? AND active = 1
             AND product_id NOT IN (${placeholders})`
        )
        .all(messageRowId, ...touchedProductIds);
      for (const r of stale) {
        db.prepare(
          "UPDATE message_products SET active = 0, updated_at = datetime('now') WHERE message_id = ? AND product_id = ?"
        ).run(messageRowId, r.product_id);
      }
      return stale.map((r) => r.product_id);
    });
    stats.deactivated = removed.length;

    for (const pid of new Set([...touchedProductIds, ...removed])) {
      transaction(db, () => recomputeAvailability(db, pid));
    }

    this._finishMessage(messageRowId, extraction.rejected.length && !extraction.products.length ? "error" : "ok", null);
    logSync(db, { level: "info", event: "message_synced", chatId, messageId, details: stats });
    logger.info("sync.done", { chatId, messageId, ...stats, rejected: extraction.rejected.length });

    return { status: "ok", messageId, ...stats, rejected: extraction.rejected };
  }

  async _extract(text) {
    if (!this.deepseek || !this.deepseek.enabled) {
      throw new Error("DeepSeek не настроен: DEEPSEEK_API_KEY пуст");
    }
    const raw = await this.deepseek.chatJson({
      system: EXTRACT_SYSTEM,
      user: buildExtractUser(text),
    });
    const { products, rejected } = validateExtraction(raw);

    // Цена берётся только из Telegram — проверяем это буквально.
    const kept = [];
    for (const p of products) {
      if (!priceAppearsInText(p.price, text)) {
        rejected.push({ reason: "цена отсутствует в тексте поста", raw: p });
        logger.warn("sync.price_not_in_text", { product: p.official_name, price: p.price });
        continue;
      }
      // Ещё один детерминированный проход по признакам «нет в наличии».
      if (looksUnavailable(p.source_name)) p.available = false;
      kept.push(p);
    }
    return { products: kept, rejected };
  }

  async _syncProduct({ item, index, messageRowId, text, chatId, messageId }) {
    const db = this.db;
    const key = normalizedKey(item);
    const match = await matchProduct(db, item, { deepseek: this.deepseek });

    let productId;
    let created = false;
    let status;

    if (match.row) {
      // Известный товар: обновляем только цену и наличие. Повторное
      // исследование и генерацию описания НЕ запускаем — экономия API.
      productId = match.row.id;
      status = match.row.status === "sync_error" ? "active" : match.row.status;
      transaction(db, () => {
        db.prepare(
          `UPDATE products
           SET price = ?, currency = ?, last_sync_status = 'ok', last_sync_error = NULL,
               last_synced_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        ).run(item.price, item.currency, productId);
        addAlias(db, productId, item.source_name);
        if (match.row.price !== item.price || match.row.currency !== item.currency) {
          logPriceChange(db, {
            productId,
            slug: match.row.slug,
            name: match.row.official_name,
            oldPrice: match.row.price,
            newPrice: item.price,
            currency: item.currency,
            source: "telegram",
          });
        }
      });
      logger.debug("sync.matched", { product: item.official_name, method: match.method, score: match.score });
    } else {
      // Новый товар: полное исследование (описание, характеристики, фото).
      const researchResult = await this.research.research(item, key);
      const data = researchResult.data || {};
      const hasImage = Boolean(data.main_image_url);
      const hasDescription = Boolean(data.description);
      status = decideStatus({
        confidence: item.confidence,
        research: researchResult.status,
        hasImage,
        hasDescription,
      });

      created = true;
      productId = transaction(db, () => {
        const slug = slugForProduct(db, {
          name: item.official_name,
          storage: item.storage,
          color: item.color,
          variant: item.variant,
        });
        db.prepare(
          `INSERT INTO products
             (slug, normalized_key, match_key, official_name, brand, model, category, variant, storage, color,
              price, currency, available, description, specifications,
              main_image_url, image_urls, image_source_url, source_page_url,
              image_is_external, image_last_checked_at, status, confidence,
              research_status, researched_at, origin, last_sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'telegram', 'ok', datetime('now'))`
        ).run(
          slug,
          key,
          matchKey(item),
          data.official_name || item.official_name,
          item.brand || data.brand || null,
          item.model || data.model || null,
          item.category || data.category || null,
          item.variant || null,
          normalizeStorage(item.storage),
          item.color || null,
          item.price,
          item.currency,
          item.available ? 1 : 0,
          data.description || null,
          JSON.stringify(data.specifications || {}),
          data.main_image_url || null,
          JSON.stringify(data.image_urls || []),
          data.image_source_url || null,
          data.source_page_url || null,
          hasImage ? new Date().toISOString() : null,
          status,
          item.confidence,
          researchResult.status === "ok" ? "done" : researchResult.status,
          researchResult.status === "ok" ? new Date().toISOString() : null
        );
        const id = db.prepare("SELECT last_insert_rowid() AS id").get().id;
        addAlias(db, id, item.source_name);
        addAlias(db, id, item.official_name);
        return id;
      });
      logSync(db, {
        level: "info",
        event: "product_created",
        chatId,
        messageId,
        productId,
        details: { name: item.official_name, status, research: researchResult.status },
      });
    }

    // Связь «пост → товар». Повторная обработка обновляет её, а не дублирует.
    transaction(db, () => {
      db.prepare(
        `INSERT INTO message_products
           (message_id, product_id, source_name, price, currency, available, active, position, confidence, warning)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(message_id, product_id) DO UPDATE SET
           source_name = excluded.source_name,
           price = excluded.price,
           currency = excluded.currency,
           available = excluded.available,
           active = 1,
           position = excluded.position,
           confidence = excluded.confidence,
           warning = excluded.warning,
           updated_at = datetime('now')`
      ).run(
        messageRowId,
        productId,
        item.source_name,
        item.price,
        item.currency,
        item.available ? 1 : 0,
        index,
        item.confidence,
        item.warning || null
      );
    });

    return { productId, created, status };
  }

  _deactivateAllLinks(messageRowId) {
    const db = this.db;
    return transaction(db, () => {
      const rows = db.prepare("SELECT product_id FROM message_products WHERE message_id = ? AND active = 1").all(messageRowId);
      db.prepare("UPDATE message_products SET active = 0, updated_at = datetime('now') WHERE message_id = ?").run(messageRowId);
      for (const r of rows) recomputeAvailability(db, r.product_id);
      return rows.map((r) => r.product_id);
    });
  }

  _finishMessage(messageRowId, status, error) {
    this.db
      .prepare(
        `UPDATE telegram_messages
         SET last_sync_status = ?, last_sync_error = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(status, error || null, messageRowId);
  }
}

module.exports = { SyncService, hashText, priceAppearsInText, recomputeAvailability, decideStatus, MIN_CONFIDENCE_FOR_ACTIVE };
