// Вебхук Wabery: единый конверт {event, payload, sentAt} на все каналы
// (WhatsApp/Instagram/Messenger) — нас интересует только message.received
// с нашего Instagram-канала (channel_id из конфига), остальное игнорируем.
const express = require("express");
const logger = require("../logger");
const config = require("../config");
const { verifyWebhookSignature } = require("../services/wabery");

function createWaberyWebhookRouter({ crm }) {
  const router = express.Router();

  router.post("/", (req, res) => {
    // req.rawBody — точные байты тела (см. verify в app.js): подпись HMAC
    // считается по ним, а не по повторно сериализованному JSON.
    if (!verifyWebhookSignature(req.rawBody, req.get("x-wabery-signature"))) {
      logger.warn("wabery_webhook.bad_signature", { ip: req.ip });
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }
    // Отвечаем сразу — обработка (в т.ч. вызов ИИ) уже после ответа.
    res.status(200).json({ ok: true });

    const body = req.body;
    if (body?.event !== "message.received") return;
    const payload = body.payload;
    if (!payload || payload.channel_id !== config.wabery.instagramChannelId) return;
    try {
      forwardToCrm(crm, payload);
    } catch (error) {
      logger.error("wabery_webhook.event_failed", { error: error.message });
    }
  });

  return router;
}

function forwardToCrm(crm, payload) {
  const text = String(payload.text || "").trim();
  const conversationId = payload.conversation_id;
  if (!text || !conversationId) return;
  Promise.resolve(crm?.receiveWabery({
    conversationId: String(conversationId),
    text,
    messageId: payload.message_id || null,
    username: payload.username || null,
  })).catch((error) => logger.error("wabery_webhook.crm_failed", { error: error.message }));
}

module.exports = { createWaberyWebhookRouter };
