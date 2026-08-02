const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics, getProductViewAnalytics } = require("./buy-analytics");
const { MODELS, modelInfo } = require("./ai");
const { syncPublicChannelPosts } = require("../cli/import-public-channel");

function escapeTelegramHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function telegramHtml(markdown) {
  const protectedBlocks = [];
  const protect = (html) => {
    const token = `\uE000${protectedBlocks.length}\uE001`;
    protectedBlocks.push(html);
    return token;
  };

  let text = String(markdown || "");
  text = text.replace(/```(?:[a-z0-9_-]+)?\s*\n?([\s\S]*?)```/gi, (_, code) =>
    protect(`<pre>${escapeTelegramHtml(code.trim())}</pre>`)
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    protect(`<code>${escapeTelegramHtml(code)}</code>`)
  );
  text = escapeTelegramHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");

  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedBlocks[Number(index)] || "");
}

const DEFAULT_PROMPT = `Ты продавец-консультант магазина техники МОСТОВОЙ в Бишкеке.
Отвечай кратко, дружелюбно и на языке клиента. Используй только цены и наличие из каталога ниже.
Не придумывай характеристики, скидки и сроки доставки. Не говори «каталог не показывает», «сейчас уточню» и «подключу менеджера»: сначала сам предложи подходящие позиции из переданной подборки.
Помоги выбрать товар и мягко предложи оформить заказ. Не упоминай, что ты AI.`;
const DEFAULT_HYPERVISOR_PROMPT = `Ты создаёшь краткое резюме контекста диалога для менеджера магазина техники.
Перескажи только факты из переписки: что хочет клиент, какие товары и условия обсуждались, что уже выяснено и какой вопрос остался открытым.
Не оценивай ответ консультанта, не исправляй его, не предлагай свой ответ и ничего не выдумывай.
Ответ — не более трёх коротких предложений.`;
const DEFAULT_CHARACTER_PROMPT = `Доброжелательный, уверенный и внимательный консультант. Общается естественно, без канцелярита и навязчивости.`;
const DEFAULT_RULES_PROMPT = `Не выдумывай наличие, цены и условия. Не обещай то, чего нет в каталоге. Не перекладывай подбор на менеджера: если клиент просит совет, сразу предложи подходящие товары из подборки.`;
const DEFAULT_TASK_PROMPT = `Помоги клиенту выбрать подходящий товар, ответь на вопрос и мягко подведи к оформлению заказа.`;
const ALLOWED_MODELS = MODELS.map((item) => item.id);
const DEEPSEEK_INPUT_USD_PER_MILLION = 0.07;
const DEEPSEEK_OUTPUT_USD_PER_MILLION = 1.10;
const PREMIUM_RUB_PRICE = /\b(?:macbook\s+pro|iphone\s+17\s+pro\s+max)\b/i;

function roundAssistantPrice(amount, currency) {
  const step = currency === "USD" ? 10 : 100;
  return Math.ceil(Number(amount) / step) * step;
}

function convertAssistantPrice(amount, from, to) {
  const sourceRate = Number(config.rates[String(from || "").toUpperCase()]) || 1;
  const targetRate = Number(config.rates[String(to || "").toUpperCase()]) || 1;
  return Number(amount) / sourceRate * targetRate;
}

function formatAssistantPrice(amount, from, to) {
  const value = roundAssistantPrice(convertAssistantPrice(amount, from, to), to);
  const suffix = to === "KGS" ? "с" : to === "RUB" ? "₽" : "$";
  return `${value.toLocaleString("ru-RU")} ${suffix}`;
}

function buildTelegramCatalogForAssistant(db) {
  // Первичный источник для ассистента — сами публикации канала, без
  // промежуточного пересказа/извлечения модели. Импортёр public-channel
  // сохраняет их при первом запуске, webhook поддерживает их свежими далее.
  const posts = db.prepare(
    `SELECT telegram_message_id, telegram_message_updated_at, telegram_original_text
       FROM telegram_messages
      WHERE is_deleted = 0 AND last_sync_status = 'raw' AND trim(telegram_original_text) != ''
      ORDER BY COALESCE(telegram_message_updated_at, updated_at, created_at) DESC, telegram_message_id DESC
      LIMIT 60`
  ).all();
  if (posts.length) {
    return posts.map((post) =>
      `[Пост канала #${post.telegram_message_id}, ${post.telegram_message_updated_at || "дата не указана"}]\n${post.telegram_original_text}`
    ).join("\n\n");
  }
  const products = db.prepare(
    `SELECT p.official_name, p.color, p.storage, mp.price, mp.currency, mp.available
       FROM products p
       JOIN message_products mp ON mp.product_id = p.id
       JOIN telegram_messages tm ON tm.id = mp.message_id
      WHERE p.status != 'hidden' AND mp.active = 1 AND tm.is_deleted = 0 AND mp.price IS NOT NULL
        AND tm.id = (
          SELECT tm2.id
            FROM message_products mp2
            JOIN telegram_messages tm2 ON tm2.id = mp2.message_id
           WHERE mp2.product_id = p.id AND mp2.active = 1 AND tm2.is_deleted = 0 AND mp2.price IS NOT NULL
           ORDER BY COALESCE(tm2.telegram_message_updated_at, tm2.updated_at, tm2.created_at) DESC, tm2.id DESC
           LIMIT 1
        )
      ORDER BY tm.telegram_message_updated_at DESC, tm.id DESC`
  ).all();
  if (products.length) return products.map((p) => {
    const title = `${p.official_name}${p.storage ? ` ${p.storage}` : ""}${p.color ? `, ${p.color}` : ""}`;
    const defaultCurrency = PREMIUM_RUB_PRICE.test(p.official_name) ? "RUB" : "KGS";
    return `- ${title}: цена по умолчанию ${formatAssistantPrice(p.price, p.currency, defaultCurrency)}; USD ${formatAssistantPrice(p.price, p.currency, "USD")}; RUB ${formatAssistantPrice(p.price, p.currency, "RUB")}${p.available ? "" : " (нет в наличии)"}`;
  }).join("\n");
  // Старые импортированные позиции могут не иметь привязки message_products,
  // но их цена уже получена из канала и актуальна в таблице products.
  const snapshots = db.prepare(
    `SELECT official_name, color, storage, price, currency, available
       FROM products
      WHERE status != 'hidden' AND price IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 180`
  ).all();
  return snapshots.map((p) => {
    const title = `${p.official_name}${p.storage ? ` ${p.storage}` : ""}${p.color ? `, ${p.color}` : ""}`;
    const defaultCurrency = PREMIUM_RUB_PRICE.test(p.official_name) ? "RUB" : "KGS";
    return `- ${title}: цена по умолчанию ${formatAssistantPrice(p.price, p.currency, defaultCurrency)}; USD ${formatAssistantPrice(p.price, p.currency, "USD")}; RUB ${formatAssistantPrice(p.price, p.currency, "RUB")}${p.available ? "" : " (нет в наличии)"}`;
  }).join("\n");
}

const ASSISTANT_PRICE_POLICY = `ЦЕНЫ И ИСТОЧНИК:
Каталог ниже синхронизирован только с публикациями Telegram-канала магазина. Не используй старые цены сайта, память модели или цены без строки из этого каталога.
Для русскоязычных и кыргызскоязычных клиентов по умолчанию называй «цену по умолчанию»: это сомы. Исключение — MacBook Pro и iPhone 17 Pro Max: по умолчанию называй цену в рублях.
Если клиент явно попросил USD, RUB или KGS — назови цену в этой валюте. Если клиент пишет по-английски — по умолчанию используй USD. Не называй несколько валют сразу, если клиент не просит сравнение.
Ниже могут быть исходные тексты публикаций канала. Это первоисточник: читай их напрямую, не пересказывай, что «уточнишь». Если одна модель встречается несколько раз, используй цену из более нового поста. Если товара нет в этих публикациях, скажи, что менеджер уточнит актуальную цену в канале.

ПРОДАЖА:
Если клиент просит посоветовать товар, называет бюджет или категорию, сразу предложи 2–3 наиболее подходящих товара из актуального каталога с ценами. Не отвечай «сейчас уточню», «уточню у менеджера» и не перекладывай подбор на клиента, пока в каталоге есть подходящие варианты.
Никогда не пиши «каталог не показывает актуальные модели», «подключу менеджера» или похожие фразы. Менеджера упоминай только если клиент сам просит оформить заказ, резерв или живой осмотр.`;

const CATALOG_SPECIALIST_PROMPT = `Ты товаровед магазина техники. Тебе даны свежие исходные публикации Telegram-канала и последнее сообщение клиента.
Найди от 1 до 5 товаров, которые подходят запросу, бюджету и категории. Бери названия, цены, валюты и наличие только из публикаций. Не используй память, сайт или догадки. Если подходящих товаров нет — верни пустой массив.
Верни JSON строго такого вида:
{"products":[{"name":"iPhone 15 Pro Max","brand":"Apple","category":"smartphone","storage":"256GB","color":"Natural Titanium","price":1099,"currency":"USD","available":true,"reason":"кратко почему подходит"}],"note":"одно короткое уточнение только если товаров нет"}
price — число без пробелов и символов. currency — только USD, KGS или RUB. Поля brand, category, storage и color заполняй только если они прямо есть в посте; иначе null. available — true только если наличие указано или не опровергнуто в свежем посте.`;

function toConversation(row) {
  return {
    id: Number(row.id),
    // Ключ идемпотентности для внешних систем (в CRM это deals.external_key).
    externalKey: row.external_key,
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
  constructor({ db, ai, deepseek, amocrm, azisCrm, crmDeals, fetchImpl } = {}) {
    this.db = db;
    this.deepseek = deepseek;
    this.ai = ai || deepseek;
    this.amocrm = amocrm;
    this.azisCrm = azisCrm;
    this.crmDeals = crmDeals;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  // Новый клиент → сделка в воронке MostovoyCRM.
  // Ничего не ждём и не бросаем: недоступная CRM не должна ни задерживать
  // ответ клиенту, ни ронять обработку сообщения. Пропуск не потеряется —
  // CRM сверяется с /api/admin/crm/conversations.
  _publishDeal(conversation) {
    if (!this.crmDeals?.enabled) return;
    void this.crmDeals
      .createDeal({
        externalKey: conversation.external_key,
        source: conversation.source,
        customerName: conversation.customer_name,
        customerPhone: conversation.customer_phone,
        customerUsername: conversation.customer_username,
      })
      .catch((error) =>
        logger.error("crm_deals.publish_failed", {
          externalKey: conversation.external_key,
          error: error.message,
        })
      );
  }

  _publishAzis(type, payload) {
    if (!this.azisCrm?.enabled) return;
    void this.azisCrm.publishEvent(type, payload).catch((error) =>
      logger.error("azis_crm.publish_failed", { type, error: error.message })
    );
  }

  _publishMessage(conversation, data) {
    this._publishAzis("message", {
      channel: conversation.source,
      externalChatId: conversation.external_chat_id,
      externalLeadId: conversation.external_lead_id,
      externalContactId: conversation.external_contact_id,
      customerName: conversation.customer_name,
      customerUsername: conversation.customer_username,
      customerPhone: conversation.customer_phone,
      externalMessageId: data.externalMessageId,
      direction: data.direction,
      sender: data.sender,
      text: data.text,
      status: data.status || "stored",
      createdAt: data.createdAt || new Date().toISOString(),
      raw: data.raw,
    });
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

  // Сбрасывает только переписку лида. Контакт, сделка, привязка к каналу,
  // продажи и аналитика остаются — новый диалог начинается с чистого листа.
  clearConversationHistory(id) {
    const conversation = this.db.prepare("SELECT id, created_at FROM crm_conversations WHERE id = ?").get(id);
    if (!conversation) return null;
    this.db.exec("BEGIN");
    try {
      const approvals = this.db.prepare("DELETE FROM bot_approvals WHERE conversation_id = ?").run(id).changes;
      const messages = this.db.prepare("DELETE FROM crm_messages WHERE conversation_id = ?").run(id).changes;
      this.db.prepare(
        "UPDATE crm_conversations SET unread_count = 0, last_message_at = created_at, updated_at = datetime('now') WHERE id = ?"
      ).run(id);
      this.db.exec("COMMIT");
      const removed = { messages: Number(messages), approvals: Number(approvals) };
      this._logEvent(id, "warn", "inbox", "conversation.history_cleared", "История лида очищена", removed);
      return { ...removed, conversation: this.getConversation(id) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getStatus() {
    const base = config.publicUrl || "https://mostovoy-store-production.up.railway.app";
    const secretPath = config.amocrm.webhookSecret
      ? `/${encodeURIComponent(config.amocrm.webhookSecret)}`
      : "";
    const azisSecretPath = config.azisCrm.integrationSecret
      ? `/${encodeURIComponent(config.azisCrm.integrationSecret)}`
      : "";
    return {
      telegram: Boolean(config.telegram.botToken),
      amocrm: Boolean(this.amocrm?.enabled),
      azisCrm: Boolean(this.azisCrm?.enabled),
      ai: Boolean(this.ai?.enabled),
      amocrmWebhook: `${base}/api/amocrm/webhook${secretPath}`,
      primaryWebhook: config.azisCrm.baseUrl
        ? `${config.azisCrm.baseUrl}/api/integrations/amo/webhook${azisSecretPath}`
        : `${base}/api/amocrm/webhook${secretPath}`,
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
    // Просмотры карточек — отдельная метрика, не смешиваем с кликами «Купить».
    analytics.views = getProductViewAnalytics(this.db, analytics.periodDays);
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
    const conversation = conversationId == null
      ? null
      : this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    this._publishAzis("ai_usage", {
      task,
      model: String(model || this.getSettings().model),
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: inputCost + outputCost,
      channel: conversation?.source || "amocrm",
      externalChatId: conversation?.external_chat_id || null,
      externalLeadId: conversation?.external_lead_id || null,
      externalContactId: conversation?.external_contact_id || null,
    });
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
      ASSISTANT_PRICE_POLICY,
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
    // Был ли диалог до этого — от этого зависит, сообщать ли CRM о новом клиенте.
    const known = this.db
      .prepare("SELECT 1 FROM crm_conversations WHERE external_key = ?")
      .get(data.externalKey);
    this.db.prepare(
      `INSERT INTO crm_conversations
        (external_key, source, external_chat_id, external_lead_id, external_contact_id,
         customer_name, customer_username, customer_phone, unread_count, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(external_key) DO UPDATE SET
         source = excluded.source,
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
      data.name || null, data.username || null, data.phone || null, data.createdAt || new Date().toISOString()
    );
    const conversation = this.db
      .prepare("SELECT * FROM crm_conversations WHERE external_key = ?")
      .get(data.externalKey);
    // Сделку заводим только на первое входящее от клиента: ручная отправка
    // менеджером (sendExternal) диалог тоже создаёт, но это не заявка.
    if (!known && data.inbound) this._publishDeal(conversation);
    return conversation;
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
      inbound: true,
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
      this._publishMessage(conversation, {
        externalMessageId: String(message.message_id),
        direction: "incoming",
        sender: "customer",
        text,
        raw: message,
      });
      this._logEvent(conversation.id, "info", "inbox", "message.received", "Получено сообщение из Telegram", {
        messageId: inserted,
      });
    }
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id, inserted);
  }

  async receiveAmo(incoming, raw) {
    if (!incoming.text || !incoming.chatId || incoming.direction !== "incoming") return { ignored: true };
    const source = /instagram/i.test(incoming.source)
      ? "instagram"
      : /whatsapp/i.test(incoming.source)
        ? "whatsapp"
        : "amocrm";
    const conversation = this._upsertConversation({
      externalKey: `amo:${incoming.chatId}`,
      source,
      inbound: true,
      chatId: incoming.chatId,
      leadId: incoming.leadId,
      contactId: incoming.contactId,
      name: incoming.customerName,
      username: incoming.customerUsername,
      phone: incoming.customerPhone,
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
      this._publishMessage(conversation, {
        externalMessageId: incoming.messageId,
        direction: "incoming",
        sender: "customer",
        text: incoming.text,
        raw,
        createdAt: incoming.createdAt,
      });
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
    // Перед каждым ответом берём свежую витрину Telegram-канала. Это поиск
    // по первоисточнику до вызова модели, а не ответ по памяти DeepSeek.
    try {
      const sync = await syncPublicChannelPosts({ db: this.db, maxPages: 1, fetchImpl: this.fetchImpl });
      this._logEvent(conversationId, "info", "catalog", "catalog.channel_synced", "Перед ответом обновлены публикации канала", sync);
    } catch (error) {
      this._logEvent(conversationId, "warn", "catalog", "catalog.channel_sync_failed", error.message);
    }
    const catalog = buildTelegramCatalogForAssistant(this.db);
    const history = detail.messages.slice(-14).map((m) => ({
      role: m.direction === "incoming" ? "user" : "assistant",
      content: m.text,
    }));
    const customerRequest = [...history].reverse().find((message) => message.role === "user")?.content || "";
    const selection = await this._selectCatalogProducts({
      conversationId,
      customerRequest,
      catalog,
    });
    const prompt = this._composePrompt(settings, selection);
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

  async _selectCatalogProducts({ conversationId, customerRequest, catalog }) {
    if (!catalog) return "Товаровед не нашёл свежих публикаций канала.";
    if (!this.deepseek?.enabled || typeof this.deepseek.chatJson !== "function") {
      this._logEvent(conversationId, "warn", "catalog", "catalog.specialist_unavailable", "Товаровед DeepSeek недоступен");
      return "Товаровед временно недоступен: не называй цену и честно предложи менеджера.";
    }
    try {
      const result = await this.deepseek.chatJson({
        system: CATALOG_SPECIALIST_PROMPT,
        user: `ЗАПРОС КЛИЕНТА:\n${customerRequest}\n\nСВЕЖИЕ ПОСТЫ КАНАЛА:\n${catalog}`,
        maxTokens: 900,
        onUsage: this._usageRecorder("catalog_specialist", conversationId, config.deepseek.model),
      });
      const products = Array.isArray(result?.products)
        ? result.products.slice(0, 5).map((item) => {
          const price = Number(item?.price);
          const currency = String(item?.currency || "").toUpperCase();
          return {
            name: String(item?.name || "").trim(),
            brand: item?.brand ? String(item.brand).trim() : null,
            category: item?.category ? String(item.category).trim() : null,
            storage: item?.storage ? String(item.storage).trim() : null,
            color: item?.color ? String(item.color).trim() : null,
            price,
            currency,
            available: item?.available === true,
            reason: String(item?.reason || "").trim(),
          };
        }).filter((item) => item.name && Number.isFinite(item.price) && ["USD", "KGS", "RUB"].includes(item.currency))
        : [];
      const selection = JSON.stringify({ products, note: String(result?.note || "").trim() });
      this._logEvent(conversationId, "info", "catalog", "catalog.specialist_selected", "Товаровед отобрал товары из канала", {
        productCount: products.length,
      });
      return `ПОДБОРКА ТОВАРОВЕДА ИЗ КАНАЛА:\n${selection}\n\nОтвечай только по этой подборке. Не говори, что обращался к товароведу или каналу.`;
    } catch (error) {
      this._logEvent(conversationId, "warn", "catalog", "catalog.specialist_failed", error.message);
      return "Товаровед временно не смог отобрать товары: не называй цену и честно предложи менеджера.";
    }
  }

  async sendManual(conversationId, text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Сообщение пустое");
    return this._send(conversationId, value.slice(0, 4000), "manager");
  }

  async sendExternal({ source, chatId, leadId, contactId, text }) {
    const value = String(text || "").trim().slice(0, 4000);
    if (!value) throw new Error("Сообщение пустое");
    if (!chatId) throw new Error("chatId required");
    const normalizedSource = /instagram/i.test(source)
      ? "instagram"
      : /whatsapp/i.test(source)
        ? "whatsapp"
        : "amocrm";
    let conversation = this.db.prepare(
      "SELECT * FROM crm_conversations WHERE external_chat_id = ? ORDER BY id DESC LIMIT 1"
    ).get(String(chatId));
    if (!conversation) {
      conversation = this._upsertConversation({
        externalKey: `amo:${chatId}`,
        source: normalizedSource,
        chatId: String(chatId),
        leadId: leadId || null,
        contactId: contactId || null,
        createdAt: new Date().toISOString(),
      });
    }
    const detail = await this._send(Number(conversation.id), value, "manager");
    return { messageId: detail.messageId, conversationId: Number(conversation.id) };
  }

  _recommendedProductImage(text) {
    const reply = String(text || "").toLocaleLowerCase("ru-RU");
    if (!reply) return null;
    const products = this.db.prepare(
      `SELECT official_name, main_image_url FROM products
       WHERE status != 'hidden' AND main_image_url IS NOT NULL AND main_image_url != ''
       ORDER BY length(official_name) DESC`
    ).all();
    return products.find((product) => reply.includes(String(product.official_name).toLocaleLowerCase("ru-RU"))) || null;
  }

  async _sendTelegramProductPhoto(conversation, product) {
    if (!config.publicUrl || !product?.main_image_url) return;
    const photo = `${config.publicUrl}/api/images/webp?src=${encodeURIComponent(product.main_image_url)}&w=1200`;
    const res = await this.fetchImpl(`${config.telegram.apiBase}/bot${config.telegram.botToken}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: conversation.external_chat_id, photo }),
    });
    if (!res.ok) throw new Error(`Telegram photo: HTTP ${res.status}`);
  }

  async _send(conversationId, text, sender) {
    const c = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    if (!c) throw new Error("Диалог не найден");
    if (c.source === "telegram") {
      if (!config.telegram.botToken) throw new Error("Telegram bot не настроен");
      const res = await this.fetchImpl(`${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: c.external_chat_id,
          text: telegramHtml(text),
          parse_mode: "HTML",
        }),
      });
      if (!res.ok) throw new Error(`Telegram: HTTP ${res.status}`);
      if (sender === "assistant") {
        const product = this._recommendedProductImage(text);
        if (product) {
          try {
            await this._sendTelegramProductPhoto(c, product);
          } catch (error) {
            this._logEvent(c.id, "warn", "delivery", "product_photo.failed", error.message, { product: product.official_name });
          }
        }
      }
    } else {
      await this.amocrm.sendMessage({
        chatId: c.external_chat_id,
        leadId: c.external_lead_id,
        contactId: c.external_contact_id,
        text,
      });
    }
    const externalMessageId = `${sender}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._storeMessage(c.id, {
      externalMessageId,
      direction: "outgoing",
      sender,
      text,
      status: "sent",
    });
    this._publishMessage(c, {
      externalMessageId,
      direction: "outgoing",
      sender,
      text,
      status: "sent",
    });
    this.db.prepare(
      "UPDATE crm_conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(c.id);
    this._logEvent(c.id, "info", "delivery", "message.sent", "Сообщение отправлено клиенту", { sender });
    return { ...this.getConversation(c.id), messageId: externalMessageId };
  }
}

module.exports = {
  CrmService,
  DEFAULT_PROMPT,
  DEFAULT_HYPERVISOR_PROMPT,
  DEFAULT_CHARACTER_PROMPT,
  DEFAULT_RULES_PROMPT,
  DEFAULT_TASK_PROMPT,
  buildTelegramCatalogForAssistant,
  formatAssistantPrice,
  telegramHtml,
  toConversation,
};
