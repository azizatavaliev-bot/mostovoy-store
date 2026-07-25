// Точка входа: миграции → первичное наполнение → сервер → воркер очереди.
const config = require("./config");
const logger = require("./logger");
const { getDb, closeDb } = require("./db");
const { seedLegacyProducts } = require("./services/seed");
const { createApp } = require("./app");

const db = getDb();
seedLegacyProducts(db);

const app = createApp({ db });
const { queue } = app.locals.services;

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
});

queue.start();

function shutdown(signal) {
  logger.info("server.shutdown", { signal });
  queue.stop();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
