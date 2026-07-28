const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { CrmService } = require("../server/services/crm");
const { parseAmoWebhook } = require("../server/services/amocrm");
const config = require("../server/config");

test("личное сообщение Telegram создаёт CRM-диалог без дублей", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({
    db,
    deepseek: { enabled: false },
    amocrm: { enabled: false },
  });
  const message = {
    message_id: 77,
    date: 1_700_000_000,
    text: "Есть iPhone 17?",
    chat: { id: 123, type: "private" },
    from: { id: 123, first_name: "Азиз", username: "aziz" },
  };

  await crm.receiveTelegram(message);
  await crm.receiveTelegram(message);

  const conversations = crm.listConversations();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].source, "telegram");
  assert.equal(conversations[0].customerName, "Азиз");
  assert.equal(crm.getConversation(conversations[0].id).messages.length, 1);
});

test("amoCRM form webhook разбирает WhatsApp-сообщение", () => {
  const parsed = parseAmoWebhook({
    "message[add][0][text]": "Здравствуйте",
    "message[add][0][type]": "incoming",
    "message[add][0][chat_id]": "chat-1",
    "message[add][0][id]": "msg-1",
    "message[add][0][author][name]": "Клиент",
    "message[add][0][element_id]": "991",
    "message[add][0][origin]": "whatsapp",
  });
  assert.equal(parsed.text, "Здравствуйте");
  assert.equal(parsed.chatId, "chat-1");
  assert.equal(parsed.leadId, "991");
  assert.equal(parsed.source, "whatsapp");
});

test("CRM хранит заметку и переключатель AI", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  await crm.receiveTelegram({
    message_id: 1,
    text: "Привет",
    chat: { id: 555, type: "private" },
    from: { first_name: "Клиент" },
  });
  const id = crm.listConversations()[0].id;
  const updated = crm.updateConversation(id, { aiEnabled: false, notes: "Ищет MacBook" });
  assert.equal(updated.conversation.aiEnabled, false);
  assert.equal(updated.conversation.notes, "Ищет MacBook");
});

test("ответ бота ждёт подтверждения и отправляется только после решения менеджера", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let sent = 0;
  const crm = new CrmService({
    db,
    deepseek: {
      enabled: true,
      chatText: async () => "Да, iPhone 17 есть в наличии.",
    },
    amocrm: { enabled: false },
    fetchImpl: async () => {
      sent += 1;
      return { ok: true, status: 200 };
    },
  });

  await crm.receiveTelegram({
    message_id: 91,
    date: 1_700_000_000,
    text: "Есть iPhone 17?",
    chat: { id: 991, type: "private" },
    from: { id: 991, first_name: "Клиент" },
  });

  const [draft] = crm.listApprovals("pending");
  assert.equal(sent, 0);
  assert.equal(draft.customerMessage, "Есть iPhone 17?");
  assert.equal(draft.aiReply, "Да, iPhone 17 есть в наличии.");

  await crm.approveReply(draft.id, "Да, есть. Какой цвет вас интересует?");

  assert.equal(sent, 1);
  assert.equal(crm.listApprovals("pending").length, 0);
  assert.equal(crm.listApprovals("approved")[0].editedReply, "Да, есть. Какой цвет вас интересует?");
  assert.equal(crm.getConversation(draft.conversationId).messages.at(-1).sender, "assistant");
  assert.equal(crm.getBuyAnalytics(30).summary.handoffs, 1);
});

test("Telegram-фото анализируется и попадает в контекст диалога", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let analyzed = null;
  const ai = {
    enabled: true,
    listModels: () => [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek", enabled: true }],
    analyzeMedia: async (payload) => {
      analyzed = payload;
      return "на фото белый iPhone 17 Pro Max";
    },
    chatText: async () => "Да, такая модель есть в каталоге.",
  };
  const crm = new CrmService({
    db,
    ai,
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (String(url).includes("/getFile")) {
        return { ok: true, json: async () => ({ result: { file_path: "photos/phone.jpg" } }) };
      }
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    },
  });

  await crm.receiveTelegram({
    message_id: 92,
    date: 1_700_000_000,
    caption: "Есть такой?",
    photo: [{ file_id: "small" }, { file_id: "large", file_size: 3 }],
    chat: { id: 992, type: "private" },
    from: { id: 992, first_name: "Клиент" },
  });

  assert.equal(analyzed.kind, "image");
  assert.equal(analyzed.mimeType, "image/jpeg");
  const detail = crm.getConversation(crm.listConversations()[0].id);
  assert.match(detail.messages[0].text, /Есть такой/);
  assert.match(detail.messages[0].text, /белый iPhone 17 Pro Max/);
  assert.equal(crm.listApprovals("pending").length, 1);
});

test("настройки бота сохраняют модель, подтверждение и гипервизор контекста", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: true }, amocrm: { enabled: false } });

  const settings = crm.saveSettings({
    approvalEnabled: false,
    aggressiveLearning: true,
    model: "deepseek-v4-pro",
    systemPrompt: "Система",
    hypervisorPrompt: "Только перескажи контекст",
    characterPrompt: "Характер",
    rulesPrompt: "Правила",
    taskPrompt: "Задача",
  });

  assert.equal(settings.approvalEnabled, false);
  assert.equal(settings.aggressiveLearning, true);
  assert.equal(settings.model, "deepseek-v4-pro");
  assert.equal(settings.systemPrompt, "Система");
  assert.equal(settings.hypervisorPrompt, "Только перескажи контекст");
  assert.equal(settings.characterPrompt, "Характер");
  assert.equal(settings.rulesPrompt, "Правила");
  assert.equal(settings.taskPrompt, "Задача");
});

test("гипервизор получает только историю диалога и сохраняет её резюме отдельно от ответа", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const calls = [];
  const ai = {
    enabled: true,
    chatText: async (payload) => {
      calls.push(payload);
      return payload.system.includes("Только факты из истории")
        ? "Клиент ищет iPhone 17 и уточняет наличие. Цвет пока не выбран."
        : "Да, iPhone 17 есть в наличии.";
    },
  };
  const crm = new CrmService({ db, ai, amocrm: { enabled: false } });
  crm.saveSettings({ hypervisorPrompt: "Только факты из истории. Не оценивай ответ." });

  await crm.receiveTelegram({
    message_id: 122,
    text: "Есть iPhone 17?",
    chat: { id: 122, type: "private" },
    from: { first_name: "Клиент" },
  });

  const draft = crm.listApprovals("pending")[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].system.includes("Только факты из истории"), false);
  assert.equal(calls[1].system, "Только факты из истории. Не оценивай ответ.");
  assert.deepEqual(calls[1].messages, [{ role: "user", content: "Есть iPhone 17?" }]);
  assert.equal("user" in calls[1], false);
  assert.equal(draft.aiReply, "Да, iPhone 17 есть в наличии.");
  assert.equal(draft.summary, "Клиент ищет iPhone 17 и уточняет наличие. Цвет пока не выбран.");
});

test("агрессивное обучение сохраняет отклонение и точечно обновляет системный промпт", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const deepseek = {
    enabled: true,
    chatText: async ({ onUsage }) => {
      onUsage?.({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, "deepseek-v4-flash");
      return "Конечно, скидка 50%.";
    },
    chatJson: async ({ onUsage }) => {
      onUsage?.({ prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 }, "deepseek-v4-flash");
      return {
        prompt_patch: "Не обещай скидку, если она не указана в каталоге.",
        reasoning: "Ответ содержал выдуманную скидку.",
      };
    },
  };
  const crm = new CrmService({ db, deepseek, amocrm: { enabled: false } });
  crm.saveSettings({ aggressiveLearning: true, systemPrompt: "Базовый промпт." });

  await crm.receiveTelegram({
    message_id: 120,
    date: 1_700_000_000,
    text: "Дадите скидку?",
    chat: { id: 120, type: "private" },
    from: { id: 120, first_name: "Клиент" },
  });
  const draft = crm.listApprovals("pending")[0];
  await crm.rejectReply(draft.id, "Бот придумал скидку");

  const rejected = crm.listApprovals("rejected")[0];
  assert.equal(rejected.rejectReason, "Бот придумал скидку");
  assert.match(crm.getSettings().systemPrompt, /Не обещай скидку/);
  const example = db.prepare("SELECT * FROM bot_training_examples WHERE approval_id = ?").get(draft.id);
  assert.equal(example.quality_label, "rejected");
  assert.equal(example.reject_reason, "Бот придумал скидку");
  assert.equal(JSON.parse(db.prepare(
    "SELECT value FROM crm_settings WHERE key = 'bot_system_prompt_history'"
  ).get().value).length, 1);

  const usage = crm.getAiUsageAnalytics();
  assert.equal(usage.tasks.find((item) => item.task === "sales_agent").tokens, 120);
  assert.equal(usage.tasks.find((item) => item.task === "aggressive_learning").tokens, 90);
  assert.ok(usage.periods.all.costUsd > 0);
});

test("сбой агрессивного обучения не отменяет отклонение ответа", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({
    db,
    deepseek: {
      enabled: true,
      chatText: async () => "Неудачный ответ",
      chatJson: async () => {
        throw new Error("DeepSeek временно недоступен");
      },
    },
    amocrm: { enabled: false },
  });
  crm.saveSettings({ aggressiveLearning: true });
  await crm.receiveTelegram({
    message_id: 121,
    text: "Вопрос",
    chat: { id: 121, type: "private" },
    from: { first_name: "Клиент" },
  });
  const draft = crm.listApprovals("pending")[0];
  await crm.rejectReply(draft.id, "Ответ неверный");

  assert.equal(crm.listApprovals("rejected").length, 1);
  assert.equal(crm.listEvents({ level: "error" })[0].event, "learning.failed");
});
