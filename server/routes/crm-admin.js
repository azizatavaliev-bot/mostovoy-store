const express = require("express");

function createCrmAdminRoutes(router, crm) {
  router.get("/crm/status", (req, res) => res.json(crm.getStatus()));
  router.get("/crm/conversations", (req, res) => {
    res.json({ conversations: crm.listConversations() });
  });
  router.get("/crm/conversations/:id", (req, res) => {
    const detail = crm.getConversation(Number(req.params.id), { markRead: true });
    if (!detail) return res.status(404).json({ error: "not_found" });
    res.json(detail);
  });
  router.patch("/crm/conversations/:id", express.json(), (req, res) => {
    const detail = crm.updateConversation(Number(req.params.id), req.body || {});
    if (!detail) return res.status(404).json({ error: "not_found" });
    res.json(detail);
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
}

module.exports = { createCrmAdminRoutes };
