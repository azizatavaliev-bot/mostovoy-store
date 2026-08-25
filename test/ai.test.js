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

test("AI router.chatJson для DeepSeek маскирует телефон/адрес клиента и восстанавливает их в разобранном JSON", async () => {
  let sentUser;
  const deepseek = new DeepSeekClient({
    apiKey: "test",
    model: "deepseek-v4-flash",
    maxRetries: 0,
    rateLimitPerMinute: 0,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      sentUser = body.messages.find((m) => m.role === "user").content;
      // Модель эхом возвращает то, что увидела — так проверяем, что именно дошло до неё.
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ echo: sentUser }) } }] }),
      };
    },
  });
  const router = new AiRouter({ deepseek });

  const result = await router.chatJson({
    system: "Реши шаблон",
    user: "Мой номер +996700123456, приезжайте на ул. Ленина 5",
    model: "deepseek-v4-flash",
  });

  assert.doesNotMatch(sentUser, /\+996700123456/, "телефон не должен уйти в DeepSeek как есть");
  assert.doesNotMatch(sentUser, /ул\. Ленина 5/, "адрес не должен уйти в DeepSeek как есть");
  assert.match(result.echo, /\+996700123456/, "телефон должен вернуться в разобранном JSON");
  assert.match(result.echo, /ул\. Ленина 5/, "адрес должен вернуться в разобранном JSON");
});

test("AI router: analyzeMedia предпочитает OpenAI, если заданы оба ключа, иначе Gemini", async (t) => {
  const previousOpenAiKey = config.openai.apiKey;
  const previousGeminiKey = config.gemini.apiKey;
  t.after(() => { config.openai.apiKey = previousOpenAiKey; config.gemini.apiKey = previousGeminiKey; });

  config.openai.apiKey = "openai-test";
  config.gemini.apiKey = "gemini-test";
  const calls = [];
  const router = new AiRouter({
    deepseek: { enabled: false },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ output_text: "iPhone 17 Pro, синий" }) };
    },
  });

  const text = await router.analyzeMedia({ kind: "image", bytes: Buffer.from("fake"), mimeType: "image/jpeg" });
  assert.equal(text, "iPhone 17 Pro, синий");
  assert.match(calls[0], /api\.openai\.com|openai/i);

  config.openai.apiKey = "";
  const calls2 = [];
  const router2 = new AiRouter({
    deepseek: { enabled: false },
    fetchImpl: async (url) => {
      calls2.push(String(url));
      return { ok: true, json: async () => ({ output_text: "iPhone 17 Pro, синий" }) };
    },
  });
  const text2 = await router2.analyzeMedia({ kind: "image", bytes: Buffer.from("fake"), mimeType: "image/jpeg" });
  assert.equal(text2, "iPhone 17 Pro, синий");
  assert.match(calls2[0], /generativelanguage|gemini/i);
});

test("AI router: без OPENAI_API_KEY и GEMINI_API_KEY analyzeMedia сразу даёт понятную ошибку", async () => {
  const previousOpenAiKey = config.openai.apiKey;
  const previousGeminiKey = config.gemini.apiKey;
  config.openai.apiKey = "";
  config.gemini.apiKey = "";
  try {
    const router = new AiRouter({ deepseek: { enabled: false } });
    await assert.rejects(
      () => router.analyzeMedia({ kind: "audio", bytes: Buffer.from("fake"), mimeType: "audio/ogg" }),
      /OPENAI_API_KEY.*GEMINI_API_KEY/
    );
  } finally {
    config.openai.apiKey = previousOpenAiKey;
    config.gemini.apiKey = previousGeminiKey;
  }
});

test("AI router: _openAiTranscribe отправляет multipart-форму с файлом и моделью транскрипции", async () => {
  const previousKey = config.openai.apiKey;
  config.openai.apiKey = "openai-test";
  try {
    let capturedForm;
    const router = new AiRouter({
      deepseek: { enabled: false },
      fetchImpl: async (_url, options) => {
        capturedForm = options.body;
        return { ok: true, json: async () => ({ text: "Здравствуйте, есть ли доставка?" }) };
      },
    });
    const text = await router.analyzeMedia({ kind: "audio", bytes: Buffer.from("fake-ogg-bytes"), mimeType: "audio/ogg" });
    assert.equal(text, "Здравствуйте, есть ли доставка?");
    assert.ok(capturedForm instanceof FormData);
    assert.equal(capturedForm.get("model"), config.openai.transcriptionModel);
    const file = capturedForm.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "audio/ogg");
  } finally {
    config.openai.apiKey = previousKey;
  }
});

test("AI router: _geminiMedia кодирует байты в base64 и передаёт правильный mime_type для голосового", async () => {
  const previousGeminiKey = config.gemini.apiKey;
  const previousOpenAiKey = config.openai.apiKey;
  config.gemini.apiKey = "gemini-test";
  config.openai.apiKey = "";
  try {
    let capturedBody;
    const router = new AiRouter({
      deepseek: { enabled: false },
      fetchImpl: async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ output_text: "Клиент спрашивает про рассрочку" }) };
      },
    });
    const bytes = Buffer.from("fake-ogg-bytes");
    const text = await router.analyzeMedia({ kind: "audio", bytes, mimeType: "audio/ogg" });
    assert.equal(text, "Клиент спрашивает про рассрочку");
    const mediaPart = capturedBody.input.find((item) => item.type === "audio");
    assert.ok(mediaPart, "запрос должен содержать часть типа audio");
    assert.equal(mediaPart.mime_type, "audio/ogg");
    assert.equal(mediaPart.data, bytes.toString("base64"));
  } finally {
    config.gemini.apiKey = previousGeminiKey;
    config.openai.apiKey = previousOpenAiKey;
  }
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

test("analyzeStoryFrames: несколько кадров уходят OpenAI одним запросом с input_image на каждый + JSON-инструкция", async (t) => {
  const previousKey = config.openai.apiKey;
  config.openai.apiKey = "openai-test";
  t.after(() => { config.openai.apiKey = previousKey; });

  let capturedBody;
  const router = new AiRouter({
    deepseek: { enabled: false },
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ output_text: JSON.stringify({ summary: "тест", products_visible: [], visible_text: [], important_details: [], contains_product: false }) }),
      };
    },
  });

  const result = await router.analyzeStoryFrames({
    images: [
      { bytes: Buffer.from("frame1"), mimeType: "image/jpeg" },
      { bytes: Buffer.from("frame2"), mimeType: "image/jpeg" },
      { bytes: Buffer.from("frame3"), mimeType: "image/jpeg" },
    ],
    caption: "Аккаунт: @mostovoyshop",
  });

  assert.equal(result.summary, "тест");
  const content = capturedBody.input[0].content;
  const imageParts = content.filter((part) => part.type === "input_image");
  assert.equal(imageParts.length, 3);
  assert.match(imageParts[0].image_url, /^data:image\/jpeg;base64,/);
  assert.match(capturedBody.instructions, /Верни ТОЛЬКО валидный JSON/);
  assert.match(capturedBody.instructions, /Никогда не выдумывай бренд/);
});

test("analyzeStoryFrames: без OpenAI и без Gemini даёт понятную ошибку", async () => {
  const previousOpenAi = config.openai.apiKey;
  const previousGemini = config.gemini.apiKey;
  config.openai.apiKey = "";
  config.gemini.apiKey = "";
  try {
    const router = new AiRouter({ deepseek: { enabled: false } });
    await assert.rejects(
      () => router.analyzeStoryFrames({ images: [{ bytes: Buffer.from("x"), mimeType: "image/jpeg" }] }),
      /OPENAI_API_KEY.*GEMINI_API_KEY/
    );
  } finally {
    config.openai.apiKey = previousOpenAi;
    config.gemini.apiKey = previousGemini;
  }
});

test("analyzeStoryFrames: без кадров бросает ошибку, не дожидаясь ответа модели", async () => {
  const router = new AiRouter({ deepseek: { enabled: false } });
  await assert.rejects(() => router.analyzeStoryFrames({ images: [] }), /кадров/i);
});

test("analyzeStoryFrames: Gemini получает несколько частей типа image в одном запросе", async (t) => {
  const previousOpenAi = config.openai.apiKey;
  const previousGemini = config.gemini.apiKey;
  config.openai.apiKey = "";
  config.gemini.apiKey = "gemini-test";
  t.after(() => { config.openai.apiKey = previousOpenAi; config.gemini.apiKey = previousGemini; });

  let capturedBody;
  const router = new AiRouter({
    deepseek: { enabled: false },
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ summary: "gemini-тест", products_visible: [], visible_text: [], important_details: [], contains_product: false }) }) };
    },
  });

  const result = await router.analyzeStoryFrames({
    images: [
      { bytes: Buffer.from("frame1"), mimeType: "image/jpeg" },
      { bytes: Buffer.from("frame2"), mimeType: "image/jpeg" },
    ],
  });
  assert.equal(result.summary, "gemini-тест");
  const imageParts = capturedBody.input.filter((part) => part.type === "image");
  assert.equal(imageParts.length, 2);
  assert.equal(imageParts[0].data, Buffer.from("frame1").toString("base64"));
});
