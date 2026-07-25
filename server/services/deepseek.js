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

  async chatJson({ system, user, temperature = 0, maxTokens }) {
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
        return await this._once({ system, user, temperature, maxTokens });
      } catch (e) {
        lastError = e;
        if (!(e instanceof DeepSeekError) || !e.retriable) throw e;
      }
    }
    throw lastError;
  }

  async _once({ system, user, temperature, maxTokens }) {
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
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // Единственный поддерживаемый DeepSeek режим структурированного вывода.
          response_format: { type: "json_object" },
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
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonStrict(content);
    logger.debug("deepseek.ok", { model: this.model, usage: data?.usage });
    return parsed;
  }
}

module.exports = { DeepSeekClient, DeepSeekError, RateLimiter, parseJsonStrict, stripFences };
