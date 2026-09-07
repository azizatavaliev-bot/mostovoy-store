"use strict";

// Клиент Agency Control Center (коннектор v1, см. CRM_CONNECTOR_CONTRACT.md
// в репозитории ADMINBOT). Пусто в CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN —
// всё становится no-op без единого лишнего лога на каждый вызов (один warn
// при старте). fire-and-forget: сеть недоступна — Control Center просто не
// видит сигнал, бот работает как раньше, ошибка никогда не долетает до
// бизнес-логики.

const config = require("../config");
const logger = require("../logger");
const pkg = require("../../package.json");

const TIMEOUT_MS = 5000;
const USAGE_FLUSH_MS = 60_000;

const enabled = config.features.controlCenter;
if (!enabled) {
  logger.warn("control_center.disabled", { hint: "задайте CONTROL_CENTER_URL и CONTROL_CENTER_TOKEN, чтобы включить" });
}

async function post(path, body) {
  if (!enabled) return;
  try {
    const res = await fetch(`${config.controlCenter.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.controlCenter.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) logger.warn("control_center.request_failed", { path, status: res.status });
  } catch (error) {
    logger.warn("control_center.request_failed", { path, error: error.message });
  }
}

// gitSha/deploySource: RAILWAY_GIT_COMMIT_SHA есть только если деплой
// действительно связан с гит-коммитом (см. контракт) — иначе честно "unknown",
// а не гадаем.
function heartbeat({ status = "ok", promptVersionId, details } = {}) {
  return post("/api/v1/connector/heartbeat", {
    status,
    version: pkg.version,
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "production",
    deploySource: process.env.RAILWAY_GIT_COMMIT_SHA ? "github" : "unknown",
    promptVersionId: promptVersionId || undefined,
    uptimeSeconds: Math.round(process.uptime()),
    details,
    security: { envPresent: Object.keys(process.env) },
  });
}

// usage копится в памяти и уходит батчем раз в минуту (до 500 за раз, как
// разрешает контракт) — не бьём по сети на каждый LLM-вызов.
let usageBuffer = [];
function reportUsage(event) {
  if (!enabled) return;
  usageBuffer.push(event);
}
function flushUsage() {
  if (!enabled || usageBuffer.length === 0) return;
  const events = usageBuffer.slice(0, 500);
  usageBuffer = usageBuffer.slice(500);
  void post("/api/v1/connector/usage", { events });
}
const usageFlushTimer = enabled ? setInterval(flushUsage, USAGE_FLUSH_MS) : null;
usageFlushTimer?.unref();

function reportEvent(event) {
  return post("/api/v1/connector/events", event);
}

module.exports = { enabled, heartbeat, reportUsage, flushUsage, reportEvent };
