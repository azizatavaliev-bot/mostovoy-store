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
const { createImageRouter } = require("./routes/images");
const { createAmoCrmRouter } = require("./routes/amocrm");
const { AmoCrmClient } = require("./services/amocrm");
const { CrmService } = require("./services/crm");
const { AzisCrmClient } = require("./services/azis-crm");
const { CrmDealsClient } = require("./services/crm-deals");
const { createAzisCrmRouter } = require("./routes/azis-crm");
const { createGreenApiRouter } = require("./routes/greenapi");
const { createInstagramWebhookRouter } = require("./routes/instagram-webhook");
const { createWaberyWebhookRouter } = require("./routes/wabery-webhook");
const { GreenApiClient } = require("./services/greenapi");
const { HikerApiClient } = require("./services/instagram/hikerClient");
const { StoryCache } = require("./services/instagram/storyCache");
const { StoryResolver } = require("./services/instagram/storyResolver");

function createApp({ db, deepseek, ai, research, queue, crm, amocrm, azisCrm, crmDeals, greenapi, storyResolver } = {}) {
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
  const crmDealsClient = crmDeals || new CrmDealsClient();
  const greenApiClient = greenapi || new GreenApiClient();
  const storyResolverService = storyResolver || new StoryResolver({
    db,
    hikerClient: new HikerApiClient(),
    ai: aiRouter,
    cache: new StoryCache({ db }),
  });
  const crmService = crm || new CrmService({
    db,
    ai: aiRouter,
    deepseek: deepseekClient,
    amocrm: amoCrmClient,
    azisCrm: azisCrmClient,
    crmDeals: crmDealsClient,
    greenapi: greenApiClient,
    storyResolver: storyResolverService,
  });

  const app = express();
  app.disable("x-powered-by");
  // Тела апдейтов Telegram маленькие — лимит защищает от мусора.
  // verify сохраняет исходные байты тела в req.rawBody — без них подпись
  // Meta (X-Hub-Signature-256 в instagram-webhook.js) посчитать нельзя:
  // HMAC считается по точным байтам с провода, а не по JSON.stringify
  // уже распарсенного объекта (это не всегда даёт те же байты обратно).
  app.use(express.json({ limit: "512kb", verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.use("/api/telegram", createTelegramRouter({ db, queue: syncQueue, crm: crmService }));
  app.use("/api/amocrm", createAmoCrmRouter({ crm: crmService }));
  app.use("/api/greenapi", createGreenApiRouter({ crm: crmService }));
  app.use("/api/webhooks/instagram", createInstagramWebhookRouter({ db, crm: crmService }));
  app.use("/api/webhooks/wabery", createWaberyWebhookRouter({ crm: crmService }));
  app.use("/api/integrations/azis", createAzisCrmRouter({ crm: crmService }));
  app.use("/api/admin", createAdminRouter({ db, crm: crmService }));
  app.use("/api/images", createImageRouter({ db }));
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
    greenapi: greenApiClient,
    storyResolver: storyResolverService,
  };
  return app;
}

module.exports = { createApp };
