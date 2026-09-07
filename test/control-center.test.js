// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.CONTROL_CENTER_URL = "https://control-center.example.com";
process.env.CONTROL_CENTER_TOKEN = "acc_pt_test-token";

const test = require("node:test");
const assert = require("node:assert/strict");
const controlCenter = require("../server/services/control-center");

test("controlCenter.enabled — true, когда CONTROL_CENTER_URL и CONTROL_CENTER_TOKEN заданы", () => {
  assert.equal(controlCenter.enabled, true);
});

test("heartbeat отправляет POST с Authorization и security.envPresent как список имён (не значений)", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200 };
  };
  try {
    await controlCenter.heartbeat({ status: "ok" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://control-center.example.com/api/v1/connector/heartbeat");
  assert.equal(calls[0].opts.headers.authorization, "Bearer acc_pt_test-token");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.status, "ok");
  assert.ok(Array.isArray(body.security.envPresent));
  assert.ok(body.security.envPresent.includes("CONTROL_CENTER_TOKEN"), "имя переменной должно быть в списке");
  assert.ok(!JSON.stringify(body).includes("acc_pt_test-token"), "само значение токена никогда не должно уходить в payload");
});

test("сетевая ошибка при отправке никогда не пробрасывается наружу (fire-and-forget)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    await assert.doesNotReject(controlCenter.reportEvent({ type: "error", title: "test" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
