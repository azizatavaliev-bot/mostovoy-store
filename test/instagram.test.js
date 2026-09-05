// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.META_APP_ID = "test-app-id";
process.env.META_APP_SECRET = "test-app-secret";
process.env.META_REDIRECT_URI = "https://example.com/api/admin/crm/instagram/callback";
process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-me";
process.env.META_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
process.env.ADMIN_TOKEN = "admin-test-token";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const config = require("../server/config");
const { createApp } = require("../server/app");
const { CrmService } = require("../server/services/crm");
const {
  encryptToken,
  decryptToken,
  createOAuthState,
  consumeOAuthState,
  buildAuthorizeUrl,
  verifyWebhookSignature,
  verifyWebhookSubscription,
  InstagramApiError,
} = require("../server/services/instagram-graph");
const { makeDb } = require("./helpers");

test("encryptToken/decryptToken — обратимо, и ciphertext не содержит исходный токен", () => {
  const token = "IGQVJ-secret-access-token";
  const encrypted = encryptToken(token);
  assert.ok(!encrypted.includes(token));
  assert.equal(decryptToken(encrypted), token);
});

test("buildAuthorizeUrl собирает корректный OAuth URL с нужными scope и state", () => {
  const url = new URL(buildAuthorizeUrl("state-123"));
  assert.equal(url.origin, "https://www.instagram.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "test-app-id");
  assert.equal(url.searchParams.get("redirect_uri"), config.meta.redirectUri);
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.match(url.searchParams.get("scope"), /instagram_business_manage_messages/);
});

test("OAuth state: одноразовый, с TTL — второй раз тот же state не проходит", (t) => {
  const db = makeDb();
  t.after(() => db.close());
  const state = createOAuthState(db);
  assert.equal(consumeOAuthState(db, state), true, "первый раз — валиден");
  assert.equal(consumeOAuthState(db, state), false, "повторное использование того же state отклоняется");
  assert.equal(consumeOAuthState(db, "выдуманный-state"), false, "случайный state не проходит");
});

test("verifyWebhookSignature: верная подпись проходит, любое изменение байта — нет", () => {
  const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const validSignature = "sha256=" + crypto.createHmac("sha256", config.meta.appSecret).update(body).digest("hex");
  assert.equal(verifyWebhookSignature(body, validSignature), true);
  assert.equal(verifyWebhookSignature(body, "sha256=" + "0".repeat(64)), false);
  assert.equal(verifyWebhookSignature(body, null), false);
  const tampered = Buffer.from(JSON.stringify({ object: "instagram", entry: [{ fake: true }] }));
  assert.equal(verifyWebhookSignature(tampered, validSignature), false);
});

test("verifyWebhookSubscription: верный verify_token отдаёт challenge, неверный — null", () => {
  assert.equal(verifyWebhookSubscription({ "hub.verify_token": "verify-me", "hub.challenge": "42" }), "42");
  assert.equal(verifyWebhookSubscription({ "hub.verify_token": "wrong", "hub.challenge": "42" }), null);
});

test("InstagramApiError несёт код ошибки для нормализованного ответа фронту", () => {
  const error = new InstagramApiError("INSTAGRAM_TOKEN_EXPIRED", "токен истёк");
  assert.equal(error.code, "INSTAGRAM_TOKEN_EXPIRED");
  assert.equal(error.message, "токен истёк");
});

// ── Маршруты ────────────────────────────────────────────────────────────

async function startTestApp(overrides = {}) {
  const db = makeDb();
  const crm = overrides.crm || new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  const app = createApp({ db, crm, deepseek: { enabled: false } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, crm, server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("GET /api/webhooks/instagram — подписка Meta: верный verify_token отдаёт challenge, неверный — 403", async (t) => {
  const { base, close } = await startTestApp();
  t.after(close);

  const ok = await fetch(`${base}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=hello`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "hello");

  const denied = await fetch(`${base}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello`);
  assert.equal(denied.status, 403);
});

test("POST /api/webhooks/instagram — без верной подписи 401, с верной подписью сообщение доходит до crm.receiveInstagramDirect", async (t) => {
  let received = null;
  const crm = { receiveInstagramDirect: async (event) => { received = event; return { ok: true }; } };
  const { base, close } = await startTestApp({ crm });
  t.after(close);

  const payload = {
    object: "instagram",
    entry: [{
      id: "17841400000000000",
      time: 1_700_000_000,
      messaging: [{
        sender: { id: "978239761327698" },
        recipient: { id: "17841400000000000" },
        timestamp: 1_700_000_000,
        message: { mid: "mid-1", text: "Здравствуйте, есть в наличии iPhone?" },
      }],
    }],
  };
  const body = JSON.stringify(payload);
  const signature = "sha256=" + crypto.createHmac("sha256", config.meta.appSecret).update(body).digest("hex");

  const unsigned = await fetch(`${base}/api/webhooks/instagram`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(unsigned.status, 401);
  assert.equal(received, null);

  const signed = await fetch(`${base}/api/webhooks/instagram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body,
  });
  assert.equal(signed.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, { senderId: "978239761327698", text: "Здравствуйте, есть в наличии iPhone?", messageId: "mid-1" });
});

test("POST /api/webhooks/instagram — повтор того же message id (mid) обрабатывается только один раз", async (t) => {
  let callCount = 0;
  const crm = { receiveInstagramDirect: async () => { callCount += 1; return { ok: true }; } };
  const { base, close } = await startTestApp({ crm });
  t.after(close);

  const payload = {
    object: "instagram",
    entry: [{ id: "acc", time: 1, messaging: [{ sender: { id: "u1" }, recipient: { id: "acc" }, timestamp: 1, message: { mid: "dup-mid", text: "Привет" } }] }],
  };
  const body = JSON.stringify(payload);
  const signature = "sha256=" + crypto.createHmac("sha256", config.meta.appSecret).update(body).digest("hex");
  const headers = { "content-type": "application/json", "x-hub-signature-256": signature };

  await fetch(`${base}/api/webhooks/instagram`, { method: "POST", headers, body });
  await fetch(`${base}/api/webhooks/instagram`, { method: "POST", headers, body });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(callCount, 1, "второй вебхук с тем же mid не должен снова дойти до crm");
});

test("админ-эндпоинты Instagram: без токена 401, со статусом «не подключён» по умолчанию", async (t) => {
  const { base, close } = await startTestApp();
  t.after(close);

  const deniedStatus = await fetch(`${base}/api/admin/crm/instagram/status`);
  assert.equal(deniedStatus.status, 401);

  const status = await fetch(`${base}/api/admin/crm/instagram/status`, { headers: { "x-admin-token": "admin-test-token" } });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.connected, false);
  assert.equal(body.configured, true);
});

test("/connect отдаёт ссылку на www.instagram.com/oauth/authorize с валидным state", async (t) => {
  const { base, close } = await startTestApp();
  t.after(close);
  const res = await fetch(`${base}/api/admin/crm/instagram/connect`, {
    method: "POST",
    headers: { "x-admin-token": "admin-test-token" },
  });
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.match(url, /^https:\/\/www\.instagram\.com\/oauth\/authorize\?/);
});

test("/callback с несуществующим state возвращает страницу с ошибкой, а не падает 500", async (t) => {
  const { base, close } = await startTestApp();
  t.after(close);
  const res = await fetch(`${base}/api/admin/crm/instagram/callback?code=abc&state=выдуманный`, {
    headers: { "x-admin-token": "admin-test-token" },
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /Не удалось подключить|state/i);
});

test("/callback работает БЕЗ admin-токена и без сессионной cookie — сюда Meta редиректит голый браузер клиента", async (t) => {
  // Найдено на проде: колбэк раньше жил внутри createCrmAdminRoutes и получал
  // requireAdmin автоматически — реальное подключение падало с
  // {"error":"unauthorized"}, потому что браузер клиента, пришедший от Meta,
  // не залогинен в /admin.html и не может нести x-admin-token.
  const { base, close } = await startTestApp();
  t.after(close);
  const res = await fetch(`${base}/api/admin/crm/instagram/callback?code=abc&state=выдуманный`);
  assert.notEqual(res.status, 401, "колбэк не должен требовать админскую авторизацию");
  assert.equal(res.status, 400, "невалидный state всё равно должен корректно отклоняться");
});
