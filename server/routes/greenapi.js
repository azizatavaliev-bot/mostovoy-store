// Вебхук Green API (WhatsApp). Как и Telegram/amoCRM: проверил токен →
// ответил 200 → обработка в фоне, иначе провайдер начнёт слать повторы.
const express = require("express");
const config = require("../config");
const logger = require("../logger");
const { parseGreenApiWebhook } = require("../services/greenapi");
const { matchesCurrentOrNext } = require("../lib/token-rotation");

function createGreenApiRouter({ crm }) {
  const router = express.Router();
  router.post("/webhook", express.json({ limit: "512kb" }), (req, res) => {
    // Green API подписывает вебхук заголовком Authorization: Bearer <webhookUrlToken>
    // (тот же токен, что передаём в setSettings). Без настроенного токена
    // маршрут закрыт целиком — иначе любой мог бы слать боту «сообщения клиентов».
    if (!config.greenapi.webhookToken) {
      logger.error("greenapi.webhook_token_missing");
      return res.status(503).json({ ok: false, error: "webhook not configured" });
    }
    const supplied = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!matchesCurrentOrNext(supplied, config.greenapi.webhookToken, config.greenapi.webhookTokenNext)) {
      logger.warn("greenapi.bad_token", { ip: req.ip });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const message = parseGreenApiWebhook(req.body);
    if (!message) return res.json({ ok: true, ignored: "not_a_message" });
    res.json({ ok: true, queued: true });
    Promise.resolve(crm?.receiveGreenApi(message, req.body)).catch((error) =>
      logger.error("greenapi.crm_failed", { error: error.message })
    );
  });
  return router;
}

module.exports = { createGreenApiRouter };
