// Клиент DeepSeek API (OpenAI-совместимый /chat/completions).
//
// Проверено по api-docs.deepseek.com на 2026-07-24:
//  - response_format поддерживает только {"type":"json_object"};
//    строгой JSON Schema (strict structured outputs) в API НЕТ,
//    поэтому ответ обязательно валидируется на нашей стороне (lib/validate.js);
//  - слово «json» должно присутствовать в промпте, иначе режим не включится;
//  - встроенного веб-поиска у /chat/completions НЕТ — за факты и ссылки
//    отвечает ProductResearchProvider, модель только разбирает найденное;
//  - модели deepseek-chat / deepseek-reasoner устарели 2026-07-24,
//    актуальны deepseek-v4-flash и deepseek-v4-pro.
const config = require("./../config");
const logger = require("./../logger");

class DeepSeekError extends Error {
  constructor(message, { code, status, retriable = false } = {}) {
    super(message);
    this.name = "DeepSeekError";
    this.code = code;
    this.status = status;
    this.retriable = retriable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Простое окно на минуту: бережём квоту и не долбим API параллельно.
class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.hits = [];
  }
  async acquire() {
    if (this.perMinute <= 0) return;
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < 60000);
      if (this.hits.length < this.perMinute) {
        this.hits.push(now);
        return;
      }
      await sleep(Math.max(50, 60000 - (now - this.hits[0])));
    }
  }
}

// Модель иногда оборачивает JSON в ```json ... ``` — снимаем.
function stripFences(text) {
  const t = String(text || "").trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : t;
}

function parseJsonStrict(content) {
  const text = stripFences(content);
  if (!text) throw new DeepSeekError("Пустой ответ модели", { code: "empty_response", retriable: true });
  try {
    return JSON.parse(text);
  } catch {
    // Иногда вокруг JSON остаётся мусор — пробуем вырезать внешний объект.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* падаем ниже */
      }
    }
    throw new DeepSeekError("Модель вернула невалидный JSON", {
      code: "invalid_json",
      retriable: true,
    });
  }
}

class DeepSeekClient {
  constructor(opts = {}) {
    const c = { ...config.deepseek, ...opts };
    this.apiKey = c.apiKey;
    this.baseUrl = c.baseUrl;
    this.model = c.model;
    this.timeoutMs = c.timeoutMs;
    this.maxRetries = c.maxRetries;
    this.maxTokens = c.maxTokens;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.limiter = opts.limiter || new RateLimiter(c.rateLimitPerMinute);
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async chatJson({ system, user, model, temperature = 0, maxTokens, onUsage }) {
    if (!this.enabled) {
      throw new DeepSeekError("DEEPSEEK_API_KEY не задан", { code: "not_configured" });
    }

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1));
        logger.warn("deepseek.retry", { attempt, backoff, reason: lastError?.message });
        await sleep(backoff);
      }
      await this.limiter.acquire();
      try {
        return await this._once({ system, user, model, temperature, maxTokens, onUsage });
      } catch (e) {
        lastError = e;
        if (!(e instanceof DeepSeekError) || !e.retriable) throw e;
      }
    }
    throw lastError;
  }

  async chatText({ system, messages = [], user, temperature = 0.35, maxTokens = 1800, model, onUsage }) {
    if (!this.enabled) {
      throw new DeepSeekError("DEEPSEEK_API_KEY не задан", { code: "not_configured" });
    }
    const chatMessages = [
      { role: "system", content: system },
      ...messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .map((m) => ({ role: m.role, content: String(m.content) })),
      ...(user ? [{ role: "user", content: user }] : []),
    ];
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(8000, 400 * 2 ** (attempt - 1));
        await sleep(backoff);
      }
      await this.limiter.acquire();
      try {
        return await this._textOnce({ messages: chatMessages, temperature, maxTokens, model, onUsage });
      } catch (e) {
        lastError = e;
        if (!(e instanceof DeepSeekError) || !e.retriable) throw e;
      }
    }
    throw lastError;
  }

  // Function calling (OpenAI-совместимый формат tools/tool_calls) — модель
  // сама решает, вызвать ли инструмент, прежде чем ответить текстом.
  // Используется, чтобы цену/наличие товара брал код из БД (executeTool),
  // а не придумывала модель: см. server/services/crm.js search_catalog.
  // maxRounds — страховка от зацикливания (модель вызывает инструмент,
  // не получая от этого финального текста).
  //
  // forceToolOnFirstRound: инструкция в системном промпте «обязательно
  // вызови функцию» модель может проигнорировать, если ей кажется, что она
  // и так знает ответ из текста промпта (проверено на проде: с большим
  // каталогом в системном промпте модель иногда отвечала напрямую, ни разу
  // не вызвав search_catalog, и один раз перепутала товар). tool_choice
  // с конкретной функцией на первом раунде убирает этот выбор совсем —
  // модель физически не может ответить текстом, не вызвав инструмент.
  async chatTextWithTools({ system, messages = [], user, tools, executeTool, temperature = 0.35, maxTokens = 1800, model, onUsage, maxRounds = 4, forceToolOnFirstRound = null }) {
    if (!this.enabled) {
      throw new DeepSeekError("DEEPSEEK_API_KEY не задан", { code: "not_configured" });
    }
    const chatMessages = [
      { role: "system", content: system },
      ...messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .map((m) => ({ role: m.role, content: String(m.content) })),
      ...(user ? [{ role: "user", content: user }] : []),
    ];
    const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let lastModel = model || this.model;
    for (let round = 0; round < maxRounds; round++) {
      await this.limiter.acquire();
      const toolChoice = round === 0 && forceToolOnFirstRound
        ? { type: "function", function: { name: forceToolOnFirstRound } }
        : undefined;
      // DeepSeek отвечает 400 "Thinking mode does not support this tool_choice",
      // если thinking включён (по умолчанию) одновременно с принудительным
      // tool_choice — отключаем thinking только на этом раунде, свободные
      // раунды (в том числе финальный текстовый ответ) его не теряют.
      const { message, usage, respondedModel } = await this._toolsOnce({ messages: chatMessages, tools, toolChoice, disableThinking: Boolean(toolChoice), temperature, maxTokens, model });
      if (usage) {
        totalUsage.prompt_tokens += Number(usage.prompt_tokens || 0);
        totalUsage.completion_tokens += Number(usage.completion_tokens || 0);
        totalUsage.total_tokens += Number(usage.total_tokens || 0);
      }
      lastModel = respondedModel || lastModel;
      if (!message.tool_calls?.length) {
        onUsage?.(totalUsage, lastModel);
        const content = String(message.content || "").trim();
        if (!content) throw new DeepSeekError("Пустой ответ модели", { code: "empty_response", retriable: true });
        return content;
      }
      chatMessages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let result;
        try {
          const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          result = await executeTool(call.function?.name, args);
        } catch (error) {
          result = { error: error.message };
        }
        chatMessages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result ?? null) });
      }
    }
    onUsage?.(totalUsage, lastModel);
    throw new DeepSeekError("Превышено число обращений к инструментам", { code: "tool_loop_limit", retriable: false });
  }

  async _toolsOnce({ messages, tools, toolChoice, disableThinking, temperature, maxTokens, model }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: model || this.model,
          messages,
          tools,
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
          temperature,
          max_tokens: maxTokens || this.maxTokens,
          stream: false,
        }),
      });
    } catch (e) {
      throw new DeepSeekError(
        e.name === "AbortError" ? "Таймаут запроса к DeepSeek" : `Сеть: ${e.message}`,
        { code: e.name === "AbortError" ? "timeout" : "network", retriable: true }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DeepSeekError(`DeepSeek ответил ${res.status}: ${body.slice(0, 300)}`, {
        code: `http_${res.status}`,
        status: res.status,
        retriable: res.status === 429 || res.status >= 500,
      });
    }
    const data = await res.json().catch(() => null);
    const message = data?.choices?.[0]?.message;
    if (!message) throw new DeepSeekError("Пустой ответ модели", { code: "empty_response", retriable: true });
    return { message, usage: data?.usage, respondedModel: data?.model };
  }

  async _once({ system, user, model, temperature, maxTokens, onUsage }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: model || this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // Единственный поддерживаемый DeepSeek режим структурированного вывода.
          response_format: { type: "json_object" },
          // Извлечение каталога — детерминированная задача. В V4 thinking
          // включён по умолчанию и на больших прайс-листах иногда съедает
          // весь лимит до финального JSON, поэтому здесь его отключаем.
          thinking: { type: "disabled" },
          temperature,
          max_tokens: maxTokens || this.maxTokens,
          stream: false,
        }),
      });
    } catch (e) {
      throw new DeepSeekError(
        e.name === "AbortError" ? "Таймаут запроса к DeepSeek" : `Сеть: ${e.message}`,
        { code: e.name === "AbortError" ? "timeout" : "network", retriable: true }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 429 и 5xx — временные, их повторяем. 4xx — ошибка запроса, повтор бесполезен.
      const retriable = res.status === 429 || res.status >= 500;
      throw new DeepSeekError(`DeepSeek ответил ${res.status}: ${body.slice(0, 300)}`, {
        code: `http_${res.status}`,
        status: res.status,
        retriable,
      });
    }

    const data = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    // Обрезанный по лимиту ответ — это всегда битый JSON. Повтор с тем же
    // лимитом бесполезен: нужна честная ошибка, а не «невалидный JSON».
    if (choice?.finish_reason === "length") {
      throw new DeepSeekError("Ответ обрезан по max_tokens — увеличьте лимит для этой задачи", {
        code: "truncated",
        retriable: false,
      });
    }
    const content = choice?.message?.content;
    const parsed = parseJsonStrict(content);
    onUsage?.(data?.usage || {}, data?.model || model || this.model);
    logger.debug("deepseek.ok", { model: model || this.model, usage: data?.usage });
    return parsed;
  }

  async _textOnce({ messages, temperature, maxTokens, model, onUsage }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: ac.signal,
        body: JSON.stringify({
          model: model || this.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      });
    } catch (e) {
      throw new DeepSeekError(
        e.name === "AbortError" ? "Таймаут запроса к DeepSeek" : `Сеть: ${e.message}`,
        { code: e.name === "AbortError" ? "timeout" : "network", retriable: true }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DeepSeekError(`DeepSeek ответил ${res.status}: ${body.slice(0, 300)}`, {
        code: `http_${res.status}`,
        status: res.status,
        retriable: res.status === 429 || res.status >= 500,
      });
    }
    const data = await res.json().catch(() => null);
    const content = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!content) throw new DeepSeekError("Пустой ответ модели", { code: "empty_response", retriable: true });
    onUsage?.(data?.usage || {}, data?.model || model || this.model);
    return content;
  }
}

module.exports = { DeepSeekClient, DeepSeekError, RateLimiter, parseJsonStrict, stripFences };
