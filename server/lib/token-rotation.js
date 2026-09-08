"use strict";

// Общая проверка межсервисных секретов с поддержкой ротации без даунтайма —
// см. docs/ROTATION.md. Каждый секрет может временно иметь два действующих
// значения: текущее (<NAME>) и следующее (<NAME>_NEXT), принимаются оба,
// пока кто-то не переключит отправителя и не уберёт старое значение.
// Все сравнения — constant-time (crypto.timingSafeEqual), как и раньше.

const crypto = require("crypto");

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ""), "utf8");
  const bufB = Buffer.from(String(b ?? ""), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Для секретов, сравниваемых напрямую (Bearer-токен, x-webhook-secret и т.п.).
function matchesCurrentOrNext(supplied, current, next) {
  if (!supplied) return false;
  if (current && timingSafeEqualStr(supplied, current)) return true;
  if (next && timingSafeEqualStr(supplied, next)) return true;
  return false;
}

// Для подписей вида HMAC-SHA256(secret, rawBody) в hex (Meta, Wabery) —
// та же логика ротации, но пересчитывается сама подпись под каждый секрет.
function matchesHmacCurrentOrNext(rawBody, providedHex, current, next) {
  if (!providedHex) return false;
  let providedBuf;
  try {
    providedBuf = Buffer.from(String(providedHex), "hex");
  } catch {
    return false;
  }
  return [current, next].filter(Boolean).some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
    return providedBuf.length === expected.length && crypto.timingSafeEqual(providedBuf, expected);
  });
}

module.exports = { timingSafeEqualStr, matchesCurrentOrNext, matchesHmacCurrentOrNext };
