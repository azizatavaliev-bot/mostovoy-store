// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.KNOWN_CONTACTS = "996700111222, @ramazan_marketer, 555001, Абдурахман";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../server/config");
const { createConnection } = require("../server/db");
const { CrmService } = require("../server/services/crm");

test("KNOWN_CONTACTS парсится в список из строки через запятую", () => {
  assert.deepEqual(config.knownContacts, ["996700111222", "@ramazan_marketer", "555001", "Абдурахман"]);
});

test("свой контакт (номер WhatsApp) не получает автоответ, но сообщение сохраняется в CRM", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  let sent = false;
  const ai = { enabled: true, chatText: async () => { sent = true; return "Ответ клиенту"; } };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => { sent = true; return { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }; },
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveGreenApi({
    type: "incoming", phone: "996700111222", name: "Свой человек",
    typeMessage: "textMessage", text: "Привет, как дела?", messageId: "wa-1",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent, false, "автоответ не должен был вызваться для своего контакта");
  const conversation = crm.listConversations().find((c) => c.externalChatId === "996700111222");
  assert.ok(conversation, "диалог всё равно должен быть виден в CRM");
  const messages = crm.getConversation(conversation.id).messages;
  assert.equal(messages.length, 1, "входящее сообщение сохранено");
  assert.equal(messages[0].text, "Привет, как дела?");
});

test("обычный клиент (номер не в списке) получает автоответ как раньше", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  let sentText = null;
  const ai = { enabled: true, chatText: async () => { sentText = "Ответ клиенту"; return sentText; } };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }),
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveGreenApi({
    type: "incoming", phone: "996700999888", name: "Обычный клиент",
    typeMessage: "textMessage", text: "Сколько стоит iPhone?", messageId: "wa-2",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sentText, "Ответ клиенту", "для обычного клиента автоответ должен сработать");
});

test("свой контакт по telegram username не получает автоответ", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });
  let sent = false;
  const ai = { enabled: true, chatText: async () => { sent = true; return "Ответ"; } };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => { return { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }; },
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveTelegram({
    message_id: 1, date: 1_700_000_000, text: "Красавчик, как продажи?",
    chat: { id: 5001, type: "private" }, from: { id: 5001, first_name: "Рамазан", username: "ramazan_marketer" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent, false);
  const conversation = crm.listConversations().find((c) => c.externalChatId === "5001");
  assert.ok(conversation);
});

test("свой контакт распознаётся по имени профиля, даже без номера/юзернейма в списке", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });
  let sent = false;
  const ai = { enabled: true, chatText: async () => { sent = true; return "Ответ"; } };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }),
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveTelegram({
    message_id: 1, date: 1_700_000_000, text: "Го, что нового",
    chat: { id: 5002, type: "private" }, from: { id: 5002, first_name: "Абдурахман", last_name: "Ниязов" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent, false, "имя «Абдурахман» есть в списке — автоответ не должен уйти");
});

test("похожее, но не совпадающее слово в имени не считается своим контактом (сравнение по словам, не по подстроке)", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });
  let sent = false;
  const ai = { enabled: true, chatText: async () => { sent = true; return "Ответ"; } };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }),
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveTelegram({
    message_id: 1, date: 1_700_000_000, text: "Сколько стоит iPhone 17?",
    chat: { id: 5003, type: "private" }, from: { id: 5003, first_name: "Абдурахманова", last_name: "Клиентка" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent, true, "«Абдурахманова» — другое слово, не должно совпасть с «Абдурахман» в списке");
});
