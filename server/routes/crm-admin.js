const express = require("express");

function createCrmAdminRoutes(router, crm) {
  router.get("/crm/status", (req, res) => res.json(crm.getStatus()));
  router.get("/crm/conversations", (req, res) => {
    res.json({ conversations: crm.listConversations() });
  });
  router.get("/crm/conversations/:id", async (req, res) => {
    try {
      const detail = await crm.getConversationWithRemoteHistory(Number(req.params.id), { markRead: true });
      if (!detail) return res.status(404).json({ error: "not_found" });
      res.json(detail);
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
  router.patch("/crm/conversations/:id", express.json(), (req, res) => {
    const detail = crm.updateConversation(Number(req.params.id), req.body || {});
    if (!detail) return res.status(404).json({ error: "not_found" });
    res.json(detail);
  });
  router.post("/crm/conversations/:id/clear-history", (req, res) => {
    const result = crm.clearConversationHistory(Number(req.params.id));
    if (!result) return res.status(404).json({ error: "not_found" });
    res.json(result);
  });
  router.delete("/crm/conversations/:id", (req, res) => {
    const result = crm.deleteConversation(Number(req.params.id));
    if (!result) return res.status(404).json({ error: "not_found" });
    res.json(result);
  });
  router.post("/crm/conversations/:id/messages", express.json(), async (req, res) => {
    try {
      const detail = await crm.sendManual(Number(req.params.id), req.body?.text);
      res.status(201).json(detail);
    } catch (error) {
      res.status(/не настроен/.test(error.message) ? 503 : 400).json({ error: error.message });
    }
  });
  router.get("/crm/settings", (req, res) => res.json(crm.getSettings()));
  router.put("/crm/settings", express.json(), (req, res) => {
    res.json(crm.saveSettings(req.body || {}));
  });
  router.get("/crm/approvals", (req, res) => {
    res.json({ approvals: crm.listApprovals(String(req.query.status || "pending")) });
  });
  router.post("/crm/approvals/:id/approve", express.json(), async (req, res) => {
    try {
      res.json({ approval: await crm.approveReply(Number(req.params.id), req.body?.text) });
    } catch (error) {
      res.status(/не найден/.test(error.message) ? 404 : 400).json({ error: error.message });
    }
  });
  router.post("/crm/approvals/:id/reject", express.json(), async (req, res) => {
    try {
      res.json({ approval: await crm.rejectReply(Number(req.params.id), req.body?.reason) });
    } catch (error) {
      res.status(/не найден/.test(error.message) ? 404 : 400).json({ error: error.message });
    }
  });
  router.get("/crm/developer/status", (req, res) => res.json(crm.getDeveloperStatus()));
  router.get("/crm/developer/events", (req, res) => {
    res.json({ events: crm.listEvents({ level: req.query.level, limit: req.query.limit }) });
  });
  router.get("/crm/developer/usage", (req, res) => res.json(crm.getAiUsageAnalytics()));
  router.post("/crm/developer/lab", express.json(), async (req, res) => {
    try {
      res.json(await crm.testBot(req.body || {}));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  // Лаборатория WhatsApp: тот же пайплайн, что у клиентов, но в изолированном
  // диалоге lab-… и без отправки наружу (crm.js labSend).
  router.post("/crm/whatsapp-lab/messages", express.json(), async (req, res) => {
    try {
      res.json(await crm.labSend(req.body || {}));
    } catch (error) {
      res.status(/не настроен/.test(error.message) ? 503 : 400).json({ error: error.message });
    }
  });
  router.get("/crm/whatsapp-lab/:chatId", (req, res) => {
    res.json({ chatId: req.params.chatId, history: crm.labHistory(req.params.chatId) });
  });
  router.delete("/crm/whatsapp-lab/:chatId", (req, res) => {
    res.json(crm.labReset(req.params.chatId));
  });
  // Настройки WhatsApp (Green API): состояние инстанса и включение вебхука.
  router.get("/crm/whatsapp/state", async (req, res) => {
    try {
      res.json(await crm.getWhatsappState());
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
  router.post("/crm/whatsapp/setup-webhook", async (req, res) => {
    try {
      res.json(await crm.setupWhatsappWebhook());
    } catch (error) {
      res.status(/не настроен|не задан/.test(error.message) ? 503 : 502).json({ error: error.message });
    }
  });
  router.get("/crm/analytics", (req, res) => {
    res.json(crm.getBuyAnalytics(Number(req.query.days)));
  });
  // Заказы, которые бот подтвердил в переписке (см. _publishOrderIfConfirmed) —
  // менеджер работает с ними тут, независимо от того, настроена ли внешняя CRM.
  router.get("/crm/orders", (req, res) => {
    res.json({ orders: crm.listOrders({ status: req.query.status }) });
  });
  router.patch("/crm/orders/:id", express.json(), (req, res) => {
    const order = crm.updateOrder(Number(req.params.id), req.body || {});
    if (!order) return res.status(404).json({ error: "not_found" });
    res.json({ order });
  });

  // Instagram Direct (Meta Graph API, Instagram Login) — состояние
  // подключения и запуск/остановку OAuth. За requireAdmin в admin.js: тот
  // же браузер, что нажал «Подключить», получает редирект от Meta обратно
  // на /callback с той же сессионной cookie, так что колбэк можно защищать
  // тем же способом, что и остальную админку — второй слой защиты (CSRF
  // state с TTL) не завязан на сессию и работает независимо.
  router.get("/crm/instagram/status", (req, res) => {
    res.json(crm.getInstagramStatus());
  });
  router.post("/crm/instagram/connect", (req, res) => {
    try {
      res.json(crm.connectInstagram());
    } catch (error) {
      res.status(error.code === "INSTAGRAM_NOT_CONNECTED" ? 503 : 500).json({ error: error.code || "INSTAGRAM_API_ERROR", message: error.message });
    }
  });
  router.get("/crm/instagram/callback", express.json(), async (req, res) => {
    try {
      await crm.handleInstagramCallback({
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
        errorDescription: req.query.error_description,
      });
      res.type("html").send(instagramCallbackPage(true, "Instagram подключён. Можно закрыть эту вкладку."));
    } catch (error) {
      res.status(400).type("html").send(instagramCallbackPage(false, error.message || "Не удалось подключить Instagram"));
    }
  });
  router.delete("/crm/instagram", (req, res) => {
    res.json(crm.disconnectInstagram());
  });
}

function instagramCallbackPage(ok, message) {
  const escaped = String(message || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Instagram</title></head>
<body style="font-family:sans-serif;padding:40px;text-align:center;">
<h2>${ok ? "✅" : "⚠️"} ${escaped}</h2>
<p><a href="/admin.html">Вернуться в админку</a></p>
</body></html>`;
}

module.exports = { createCrmAdminRoutes };
