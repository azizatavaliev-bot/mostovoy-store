const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { CrmService } = require("../server/services/crm");
const { parseAmoWebhook } = require("../server/services/amocrm");

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

test("CRM считает аналитику только по подтверждённым продажам", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, price, currency)
     VALUES (?, ?, ?, ?, ?)`
  ).run("iphone-17", "apple|iphone-17|||standard", "iPhone 17", 1000, "USD");
  db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, price, currency)
     VALUES (?, ?, ?, ?, ?)`
  ).run("airpods-4", "apple|airpods-4|||standard", "AirPods 4", 120, "USD");
  await crm.receiveTelegram({
    message_id: 1,
    text: "Беру iPhone",
    chat: { id: 900, type: "private" },
    from: { first_name: "Клиент" },
  });
  const conversationId = crm.listConversations()[0].id;

  crm.recordSale({ conversationId, productSlug: "iphone-17", quantity: 2, unitPrice: 950 });
  crm.recordSale({ conversationId, productSlug: "airpods-4", quantity: 1 });

  const analytics = crm.getSalesAnalytics(30);
  assert.equal(analytics.summary.salesCount, 2);
  assert.equal(analytics.summary.units, 3);
  assert.deepEqual(analytics.summary.revenue, [{ currency: "USD", amount: 2020 }]);
  assert.equal(analytics.topProducts[0].productName, "iPhone 17");
  assert.equal(analytics.topProducts[0].units, 2);
  assert.equal(analytics.sources[0].source, "telegram");
  assert.equal(analytics.recent.length, 2);
});

test("CRM позволяет удалить ошибочно отмеченную продажу", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, price, currency)
     VALUES ('watch', 'apple|watch|||standard', 'Apple Watch', 300, 'USD')`
  ).run();
  const sale = crm.recordSale({ productSlug: "watch" });
  assert.equal(crm.deleteSale(sale.id), true);
  assert.equal(crm.getSalesAnalytics(30).summary.salesCount, 0);
});
