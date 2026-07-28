const config = require("../config");

function parseAmoWebhook(body) {
  const get = (key) => body?.[key];
  const nested = body?.message?.add?.[0] || {};
  const author = nested.author || {};
  const created = Number(get("message[add][0][created_at]") || nested.created_at);
  return {
    text: String(get("message[add][0][text]") || nested.text || "").trim(),
    direction: String(get("message[add][0][type]") || nested.type || "incoming").toLowerCase(),
    chatId: String(get("message[add][0][chat_id]") || nested.chat_id || ""),
    messageId: String(get("message[add][0][id]") || nested.id || ""),
    customerId: String(get("message[add][0][author][id]") || author.id || ""),
    customerName: String(get("message[add][0][author][name]") || author.name || ""),
    leadId: String(get("message[add][0][element_id]") || get("message[add][0][entity_id]") || nested.element_id || nested.entity_id || ""),
    contactId: String(get("message[add][0][contact_id]") || nested.contact_id || ""),
    source: String(get("message[add][0][origin]") || nested.origin || "whatsapp"),
    createdAt: created ? new Date(created * 1000).toISOString() : new Date().toISOString(),
  };
}

class AmoCrmClient {
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? config.amocrm.baseUrl;
    this.accessToken = opts.accessToken ?? config.amocrm.accessToken;
    this.amojoBaseUrl = opts.amojoBaseUrl ?? config.amocrm.amojoBaseUrl;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
  }

  get enabled() {
    return Boolean(this.baseUrl && this.accessToken);
  }

  async sendMessage({ chatId, leadId, contactId, text }) {
    if (!this.enabled) throw new Error("amoCRM не настроена");
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
    const result = await this.fetchImpl(`${this.amojoBaseUrl}/v1/chats/${accountId}/${chatId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        "x-auth-token": data.access_token,
        chatId,
      },
      body: payload,
    });
    if (!result.ok) throw new Error(`amoCRM message: HTTP ${result.status}`);
    return result.json().catch(() => ({ ok: true }));
  }
}

module.exports = { AmoCrmClient, parseAmoWebhook };
