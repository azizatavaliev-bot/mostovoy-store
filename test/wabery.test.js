// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.WABERY_API_KEY = "wab_live_test";
process.env.WABERY_WEBHOOK_SECRET = "wabery-webhook-secret";
process.env.WABERY_INSTAGRAM_CHANNEL_ID = "channel_test123";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const config = require("../server/config");
const { createApp } = require("../server/app");
const { CrmService } = require("../server/services/crm");
const { verifyWebhookSignature, sendTextMessage, WaberyApiError } = require("../server/services/wabery");
const { makeDb } = require("./helpers");

test("verifyWebhookSignature: верная подпись HMAC-SHA256 по сырому телу проходит, любая другая — нет", () => {
  const body = Buffer.from(JSON.stringify({ event: "message.received", payload: {} }));
  const valid = "sha256=" + crypto.createHmac("sha256", config.wabery.webhookSecret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, valid), true);
  assert.equal(verifyWebhookSignature(body, "sha256=" + "0".repeat(64)), false);
  assert.equal(verifyWebhookSignature(body, null), false);
});

test("sendTextMessage: POST /messages с правильным телом, успешный ответ разбирается", async () => {
  let capturedUrl = null;
  let capturedBody = null;
  let capturedAuth = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    capturedAuth = init.headers.authorization;
    return { ok: true, status: 202, json: async () => ({ id: "msg_1", status: "queued" }) };
  };
  const result = await sendTextMessage({ conversationId: "conversation_42", text: "Здравствуйте!" }, fetchImpl);
  assert.equal(capturedUrl, "https://api.wabery.com/v1/messages");
  assert.deepEqual(capturedBody, { channel_id: "channel_test123", conversation_id: "conversation_42", text: "Здравствуйте!" });
  assert.equal(capturedAuth, "Bearer wab_live_test");
  assert.deepEqual(result, { messageId: "msg_1", status: "queued" });
});

test("sendTextMessage: 429 message_pair_rate_limit превращается в INSTAGRAM_RATE_LIMIT", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: "message_pair_rate_limit", message: "слишком часто", retry_after: 4 }),
  });
  await assert.rejects(
    () => sendTextMessage({ conversationId: "c1", text: "привет" }, fetchImpl),
    (error) => {
      assert.ok(error instanceof WaberyApiError);
      assert.equal(error.code, "INSTAGRAM_RATE_LIMIT");
      return true;
    }
  );
});

// ── Маршрут вебхука ─────────────────────────────────────────────────────

async function startTestApp(overrides = {}) {
  const db = makeDb();
  const crm = overrides.crm || new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  const app = createApp({ db, crm, deepseek: { enabled: false } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, crm, server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function signedRequest(payload) {
  const body = JSON.stringify(payload);
  const signature = "sha256=" + crypto.createHmac("sha256", config.wabery.webhookSecret).update(body).digest("hex");
  return { body, headers: { "content-type": "application/json", "x-wabery-signature": signature } };
}

test("POST /api/webhooks/wabery — без подписи 401, с подписью доходит до crm.receiveWabery", async (t) => {
  let received = null;
  const crm = { receiveWabery: async (event) => { received = event; return { ok: true }; } };
  const { base, close } = await startTestApp({ crm });
  t.after(close);

  const payload = {
    event: "message.received",
    payload: {
      channel_id: "channel_test123",
      conversation_id: "conversation_777",
      message_id: "msg_abc",
      text: "Здравствуйте, какие Apple Watch есть?",
      username: "client_ig",
    },
    sentAt: "2026-09-01T10:00:00.000Z",
  };
  const { body, headers } = signedRequest(payload);

  const unsigned = await fetch(`${base}/api/webhooks/wabery`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal(unsigned.status, 401);
  assert.equal(received, null);

  const signed = await fetch(`${base}/api/webhooks/wabery`, { method: "POST", headers, body });
  assert.equal(signed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, {
    conversationId: "conversation_777",
    text: "Здравствуйте, какие Apple Watch есть?",
    messageId: "msg_abc",
    username: "client_ig",
  });
});

test("POST /api/webhooks/wabery — событие с чужого channel_id игнорируется", async (t) => {
  let calls = 0;
  const crm = { receiveWabery: async () => { calls += 1; } };
  const { base, close } = await startTestApp({ crm });
  t.after(close);

  const payload = {
    event: "message.received",
    payload: { channel_id: "channel_другой_магазин", conversation_id: "c1", message_id: "m1", text: "привет" },
  };
  const { body, headers } = signedRequest(payload);
  await fetch(`${base}/api/webhooks/wabery`, { method: "POST", headers, body });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("POST /api/webhooks/wabery — событие не message.received игнорируется", async (t) => {
  let calls = 0;
  const crm = { receiveWabery: async () => { calls += 1; } };
  const { base, close } = await startTestApp({ crm });
  t.after(close);

  const payload = { event: "message.status", payload: { channel_id: "channel_test123" } };
  const { body, headers } = signedRequest(payload);
  await fetch(`${base}/api/webhooks/wabery`, { method: "POST", headers, body });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);
});

test("receiveWabery: заводит диалог с source=wabery_instagram и запускает обычный автоответ", async (t) => {
  const db = makeDb();
  t.after(() => db.close());
  let sentText = null;
  const crm = new CrmService({
    db,
    ai: { enabled: true, chatText: async () => "Здравствуйте! Чем могу помочь?" },
    amocrm: { enabled: false },
    autoReplyDebounceMs: 0,
    fetchImpl: async (url, init) => {
      if (String(url).includes("api.wabery.com") && init) sentText = JSON.parse(init.body).text;
      return { ok: true, status: 202, json: async () => ({ id: "msg_1", status: "queued" }) };
    },
  });
  crm.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });

  await crm.receiveWabery({ conversationId: "conv_1", text: "Здравствуйте", messageId: "m1", username: "client" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const conversation = crm.listConversations().find((c) => c.externalChatId === "conv_1");
  assert.ok(conversation, "диалог должен завестись");
  assert.equal(conversation.source, "wabery_instagram");
});
