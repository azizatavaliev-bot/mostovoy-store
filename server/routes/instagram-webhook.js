// Вебхук Instagram Direct (Meta Graph API). Как и другие вебхуки в проекте
// (Telegram/Green API/amoCRM): проверить подлинность → ответить 200 как
// можно быстрее → обработка сообщения уже после ответа, чтобы Meta не
// начала слать повторы из-за медленного ответа.
const express = require("express");
const logger = require("../logger");
const config = require("../config");
const { verifyWebhookSignature, verifyWebhookSubscription } = require("../services/instagram-graph");

function createInstagramWebhookRouter({ db, crm }) {
  const router = express.Router();

  // Meta один раз при подписке (и при каждой смене полей/URL) шлёт GET с
  // hub.mode=subscribe — должны отдать hub.challenge как есть, plain text.
  router.get("/", (req, res) => {
    const challenge = verifyWebhookSubscription(req.query);
    if (req.query["hub.mode"] !== "subscribe" || challenge === null) {
      logger.warn("instagram_webhook.verify_failed", { ip: req.ip });
      return res.status(403).send("Forbidden");
    }
    res.status(200).send(challenge);
  });

  router.post("/", (req, res) => {
    // req.rawBody — точные байты тела с провода (см. verify в app.js);
    // без них HMAC не сойдётся даже для настоящего запроса Meta.
    if (!verifyWebhookSignature(req.rawBody, req.get("x-hub-signature-256"))) {
      logger.warn("instagram_webhook.bad_signature", { ip: req.ip });
      return res.status(401).json({ ok: false, error: "INSTAGRAM_WEBHOOK_INVALID_SIGNATURE" });
    }
    // Отвечаем немедленно — Meta ждёт HTTP 200 в течение нескольких секунд,
    // иначе считает доставку неуспешной и повторяет её (что и ловит дедуп
    // ниже, но лучше не провоцировать лишние повторы медленным ответом).
    res.status(200).json({ ok: true });

    const body = req.body;
    if (body?.object !== "instagram" || !Array.isArray(body?.entry)) return;
    for (const entry of body.entry) {
      for (const item of entry?.messaging || []) {
        try {
          processMessagingEvent({ db, crm, item });
        } catch (error) {
          logger.error("instagram_webhook.event_failed", { error: error.message });
        }
      }
    }
  });

  return router;
}

function processMessagingEvent({ db, crm, item }) {
  const message = item?.message;
  // is_echo — сообщение, которое сама бизнес-страница отправила (либо этот
  // же бот, либо менеджер из другого клиента Meta) — не входящее от клиента.
  if (!message || message.is_echo || message.is_unsupported || !message.text) return;
  const eventId = message.mid;
  if (!eventId) return;
  // Идемпотентность на уровне HTTP-события: Meta может продублировать
  // доставку одного и того же вебхука. Без этой проверки дубль всё равно
  // отсеется дальше по UNIQUE(conversation_id, external_message_id) в
  // crm_messages, но так мы не тратим время на повторную обработку вообще.
  try {
    db.prepare("INSERT INTO instagram_webhook_events (event_id) VALUES (?)").run(eventId);
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) return;
    throw error;
  }
  const senderId = item?.sender?.id;
  if (!senderId) return;
  Promise.resolve(crm?.receiveInstagramDirect({ senderId: String(senderId), text: message.text, messageId: eventId })).catch((error) =>
    logger.error("instagram_webhook.crm_failed", { error: error.message })
  );
}

module.exports = { createInstagramWebhookRouter };
