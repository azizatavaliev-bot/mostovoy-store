const config = require("../config");
const { buildMapping, applyMapping, restoreMapping } = require("./privacy");

const MODELS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek" },
  { id: "gpt-5.6-sol", label: "ChatGPT 5.6", provider: "openai" },
  { id: "gemini-3.6-pro", label: "Gemini 3.6 Pro", provider: "gemini" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", provider: "gemini" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
];

function modelInfo(model) {
  return MODELS.find((item) => item.id === model);
}

function stripFences(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function parseJson(value) {
  const text = stripFences(value);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Модель вернула невалидный JSON");
  }
}

function usageFromOpenAi(usage = {}) {
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

function usageFromGemini(usage = {}) {
  return {
    prompt_tokens: Number(usage.total_input_tokens || 0),
    completion_tokens: Number(usage.total_output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

function usageFromAnthropic(usage = {}) {
  const prompt = Number(usage.input_tokens || 0);
  const completion = Number(usage.output_tokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

function outputText(data) {
  if (data?.output_text) return String(data.output_text).trim();
  for (const item of data?.output || data?.steps || []) {
    for (const part of item?.content || []) {
      if (part?.text) return String(part.text).trim();
    }
  }
  return "";
}

class AiRouter {
  constructor({ deepseek, fetchImpl } = {}) {
    this.deepseek = deepseek;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  isEnabled(model) {
    const provider = modelInfo(model)?.provider;
    if (provider === "deepseek") return Boolean(this.deepseek?.enabled);
    if (provider === "openai") return Boolean(config.openai.apiKey);
    if (provider === "gemini") return Boolean(config.gemini.apiKey);
    if (provider === "anthropic") return Boolean(config.anthropic.apiKey);
    return false;
  }

  get enabled() {
    return MODELS.some((item) => this.isEnabled(item.id));
  }

  listModels() {
    return MODELS.map((item) => ({ ...item, enabled: this.isEnabled(item.id) }));
  }

  // Телефон/адрес/имя клиента не должны уходить ни в один ИИ-провайдер как
  // есть — заменяем на плейсхолдеры перед вызовом и подставляем реальные
  // значения обратно в готовый текст. Единая точка входа для всех
  // текстовых генераций (chatText/chatJson), поэтому провайдер-специфичный
  // код остался в _dispatchChatText нетронутым.
  //
  // maxTokens по умолчанию — 1800, а не 900: полный список линейки товара
  // (например все MacBook с конфигурациями и ценами) на 900 токенах обрывался
  // посреди слова, потому что ПРОДАЖА-политика требует перечислить каждую
  // модель и модификацию, а не сокращённую подборку.
  async chatText({ system, messages = [], user, model, maxTokens = 1800, temperature, onUsage }) {
    const mapping = buildMapping([...messages.map((item) => item.content), user]);
    const redactedMessages = messages.map((item) => ({ ...item, content: applyMapping(item.content, mapping) }));
    const redactedUser = applyMapping(user, mapping);
    const text = await this._dispatchChatText({
      system,
      messages: redactedMessages,
      user: redactedUser,
      model,
      maxTokens,
      temperature,
      onUsage,
    });
    return restoreMapping(text, mapping);
  }

  async _dispatchChatText({ system, messages = [], user, model, maxTokens = 900, temperature, onUsage }) {
    const info = modelInfo(model);
    if (!info) throw new Error("Неизвестная модель");
    if (!this.isEnabled(model)) throw new Error(`${info.label}: API-ключ не настроен`);
    if (info.provider === "deepseek") {
      return this.deepseek.chatText({ system, messages, user, model, maxTokens, temperature, onUsage });
    }
    if (info.provider === "openai") {
      return this._openAiText({ system, messages, user, model, maxTokens, onUsage });
    }
    if (info.provider === "anthropic") {
      return this._anthropicText({ system, messages, user, model, maxTokens, onUsage });
    }
    return this._geminiText({ system, messages, user, model, maxTokens, onUsage });
  }

  async chatJson(args) {
    const text = await this.chatText({
      ...args,
      system: `${args.system}\n\nВерни только валидный JSON без Markdown.`,
    });
    return parseJson(text);
  }

  async analyzeMedia({ kind, bytes, mimeType, caption = "", onUsage }) {
    const selected = config.openai.apiKey
      ? { provider: "openai", model: config.openai.model }
      : config.gemini.apiKey
        ? { provider: "gemini", model: config.gemini.model }
        : null;
    if (!selected) throw new Error("Для анализа изображения и аудио настройте OPENAI_API_KEY или GEMINI_API_KEY");
    if (selected.provider === "openai") {
      if (kind === "audio") return this._openAiTranscribe({ bytes, mimeType, onUsage });
      return this._openAiImage({ bytes, mimeType, caption, onUsage });
    }
    return this._geminiMedia({ kind, bytes, mimeType, caption, onUsage });
  }

  async _openAiText({ system, messages, user, model, maxTokens, onUsage }) {
    const input = [
      ...messages.map((item) => ({
        role: item.role,
        content: String(item.content),
      })),
      ...(user ? [{ role: "user", content: String(user) }] : []),
    ];
    const data = await this._jsonRequest(`${config.openai.baseUrl}/responses`, {
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      body: { model, instructions: system, input, max_output_tokens: maxTokens },
      provider: "OpenAI",
    });
    const text = outputText(data);
    if (!text) throw new Error("OpenAI вернул пустой ответ");
    onUsage?.(usageFromOpenAi(data.usage), data.model || model);
    return text;
  }

  async _openAiImage({ bytes, mimeType, caption, onUsage }) {
    const data = await this._jsonRequest(`${config.openai.baseUrl}/responses`, {
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      body: {
        model: config.openai.model,
        instructions: "Опиши изображение для продавца-консультанта магазина техники. Укажи товар, модель и важные видимые детали. Не выдумывай.",
        input: [{
          role: "user",
          content: [
            { type: "input_image", image_url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
            { type: "input_text", text: caption || "Что изображено?" },
          ],
        }],
        max_output_tokens: 500,
      },
      provider: "OpenAI",
    });
    onUsage?.(usageFromOpenAi(data.usage), data.model || config.openai.model);
    const text = outputText(data);
    if (!text) throw new Error("OpenAI не смог описать изображение");
    return text;
  }

  async _openAiTranscribe({ bytes, mimeType, onUsage }) {
    const form = new FormData();
    form.set("model", config.openai.transcriptionModel);
    form.set("file", new Blob([bytes], { type: mimeType }), `voice.${mimeType.split("/")[1] || "ogg"}`);
    const res = await this.fetchImpl(`${config.openai.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcription: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    onUsage?.(usageFromOpenAi(data.usage), config.openai.transcriptionModel);
    const text = String(data.text || "").trim();
    if (!text) throw new Error("OpenAI не смог распознать аудио");
    return text;
  }

  async _geminiText({ system, messages, user, model, maxTokens, onUsage }) {
    const conversation = messages.map((item) =>
      `${item.role === "assistant" ? "КОНСУЛЬТАНТ" : "КЛИЕНТ"}: ${item.content}`
    ).join("\n");
    const data = await this._jsonRequest(`${config.gemini.baseUrl}/interactions`, {
      headers: { "x-goog-api-key": config.gemini.apiKey, "Api-Revision": "2026-05-20" },
      body: {
        model,
        input: `${system}\n\nИСТОРИЯ:\n${conversation}\n\nКЛИЕНТ: ${user || ""}`,
      },
      provider: "Gemini",
    });
    const text = outputText(data);
    if (!text) throw new Error("Gemini вернул пустой ответ");
    onUsage?.(usageFromGemini(data.usage), data.model || model);
    return text;
  }

  async _anthropicText({ system, messages, user, model, maxTokens, onUsage }) {
    const chatMessages = [
      ...messages
        .filter((item) => item?.role === "user" || item?.role === "assistant")
        .map((item) => ({ role: item.role, content: String(item.content) })),
      ...(user ? [{ role: "user", content: String(user) }] : []),
    ];
    const data = await this._jsonRequest(`${config.anthropic.baseUrl}/v1/messages`, {
      headers: {
        "x-api-key": config.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        system,
        messages: chatMessages,
        max_tokens: maxTokens,
      },
      provider: "Anthropic",
    });
    const text = (data?.content || [])
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => String(part.text))
      .join("\n")
      .trim();
    if (!text) throw new Error("Claude вернул пустой ответ");
    onUsage?.(usageFromAnthropic(data.usage), data.model || model);
    return text;
  }

  async _geminiMedia({ kind, bytes, mimeType, caption, onUsage }) {
    const prompt = kind === "audio"
      ? "Точно расшифруй речь на языке клиента. Если слышны важные неречевые звуки, кратко укажи их."
      : "Опиши изображение для продавца-консультанта магазина техники. Укажи товар, модель и важные видимые детали. Не выдумывай.";
    const data = await this._jsonRequest(`${config.gemini.baseUrl}/interactions`, {
      headers: { "x-goog-api-key": config.gemini.apiKey, "Api-Revision": "2026-05-20" },
      body: {
        model: config.gemini.model,
        input: [
          { type: "text", text: [prompt, caption].filter(Boolean).join("\n") },
          { type: kind === "audio" ? "audio" : "image", data: Buffer.from(bytes).toString("base64"), mime_type: mimeType },
        ],
      },
      provider: "Gemini",
    });
    onUsage?.(usageFromGemini(data.usage), data.model || config.gemini.model);
    const text = outputText(data);
    if (!text) throw new Error("Gemini не смог проанализировать вложение");
    return text;
  }

  async _jsonRequest(url, { headers = {}, body, provider }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`${provider}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

module.exports = { AiRouter, MODELS, modelInfo };
