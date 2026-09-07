// Отдельный файл — без CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN, чтобы
// проверить no-op режим в чистом виде (config читает env один раз при
// первом require, поэтому его нельзя проверить в одном процессе с
// control-center.test.js, где эти переменные заданы).

const test = require("node:test");
const assert = require("node:assert/strict");
const controlCenter = require("../server/services/control-center");

test("controlCenter.enabled — false без CONTROL_CENTER_URL/TOKEN, вызовы не бьют по сети", async () => {
  assert.equal(controlCenter.enabled, false);

  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200 }; };
  try {
    await controlCenter.heartbeat();
    await controlCenter.reportEvent({ type: "error", title: "test" });
    controlCenter.reportUsage({ provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 1, outputTokens: 1 });
    controlCenter.flushUsage();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalled, false, "выключенная интеграция не должна делать сетевых запросов вообще");
});
