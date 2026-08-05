// Живой курс валют для показа цены в другой валюте на витрине и в ответах
// бота. Раз в несколько часов подтягивает реальный курс USD → KGS/RUB/KZT и
// обновляет config.rates на месте — все потребители (роут /api/catalog,
// buildTelegramCatalogForAssistant) читают тот же объект и получают
// свежие цифры без дополнительных правок.
//
// Если внешний источник недоступен — молча оставляем прежнее значение
// (последний удачный курс или дефолт из .env). Курс никогда не обнуляется
// и не падает сервер из-за сети.
const logger = require("../logger");
const config = require("../config");

const SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 часов — курс так часто не меняется
const FETCH_TIMEOUT_MS = 10000;
// KGS сюда не входит: это фиксированный внутренний курс магазина (88),
// а не рыночный — не должен обновляться живым источником.
const TRACKED = ["RUB", "KZT"];

async function fetchLiveRates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || data.result !== "success" || !data.rates) {
      throw new Error("Неожиданный ответ источника курсов");
    }
    return data.rates;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshRatesOnce() {
  try {
    const rates = await fetchLiveRates();
    const updated = {};
    for (const code of TRACKED) {
      const value = Number(rates[code]);
      if (Number.isFinite(value) && value > 0) {
        config.rates[code] = value;
        updated[code] = value;
      }
    }
    if (Object.keys(updated).length) {
      logger.info("fx_rates.updated", updated);
    }
  } catch (error) {
    logger.warn("fx_rates.fetch_failed", { error: error.message });
  }
}

// Запускать только из реальной точки входа сервера (server/index.js) —
// тесты и CLI используют createApp() напрямую и не должны стучаться в сеть.
function startFxRateUpdater() {
  refreshRatesOnce();
  const timer = setInterval(refreshRatesOnce, REFRESH_MS);
  timer.unref();
  return timer;
}

module.exports = { startFxRateUpdater, refreshRatesOnce };
