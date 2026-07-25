// Минимальный структурный логгер: одна строка JSON на событие.
const config = require("./config");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, event, data) {
  if (LEVELS[level] > threshold) return;
  const line = { ts: new Date().toISOString(), level, event, ...data };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
}

module.exports = {
  error: (event, data = {}) => emit("error", event, data),
  warn: (event, data = {}) => emit("warn", event, data),
  info: (event, data = {}) => emit("info", event, data),
  debug: (event, data = {}) => emit("debug", event, data),
};
