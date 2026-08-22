// WhatsApp через Green API (green-api.com) — официально задокументированный
// HTTP API: idInstance и apiTokenInstance идут частями пути. Клиент умеет
// ровно то, что нужно боту: состояние инстанса, включить вебхук на наш адрес,
// отправить текст, разобрать входящий вебхук. Та же идея, что и в CRM
// SmileKit (src/lib/greenapi/client.ts), только на Node без зависимостей.
const config = require("../config");

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/** Номер в любом формате → chatId WhatsApp: только цифры + "@c.us". */
function toGreenApiChatId(phone) {
  return `${normalizePhone(phone)}@c.us`;
}

/** chatId → голый номер (для external_chat_id и customer_phone). */
function phoneFromGreenApiChatId(chatId) {
  return String(chatId || "").replace(/@c\.us$/, "");
}

function extractText(body) {
  const data = body?.messageData || {};
  return String(
    data.textMessageData?.textMessage
      ?? data.extendedTextMessageData?.text
      ?? data.fileMessageData?.caption
      ?? ""
  ).trim();
}

// Нормализованное сообщение из вебхука — или null для служебных событий
// (статусы доставки, смена состояния инстанса, групповые чаты).
// type: "incoming" — клиент написал; "outgoing" — сообщение ушло с самого
// телефона (живой менеджер), outgoingAPIMessageReceived — наше же эхо, его
// пропускаем, иначе бот сам себя примет за менеджера и замолчит.
function parseGreenApiWebhook(body) {
  if (!body || typeof body !== "object") return null;
  const chatId = body.senderData?.chatId;
  const messageId = body.idMessage;
  if (!chatId || !messageId) return null;
  if (!/@c\.us$/.test(String(chatId))) return null;
  const text = extractText(body);
  const mediaUrl = body.messageData?.fileMessageData?.downloadUrl || null;
  const typeMessage = String(body.messageData?.typeMessage || "");
  const base = {
    messageId: String(messageId),
    chatId: String(chatId),
    phone: phoneFromGreenApiChatId(chatId),
    name: body.senderData?.senderName || body.senderData?.chatName || null,
    text,
    typeMessage,
    mediaUrl,
    createdAt: new Date(Number(body.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  if (body.typeWebhook === "incomingMessageReceived") {
    if (!text && !mediaUrl) return null;
    return { type: "incoming", ...base };
  }
  if (body.typeWebhook === "outgoingMessageReceived") {
    if (!text) return null;
    return { type: "outgoing", ...base };
  }
  return null;
}

class GreenApiClient {
  constructor({ fetchImpl, settings } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.settings = settings || config.greenapi;
  }

  get enabled() {
    return Boolean(this.settings.idInstance && this.settings.apiTokenInstance);
  }

  _url(method, { media = false } = {}) {
    const host = media && this.settings.mediaUrl ? this.settings.mediaUrl : this.settings.apiUrl;
    return `${host}/waInstance${this.settings.idInstance}/${method}/${this.settings.apiTokenInstance}`;
  }

  async _call(method, body, { media = false } = {}) {
    if (!this.enabled) throw new Error("Green API не настроен: задайте GREENAPI_ID_INSTANCE и GREENAPI_API_TOKEN_INSTANCE");
    const res = await this.fetchImpl(this._url(method, { media }), {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.settings.timeoutMs || 20000),
    });
    if (!res.ok) {
      const text = typeof res.text === "function" ? await res.text().catch(() => "") : "";
      throw new Error(`Green API ${method}: HTTP ${res.status} ${String(text).slice(0, 300)}`.trim());
    }
    return typeof res.json === "function" ? res.json() : {};
  }

  /** authorized | notAuthorized | blocked | starting | ... */
  async getState() {
    const data = await this._call("getStateInstance");
    return String(data?.stateInstance || "unknown");
  }

  /** Включает вебхук на входящие/исходящие сообщения на наш адрес. */
  async setWebhook({ webhookUrl, webhookUrlToken }) {
    return this._call("setSettings", {
      webhookUrl,
      webhookUrlToken,
      incomingWebhook: "yes",
      outgoingMessageWebhook: "yes",
      outgoingAPIMessageWebhook: "no",
      outgoingWebhook: "no",
      stateWebhook: "no",
    });
  }

  async sendMessage(chatId, message) {
    const data = await this._call("sendMessage", { chatId, message: String(message || "") });
    return { idMessage: String(data?.idMessage || "") };
  }

  async sendFileByUrl({ chatId, urlFile, fileName, caption }) {
    const data = await this._call("sendFileByUrl", { chatId, urlFile, fileName, caption }, { media: true });
    return { idMessage: String(data?.idMessage || "") };
  }
}

module.exports = { GreenApiClient, parseGreenApiWebhook, toGreenApiChatId, phoneFromGreenApiChatId, normalizePhone };
