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

test("chatTextWithTools: модель вызывает инструмент, получает результат, отвечает текстом", async () => {
  const calls = [];
  const client = new DeepSeekClient({
    apiKey: "test",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (calls.length === 1) {
        return {
          ok: true,
          json: async () => ({
            model: "deepseek-v4-flash",
            choices: [{ message: { role: "assistant", tool_calls: [
              { id: "call_1", function: { name: "search_catalog", arguments: '{"query":"iPhone 17"}' } },
            ] } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          model: "deepseek-v4-flash",
          choices: [{ message: { role: "assistant", content: "iPhone 17 — 885$. Оформляем?" } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
      };
    },
  });

  let toolCalledWith = null;
  let usageTotal = null;
  const reply = await client.chatTextWithTools({
    system: "Ты продавец",
    user: "Сколько стоит iPhone 17?",
    tools: [{ type: "function", function: { name: "search_catalog", parameters: {} } }],
    executeTool: async (name, args) => {
      toolCalledWith = { name, args };
      return { products: [{ name: "iPhone 17", price: 885, currency: "USD" }] };
    },
    onUsage: (usage) => { usageTotal = usage; },
  });

  assert.equal(reply, "iPhone 17 — 885$. Оформляем?");
  assert.deepEqual(toolCalledWith, { name: "search_catalog", args: { query: "iPhone 17" } });
  // Второй запрос к DeepSeek должен содержать роль tool с результатом функции.
  assert.equal(calls.length, 2);
  const toolMessage = calls[1].messages.find((m) => m.role === "tool");
  assert.match(toolMessage.content, /"price":885/);
  // usage суммируется по обоим раундам, а не берётся только с последнего.
  assert.deepEqual(usageTotal, { prompt_tokens: 30, completion_tokens: 13, total_tokens: 43 });
});

test("chatTextWithTools: forceToolOnFirstRound шлёт tool_choice только на первом раунде, не на втором", async () => {
  const requests = [];
  const client = new DeepSeekClient({
    apiKey: "test",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", tool_calls: [
              { id: "c1", function: { name: "search_catalog", arguments: "{}" } },
            ] } }],
          }),
        };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "Готово" } }] }) };
    },
  });

  const reply = await client.chatTextWithTools({
    system: "s", user: "u",
    tools: [{ type: "function", function: { name: "search_catalog" } }],
    executeTool: async () => ({ products: [] }),
    forceToolOnFirstRound: "search_catalog",
  });

  assert.equal(reply, "Готово");
  assert.deepEqual(requests[0].tool_choice, { type: "function", function: { name: "search_catalog" } });
  assert.equal("tool_choice" in requests[1], false, "на втором раунде выбор снова свободный");
});

test("chatTextWithTools: бесконечные вызовы инструмента обрываются по maxRounds честной ошибкой", async () => {
  const client = new DeepSeekClient({
    apiKey: "test",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", tool_calls: [
          { id: "call_x", function: { name: "search_catalog", arguments: "{}" } },
        ] } }],
      }),
    }),
  });

  await assert.rejects(
    () => client.chatTextWithTools({
      system: "s", user: "u",
      tools: [{ type: "function", function: { name: "search_catalog" } }],
      executeTool: async () => ({ products: [] }),
      maxRounds: 2,
    }),
    /Превышено число обращений к инструментам/
  );
});
