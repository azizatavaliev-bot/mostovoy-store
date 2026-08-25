const test = require("node:test");
const assert = require("node:assert/strict");
const { HikerApiClient, HikerApiError } = require("../server/services/instagram/hikerClient");

function client({ fetchImpl, apiKey = "test-key" } = {}) {
  return new HikerApiClient({ apiKey, baseUrl: "https://api.hikerapi.com", timeoutMs: 5000, fetchImpl });
}

test("без ключа выбрасывает not_configured, не делая сетевой запрос", async () => {
  let called = false;
  const c = client({ apiKey: "", fetchImpl: async () => { called = true; } });
  await assert.rejects(() => c.resolveStoryByUrl("https://www.instagram.com/stories/x/1/"), (error) => {
    assert.ok(error instanceof HikerApiError);
    assert.equal(error.code, "not_configured");
    return true;
  });
  assert.equal(called, false);
});

test("успешный resolveStoryByUrl отправляет x-access-key и правильный путь/параметр", async () => {
  let capturedUrl, capturedHeaders;
  const c = client({
    fetchImpl: async (url, options) => {
      capturedUrl = String(url);
      capturedHeaders = options.headers;
      return { ok: true, status: 200, json: async () => ({ pk: "1", id: "1", media_type: 1, thumbnail_url: "https://cdn.example.com/photo.jpg", user: { username: "shop", is_private: false } }) };
    },
  });
  const story = await c.resolveStoryByUrl("https://www.instagram.com/stories/shop/123/");
  assert.match(capturedUrl, /^https:\/\/api\.hikerapi\.com\/v1\/story\/download\/by\/story\/url\?url=/);
  assert.equal(capturedHeaders["x-access-key"], "test-key");
  assert.equal(story.thumbnail_url, "https://cdn.example.com/photo.jpg");
});

test("resolveHighlightByUrl ходит на правильный путь", async () => {
  let capturedUrl;
  const c = client({
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ pk: "9", id: "9", title: "Новинки", items: [] }) };
    },
  });
  await c.resolveHighlightByUrl("https://www.instagram.com/stories/highlights/9/");
  assert.match(capturedUrl, /^https:\/\/api\.hikerapi\.com\/v1\/highlight\/by\/url\?url=/);
});

test("HTTP 404 -> not_found (Story удалена/истекла/никогда не существовала)", async () => {
  const c = client({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }) });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "not_found");
});

test("HTTP 429 -> rate_limited", async () => {
  const c = client({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => "" }) });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "rate_limited");
});

test("прочий не-2xx -> http_error с сообщением сервера", async () => {
  const c = client({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => "internal boom" }) });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "http_error" && e.message.includes("internal boom"));
});

test("таймаут запроса -> timeout", async () => {
  const hangingFetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const c = new HikerApiClient({ apiKey: "k", baseUrl: "https://api.hikerapi.com", timeoutMs: 10, fetchImpl: hangingFetch });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "timeout");
});

test("сетевая ошибка (недоступен HikerAPI) -> network", async () => {
  const c = client({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "network");
});

test("malformed JSON от HikerAPI -> invalid_response", async () => {
  const c = client({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }) });
  await assert.rejects(() => c.resolveStoryByUrl("https://x/stories/a/1/"), (e) => e.code === "invalid_response");
});
