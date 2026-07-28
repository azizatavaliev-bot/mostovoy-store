const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics } = require("./buy-analytics");
const { MODELS, modelInfo } = require("./ai");

const DEFAULT_PROMPT = `Ты продавец-консультант магазина техники МОСТОВОЙ в Бишкеке.
Отвечай кратко, дружелюбно и на языке клиента. Используй только цены и наличие из каталога ниже.
Не придумывай характеристики, скидки и сроки доставки. Если данных нет — честно скажи, что менеджер уточнит.
Помоги выбрать товар и мягко предложи оформить заказ. Не упоминай, что ты AI.`;
const DEFAULT_HYPERVISOR_PROMPT = `Ты создаёшь краткое резюме контекста диалога для менеджера магазина техники.
Перескажи только факты из переписки: что хочет клиент, какие товары и условия обсуждались, что уже выяснено и какой вопрос остался открытым.
Не оценивай ответ консультанта, не исправляй его, не предлагай свой ответ и ничего не выдумывай.
Ответ — не более трёх коротких предложений.`;
const DEFAULT_CHARACTER_PROMPT = `Доброжелательный, уверенный и внимательный консультант. Общается естественно, без канцелярита и навязчивости.`;
const DEFAULT_RULES_PROMPT = `Не выдумывай наличие, цены и условия. Не обещай то, чего нет в каталоге. Если информации недостаточно — передай вопрос менеджеру.`;
const DEFAULT_TASK_PROMPT = `Помоги клиенту выбрать подходящий товар, ответь на вопрос и мягко подведи к оформлению заказа.`;
const ALLOWED_MODELS = MODELS.map((item) => item.id);
const DEEPSEEK_INPUT_USD_PER_MILLION = 0.07;
const DEEPSEEK_OUTPUT_USD_PER_MILLION = 1.10;

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
  constructor({ db, ai, deepseek, amocrm, fetchImpl } = {}) {
    this.db = db;
    this.deepseek = deepseek;
    this.ai = ai || deepseek;
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
      ai: Boolean(this.ai?.enabled),
      amocrmWebhook: `${base}/api/amocrm/webhook${secretPath}`,
    };
  }

  getSettings() {
    const rows = Object.fromEntries(
      this.db.prepare("SELECT key, value FROM crm_settings").all().map((row) => [row.key, row.value])
    );
    return {
      approvalEnabled: rows.bot_approval_enabled !== "false",
      aggressiveLearning: rows.bot_learning_mode === "aggressive",
      model: ALLOWED_MODELS.includes(rows.bot_model) ? rows.bot_model : config.deepseek.model,
      systemPrompt: rows.bot_system_prompt || rows.sales_prompt || DEFAULT_PROMPT,
      hypervisorPrompt: rows.bot_hypervisor_prompt || DEFAULT_HYPERVISOR_PROMPT,
      characterPrompt: rows.bot_character_prompt || DEFAULT_CHARACTER_PROMPT,
      rulesPrompt: rows.bot_rules_prompt || DEFAULT_RULES_PROMPT,
      taskPrompt: rows.bot_task_prompt || DEFAULT_TASK_PROMPT,
      models: typeof this.ai?.listModels === "function"
        ? this.ai.listModels()
        : MODELS.map((item) => ({ ...item, enabled: item.provider === "deepseek" && Boolean(this.ai?.enabled) })),
    };
  }

  saveSettings(payload = {}) {
    const current = this.getSettings();
    const values = {
      bot_approval_enabled: String(payload.approvalEnabled ?? current.approvalEnabled),
      bot_learning_mode: (payload.aggressiveLearning ?? current.aggressiveLearning) ? "aggressive" : "manual",
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
      aggressiveLearning: values.bot_learning_mode === "aggressive",
    });
    return this.getSettings();
  }

  getBuyAnalytics(days = 30) {
    const analytics = getBuyClickAnalytics(this.db, days);
    const since = `-${analytics.periodDays - 1} days`;
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT conversation_id) AS count FROM (
         SELECT conversation_id FROM bot_approvals
          WHERE status = 'approved' AND decided_at >= datetime('now', ?)
         UNION
         SELECT conversation_id FROM crm_messages
          WHERE sender = 'manager' AND created_at >= datetime('now', ?)
       )`
    ).get(since, since);
    analytics.summary.handoffs = Number(row.count || 0);
    return analytics;
  }

  _recordUsage(task, conversationId, model, usage = {}) {
    const promptTokens = Math.max(0, Number(usage.prompt_tokens || 0));
    const completionTokens = Math.max(0, Number(usage.completion_tokens || 0));
    const totalTokens = Math.max(0, Number(usage.total_tokens || promptTokens + completionTokens));
    const hasKnownPricing = String(model || "").startsWith("deepseek-");
    const inputCost = hasKnownPricing ? promptTokens / 1_000_000 * DEEPSEEK_INPUT_USD_PER_MILLION : 0;
    const outputCost = hasKnownPricing ? completionTokens / 1_000_000 * DEEPSEEK_OUTPUT_USD_PER_MILLION : 0;
    this.db.prepare(
      `INSERT INTO ai_usage
        (conversation_id, task, model, prompt_tokens, completion_tokens, total_tokens,
         input_cost_usd, output_cost_usd, total_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId == null ? null : Number(conversationId),
      task,
      String(model || this.getSettings().model),
      promptTokens,
      completionTokens,
      totalTokens,
      inputCost,
      outputCost,
      inputCost + outputCost
    );
  }

  _usageRecorder(task, conversationId, fallbackModel) {
    return (usage, model) => this._recordUsage(task, conversationId, model || fallbackModel, usage);
  }

  getAiUsageAnalytics() {
    const period = (modifier) => this.db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(total_cost_usd), 0) AS cost
       FROM ai_usage ${modifier ? "WHERE created_at >= datetime('now', ?)" : ""}`
    ).get(...(modifier ? [modifier] : []));
    const today = period("start of day");
    const month = period("-30 days");
    const year = period("-365 days");
    const all = period();
    const activeDays = this.db.prepare(
      "SELECT COUNT(DISTINCT date(created_at)) AS count FROM ai_usage"
    ).get();
    const tasks = this.db.prepare(
      `SELECT task, model, COUNT(*) AS calls, SUM(total_tokens) AS tokens,
              SUM(total_cost_usd) AS cost
       FROM ai_usage GROUP BY task, model ORDER BY cost DESC, tokens DESC`
    ).all().map((row) => ({
      task: row.task,
      model: row.model,
      calls: Number(row.calls || 0),
      tokens: Number(row.tokens || 0),
      costUsd: Number(row.cost || 0),
    }));
    const overview = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM crm_conversations) AS conversations,
        (SELECT COUNT(*) FROM crm_messages) AS messages,
        (SELECT COUNT(*) FROM bot_approvals) AS aiReplies,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'approved') AS approved,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'approved' AND edited_reply IS NULL) AS withoutEdits,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'rejected') AS rejected`
    ).get();
    const normalize = (row) => ({ tokens: Number(row.tokens || 0), costUsd: Number(row.cost || 0) });
    return {
      overview: Object.fromEntries(Object.entries(overview).map(([key, value]) => [key, Number(value || 0)])),
      periods: {
        today: normalize(today),
        averageDay: {
          tokens: Math.round(Number(all.tokens || 0) / Math.max(1, Number(activeDays.count || 0))),
          costUsd: Number(all.cost || 0) / Math.max(1, Number(activeDays.count || 0)),
        },
        month: normalize(month),
        year: normalize(year),
        all: normalize(all),
      },
      tasks,
      pricing: {
        inputUsdPerMillion: DEEPSEEK_INPUT_USD_PER_MILLION,
        outputUsdPerMillion: DEEPSEEK_OUTPUT_USD_PER_MILLION,
      },
    };
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
      enabled: Boolean(this.ai?.enabled),
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
      rejectReason: row.reject_reason,
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
    this._saveTrainingExample(row, {
      qualityLabel: "accepted",
      finalReply: finalText,
      wasEdited: finalText !== row.ai_reply,
    });
    this._logEvent(row.conversation_id, "info", "approval", "approval.approved", "Ответ подтверждён и отправлен", {
      approvalId: Number(row.id),
      edited: finalText !== row.ai_reply,
    });
    return this.listApprovals("all").find((item) => item.id === Number(row.id));
  }

  async rejectReply(id, reason) {
    const row = this.db.prepare("SELECT * FROM bot_approvals WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Черновик не найден");
    if (row.status !== "pending") throw new Error("Черновик уже обработан");
    const rejectReason = String(reason || "").trim().slice(0, 2000);
    if (!rejectReason) throw new Error("Укажите причину отклонения");
    this.db.prepare(
      `UPDATE bot_approvals SET status = 'rejected', reject_reason = ?,
       decided_at = datetime('now') WHERE id = ?`
    ).run(rejectReason, row.id);
    this._saveTrainingExample(row, {
      qualityLabel: "rejected",
      rejectReason,
    });
    this._logEvent(row.conversation_id, "warn", "approval", "approval.rejected", "Ответ отклонён менеджером", {
      approvalId: Number(row.id),
      reason: rejectReason,
    });
    if (this.getSettings().aggressiveLearning) {
      try {
        await this._calibratePromptFromReject(row, rejectReason);
      } catch (error) {
        this._logEvent(row.conversation_id, "error", "learning", "learning.failed", error.message, {
          approvalId: Number(row.id),
        });
      }
    }
    return this.listApprovals("all").find((item) => item.id === Number(row.id));
  }

  _saveTrainingExample(row, { qualityLabel, finalReply = null, wasEdited = false, rejectReason = null }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO bot_training_examples
        (approval_id, conversation_id, customer_message, ai_reply, final_reply,
         was_edited, quality_label, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.conversation_id,
      row.customer_message,
      row.ai_reply,
      finalReply,
      wasEdited ? 1 : 0,
      qualityLabel,
      rejectReason
    );
  }

  async _calibratePromptFromReject(row, reason) {
    if (!this.ai?.enabled || typeof this.ai.chatJson !== "function") return;
    const settings = this.getSettings();
    const result = await this.ai.chatJson({
      system: `Ты калибруешь системный промпт продавца магазина техники.
Верни JSON с полями prompt_patch и reasoning.
prompt_patch — не больше двух коротких предложений, только универсальное правило.
Если замечание относится лишь к единичному случаю, верни пустой prompt_patch.`,
      user: JSON.stringify({
        customer_message: row.customer_message,
        rejected_reply: row.ai_reply,
        reject_reason: reason,
        current_system_prompt: settings.systemPrompt,
      }),
      temperature: 0.2,
      maxTokens: 350,
      model: settings.model,
      onUsage: this._usageRecorder("aggressive_learning", row.conversation_id, settings.model),
    });
    const patch = String(result?.prompt_patch || "").trim().slice(0, 1000);
    if (!patch || settings.systemPrompt.includes(patch)) return;
    const nextPrompt = `${settings.systemPrompt}\n\n${patch}`.slice(0, 16000);
    const upsert = this.db.prepare(
      `INSERT INTO crm_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    let history = [];
    try {
      const saved = this.db.prepare("SELECT value FROM crm_settings WHERE key = 'bot_system_prompt_history'").get();
      history = saved?.value ? JSON.parse(saved.value) : [];
    } catch {
      history = [];
    }
    history.push({
      at: new Date().toISOString(),
      approvalId: Number(row.id),
      reason,
      patch,
      reasoning: String(result?.reasoning || "").slice(0, 2000),
      previousPrompt: settings.systemPrompt,
    });
    upsert.run("bot_system_prompt", nextPrompt);
    upsert.run("bot_system_prompt_history", JSON.stringify(history.slice(-200)));
    this._logEvent(row.conversation_id, "info", "learning", "prompt.auto_calibrated", "Системный промпт обновлён", {
      approvalId: Number(row.id),
      patch,
    });
  }

  async testBot({ message, history = [], model, prompts = {} } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Введите сообщение тестового клиента");
    const settings = { ...this.getSettings(), ...prompts };
    const selectedModel = ALLOWED_MODELS.includes(model) ? model : settings.model;
    const startedAt = Date.now();
    const reply = await this.ai.chatText({
      system: this._composePrompt(settings, ""),
      messages: Array.isArray(history) ? history.slice(-20) : [],
      user: text,
      model: selectedModel,
      onUsage: this._usageRecorder("laboratory", null, selectedModel),
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

  async _summarizeConversation(conversationId, history, settings) {
    this._logEvent(conversationId, "info", "hypervisor", "hypervisor.started", "Гипервизор пересказывает контекст диалога");
    try {
      const summary = await this.ai.chatText({
        system: settings.hypervisorPrompt,
        messages: history,
        model: settings.model,
        maxTokens: 260,
        temperature: 0.1,
        onUsage: this._usageRecorder("hypervisor_context", conversationId, settings.model),
      });
      const value = String(summary || "").trim().slice(0, 2000);
      this._logEvent(conversationId, "info", "hypervisor", "hypervisor.completed", "Контекст диалога подготовлен");
      return value || null;
    } catch (error) {
      this._logEvent(conversationId, "warn", "hypervisor", "hypervisor.failed", error.message);
      return null;
    }
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
    const hasMedia = Boolean(message?.photo?.length || message?.voice || message?.audio);
    if ((!message?.text?.trim() && !message?.caption?.trim() && !hasMedia) || message.from?.is_bot || message.chat?.type !== "private") return;
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
    let text = String(message.text || message.caption || "").trim();
    if (hasMedia) {
      try {
        const media = message.photo?.length
          ? { kind: "image", file: message.photo.at(-1), mimeType: "image/jpeg" }
          : { kind: "audio", file: message.voice || message.audio, mimeType: (message.voice || message.audio)?.mime_type || "audio/ogg" };
        if (Number(media.file?.file_size || 0) > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const fileRes = await this.fetchImpl(
          `${config.telegram.apiBase}/bot${config.telegram.botToken}/getFile?file_id=${encodeURIComponent(media.file.file_id)}`
        );
        if (!fileRes.ok) throw new Error(`Telegram getFile: HTTP ${fileRes.status}`);
        const fileData = await fileRes.json();
        const filePath = fileData?.result?.file_path;
        if (!filePath) throw new Error("Telegram не вернул путь к файлу");
        const download = await this.fetchImpl(
          `${config.telegram.apiBase}/file/bot${config.telegram.botToken}/${filePath}`
        );
        if (!download.ok) throw new Error(`Telegram file: HTTP ${download.status}`);
        const bytes = Buffer.from(await download.arrayBuffer());
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const analysis = await this.ai.analyzeMedia({
          kind: media.kind,
          bytes,
          mimeType: media.mimeType,
          caption: text,
          onUsage: this._usageRecorder("media_analysis", conversation.id, this.getSettings().model),
        });
        text = [text, media.kind === "image" ? `[Изображение: ${analysis}]` : `[Аудио: ${analysis}]`]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "info", "media", "media.analyzed", "Вложение проанализировано", {
          kind: media.kind,
          bytes: bytes.length,
        });
      } catch (error) {
        text = [text, message.photo?.length ? "[Клиент прислал изображение]" : "[Клиент прислал аудио]"]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "error", "media", "media.failed", error.message);
      }
    }
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: String(message.message_id),
      direction: "incoming",
      sender: "customer",
      text,
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
    if (!this.ai?.enabled) return;
    const detail = this.getConversation(conversationId);
    if (!detail?.conversation.aiEnabled) return;
    const settings = this.getSettings();
    const products = this.db.prepare(
      `SELECT official_name, color, storage, price, currency, available
       FROM products WHERE status = 'active' AND price IS NOT NULL ORDER BY updated_at DESC`
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
      const reply = await this.ai.chatText({
        system: prompt,
        messages: history,
        model: settings.model,
        onUsage: this._usageRecorder("sales_agent", conversationId, settings.model),
      });
      if (settings.approvalEnabled) {
        const summary = await this._summarizeConversation(conversationId, history, settings);
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
