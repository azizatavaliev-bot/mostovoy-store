// Сборка Express-приложения. Вынесено из index.js, чтобы тесты могли
// поднять приложение с тестовой базой и мок-клиентами.
const path = require("path");
const fs = require("fs");
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
const { createAdminRouter } = require("./routes/admin");

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
  app.use("/api/admin", createAdminRouter({ db }));
  app.use("/api", createCatalogRouter({ db }));

  // Фото, загруженные через админку. Живут вне репозитория (см. .gitignore).
  app.use("/uploads", express.static(config.uploads.dir, { maxAge: "30d" }));

  // Витрина: собранный Vite-фронт (frontend/dist). В деве фронт крутится
  // отдельным процессом (vite, :5173) и проксирует /api и /uploads сюда —
  // тогда этой сборки ещё нет, и статику просто не отдаём.
  const distRoot = path.join(__dirname, "..", "frontend", "dist");
  if (fs.existsSync(path.join(distRoot, "index.html"))) {
    app.use(
      express.static(distRoot, {
        extensions: ["html"],
        setHeaders: (res, filePath) => {
          if (filePath.endsWith(".html")) res.setHeader("cache-control", "no-cache");
        },
      })
    );
  } else {
    logger.warn("server.frontend_dist_missing", { hint: "npm run build (в frontend/) или npm run dev для локальной разработки" });
  }

  app.use((err, req, res, next) => {
    logger.error("http.error", { path: req.path, error: err.message });
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  app.locals.services = { deepseek: deepseekClient, research: researchService, sync: syncService, queue: syncQueue };
  return app;
}

module.exports = { createApp };
