"use strict";

// Wabery (wabery.com) — единый API для WhatsApp/Instagram/Messenger. Мы
// используем его только для Instagram Direct: Wabery уже прошли Meta App
// Review своим приложением, нам остаётся только слать/принимать сообщения
// через их REST API + вебхук. См. docs/wabery-instagram-setup.md для
// пошаговой настройки в их дашборде.
//
// Схема подтверждена официальной OpenAPI-спекой (https://api.wabery.com/v1/openapi.json)
// и страницами /docs/sending-messages/, /docs/webhooks/ по состоянию на 2026.

const crypto = require("crypto");
const config = require("../config");

class WaberyApiError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = "WaberyApiError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function requireConfigured() {
  if (!config.features.waberyInstagram) {
    throw new WaberyApiError(
      "INSTAGRAM_NOT_CONNECTED",
      "Wabery не настроен: заданы не все переменные окружения (WABERY_API_KEY/WABERY_WEBHOOK_SECRET/WABERY_INSTAGRAM_CHANNEL_ID)"
    );
  }
}

// Подпись вебхука: заголовок x-wabery-signature вида "sha256=<hex>",
// HMAC-SHA256 по СЫРОМУ телу запроса (см. verify в app.js — req.rawBody).
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.wabery.webhookSecret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", config.wabery.webhookSecret).update(rawBody).digest("hex");
  const provided = String(signatureHeader).replace(/^sha256=/, "");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Отправка обычного текстового сообщения в рамках уже открытой переписки
// (conversation_id, а не "to" — то есть отвечаем клиенту, который уже
// написал первым; исходящий broadcast Wabery поддерживает отдельно, но
// боту он не нужен).
async function sendTextMessage({ conversationId, text }, fetchImpl = fetch) {
  requireConfigured();
  let res;
  try {
    res = await fetchImpl(`${config.wabery.apiBaseUrl}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.wabery.apiKey}` },
      body: JSON.stringify({
        channel_id: config.wabery.instagramChannelId,
        conversation_id: conversationId,
        text: String(text || "").slice(0, 1000),
      }),
    });
  } catch (error) {
    throw new WaberyApiError("INSTAGRAM_API_ERROR", `Сеть недоступна при отправке через Wabery: ${error.message}`, { cause: error });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 429 || data?.error === "message_pair_rate_limit") {
    throw new WaberyApiError("INSTAGRAM_RATE_LIMIT", data?.message || "Wabery: превышен лимит сообщений этому получателю", { status: res.status });
  }
  if (!res.ok) {
    const code = /token|auth/i.test(String(data?.error || "")) ? "INSTAGRAM_TOKEN_REVOKED" : "INSTAGRAM_API_ERROR";
    throw new WaberyApiError(code, data?.message || data?.error || `Wabery вернул ошибку (HTTP ${res.status})`, { status: res.status });
  }
  return { messageId: data?.id || null, status: data?.status || null };
}

module.exports = { WaberyApiError, requireConfigured, verifyWebhookSignature, sendTextMessage };
