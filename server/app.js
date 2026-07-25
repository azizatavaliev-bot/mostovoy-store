// Сборка Express-приложения. Вынесено из index.js, чтобы тесты могли
// поднять приложение с тестовой базой и мок-клиентами.
const path = require("path");
const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { DeepSeekClient } = require("./services/deepseek");
const { ProductResearchService } = require("./services/research");
const { createResearchProvider } = require("./services/research/providers");
const { SyncService } = require("./services/sync");
const { SyncQueue } = require("./queue");
const { createTelegramRouter } = require("./routes/telegram");
const { createCatalogRouter } = require("./routes/catalog");

function createApp({ db, deepseek, research, queue } = {}) {
  const deepseekClient = deepseek || new DeepSeekClient();
  const researchService =
    research ||
    new ProductResearchService({
      provider: createResearchProvider(),
      deepseek: deepseekClient,
      db,
    });
  const syncService = new SyncService({ db, deepseek: deepseekClient, research: researchService });
  const syncQueue = queue || new SyncQueue({ db, syncService });

  const app = express();
  app.disable("x-powered-by");
  // Тела апдейтов Telegram маленькие — лимит защищает от мусора.
  app.use(express.json({ limit: "512kb" }));

  app.use("/api/telegram", createTelegramRouter({ db, queue: syncQueue }));
  app.use("/api", createCatalogRouter({ db }));

  // Витрина: статика из корня репозитория.
  const staticRoot = path.join(__dirname, "..");
  app.use(
    express.static(staticRoot, {
      extensions: ["html"],
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) res.setHeader("cache-control", "no-cache");
      },
    })
  );

  app.use((err, req, res, next) => {
    logger.error("http.error", { path: req.path, error: err.message });
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  app.locals.services = { deepseek: deepseekClient, research: researchService, sync: syncService, queue: syncQueue };
  return app;
}

module.exports = { createApp };
