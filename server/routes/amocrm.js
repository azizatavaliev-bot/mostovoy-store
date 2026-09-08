const express = require("express");
const config = require("../config");
const logger = require("../logger");
const { parseAmoWebhooks } = require("../services/amocrm");
const { matchesCurrentOrNext } = require("../lib/token-rotation");

function createAmoCrmRouter({ crm }) {
  const router = express.Router();
  router.post(
    ["/webhook", "/webhook/:secret"],
    express.urlencoded({ extended: true, limit: "512kb" }),
    express.json({ limit: "512kb" }),
    (req, res) => {
      if (config.amocrm.webhookSecret) {
        const supplied = req.params.secret || req.get("x-webhook-secret");
        if (!matchesCurrentOrNext(supplied, config.amocrm.webhookSecret, config.amocrm.webhookSecretNext)) {
          return res.status(401).json({ ok: false, error: "invalid_secret" });
        }
      }
      const messages = parseAmoWebhooks(req.body || {}).filter((message) => message.text && message.chatId);
      if (!messages.length) {
        return res.json({ ok: true, ignored: "not_a_message" });
      }
      res.json({ ok: true, queued: true });
      const ordered = [
        ...messages.filter((message) => message.direction === "outgoing"),
        ...messages.filter((message) => message.direction !== "outgoing"),
      ];
      Promise.resolve().then(async () => {
        for (const message of ordered) await crm.receiveAmo(message, req.body);
      }).catch((error) =>
        logger.error("amocrm.crm_failed", { error: error.message })
      );
    }
  );
  return router;
}

module.exports = { createAmoCrmRouter };
