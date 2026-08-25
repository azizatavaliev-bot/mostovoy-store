// Клиент HikerAPI (hikerapi.com) — публичные данные Instagram.
// Проверено по официальной OpenAPI-схеме (https://api.hikerapi.com/openapi.json,
// 2026-08-24): базовый хост https://api.hikerapi.com, авторизация — заголовок
// x-access-key. Используемые эндпоинты:
//   GET /v1/story/download/by/story/url?url=<story_url>  — { Story }
//   GET /v1/highlight/by/url?url=<highlight_url>          — { Highlight }
// Story: { pk, id, media_type (1=фото,2=видео), thumbnail_url, video_url,
//          video_duration, user: { username, is_private } }
// Highlight: { pk, id, title, media_count, items: Story[] }
const config = require("../../config");

class HikerApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "HikerApiError";
    this.code = code;
  }
}

class HikerApiClient {
  constructor({ apiKey, baseUrl, timeoutMs, fetchImpl } = {}) {
    this.apiKey = apiKey ?? config.instagram.hikerApiKey;
    this.baseUrl = (baseUrl ?? config.instagram.hikerApiBaseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs ?? config.instagram.hikerApiTimeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async _get(path, params) {
    if (!this.enabled) throw new HikerApiError("HIKER_API_KEY не задан", "not_configured");
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { "x-access-key": this.apiKey, accept: "application/json" },
        signal: ac.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new HikerApiError("Таймаут запроса к HikerAPI", "timeout");
      throw new HikerApiError(`Сеть: ${error.message}`, "network");
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) throw new HikerApiError("Story/Highlight не найдены (удалены или никогда не существовали)", "not_found");
    if (res.status === 429) throw new HikerApiError("HikerAPI: превышен лимит запросов", "rate_limited");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HikerApiError(`HikerAPI ответил ${res.status}: ${body.slice(0, 300)}`, "http_error");
    }
    try {
      return await res.json();
    } catch {
      throw new HikerApiError("HikerAPI вернул невалидный JSON", "invalid_response");
    }
  }

  /** Story по прямой ссылке на неё. Бросает HikerApiError с .code при сбое. */
  async resolveStoryByUrl(url) {
    return this._get("/v1/story/download/by/story/url", { url });
  }

  /** Highlight по ссылке — возвращает объект Highlight с полем items: Story[]. */
  async resolveHighlightByUrl(url) {
    return this._get("/v1/highlight/by/url", { url });
  }
}

module.exports = { HikerApiClient, HikerApiError };
