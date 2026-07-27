// Telegram webhook. Отвечает быстро: проверил → сохранил задачу → 200.
// Вся тяжёлая работа уходит в очередь (см. queue.js).
const crypto = require("crypto");
const express = require("express");
const config = require("../config");
const logger = require("../logger");

// Сравнение секрета без утечки времени.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Публикация может быть text или caption (фото с подписью).
function postText(post) {
  return post?.text ?? post?.caption ?? "";
}

function createTelegramRouter({ db, queue, crm }) {
  const router = express.Router();

  router.post("/webhook", (req, res) => {
    if (!config.telegram.webhookSecret) {
      logger.error("telegram.webhook_secret_missing");
      return res.status(503).json({ ok: false, error: "webhook not configured" });
    }
    if (!safeEqual(req.get("x-telegram-bot-api-secret-token"), config.telegram.webhookSecret)) {
      logger.warn("telegram.bad_secret", { ip: req.ip });
      return res.status(401).json({ ok: false });
    }

    const update = req.body;
    if (!update || typeof update !== "object") return res.status(400).json({ ok: false });

    // Повторная доставка того же update — Telegram шлёт заново при таймауте.
    if (Number.isFinite(update.update_id)) {
      const dup = db.prepare("SELECT 1 FROM telegram_updates WHERE update_id = ?").get(update.update_id);
      if (dup) {
        logger.info("telegram.duplicate_update", { updateId: update.update_id });
        return res.json({ ok: true, duplicate: true });
      }
      db.prepare("INSERT INTO telegram_updates (update_id) VALUES (?)").run(update.update_id);
    }

    // Личные сообщения покупателей идут в единый CRM inbox. Сохраняем и
    // отвечаем после быстрого 200, чтобы Telegram не повторял webhook.
    if (update.message?.chat?.type === "private") {
      res.json({ ok: true, queued: true, kind: "customer_message" });
      Promise.resolve(crm?.receiveTelegram(update.message)).catch((error) =>
        logger.error("telegram.crm_failed", { error: error.message })
      );
      return;
    }

    const post = update.channel_post || update.edited_channel_post;
    const eventType = update.channel_post ? "channel_post" : update.edited_channel_post ? "edited_channel_post" : null;
    if (!post || !eventType) return res.json({ ok: true, ignored: "not_a_channel_post" });

    // Слушаем только свой канал.
    const chatId = String(post.chat?.id ?? "");
    if (config.telegram.channelId && chatId !== String(config.telegram.channelId)) {
      logger.warn("telegram.foreign_chat", { chatId });
      return res.json({ ok: true, ignored: "foreign_chat" });
    }

    const text = postText(post);
    if (!text.trim()) return res.json({ ok: true, ignored: "empty_post" });

    queue.enqueue({
      chatId,
      messageId: post.message_id,
      eventType,
      payload: {
        chatId,
        messageId: post.message_id,
        text,
        messageUpdatedAt: new Date((post.edit_date || post.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      },
    });

    return res.json({ ok: true, queued: true });
  });

  return router;
}

module.exports = { createTelegramRouter, safeEqual, postText };
