const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../server/config");
const { AiRouter } = require("../server/services/ai");
const { DeepSeekClient } = require("../server/services/deepseek");

test("AI router.chatJson для DeepSeek идёт через json_object+thinking:disabled, а не через обычный chatText", async () => {
  let request;
  const deepseek = new DeepSeekClient({
    apiKey: "test",
    model: "deepseek-v4-flash",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ model: "deepseek-v4-pro", choices: [{ message: { content: '{"template_id":"reserve"}' } }] }),
      };
    },
  });
  const router = new AiRouter({ deepseek });
  let usageModel;
  const result = await router.chatJson({
    system: "Выбери шаблон",
    user: "Придержите модель",
    model: "deepseek-v4-pro",
    temperature: 0,
    maxTokens: 60,
    onUsage: (_usage, model) => { usageModel = model; },
  });

  assert.deepEqual(result, { template_id: "reserve" });
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.deepEqual(request.response_format, { type: "json_object" });
  // Модель, выбранную в настройках бота (deepseek-v4-pro), а не дефолт клиента.
  assert.equal(request.model, "deepseek-v4-pro");
  assert.equal(usageModel, "deepseek-v4-pro");
});

test("AI router показывает ChatGPT и Gemini и помечает доступность по ключам", (t) => {
  const previousOpenAi = config.openai.apiKey;
  const previousGemini = config.gemini.apiKey;
  config.openai.apiKey = "openai-test";
  config.gemini.apiKey = "";
  t.after(() => {
    config.openai.apiKey = previousOpenAi;
    config.gemini.apiKey = previousGemini;
  });
  const router = new AiRouter({ deepseek: { enabled: true } });
  const models = router.listModels();

  assert.equal(models.find((item) => item.id === "gpt-5.6-sol").enabled, true);
  assert.equal(models.find((item) => item.id === "gemini-3.6-flash").enabled, false);
  assert.equal(models.find((item) => item.id === "deepseek-v4-flash").enabled, true);
});

test("AI router отправляет текст в выбранную модель ChatGPT", async (t) => {
  const previousKey = config.openai.apiKey;
  config.openai.apiKey = "openai-test";
  t.after(() => {
    config.openai.apiKey = previousKey;
  });
  let request;
  const router = new AiRouter({
    deepseek: { enabled: false },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: "gpt-5.6-sol",
          output_text: "Готово",
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
      };
    },
  });
  let usage;
  const reply = await router.chatText({
    model: "gpt-5.6-sol",
    system: "Система",
    user: "Привет",
    onUsage: (value) => { usage = value; },
  });

  assert.equal(reply, "Готово");
  assert.match(request.url, /\/responses$/);
  assert.equal(request.body.model, "gpt-5.6-sol");
  assert.equal(usage.total_tokens, 12);
});
