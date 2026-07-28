// Сборка Express-приложения. Вынесено из index.js, чтобы тесты могли
// поднять приложение с тестовой базой и мок-клиентами.
const path = require("path");
const fs = require("fs");
const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { DeepSeekClient } = require("./services/deepseek");
const { AiRouter } = require("./services/ai");
const { ProductResearchService } = require("./services/research");
const { createResearchProvider } = require("./services/research/providers");
const { SyncService } = require("./services/sync");
const { SyncQueue } = require("./queue");
const { createTelegramRouter } = require("./routes/telegram");
const { createCatalogRouter } = require("./routes/catalog");
const { createAdminRouter } = require("./routes/admin");
const { createAmoCrmRouter } = require("./routes/amocrm");
const { AmoCrmClient } = require("./services/amocrm");
const { CrmService } = require("./services/crm");
const { AzisCrmClient } = require("./services/azis-crm");
const { createAzisCrmRouter } = require("./routes/azis-crm");

function createApp({ db, deepseek, ai, research, queue, crm, amocrm, azisCrm } = {}) {
  const deepseekClient = deepseek || new DeepSeekClient();
  const aiRouter = ai || new AiRouter({ deepseek: deepseekClient });
  const researchService =
    research ||
    new ProductResearchService({
      provider: createResearchProvider(),
      deepseek: deepseekClient,
      db,
    });
  const syncService = new SyncService({ db, deepseek: deepseekClient, research: researchService });
  const syncQueue = queue || new SyncQueue({ db, syncService });
  const amoCrmClient = amocrm || new AmoCrmClient();
  const azisCrmClient = azisCrm || new AzisCrmClient();
  const crmService = crm || new CrmService({
    db,
    ai: aiRouter,
    deepseek: deepseekClient,
    amocrm: amoCrmClient,
    azisCrm: azisCrmClient,
  });

  const app = express();
  app.disable("x-powered-by");
  // Тела апдейтов Telegram маленькие — лимит защищает от мусора.
  app.use(express.json({ limit: "512kb" }));

  app.use("/api/telegram", createTelegramRouter({ db, queue: syncQueue, crm: crmService }));
  app.use("/api/amocrm", createAmoCrmRouter({ crm: crmService }));
  app.use("/api/integrations/azis", createAzisCrmRouter({ crm: crmService }));
  app.use("/api/admin", createAdminRouter({ db, crm: crmService }));
  app.use("/api", createCatalogRouter({ db, azisCrm: azisCrmClient }));

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

  app.locals.services = {
    deepseek: deepseekClient,
    ai: aiRouter,
    research: researchService,
    sync: syncService,
    queue: syncQueue,
    crm: crmService,
    amocrm: amoCrmClient,
    azisCrm: azisCrmClient,
  };
  return app;
}

module.exports = { createApp };
