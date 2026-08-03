// Точка входа: миграции → первичное наполнение → сервер → воркер очереди.
const config = require("./config");
const logger = require("./logger");
const { getDb, closeDb } = require("./db");
const { seedLegacyProducts } = require("./services/seed");
const { createApp } = require("./app");
const { syncPublicChannelPosts } = require("./cli/import-public-channel");
const { startFxRateUpdater } = require("./services/fx-rates");

const db = getDb();
seedLegacyProducts(db);

const app = createApp({ db });
const { queue } = app.locals.services;
let fullCatalogSyncTimer = null;

async function syncFullChannelCatalog() {
  try {
    const result = await syncPublicChannelPosts({ db, maxPages: Infinity });
    logger.info("catalog.full_channel_synced", result);
  } catch (error) {
    logger.warn("catalog.full_channel_sync_failed", { error: error.message });
  }
}

const server = app.listen(config.port, () => {
  logger.info("server.started", {
    port: config.port,
    features: config.features,
    model: config.deepseek.model,
    researchProvider: config.research.provider,
  });
  if (!config.features.telegram) logger.warn("server.telegram_disabled", { hint: "задайте TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET" });
  if (!config.features.deepseek) logger.warn("server.deepseek_disabled", { hint: "задайте DEEPSEEK_API_KEY" });
  if (!config.features.research) logger.warn("server.research_disabled", { hint: "новые товары будут создаваться со статусом needs_research и без фото" });
  void syncFullChannelCatalog();
  fullCatalogSyncTimer = setInterval(syncFullChannelCatalog, 6 * 60 * 60 * 1000);
  fullCatalogSyncTimer.unref();
  startFxRateUpdater();
});

queue.start();

function shutdown(signal) {
  logger.info("server.shutdown", { signal });
  if (fullCatalogSyncTimer) clearInterval(fullCatalogSyncTimer);
  queue.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
