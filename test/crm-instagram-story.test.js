// Интеграция StoryResolver с основным пайплайном (_augmentWithInstagramStory,
// см. server/services/crm.js). Сам резолвер и его части уже покрыты отдельно
// (test/instagram-*.test.js) — здесь только точка стыковки с тремя каналами.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const config = require("../server/config");
const { CrmService } = require("../server/services/crm");

const STORY_URL = "https://www.instagram.com/stories/mostovoyshop/3712345678901234567/";

const okFetch = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) });

function fakeAiText(reply = "Обычный ответ бота.") {
  return { enabled: true, chatText: async () => reply, chatJson: async () => ({ template_id: null }) };
}

test("Telegram: ссылка на Story в тексте — контекст резолвится и уходит в историю для ИИ", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });

  let historySeenByAi = null;
  const ai = { enabled: true, chatText: async ({ messages }) => { historySeenByAi = messages; return "Вы про эти чёрные очки?"; }, chatJson: async () => ({ template_id: null }) };
  const storyResolver = {
    enabled: true,
    resolve: async (url) => {
      assert.equal(url, STORY_URL);
      return {
        ok: true, cached: false,
        analysis: { summary: "чёрные очки", products_visible: [{ name_guess: "чёрные очки", category: "очки", brand: null, model: null, confidence: 0.9 }], visible_text: [], important_details: [], contains_product: true },
        catalogMatches: [],
      };
    },
  };
  const crm = new CrmService({ db, ai, amocrm: { enabled: false }, storyResolver, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  const msg = { date: 1_700_000_000, chat: { id: 501, type: "private" }, from: { id: 501, first_name: "Клиент" } };
  await crm.receiveTelegram({ ...msg, message_id: 1, text: "Привет" });
  await crm.receiveTelegram({ ...msg, message_id: 2, text: `Это есть? ${STORY_URL}` });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = crm.getConversation(crm.listConversations()[0].id);
  const storedIncoming = detail.messages.find((m) => m.direction === "incoming" && m.text.includes(STORY_URL));
  assert.match(storedIncoming.text, /\[Instagram Story\]/);
  assert.match(storedIncoming.text, /чёрные очки/);

  assert.ok(historySeenByAi.some((m) => m.role === "user" && m.content.includes("[Instagram Story]")), "основной AI-менеджер должен увидеть контекст Story в истории");
});

test("Telegram: Story недоступна — в контексте честный fallback, без выдумывания содержимого", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });

  const storyResolver = { enabled: true, resolve: async () => ({ ok: false, story_analysis_failed: true, reason: "story_unavailable" }) };
  const crm = new CrmService({ db, ai: fakeAiText(), amocrm: { enabled: false }, storyResolver, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  const msg = { date: 1_700_000_000, chat: { id: 502, type: "private" }, from: { id: 502, first_name: "Клиент" } };
  await crm.receiveTelegram({ ...msg, message_id: 1, text: "Привет" });
  await crm.receiveTelegram({ ...msg, message_id: 2, text: STORY_URL });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = crm.getConversation(crm.listConversations()[0].id);
  const stored = detail.messages.find((m) => m.direction === "incoming" && m.text.includes(STORY_URL));
  assert.match(stored.text, /\[Instagram Story\]/);
  assert.match(stored.text, /не удалось/);
});

test("без storyResolver (фича выключена) текст сообщения не трогается — поведение как раньше", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });

  const crm = new CrmService({ db, ai: fakeAiText(), amocrm: { enabled: false }, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  const msg = { date: 1_700_000_000, chat: { id: 503, type: "private" }, from: { id: 503, first_name: "Клиент" } };
  await crm.receiveTelegram({ ...msg, message_id: 1, text: "Привет" });
  await crm.receiveTelegram({ ...msg, message_id: 2, text: STORY_URL });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = crm.getConversation(crm.listConversations()[0].id);
  const stored = detail.messages.find((m) => m.direction === "incoming" && m.text.includes(STORY_URL));
  assert.equal(stored.text, STORY_URL);
});

test("amoCRM (канал Instagram): ссылка на Story в входящем сообщении тоже резолвится", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const storyResolver = {
    enabled: true,
    resolve: async () => ({ ok: true, cached: false, analysis: { summary: "тест из Instagram", products_visible: [], visible_text: [], important_details: [], contains_product: false }, catalogMatches: [] }),
  };
  const crm = new CrmService({ db, ai: fakeAiText(), amocrm: { enabled: true, sendMessage: async () => {} }, storyResolver, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  await crm.receiveAmo({
    text: `Что это? ${STORY_URL}`,
    direction: "incoming",
    chatId: "ig-chat-1",
    messageId: "ig-msg-1",
    leadId: "701",
    source: "instagram",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = crm.getConversation(crm.listConversations()[0].id);
  const stored = detail.messages.find((m) => m.direction === "incoming");
  assert.match(stored.text, /\[Instagram Story\]/);
  assert.match(stored.text, /тест из Instagram/);
});

test("неожиданное падение storyResolver.resolve (не graceful-ошибка) не ломает обработку сообщения", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });

  const storyResolver = { enabled: true, resolve: async () => { throw new Error("неожиданный краш резолвера"); } };
  const crm = new CrmService({ db, ai: fakeAiText(), amocrm: { enabled: false }, storyResolver, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  const msg = { date: 1_700_000_000, chat: { id: 504, type: "private" }, from: { id: 504, first_name: "Клиент" } };
  await crm.receiveTelegram({ ...msg, message_id: 1, text: "Привет" });
  // Не должно бросить исключение наружу и уронить приём сообщения.
  await assert.doesNotReject(() => crm.receiveTelegram({ ...msg, message_id: 2, text: STORY_URL }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = crm.getConversation(crm.listConversations()[0].id);
  const stored = detail.messages.find((m) => m.direction === "incoming" && m.text.includes(STORY_URL));
  assert.match(stored.text, /\[Instagram Story\]/, "даже на неожиданный краш должен подставиться честный fallback-контекст");
});

test("сообщение без ссылки на Story не резолвится, даже если storyResolver настроен", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });

  let called = false;
  const storyResolver = { enabled: true, resolve: async () => { called = true; } };
  const crm = new CrmService({ db, ai: fakeAiText(), amocrm: { enabled: false }, storyResolver, fetchImpl: okFetch, autoReplyDebounceMs: 0 });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false });

  const msg = { date: 1_700_000_000, chat: { id: 505, type: "private" }, from: { id: 505, first_name: "Клиент" } };
  await crm.receiveTelegram({ ...msg, message_id: 1, text: "Привет" });
  await crm.receiveTelegram({ ...msg, message_id: 2, text: "Есть iPhone 17?" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(called, false);
});
