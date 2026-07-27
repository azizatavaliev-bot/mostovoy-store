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
});

test("настройки бота сохраняют модель, подтверждение и все пять промптов", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: true }, amocrm: { enabled: false } });

  const settings = crm.saveSettings({
    approvalEnabled: false,
    model: "deepseek-reasoner",
    systemPrompt: "Система",
    hypervisorPrompt: "Гипервизор",
    characterPrompt: "Характер",
    rulesPrompt: "Правила",
    taskPrompt: "Задача",
  });

  assert.equal(settings.approvalEnabled, false);
  assert.equal(settings.model, "deepseek-reasoner");
  assert.equal(settings.systemPrompt, "Система");
  assert.equal(settings.hypervisorPrompt, "Гипервизор");
  assert.equal(settings.characterPrompt, "Характер");
  assert.equal(settings.rulesPrompt, "Правила");
  assert.equal(settings.taskPrompt, "Задача");
});
