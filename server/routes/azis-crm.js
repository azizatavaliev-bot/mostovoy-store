const crypto = require("crypto");
const express = require("express");
const config = require("../config");

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createAzisCrmRouter({ crm }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!config.azisCrm.integrationSecret) {
      return res.status(503).json({ ok: false, error: "azis_crm_not_configured" });
    }
    if (!safeEqual(req.get("x-integration-secret"), config.azisCrm.integrationSecret)) {
      return res.status(401).json({ ok: false, error: "invalid_secret" });
    }
    next();
  });

  router.post("/incoming", async (req, res, next) => {
    try {
      const body = req.body || {};
      const result = await crm.receiveAmo(
        {
          text: String(body.text || "").trim(),
          direction: "incoming",
          chatId: String(body.externalChatId || body.chatId || ""),
          messageId: String(body.externalMessageId || body.messageId || ""),
          customerName: String(body.customerName || ""),
          customerUsername: String(body.customerUsername || ""),
          customerPhone: String(body.customerPhone || ""),
          leadId: String(body.externalLeadId || body.leadId || ""),
          contactId: String(body.externalContactId || body.contactId || ""),
          source: String(body.channel || body.source || "amocrm"),
          createdAt: body.createdAt || new Date().toISOString(),
        },
        body.raw || body,
      );
      res.status(202).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/outgoing", async (req, res, next) => {
    try {
      const result = await crm.sendExternal({
        source: String(req.body?.source || "amocrm"),
        chatId: String(req.body?.chatId || ""),
        leadId: String(req.body?.leadId || ""),
        contactId: String(req.body?.contactId || ""),
        text: String(req.body?.text || ""),
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAzisCrmRouter, safeEqual };
