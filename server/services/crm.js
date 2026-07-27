const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics } = require("./buy-analytics");

const DEFAULT_PROMPT = `Ты продавец-консультант магазина техники МОСТОВОЙ в Бишкеке.
Отвечай кратко, дружелюбно и на языке клиента. Используй только цены и наличие из каталога ниже.
Не придумывай характеристики, скидки и сроки доставки. Если данных нет — честно скажи, что менеджер уточнит.
Помоги выбрать товар и мягко предложи оформить заказ. Не упоминай, что ты AI.`;
const DEFAULT_HYPERVISOR_PROMPT = `Кратко опиши для менеджера, чего хочет клиент, что уже выяснено и что важно проверить перед отправкой ответа. Не более трёх предложений.`;
const DEFAULT_CHARACTER_PROMPT = `Доброжелательный, уверенный и внимательный консультант. Общается естественно, без канцелярита и навязчивости.`;
const DEFAULT_RULES_PROMPT = `Не выдумывай наличие, цены и условия. Не обещай то, чего нет в каталоге. Если информации недостаточно — передай вопрос менеджеру.`;
const DEFAULT_TASK_PROMPT = `Помоги клиенту выбрать подходящий товар, ответь на вопрос и мягко подведи к оформлению заказа.`;
const ALLOWED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-reasoner"];

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
    const rows = Object.fromEntries(
      this.db.prepare("SELECT key, value FROM crm_settings").all().map((row) => [row.key, row.value])
    );
    return {
      approvalEnabled: rows.bot_approval_enabled !== "false",
      model: ALLOWED_MODELS.includes(rows.bot_model) ? rows.bot_model : config.deepseek.model,
      systemPrompt: rows.bot_system_prompt || rows.sales_prompt || DEFAULT_PROMPT,
      hypervisorPrompt: rows.bot_hypervisor_prompt || DEFAULT_HYPERVISOR_PROMPT,
      characterPrompt: rows.bot_character_prompt || DEFAULT_CHARACTER_PROMPT,
      rulesPrompt: rows.bot_rules_prompt || DEFAULT_RULES_PROMPT,
      taskPrompt: rows.bot_task_prompt || DEFAULT_TASK_PROMPT,
      models: ALLOWED_MODELS,
    };
  }

  saveSettings(payload = {}) {
    const current = this.getSettings();
    const values = {
      bot_approval_enabled: String(payload.approvalEnabled ?? current.approvalEnabled),
      bot_model: ALLOWED_MODELS.includes(payload.model) ? payload.model : current.model,
      bot_system_prompt: String(payload.systemPrompt ?? current.systemPrompt).trim().slice(0, 16000) || DEFAULT_PROMPT,
      bot_hypervisor_prompt: String(payload.hypervisorPrompt ?? current.hypervisorPrompt).trim().slice(0, 8000) || DEFAULT_HYPERVISOR_PROMPT,
      bot_character_prompt: String(payload.characterPrompt ?? current.characterPrompt).trim().slice(0, 8000) || DEFAULT_CHARACTER_PROMPT,
      bot_rules_prompt: String(payload.rulesPrompt ?? current.rulesPrompt).trim().slice(0, 8000) || DEFAULT_RULES_PROMPT,
      bot_task_prompt: String(payload.taskPrompt ?? current.taskPrompt).trim().slice(0, 8000) || DEFAULT_TASK_PROMPT,
    };
    const upsert = this.db.prepare(
      `INSERT INTO crm_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    for (const [key, value] of Object.entries(values)) upsert.run(key, value);
    this._logEvent(null, "info", "settings", "settings.saved", "Настройки бота сохранены", {
      model: values.bot_model,
      approvalEnabled: values.bot_approval_enabled === "true",
    });
    return this.getSettings();
  }

  getBuyAnalytics(days = 30) {
    return getBuyClickAnalytics(this.db, days);
  }

  _logEvent(conversationId, level, stage, event, message, details) {
    this.db.prepare(
      `INSERT INTO bot_events (conversation_id, level, stage, event, message, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId == null ? null : Number(conversationId),
      level,
      stage,
      event,
      message || null,
      details ? JSON.stringify(details) : null
    );
  }

  listEvents({ level, limit = 150 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 150));
    const rows = level === "error"
      ? this.db.prepare("SELECT * FROM bot_events WHERE level = 'error' ORDER BY id DESC LIMIT ?").all(safeLimit)
      : this.db.prepare("SELECT * FROM bot_events ORDER BY id DESC LIMIT ?").all(safeLimit);
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
      level: row.level,
      stage: row.stage,
      event: row.event,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: row.created_at,
    }));
  }

  getDeveloperStatus() {
    const approvals = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM bot_approvals`
    ).get();
    const errors = this.db.prepare(
      "SELECT COUNT(*) AS count FROM bot_events WHERE level = 'error' AND created_at >= datetime('now', '-24 hours')"
    ).get();
    return {
      enabled: Boolean(this.deepseek?.enabled),
      settings: this.getSettings(),
      approvals: {
        total: Number(approvals.total || 0),
        pending: Number(approvals.pending || 0),
        approved: Number(approvals.approved || 0),
        rejected: Number(approvals.rejected || 0),
      },
      errors24h: Number(errors.count || 0),
    };
  }

  listApprovals(status = "pending") {
    const allowed = ["pending", "approved", "rejected", "all"];
    const selected = allowed.includes(status) ? status : "pending";
    const rows = selected === "all"
      ? this.db.prepare(
        `SELECT a.*, c.customer_name, c.source FROM bot_approvals a
         JOIN crm_conversations c ON c.id = a.conversation_id
         ORDER BY a.id DESC LIMIT 100`
      ).all()
      : this.db.prepare(
        `SELECT a.*, c.customer_name, c.source FROM bot_approvals a
         JOIN crm_conversations c ON c.id = a.conversation_id
         WHERE a.status = ? ORDER BY a.id DESC LIMIT 100`
      ).all(selected);
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: Number(row.conversation_id),
      customerName: row.customer_name || "Без имени",
      source: row.source,
      customerMessage: row.customer_message,
      aiReply: row.ai_reply,
      editedReply: row.edited_reply,
      summary: row.conversation_summary,
      model: row.model,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    }));
  }

  async approveReply(id, text) {
    const row = this.db.prepare("SELECT * FROM bot_approvals WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Черновик не найден");
    if (row.status !== "pending") throw new Error("Черновик уже обработан");
    const finalText = String(text || row.edited_reply || row.ai_reply).trim().slice(0, 4000);
    if (!finalText) throw new Error("Ответ пустой");
    await this._send(Number(row.conversation_id), finalText, "assistant");
    this.db.prepare(
      `UPDATE bot_approvals SET status = 'approved', edited_reply = ?, decided_at = datetime('now')
       WHERE id = ?`
    ).run(finalText === row.ai_reply ? null : finalText, row.id);
    this._logEvent(row.conversation_id, "info", "approval", "approval.approved", "Ответ подтверждён и отправлен", {
      approvalId: Number(row.id),
      edited: finalText !== row.ai_reply,
    });
    return this.listApprovals("all").find((item) => item.id === Number(row.id));
  }

  rejectReply(id) {
    const row = this.db.prepare("SELECT * FROM bot_approvals WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Черновик не найден");
    if (row.status !== "pending") throw new Error("Черновик уже обработан");
    this.db.prepare(
      "UPDATE bot_approvals SET status = 'rejected', decided_at = datetime('now') WHERE id = ?"
    ).run(row.id);
    this._logEvent(row.conversation_id, "warn", "approval", "approval.rejected", "Ответ отклонён менеджером", {
      approvalId: Number(row.id),
    });
    return true;
  }

  async testBot({ message, history = [], model, prompts = {} } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Введите сообщение тестового клиента");
    const settings = { ...this.getSettings(), ...prompts };
    const selectedModel = ALLOWED_MODELS.includes(model) ? model : settings.model;
    const startedAt = Date.now();
    const reply = await this.deepseek.chatText({
      system: this._composePrompt(settings, ""),
      messages: Array.isArray(history) ? history.slice(-20) : [],
      user: text,
      model: selectedModel,
    });
    this._logEvent(null, "info", "laboratory", "lab.reply_generated", "Лаборатория получила ответ", {
      model: selectedModel,
      latencyMs: Date.now() - startedAt,
    });
    return { reply, model: selectedModel, latencyMs: Date.now() - startedAt };
  }

  _composePrompt(settings, catalog) {
    return [
      settings.systemPrompt,
      `ХАРАКТЕР:\n${settings.characterPrompt}`,
      `ПРАВИЛА:\n${settings.rulesPrompt}`,
      `ЗАДАЧА:\n${settings.taskPrompt}`,
      catalog ? `АКТУАЛЬНЫЙ КАТАЛОГ:\n${catalog}` : "",
    ].filter(Boolean).join("\n\n");
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
      const result = this.db.prepare(
        `INSERT INTO crm_messages
          (conversation_id, external_message_id, direction, sender, text, status, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conversationId, data.externalMessageId || null, data.direction, data.sender, data.text,
        data.status || "stored", data.raw ? JSON.stringify(data.raw) : null, data.createdAt || new Date().toISOString()
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) return null;
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
    if (inserted) {
      this._logEvent(conversation.id, "info", "inbox", "message.received", "Получено сообщение из Telegram", {
        messageId: inserted,
      });
    }
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id, inserted);
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
    if (inserted) {
      this._logEvent(conversation.id, "info", "inbox", "message.received", `Получено сообщение из ${source}`, {
        messageId: inserted,
      });
    }
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id, inserted);
    return { stored: Boolean(inserted), conversationId: Number(conversation.id) };
  }

  async _autoReply(conversationId, incomingMessageId) {
    if (!this.deepseek?.enabled) return;
    const detail = this.getConversation(conversationId);
    if (!detail?.conversation.aiEnabled) return;
    const settings = this.getSettings();
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
    const prompt = this._composePrompt(settings, catalog || "Каталог пока пуст.");
    this._logEvent(conversationId, "info", "generation", "generation.started", "ИИ формирует черновик", {
      model: settings.model,
      incomingMessageId,
    });
    try {
      const reply = await this.deepseek.chatText({ system: prompt, messages: history, model: settings.model });
      let summary = null;
      const incomingCount = history.filter((message) => message.role === "user").length;
      if (settings.approvalEnabled && incomingCount > 1) {
        summary = await this.deepseek.chatText({
          system: settings.hypervisorPrompt,
          messages: history,
          model: settings.model,
          maxTokens: 240,
          temperature: 0.15,
        }).catch((error) => {
          this._logEvent(conversationId, "warn", "hypervisor", "hypervisor.failed", error.message);
          return null;
        });
      }
      if (settings.approvalEnabled) {
        const customerMessage = [...detail.messages].reverse().find((message) => message.direction === "incoming")?.text || "";
        const result = this.db.prepare(
          `INSERT INTO bot_approvals
            (conversation_id, incoming_message_id, customer_message, ai_reply, conversation_summary, model)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(conversationId, incomingMessageId || null, customerMessage, reply, summary, settings.model);
        this._logEvent(conversationId, "info", "approval", "approval.created", "Черновик ждёт подтверждения", {
          approvalId: Number(result.lastInsertRowid),
        });
      } else {
        await this._send(conversationId, reply, "assistant");
        this._logEvent(conversationId, "info", "delivery", "reply.sent", "Автоответ отправлен без подтверждения");
      }
    } catch (error) {
      logger.error("crm.auto_reply_failed", { conversationId, error: error.message });
      this._logEvent(conversationId, "error", "generation", "generation.failed", error.message, {
        incomingMessageId,
      });
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
    this._logEvent(c.id, "info", "delivery", "message.sent", "Сообщение отправлено клиенту", { sender });
    return this.getConversation(c.id);
  }
}

module.exports = {
  CrmService,
  DEFAULT_PROMPT,
  DEFAULT_HYPERVISOR_PROMPT,
  DEFAULT_CHARACTER_PROMPT,
  DEFAULT_RULES_PROMPT,
  DEFAULT_TASK_PROMPT,
  toConversation,
};
