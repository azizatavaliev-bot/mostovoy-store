const test = require("node:test");
const assert = require("node:assert/strict");
const { DeepSeekClient } = require("../server/services/deepseek");

test("JSON extraction disables DeepSeek thinking mode", async () => {
  let request;
  const client = new DeepSeekClient({
    apiKey: "test",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"products":[]}' } }] }),
      };
    },
  });

  await client.chatJson({ system: "Верни JSON", user: "Прайс" });

  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.deepEqual(request.response_format, { type: "json_object" });
});
