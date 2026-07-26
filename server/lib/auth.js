// Пароль и сессии админки. Без внешних библиотек — всё на node:crypto.
//
// Пароль: scrypt (параметры по умолчанию в Node — N=16384, r=8, p=1,
// это и есть текущая рекомендация OWASP для scrypt) + случайная соль
// на установку. В .env хранится только хеш, не пароль.
//
// Сессия: HMAC-подписанный токен без состояния на сервере (переживает
// рестарт, не требует таблицы/Map с сессиями). Токен — это payload +
// подпись, обе части base64url; подделать без SESSION_SECRET нельзя,
// подобрать payload задним числом бессмысленно — exp проверяется всегда.
const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// --- Пароль -----------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

// Timing-safe: длина сравнения не зависит от того, где строки разошлись.
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- Сессии -------------------------------------------------------------

function sign(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest();
}

function createSession(secret, ttlMs) {
  const payload = JSON.stringify({ iat: Date.now(), exp: Date.now() + ttlMs });
  const body = b64url(payload);
  const sig = b64url(sign(body, secret));
  return `${body}.${sig}`;
}

function verifySession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expectedSig = b64url(sign(body, secret));
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

// --- Защита от подбора пароля -------------------------------------------
// В памяти, на процесс: для админки одного владельца этого достаточно —
// рестарт сервера снимает блокировку, но и трафика на такой инструмент
// извне почти нет. Считаем неудачные попытки по IP.

class LoginThrottle {
  constructor({ maxAttempts = 5, windowMs = 10 * 60 * 1000, lockMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.byIp = new Map();
  }

  // Бросить исключение вместо булева — вызывающему коду нечего делать,
  // кроме как сразу отдать 429.
  check(ip) {
    const rec = this.byIp.get(ip);
    if (!rec) return;
    if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
      const retryAfterSec = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
      const err = new Error("Слишком много попыток входа. Попробуйте позже.");
      err.retryAfterSec = retryAfterSec;
      throw err;
    }
  }

  recordFailure(ip) {
    const now = Date.now();
    const rec = this.byIp.get(ip) || { count: 0, firstAt: now };
    if (now - rec.firstAt > this.windowMs) {
      rec.count = 0;
      rec.firstAt = now;
    }
    rec.count++;
    if (rec.count >= this.maxAttempts) rec.lockedUntil = now + this.lockMs;
    this.byIp.set(ip, rec);
  }

  recordSuccess(ip) {
    this.byIp.delete(ip);
  }
}

module.exports = { hashPassword, verifyPassword, createSession, verifySession, LoginThrottle };
