// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.GREENAPI_WEBHOOK_TOKEN = "wa-test-token";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { createApp } = require("../server/app");
const { CrmService } = require("../server/services/crm");
const { parseGreenApiWebhook, toGreenApiChatId } = require("../server/services/greenapi");
const { templateById } = require("../server/services/templates");
const { SyncQueue } = require("../server/queue");
const { SyncService } = require("../server/services/sync");
const { makeDb, FakeDeepSeek, StubResearchService } = require("./helpers");

const okFetch = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) });

function incomingBody({ phone = "996700000001", text = "Привет", idMessage = "wa-1", typeWebhook = "incomingMessageReceived" } = {}) {
  return {
    typeWebhook,
    idMessage,
    timestamp: 1_700_000_000,
    senderData: { chatId: `${phone}@c.us`, senderName: "Клиент WA" },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: text } },
  };
}

test("вебхук Green API: текст клиента разбирается, эхо API и группы отбрасываются", () => {
  const incoming = parseGreenApiWebhook(incomingBody({ text: "Есть iPhone?" }));
  assert.equal(incoming.type, "incoming");
  assert.equal(incoming.phone, "996700000001");
  assert.equal(incoming.text, "Есть iPhone?");
  assert.equal(parseGreenApiWebhook(incomingBody({ typeWebhook: "outgoingAPIMessageReceived" })), null);
  assert.equal(parseGreenApiWebhook({ ...incomingBody(), senderData: { chatId: "123@g.us" } }), null);
  assert.equal(parseGreenApiWebhook(incomingBody({ typeWebhook: "outgoingMessageReceived", text: "Ответ менеджера" })).type, "outgoing");
  assert.equal(toGreenApiChatId("+996 700 000-001"), "996700000001@c.us");
});

test("маршрут вебхука Green API: без Bearer-токена 401, с токеном сообщение попадает в inbox как WhatsApp", async (t) => {
  const db = makeDb();
  const deepseek = new FakeDeepSeek({ extract: { products: [] } });
  const research = new StubResearchService({ status: "skipped", data: null, reason: "disabled" });
  const queue = new SyncQueue({ db, syncService: new SyncService({ db, deepseek, research }) });
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, fetchImpl: okFetch });
  const app = createApp({ db, deepseek, research, queue, crm });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const denied = await fetch(`${base}/api/greenapi/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify(incomingBody()),
  });
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${base}/api/greenapi/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wa-test-token" },
    body: JSON.stringify(incomingBody({ text: "Есть iPhone 17?" })),
  });
  assert.equal(accepted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const conversations = crm.listConversations();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].source, "whatsapp");
  assert.equal(conversations[0].externalKey, "greenapi:996700000001");
  assert.equal(conversations[0].customerPhone, "996700000001");
  const detail = crm.getConversation(conversations[0].id);
  assert.equal(detail.messages.at(-1).text, "Есть iPhone 17?");
});

test("ответ бота в WhatsApp уходит через Green API sendMessage, а сообщение с телефона выключает AI", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const sent = [];
  const greenapi = { enabled: true, sendMessage: async (chatId, message) => { sent.push({ chatId, message }); return { idMessage: "m1" }; } };
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => "не должно вызываться для шаблона", chatJson: async () => ({ template_id: null }) },
    amocrm: { enabled: false },
    greenapi,
    fetchImpl: okFetch,
    autoReplyDebounceMs: 0,
  });
  await crm.receiveGreenApi(parseGreenApiWebhook(incomingBody({ text: "Привет", idMessage: "wa-0" })));
  await crm.receiveGreenApi(parseGreenApiWebhook(incomingBody({ text: "Здравствуйте, а оптом можно у вас брать?" })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 2, "приветствие + шаблон про опт");
  assert.equal(sent[1].chatId, "996700000001@c.us");
  assert.equal(sent[1].message, templateById("cooperation_inquiry"));

  await crm.receiveGreenApi(parseGreenApiWebhook(incomingBody({ typeWebhook: "outgoingMessageReceived", text: "Это менеджер, я на связи", idMessage: "wa-2" })));
  const conversation = crm.listConversations()[0];
  assert.equal(conversation.aiEnabled, false);
  await crm.receiveGreenApi(parseGreenApiWebhook(incomingBody({ text: "А доставка есть?", idMessage: "wa-3" })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 2, "после менеджера бот молчит");
});

test("лаборатория WhatsApp: реальный пайплайн, но ничего не уходит наружу и не попадает в inbox", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const sent = [];
  const deals = [];
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => "Ответ бота из лаборатории.", chatJson: async () => ({ template_id: null }) },
    amocrm: { enabled: false },
    greenapi: { enabled: true, sendMessage: async (chatId, message) => { sent.push({ chatId, message }); return {}; } },
    crmDeals: { enabled: true, createDeal: async (deal) => { deals.push(deal); }, advanceStage: async () => ({}), notifyImportant: async () => ({}) },
    fetchImpl: okFetch,
    autoReplyDebounceMs: 0,
  });
  // Подтверждение ответов включено — в лаборатории оно не должно задерживать ответ.
  crm.saveSettings({ approvalEnabled: true, supervisorEnabled: false });

  const first = await crm.labSend({ text: "Привет" });
  assert.match(first.chatId, /^lab-/);
  assert.equal(first.history.length, 2);
  assert.equal(first.history[0].sender, "client");
  assert.equal(first.history[1].sender, "bot");
  assert.match(first.history[1].text, /MOSTOVOY SHOP/);

  const second = await crm.labSend({ chatId: first.chatId, text: "Какой MacBook посоветуете для монтажа?" });
  assert.equal(second.chatId, first.chatId);
  assert.equal(second.history.at(-1).sender, "bot");
  assert.match(second.history.at(-1).text, /Ответ бота из лаборатории/);

  assert.equal(sent.length, 0, "Green API не дёргается");
  assert.equal(deals.length, 0, "сделка не создаётся");
  assert.equal(crm.listApprovals("pending").length, 0, "ответ не завис в подтверждении");
  assert.equal(crm.listConversations().length, 0, "лаборатория не видна в inbox");

  assert.deepEqual(crm.labReset(first.chatId), { deleted: true });
  assert.deepEqual(crm.labHistory(first.chatId), []);
});
