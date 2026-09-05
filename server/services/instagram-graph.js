"use strict";

// Instagram Direct через официальный Meta Graph API — конкретно "Instagram
// API with Instagram Login" (Business Login), без обязательной привязки
// Facebook Page. Один магазин — одно подключение (см. схему
// instagram_integration в migrations.js, 022_instagram_integration),
// поэтому здесь нет organizationId и прочего мультитенантного слоя.
//
// Три разных хоста — не перепутать (подтверждено официальной документацией
// Meta по состоянию на 2026):
//   www.instagram.com/oauth/authorize — редирект пользователя на авторизацию
//   api.instagram.com/oauth/access_token — обмен code → короткоживущий токен
//   graph.instagram.com — обмен на долгоживущий токен (60 дней) + сам Send API

const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");

// Права, которые реально нужны боту: базовый доступ к аккаунту + чтение и
// отправка Direct-сообщений. Ничего лишнего (публикация постов, комментарии
// и т.п.) — каждый лишний scope это отдельный пункт в App Review.
const OAUTH_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"];

const STATE_TTL_MINUTES = 10;
const LONG_LIVED_TOKEN_TTL_DAYS = 60;
// Meta продлевает токен, только если до истечения осталось не меньше суток —
// обновляем заранее, а не в последний момент.
const TOKEN_REFRESH_MARGIN_DAYS = 5;

class InstagramApiError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = "InstagramApiError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function requireConfigured() {
  if (!config.features.instagramDirect) {
    throw new InstagramApiError(
      "INSTAGRAM_NOT_CONNECTED",
      "Instagram Direct не настроен: заданы не все переменные окружения (META_APP_ID/META_APP_SECRET/META_REDIRECT_URI/META_TOKEN_ENCRYPTION_KEY)"
    );
  }
}

// ── Шифрование access token в базе (AES-256-GCM) ──────────────────────────
// Формат хранения: base64(iv[12] + authTag[16] + ciphertext). Ключ — 32
// байта в hex в META_TOKEN_ENCRYPTION_KEY (сгенерировать: `openssl rand -hex 32`).
function encryptionKey() {
  const hex = String(config.meta.tokenEncryptionKey || "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new InstagramApiError("INSTAGRAM_NOT_CONNECTED", "META_TOKEN_ENCRYPTION_KEY должен быть 32 байта в hex (64 символа)");
  }
  return Buffer.from(hex, "hex");
}

function encryptToken(plainText) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptToken(encoded) {
  const key = encryptionKey();
  const raw = Buffer.from(String(encoded), "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ── OAuth state (CSRF) ─────────────────────────────────────────────────────
// Криптографически случайный, одноразовый, с TTL — хранится в БД (не в
// памяти процесса), чтобы пережить рестарт деплоя между /connect и /callback.
function createOAuthState(db) {
  requireConfigured();
  const state = crypto.randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO instagram_oauth_states (state, expires_at) VALUES (?, datetime('now', '+${STATE_TTL_MINUTES} minutes'))`
  ).run(state);
  return state;
}

// Одноразовый: помечает state использованным даже при провале дальнейшего
// обмена токена — повторно подставить тот же state в другой callback нельзя.
function consumeOAuthState(db, state) {
  if (!state) return false;
  const row = db.prepare(
    `SELECT state FROM instagram_oauth_states WHERE state = ? AND consumed_at IS NULL AND expires_at > datetime('now')`
  ).get(String(state));
  if (!row) return false;
  db.prepare(`UPDATE instagram_oauth_states SET consumed_at = datetime('now') WHERE state = ?`).run(String(state));
  return true;
}

function buildAuthorizeUrl(state) {
  requireConfigured();
  const url = new URL("/oauth/authorize", config.meta.authBaseUrl);
  url.searchParams.set("client_id", config.meta.appId);
  url.searchParams.set("redirect_uri", config.meta.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

// ── Обмен code → токен ──────────────────────────────────────────────────
async function exchangeCodeForShortLivedToken(code, fetchImpl = fetch) {
  requireConfigured();
  const body = new URLSearchParams({
    client_id: config.meta.appId,
    client_secret: config.meta.appSecret,
    grant_type: "authorization_code",
    redirect_uri: config.meta.redirectUri,
    code: String(code || ""),
  });
  let res;
  try {
    res = await fetchImpl(`${config.meta.tokenBaseUrl}/oauth/access_token`, { method: "POST", body });
  } catch (error) {
    throw new InstagramApiError("INSTAGRAM_API_ERROR", `Сеть недоступна при обмене code на токен: ${error.message}`, { cause: error });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new InstagramApiError("INSTAGRAM_AUTH_FAILED", data?.error_message || `Meta отклонила обмен code на токен (HTTP ${res.status})`, { status: res.status });
  }
  return { accessToken: data.access_token, userId: String(data.user_id) };
}

async function exchangeForLongLivedToken(shortLivedToken, fetchImpl = fetch) {
  requireConfigured();
  const url = new URL("/access_token", config.meta.graphBaseUrl);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", config.meta.appSecret);
  url.searchParams.set("access_token", shortLivedToken);
  let res;
  try {
    res = await fetchImpl(url.toString());
  } catch (error) {
    throw new InstagramApiError("INSTAGRAM_API_ERROR", `Сеть недоступна при обмене на долгоживущий токен: ${error.message}`, { cause: error });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new InstagramApiError("INSTAGRAM_AUTH_FAILED", data?.error?.message || `Meta отклонила обмен на долгоживущий токен (HTTP ${res.status})`, { status: res.status });
  }
  return { accessToken: data.access_token, expiresInSeconds: Number(data.expires_in) || LONG_LIVED_TOKEN_TTL_DAYS * 86400 };
}

async function fetchAccountInfo(accessToken, userId, fetchImpl = fetch) {
  const url = new URL(`/${userId}`, config.meta.graphBaseUrl);
  url.searchParams.set("fields", "user_id,username");
  url.searchParams.set("access_token", accessToken);
  let res;
  try {
    res = await fetchImpl(url.toString());
  } catch (error) {
    throw new InstagramApiError("INSTAGRAM_API_ERROR", `Сеть недоступна при запросе данных аккаунта: ${error.message}`, { cause: error });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new InstagramApiError("INSTAGRAM_API_ERROR", data?.error?.message || `Meta не отдала данные аккаунта (HTTP ${res.status})`, { status: res.status });
  }
  return { username: data?.username || null };
}

// ── Отправка сообщения (Send API) ──────────────────────────────────────
async function sendDirectMessage({ accessToken, igUserId, recipientId, text }, fetchImpl = fetch) {
  const url = new URL(`/${igUserId}/messages`, config.meta.graphBaseUrl);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: String(text || "").slice(0, 1000) } }),
    });
  } catch (error) {
    throw new InstagramApiError("INSTAGRAM_API_ERROR", `Сеть недоступна при отправке сообщения: ${error.message}`, { cause: error });
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return { messageId: data?.message_id || null };
  const metaCode = data?.error?.code;
  const metaSubcode = data?.error?.error_subcode;
  // Коды Meta для истёкшего/отозванного токена и лимита запросов — по
  // официальной документации error codes Graph API.
  if (metaCode === 190) {
    throw new InstagramApiError(metaSubcode === 460 ? "INSTAGRAM_TOKEN_REVOKED" : "INSTAGRAM_TOKEN_EXPIRED", data?.error?.message || "Токен недействителен", { status: res.status });
  }
  if (metaCode === 10 || metaCode === 200) {
    throw new InstagramApiError("INSTAGRAM_PERMISSION_DENIED", data?.error?.message || "Недостаточно прав (permission denied)", { status: res.status });
  }
  if (metaCode === 4 || metaCode === 32 || metaCode === 613 || res.status === 429) {
    throw new InstagramApiError("INSTAGRAM_RATE_LIMIT", data?.error?.message || "Превышен лимит запросов Instagram Messaging API", { status: res.status });
  }
  throw new InstagramApiError("INSTAGRAM_API_ERROR", data?.error?.message || `Instagram API вернул ошибку (HTTP ${res.status})`, { status: res.status });
}

// ── Webhook: подпись и верификация подписки ────────────────────────────
// Meta подписывает тело запроса заголовком X-Hub-Signature-256:
// "sha256=" + HMAC-SHA256(appSecret, rawBody). Без rawBody (после того как
// express.json() уже распарсил и переформатировал тело) подпись не сойдётся
// даже для настоящего запроса — поэтому подпись всегда проверяется по
// точным байтам, которые пришли по сети (см. req.rawBody в webhook-роуте).
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.meta.appSecret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", config.meta.appSecret).update(rawBody).digest("hex");
  const provided = String(signatureHeader).replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhookSubscription(query) {
  if (query?.["hub.verify_token"] !== config.meta.webhookVerifyToken) return null;
  return query?.["hub.challenge"] || null;
}

module.exports = {
  InstagramApiError,
  OAUTH_SCOPES,
  TOKEN_REFRESH_MARGIN_DAYS,
  requireConfigured,
  encryptToken,
  decryptToken,
  createOAuthState,
  consumeOAuthState,
  buildAuthorizeUrl,
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
  fetchAccountInfo,
  sendDirectMessage,
  verifyWebhookSignature,
  verifyWebhookSubscription,
};
