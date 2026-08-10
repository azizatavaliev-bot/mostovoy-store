const config = require("../config");

function parseAmoWebhook(body, index = 0) {
  const get = (key) => body?.[key];
  const nested = body?.message?.add?.[index] || {};
  const author = nested.author || {};
  const key = (field) => `message[add][${index}][${field}]`;
  const created = Number(get(key("created_at")) || nested.created_at);
  const messageType = String(get(key("message_type")) || nested.message_type || "text");
  const media = String(get(key("attachment][link")) || nested?.attachment?.link || nested?.media || "");
  const text = String(get(key("text")) || nested.text || "").trim() || (media ? `[${messageType}] ${media}` : "");
  return {
    text,
    direction: String(get(key("type")) || nested.type || "incoming").toLowerCase(),
    chatId: String(get(key("chat_id")) || nested.chat_id || ""),
    messageId: String(get(key("id")) || nested.id || ""),
    customerId: String(get(key("author][id")) || author.id || ""),
    customerName: String(get(key("author][name")) || author.name || ""),
    leadId: String(get(key("element_id")) || get(key("entity_id")) || nested.element_id || nested.entity_id || ""),
    contactId: String(get(key("contact_id")) || nested.contact_id || ""),
    source: String(get(key("origin")) || nested.origin || "whatsapp"),
    createdAt: created ? new Date(created * 1000).toISOString() : new Date().toISOString(),
  };
}

function parseAmoWebhooks(body) {
  const indexes = new Set();
  for (const key of Object.keys(body || {})) {
    const match = key.match(/^message\[add\]\[(\d+)\]/);
    if (match) indexes.add(Number(match[1]));
  }
  if (Array.isArray(body?.message?.add)) {
    body.message.add.forEach((_, index) => indexes.add(index));
  }
  if (!indexes.size) indexes.add(0);
  return [...indexes].sort((a, b) => a - b).map((index) => parseAmoWebhook(body, index));
}

class AmoCrmClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? config.amocrm.baseUrl;
    this.accessToken = opts.accessToken ?? config.amocrm.accessToken;
    this.amojoBaseUrl = opts.amojoBaseUrl ?? config.amocrm.amojoBaseUrl;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.cachedSession = null;
    this.sessionPromise = null;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.accessToken);
  }

  async sendMessage({ chatId, leadId, contactId, text }) {
    if (!this.enabled) throw new Error("amoCRM не настроена");
    const input = { chatId, leadId, contactId, text };
    try {
      return await this._sendWithSession(await this._getSession(), input);
    } catch {
      return this._sendWithSession(await this._getSession(true), input);
    }
  }

  async getChatHistory(chatId, limit = 200) {
    if (!this.enabled || !chatId) return [];
    try {
      return await this._historyWithSession(await this._getSession(), chatId, limit);
    } catch {
      return this._historyWithSession(await this._getSession(true), chatId, limit);
    }
  }

  async _getSession(forceNew = false) {
    if (!forceNew && this.cachedSession && this.cachedSession.expiresAt > Date.now() / 1000 + 60) {
      return this.cachedSession;
    }
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          try {
            this.cachedSession = await this._createSession();
            return this.cachedSession;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      })().finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }

  async _createSession() {
    const sessionRes = await this.fetchImpl(`${this.baseUrl}/ajax/v1/chats/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
      },
      body: new URLSearchParams({ "request[chats][session][action]": "create" }),
    });
    if (!sessionRes.ok) throw new Error(`amoCRM session: HTTP ${sessionRes.status}`);
    const session = await sessionRes.json();
    const data = session?.response?.chats?.session || {};
    const accountId = data?.account?.id;
    if (!accountId || !data.access_token) throw new Error("amoCRM не вернула chat session");
    return {
      accountId: String(accountId),
      accessToken: data.access_token,
      expiresAt: Number(data.expired_at) || Date.now() / 1000 + 3600,
    };
  }

  async _sendWithSession(session, { chatId, leadId, contactId, text }) {
    const payload = new URLSearchParams({
      silent: "false",
      priority: "low",
      "crm_entity[id]": String(leadId || ""),
      "crm_entity[type]": "2",
      persona_name: "МОСТОВОЙ",
      text,
      crm_contact_id: String(contactId || ""),
      skip_link_shortener: "false",
    });
    const result = await this.fetchImpl(`${this.amojoBaseUrl}/v1/chats/${session.accountId}/${chatId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        "x-auth-token": session.accessToken,
        chatId,
      },
      body: payload,
    });
    if (!result.ok) throw new Error(`amoCRM message: HTTP ${result.status}`);
    return result.json().catch(() => ({ ok: true }));
  }

  async _historyWithSession(session, chatId, limit) {
    const url = new URL(`${this.amojoBaseUrl}/v1/chats/${session.accountId}/${chatId}/messages`);
    url.searchParams.set("limit", String(Math.max(1, Math.min(Number(limit) || 200, 200))));
    const response = await this.fetchImpl(url, {
      headers: { "x-auth-token": session.accessToken, chatId },
    });
    if (!response.ok) throw new Error(`amoCRM history: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((item) => {
      const message = item?.message || {};
      const type = String(message.type || "text");
      const media = typeof message.media === "string" ? message.media : "";
      const text = String(message.text || item?.text || "").trim() || (media ? `[${type}] ${media}` : "");
      const created = Number(item?.created_at);
      if (!item?.id || !text || !created) return [];
      return [{
        messageId: String(item.id),
        direction: item.recipient ? "outgoing" : "incoming",
        authorName: String(item?.author?.name || "") || null,
        text,
        createdAt: new Date(created * 1000).toISOString(),
      }];
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

module.exports = { AmoCrmClient, parseAmoWebhook, parseAmoWebhooks };
