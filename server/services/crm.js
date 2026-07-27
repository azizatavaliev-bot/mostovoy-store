const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics } = require("./buy-analytics");

const DEFAULT_PROMPT = `Ты продавец-консультант магазина техники МОСТОВОЙ в Бишкеке.
Отвечай кратко, дружелюбно и на языке клиента. Используй только цены и наличие из каталога ниже.
Не придумывай характеристики, скидки и сроки доставки. Если данных нет — честно скажи, что менеджер уточнит.
Помоги выбрать товар и мягко предложи оформить заказ. Не упоминай, что ты AI.`;

function toConversation(row) {
  return {
    id: Number(row.id),
    source: row.source,
    externalChatId: row.external_chat_id,
    externalLeadId: row.external_lead_id,
    customerName: row.customer_name || row.customer_username || "Без имени",
    customerUsername: row.customer_username,
    customerPhone: row.customer_phone,
    aiEnabled: Boolean(row.ai_enabled),
    unreadCount: Number(row.unread_count || 0),
    notes: row.notes || "",
    status: row.status,
    lastMessageAt: row.last_message_at,
    lastMessage: row.last_message || "",
  };
}

class CrmService {
  constructor({ db, deepseek, amocrm, fetchImpl } = {}) {
    this.db = db;
    this.deepseek = deepseek;
    this.amocrm = amocrm;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  listConversations() {
    return this.db.prepare(
      `SELECT c.*,
        (SELECT text FROM crm_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM crm_conversations c ORDER BY c.last_message_at DESC, c.id DESC`
    ).all().map(toConversation);
  }

  getConversation(id, { markRead = false } = {}) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    if (markRead) this.db.prepare("UPDATE crm_conversations SET unread_count = 0 WHERE id = ?").run(id);
    const messages = this.db.prepare(
      "SELECT id, direction, sender, text, status, created_at FROM crm_messages WHERE conversation_id = ? ORDER BY id ASC"
    ).all(id).map((m) => ({
      id: Number(m.id),
      direction: m.direction,
      sender: m.sender,
      text: m.text,
      status: m.status,
      createdAt: m.created_at,
    }));
    return { conversation: toConversation({ ...row, unread_count: markRead ? 0 : row.unread_count }), messages };
  }

  updateConversation(id, patch) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    const aiEnabled = patch.aiEnabled === undefined ? row.ai_enabled : patch.aiEnabled ? 1 : 0;
    const notes = patch.notes === undefined ? row.notes : String(patch.notes || "").slice(0, 4000);
    const status = patch.status === "closed" ? "closed" : patch.status === "open" ? "open" : row.status;
    this.db.prepare(
      "UPDATE crm_conversations SET ai_enabled = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(aiEnabled, notes, status, id);
    return this.getConversation(id);
  }

  getStatus() {
    const base = config.publicUrl || "https://mostovoy-store-production.up.railway.app";
    const secretPath = config.amocrm.webhookSecret
      ? `/${encodeURIComponent(config.amocrm.webhookSecret)}`
      : "";
    return {
      telegram: Boolean(config.telegram.botToken),
      amocrm: Boolean(this.amocrm?.enabled),
      ai: Boolean(this.deepseek?.enabled),
      amocrmWebhook: `${base}/api/amocrm/webhook${secretPath}`,
    };
  }

  getSettings() {
    const row = this.db.prepare("SELECT value FROM crm_settings WHERE key = 'sales_prompt'").get();
    return { salesPrompt: row?.value || DEFAULT_PROMPT };
  }

  saveSettings({ salesPrompt }) {
    const value = String(salesPrompt || "").trim().slice(0, 12000) || DEFAULT_PROMPT;
    this.db.prepare(
      `INSERT INTO crm_settings (key, value) VALUES ('sales_prompt', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(value);
    return this.getSettings();
  }

  getBuyAnalytics(days = 30) {
    return getBuyClickAnalytics(this.db, days);
  }

  _upsertConversation(data) {
    this.db.prepare(
      `INSERT INTO crm_conversations
        (external_key, source, external_chat_id, external_lead_id, external_contact_id,
         customer_name, customer_username, customer_phone, unread_count, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(external_key) DO UPDATE SET
         customer_name = COALESCE(excluded.customer_name, customer_name),
         customer_username = COALESCE(excluded.customer_username, customer_username),
         customer_phone = COALESCE(excluded.customer_phone, customer_phone),
         external_lead_id = COALESCE(excluded.external_lead_id, external_lead_id),
         external_contact_id = COALESCE(excluded.external_contact_id, external_contact_id),
         unread_count = unread_count + 1,
         last_message_at = excluded.last_message_at,
         updated_at = datetime('now')`
    ).run(
      data.externalKey, data.source, data.chatId, data.leadId || null, data.contactId || null,
      data.name || null, data.username || null, data.phone || null, data.createdAt
    );
    return this.db.prepare("SELECT * FROM crm_conversations WHERE external_key = ?").get(data.externalKey);
  }

  _storeMessage(conversationId, data) {
    try {
      this.db.prepare(
        `INSERT INTO crm_messages
          (conversation_id, external_message_id, direction, sender, text, status, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conversationId, data.externalMessageId || null, data.direction, data.sender, data.text,
        data.status || "stored", data.raw ? JSON.stringify(data.raw) : null, data.createdAt || new Date().toISOString()
      );
      return true;
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }

  async receiveTelegram(message) {
    if (!message?.text?.trim() || message.from?.is_bot || message.chat?.type !== "private") return;
    const chatId = String(message.chat.id);
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
    const conversation = this._upsertConversation({
      externalKey: `telegram:${chatId}`,
      source: "telegram",
      chatId,
      name,
      username: message.from?.username ? `@${message.from.username}` : null,
      createdAt: new Date(Number(message.date || Date.now() / 1000) * 1000).toISOString(),
    });
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: String(message.message_id),
      direction: "incoming",
      sender: "customer",
      text: message.text.trim(),
      raw: message,
    });
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id);
  }

  async receiveAmo(incoming, raw) {
    if (!incoming.text || !incoming.chatId || incoming.direction !== "incoming") return { ignored: true };
    const source = /whatsapp/i.test(incoming.source) ? "whatsapp" : "amocrm";
    const conversation = this._upsertConversation({
      externalKey: `amo:${incoming.chatId}`,
      source,
      chatId: incoming.chatId,
      leadId: incoming.leadId,
      contactId: incoming.contactId,
      name: incoming.customerName,
      createdAt: incoming.createdAt,
    });
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: incoming.messageId,
      direction: "incoming",
      sender: "customer",
      text: incoming.text,
      raw,
      createdAt: incoming.createdAt,
    });
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id);
    return { stored: inserted, conversationId: Number(conversation.id) };
  }

  async _autoReply(conversationId) {
    if (!this.deepseek?.enabled) return;
    const detail = this.getConversation(conversationId);
    if (!detail?.conversation.aiEnabled) return;
    const products = this.db.prepare(
      `SELECT official_name, color, storage, price, currency, available
       FROM products WHERE status = 'active' AND price IS NOT NULL ORDER BY updated_at DESC LIMIT 120`
    ).all();
    const catalog = products.map((p) =>
      `- ${p.official_name}${p.storage ? ` ${p.storage}` : ""}${p.color ? `, ${p.color}` : ""}: ${p.price} ${p.currency}${p.available ? "" : " (нет в наличии)"}`
    ).join("\n");
    const history = detail.messages.slice(-14).map((m) => ({
      role: m.direction === "incoming" ? "user" : "assistant",
      content: m.text,
    }));
    const prompt = `${this.getSettings().salesPrompt}\n\nАКТУАЛЬНЫЙ КАТАЛОГ:\n${catalog || "Каталог пока пуст."}`;
    try {
      const reply = await this.deepseek.chatText({ system: prompt, messages: history });
      await this._send(conversationId, reply, "assistant");
    } catch (error) {
      logger.error("crm.auto_reply_failed", { conversationId, error: error.message });
    }
  }

  async sendManual(conversationId, text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Сообщение пустое");
    return this._send(conversationId, value.slice(0, 4000), "manager");
  }

  async _send(conversationId, text, sender) {
    const c = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    if (!c) throw new Error("Диалог не найден");
    if (c.source === "telegram") {
      if (!config.telegram.botToken) throw new Error("Telegram bot не настроен");
      const res = await this.fetchImpl(`${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.external_chat_id, text }),
      });
      if (!res.ok) throw new Error(`Telegram: HTTP ${res.status}`);
    } else {
      await this.amocrm.sendMessage({
        chatId: c.external_chat_id,
        leadId: c.external_lead_id,
        contactId: c.external_contact_id,
        text,
      });
    }
    this._storeMessage(c.id, {
      externalMessageId: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      direction: "outgoing",
      sender,
      text,
      status: "sent",
    });
    this.db.prepare(
      "UPDATE crm_conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(c.id);
    return this.getConversation(c.id);
  }
}

module.exports = { CrmService, DEFAULT_PROMPT, toConversation };
