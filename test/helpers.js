// Общие моки для тестов: база в памяти, поддельные DeepSeek/поиск/HTTP.
// Сеть в тестах не используется вообще.
const { createConnection } = require("../server/db");
const { EXTRACT_SYSTEM, RESEARCH_SYSTEM, MATCH_SYSTEM } = require("../server/prompts");

function makeDb() {
  return createConnection(":memory:");
}

/**
 * Поддельный клиент модели. Ответы задаются по типу промпта:
 *   { extract: [...], research: [...], match: [...] }
 * Значение может быть объектом (ответ), функцией (по user-промпту) или Error (бросить).
 */
class FakeDeepSeek {
  constructor(responses = {}) {
    this.enabled = true;
    this.responses = {
      extract: [].concat(responses.extract || []),
      research: [].concat(responses.research || []),
      match: [].concat(responses.match || []),
    };
    this.calls = { extract: 0, research: 0, match: 0 };
  }

  _kind(system) {
    if (system === EXTRACT_SYSTEM) return "extract";
    if (system === RESEARCH_SYSTEM) return "research";
    if (system === MATCH_SYSTEM) return "match";
    throw new Error("Неизвестный системный промпт");
  }

  async chatJson({ system, user }) {
    const kind = this._kind(system);
    this.calls[kind]++;
    const queue = this.responses[kind];
    // Последний ответ переиспользуется, если вызовов больше, чем заготовок.
    const item = queue.length > 1 ? queue.shift() : queue[0];
    if (item === undefined) throw new Error(`Нет заготовленного ответа для ${kind}`);
    if (item instanceof Error) throw item;
    return typeof item === "function" ? item(user) : item;
  }
}

// Провайдер поиска, который «находит» заранее заданные страницы и картинки.
class FakeResearchProvider {
  constructor({ results = [], images = [], available = true, name = "fake" } = {}) {
    this.name = name;
    this.available = available;
    this.results = results;
    this.images = images;
    this.calls = 0;
  }
  async search() {
    this.calls++;
    return { results: this.results, images: this.images };
  }
}

// Исследование, которое всегда возвращает заданный результат.
class StubResearchService {
  constructor(result = { status: "skipped", data: null, reason: "disabled" }) {
    this.result = result;
    this.calls = 0;
  }
  async research() {
    this.calls++;
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

/**
 * Поддельный fetch. routes — карта «подстрока URL → ответ».
 * Ответ: { status, headers, body(Buffer|string) } либо Error.
 */
function makeFetch(routes = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) {
      const err = new Error("getaddrinfo ENOTFOUND");
      throw err;
    }
    const spec = routes[key];
    if (spec instanceof Error) throw spec;
    const body = spec.body ?? Buffer.alloc(0);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const headers = new Map(
      Object.entries({ "content-length": String(buf.length), ...(spec.headers || {}) }).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ])
    );
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers.get(String(h).toLowerCase()) ?? null },
      async arrayBuffer() {
        return buf;
      },
      async text() {
        return buf.toString("utf8");
      },
      async json() {
        return JSON.parse(buf.toString("utf8"));
      },
      body: null,
    };
  };
  impl.calls = calls;
  return impl;
}

// Минимальный валидный PNG заданного размера (для проверок картинок).
function pngBuffer(width = 800, height = 600, padTo = 20000) {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, padTo - header.length), 7)]);
}

// Апдейт Telegram с постом канала.
function channelPostUpdate({ updateId = 1, chatId = "-1001", messageId = 100, text = "", edited = false, date = 1750000000 }) {
  const post = { message_id: messageId, chat: { id: Number(chatId), type: "channel" }, date, text };
  if (edited) post.edit_date = date + 60;
  return edited ? { update_id: updateId, edited_channel_post: post } : { update_id: updateId, channel_post: post };
}

// Товар в формате ответа extract-промпта.
function extractedProduct(overrides = {}) {
  return {
    source_name: "Sony 5 slim",
    official_name: "PlayStation 5 Slim",
    brand: "Sony",
    model: "PlayStation 5 Slim",
    category: "Игровые приставки",
    variant: null,
    storage: null,
    color: null,
    price: 650,
    currency: "USD",
    available: true,
    confidence: 0.97,
    warning: null,
    ...overrides,
  };
}

module.exports = {
  makeDb,
  FakeDeepSeek,
  FakeResearchProvider,
  StubResearchService,
  makeFetch,
  pngBuffer,
  channelPostUpdate,
  extractedProduct,
};
