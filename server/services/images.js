// Проверка внешних изображений перед сохранением в базу.
// Файлы к себе не скачиваем — храним URL. Но URL обязан быть настоящей
// картинкой достаточного размера, доступной без авторизации.
const config = require("../config");
const logger = require("../logger");
const { safeFetch, readLimited, FetchGuardError } = require("../lib/safeFetch");

// Явный мусор: иконки, логотипы, спрайты, заглушки, плейсхолдеры.
const JUNK_URL = /(favicon|sprite|logo|icon|placeholder|no[-_]?image|thumb(nail)?[-_]?small|1x1|pixel|spacer)/i;
// Подписанные временные ссылки: протухнут через час-другой.
const SIGNED_URL = /[?&](x-amz-signature|x-amz-credential|signature|expires|token|sig|hmac)=/i;

// --- Размеры картинки из заголовка файла (без зависимостей) ---------------

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifSize(b) {
  if (b.length < 10 || b.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, кроме DHT(c4), JPG(c8), DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const fmt = b.toString("ascii", 12, 16);
  if (fmt === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (fmt === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fmt === "VP8X") {
    return {
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    };
  }
  return null;
}

function imageSize(buf) {
  return pngSize(buf) || jpegSize(buf) || webpSize(buf) || gifSize(buf) || null;
}

// --- Проверка одного URL --------------------------------------------------

function registrableDomain(hostname) {
  const parts = String(hostname).toLowerCase().split(".");
  return parts.slice(-2).join(".");
}

/**
 * Проверяет, что по URL лежит настоящая картинка товара.
 * Возвращает { ok, reason, width, height, contentType, bytes }.
 */
async function verifyImageUrl(rawUrl, opts = {}) {
  const {
    timeoutMs = config.images.timeoutMs,
    maxBytes = config.images.maxBytes,
    minBytes = config.images.minBytes,
    minWidth = config.images.minWidth,
    expectedDomain = null,
    fetchImpl,
  } = opts;

  if (typeof rawUrl !== "string" || !rawUrl) return { ok: false, reason: "empty_url" };
  if (!rawUrl.startsWith("https://")) return { ok: false, reason: "not_https" };
  if (JUNK_URL.test(rawUrl)) return { ok: false, reason: "looks_like_icon_or_logo" };
  if (SIGNED_URL.test(rawUrl)) return { ok: false, reason: "temporary_signed_url" };

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (expectedDomain && registrableDomain(parsed.hostname) !== registrableDomain(expectedDomain)) {
    return { ok: false, reason: "domain_mismatch" };
  }

  let res;
  try {
    // Без cookies и авторизации — картинка должна открываться анонимно.
    ({ res } = await safeFetch(rawUrl, {
      timeoutMs,
      maxBytes,
      headers: { accept: "image/*" },
      fetchImpl,
    }));
  } catch (e) {
    if (e instanceof FetchGuardError) return { ok: false, reason: e.code };
    return { ok: false, reason: "network" };
  }

  if (!res.ok) return { ok: false, reason: `http_${res.status}` };

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) return { ok: false, reason: "not_an_image" };
  if (contentType.startsWith("image/svg")) return { ok: false, reason: "svg_not_a_photo" };

  let body;
  try {
    body = await readLimited(res, maxBytes);
  } catch {
    return { ok: false, reason: "too_large" };
  }
  if (body.length < minBytes) return { ok: false, reason: "too_small_file" };

  const size = imageSize(body);
  if (size && size.width < minWidth) {
    return { ok: false, reason: "low_resolution", width: size.width, height: size.height };
  }

  return {
    ok: true,
    reason: null,
    contentType,
    bytes: body.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/**
 * Проверяет пачку кандидатов и возвращает только пригодные, сохраняя порядок.
 * Порядок = приоритет источника, его задаёт research.js.
 */
async function verifyImageUrls(urls, opts = {}) {
  const limit = opts.limit || config.images.maxPerProduct;
  const good = [];
  const rejected = [];
  for (const url of urls) {
    if (good.length >= limit) break;
    const result = await verifyImageUrl(url, opts);
    if (result.ok) good.push({ url, ...result });
    else rejected.push({ url, reason: result.reason });
  }
  if (rejected.length) logger.debug("images.rejected", { count: rejected.length, rejected });
  return { good, rejected };
}

module.exports = { verifyImageUrl, verifyImageUrls, imageSize, registrableDomain };
