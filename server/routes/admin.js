// Админка: ручное добавление и правка товаров — фото (URL или загрузка файлом),
// описание, цена, диапазон памяти, доступные цвета, акции. Один и тот же API
// доступен и из браузера (admin.html — вход по логину/паролю), и с терминала
// (npm run admin — по ADMIN_TOKEN), и curl'ом напрямую.
//
// Все товары, добавленные тут, попадают в ту же таблицу products и на ту же
// витрину /api/catalog, что и товары из Telegram — переиспользуется вся
// существующая бизнес-логика: ключи сопоставления, слаги, проверка фото.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const config = require("../config");
const logger = require("../logger");
const { transaction, logPriceChange } = require("../db");
const { normalizedKey, matchKey, normalizeStorage, slugify } = require("../lib/normalize");
const { GROUPS, CATEGORY_SUGGESTIONS, guessGroup } = require("../lib/groups");
const { slugForProduct } = require("../services/products");
const { verifyImageUrl } = require("../services/images");
const { verifyPassword, createSession, verifySession, LoginThrottle } = require("../lib/auth");
const { imageSize } = require("../services/images");
const { createCrmAdminRoutes } = require("./crm-admin");
const { safeFetch, readLimited, FetchGuardError } = require("../lib/safeFetch");
const { syncPublicChannelPosts } = require("../cli/import-public-channel");

const CURRENCIES = ["USD", "KGS", "RUB"];
const SESSION_COOKIE = "mostovoy_admin_session";

class AdminError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Сравнение токена без утечки времени выполнения.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Cookie без внешних зависимостей ---------------------------------------

function parseCookies(req) {
  const header = req.get("cookie") || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = req.protocol === "https" || req.get("x-forwarded-proto") === "https";
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// --- Загрузка фото файлом ---------------------------------------------------

fs.mkdirSync(config.uploads.dir, { recursive: true });

const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(EXT_BY_MIME, file.mimetype)),
});

// --- Валидация и нормализация входных данных ------------------------------

function str(v, { max = 500 } = {}) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// Принимает массив или строку "128GB, 256GB, 512GB" / построчно.
function parseStorageOptions(raw) {
  const list = Array.isArray(raw) ? raw : str(raw, { max: 2000 })?.split(/[,\n]/) || [];
  const normalized = list.map((s) => normalizeStorage(String(s).trim())).filter(Boolean);
  return [...new Set(normalized)];
}

function parseImageList(raw) {
  const list = Array.isArray(raw) ? raw : str(raw, { max: 4000 })?.split(/[,\n]/) || [];
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

function normalizeHex(hex) {
  const h = str(hex, { max: 9 });
  return h && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h) ? h : "#cccccc";
}

// Доступные цвета: [[«Чёрный», «#111111»], ...]. Принимает массив пар/объектов
// {name,hex} (из формы админки) или строку "Чёрный:#111111, Белый:#ffffff" (CLI).
function parseSwatches(raw) {
  if (raw == null || raw === "") return [];
  let list = raw;
  if (typeof raw === "string") {
    list = raw
      .split(/[,\n]/)
      .map((s) => s.split(":").map((x) => x?.trim()))
      .filter(([name]) => name);
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (Array.isArray(item)) return [str(item[0], { max: 60 }), item[1]];
      if (item && typeof item === "object") return [str(item.name, { max: 60 }), item.hex];
      return null;
    })
    .filter((pair) => pair && pair[0])
    .map(([name, hex]) => [name, normalizeHex(hex)])
    .slice(0, 12);
}

function parseDiscount(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AdminError(400, "Процент акции должен быть числом");
  if (n <= 0 || n >= 100) throw new AdminError(400, "Процент акции должен быть от 1 до 99");
  return Math.round(n * 100) / 100;
}

function validateBody(body, { partial = false } = {}) {
  const out = {};

  const name = str(body.name, { max: 200 });
  if (!partial || body.name !== undefined) {
    if (!name) throw new AdminError(400, "Название обязательно");
    out.name = name;
  }

  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new AdminError(400, "Цена должна быть положительным числом");
    out.price = price;
  }

  if (!partial || body.currency !== undefined) {
    const currency = str(body.currency)?.toUpperCase();
    if (!currency || !CURRENCIES.includes(currency)) {
      throw new AdminError(400, `Валюта должна быть одной из: ${CURRENCIES.join(", ")}`);
    }
    out.currency = currency;
  }

  if (!partial || body.brand !== undefined) out.brand = str(body.brand, { max: 80 });
  if (!partial || body.category !== undefined) out.category = str(body.category, { max: 80 });
  if (!partial || body.color !== undefined) out.color = str(body.color, { max: 60 });
  if (!partial || body.variant !== undefined) out.variant = str(body.variant, { max: 80 });
  if (!partial || body.description !== undefined) out.description = str(body.description, { max: 900 });
  if (!partial || body.available !== undefined) out.available = body.available !== false && body.available !== "false";

  if (!partial || body.storageOptions !== undefined) {
    out.storageOptions = parseStorageOptions(body.storageOptions);
  }
  if (!partial || body.image !== undefined) out.image = str(body.image, { max: 2000 });
  if (!partial || body.images !== undefined) out.images = parseImageList(body.images);

  if (!partial || body.productGroup !== undefined) {
    const g = str(body.productGroup, { max: 40 });
    if (g && !GROUPS.includes(g)) throw new AdminError(400, `Группа должна быть одной из: ${GROUPS.join(", ")}`);
    out.productGroup = g;
  }
  if (!partial || body.swatches !== undefined) out.swatches = parseSwatches(body.swatches);
  if (!partial || body.discountPercent !== undefined) out.discountPercent = parseDiscount(body.discountPercent);
  if (!partial || body.discountLabel !== undefined) out.discountLabel = str(body.discountLabel, { max: 60 });

  return out;
}

// --- Быстрое добавление по ссылке -------------------------------------------
// Разбирает страницу товара любого магазина: Open Graph / JSON-LD (schema.org
// Product) — без headless-браузера, без сторонних библиотек парсинга HTML.
// Даёт черновик (название/фото/цена), сохраняет админ уже осознанно.

function metaContent(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function metaTag(html, property) {
  const attr = String.raw`(?:property|name|itemprop)=["']${property}["']`;
  const content = `content=["']([^"']*)["']`;
  return metaContent(html, [
    new RegExp(`<meta[^>]*${attr}[^>]*${content}`, "i"),
    new RegExp(`<meta[^>]*${content}[^>]*${attr}`, "i"),
  ]);
}

function findJsonLdProduct(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
    for (const item of candidates) {
      const type = item && item["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (isProduct) return item;
    }
  }
  return null;
}

function firstOfferPrice(offers) {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer) return {};
  return { price: offer.price ?? offer.lowPrice, currency: offer.priceCurrency };
}

// --- Проверка фото перед сохранением ---------------------------------------
// Та же защита, что и для фото из Telegram-исследования: HTTPS, реальная
// картинка, не иконка, доступна без авторизации. Битые ссылки не сохраняем —
// админ узнаёт об этом сразу, а не когда на сайте вылезет пустое место.
// Загруженные через /upload файлы этой проверке не подвергаются повторно —
// они уже проверены по магическим байтам в момент загрузки.

function isLocalUpload(url) {
  return typeof url === "string" && url.startsWith("/uploads/");
}

async function verifyImages({ image, images }) {
  const warnings = [];
  let mainImage = null;
  const extraImages = [];

  if (image) {
    if (isLocalUpload(image)) {
      mainImage = image;
    } else {
      const r = await verifyImageUrl(image);
      if (!r.ok) throw new AdminError(422, `Главное фото недоступно: ${r.reason}`, { field: "image" });
      mainImage = image;
    }
  }

  for (const url of images || []) {
    if (isLocalUpload(url)) {
      extraImages.push(url);
      continue;
    }
    const r = await verifyImageUrl(url);
    if (r.ok) extraImages.push(url);
    else warnings.push(`Пропущено фото (${r.reason}): ${url}`);
  }

  return { mainImage, extraImages, warnings };
}

// --- Представление товара для админки (все поля, любой статус) ------------

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toAdminJson(row) {
  const specifications = parseJson(row.specifications, {});
  const storageOptions = specifications["Память"]
    ? String(specifications["Память"]).split(" / ")
    : row.storage
      ? [row.storage]
      : [];
  const discountPercent = row.discount_percent ?? null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.official_name,
    brand: row.brand,
    model: row.model,
    category: row.category,
    group: row.product_group,
    variant: row.variant,
    color: row.color,
    swatches: parseJson(row.swatches, []),
    price: row.price,
    currency: row.currency,
    discountPercent,
    discountLabel: row.discount_label,
    salePrice: discountPercent ? Math.round(row.price * (1 - discountPercent / 100) * 100) / 100 : null,
    available: Boolean(row.available),
    status: row.status,
    origin: row.origin,
    description: row.description,
    storageOptions,
    image: row.main_image_url,
    images: parseJson(row.image_urls, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createAdminRouter({ db, crm }) {
  const router = express.Router();
  // Свой лимитер на роутер, а не на модуль: иначе несколько createApp() в
  // одном процессе (как в тестах) делят один и тот же счётчик попыток по IP.
  const loginThrottle = new LoginThrottle();

  // Сессия — подписанный токен без состояния на сервере (переживает рестарт),
  // но это значит, что logout сам по себе токен не аннулирует — браузер просто
  // перестаёт его слать. Чтобы отозванный токен нельзя было переиспользовать
  // (например, если он утёк), держим короткий список отозванных до истечения
  // их естественного срока. Список маленький и сам себя чистит.
  const revokedSessions = new Map(); // token -> exp (ms)
  function isRevoked(token) {
    if (revokedSessions.size > 100) {
      const now = Date.now();
      for (const [t, exp] of revokedSessions) if (exp < now) revokedSessions.delete(t);
    }
    return revokedSessions.has(token);
  }
  function revoke(token, session) {
    if (token && session?.exp) revokedSessions.set(token, session.exp);
  }

  function checkSession(req) {
    const cookie = parseCookies(req)[SESSION_COOKIE];
    if (!cookie || isRevoked(cookie)) return null;
    return verifySession(cookie, config.admin.sessionSecret);
  }

  function requireAdmin(req, res, next) {
    if (!config.features.admin) {
      return res.status(503).json({ error: "admin_not_configured", message: "Задайте ADMIN_TOKEN или ADMIN_USERNAME/ADMIN_PASSWORD_HASH в .env" });
    }
    const headerToken = req.get("x-admin-token") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (config.admin.token && headerToken && safeEqual(headerToken, config.admin.token)) {
      return next();
    }
    if (config.features.adminLogin && checkSession(req)) return next();
    return res.status(401).json({ error: "unauthorized" });
  }

  // --- Вход по логину и паролю (только если настроен) -----------------
  router.post("/login", express.json(), (req, res) => {
    if (!config.features.adminLogin) {
      return res.status(503).json({ error: "login_not_configured", message: "Вход по паролю не настроен — задайте ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET" });
    }
    const ip = clientIp(req);
    try {
      loginThrottle.check(ip);
    } catch (e) {
      return res.status(429).json({ error: e.message, retryAfterSec: e.retryAfterSec });
    }

    const { username, password } = req.body || {};
    const okUser = safeEqual(String(username || ""), config.admin.username);
    const okPass = okUser && verifyPassword(String(password || ""), config.admin.passwordHash);
    if (!okUser || !okPass) {
      loginThrottle.recordFailure(ip);
      logger.warn("admin.login_failed", { ip });
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    loginThrottle.recordSuccess(ip);
    const token = createSession(config.admin.sessionSecret, config.admin.sessionTtlMs);
    setSessionCookie(req, res, token, config.admin.sessionTtlMs);
    logger.info("admin.login_ok", { ip });
    res.json({ ok: true });
  });

  router.post("/logout", (req, res) => {
    const cookie = parseCookies(req)[SESSION_COOKIE];
    if (cookie) revoke(cookie, verifySession(cookie, config.admin.sessionSecret));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Проверка «уже вошли?» — чтобы браузер не спрашивал логин при каждом заходе.
  router.get("/session", (req, res) => {
    const session = config.features.adminLogin ? checkSession(req) : null;
    res.json({ authenticated: Boolean(session), loginEnabled: config.features.adminLogin });
  });

  router.use(requireAdmin);

  createPostsRoutes(router, db);
  if (crm) createCrmAdminRoutes(router, crm);

  router.post("/import-url", express.json(), async (req, res) => {
    const url = str(req.body?.url, { max: 2000 });
    if (!url || !/^https:\/\//i.test(url)) {
      return res.status(400).json({ error: "Нужна ссылка на страницу товара (https://...)" });
    }
    try {
      const { res: response } = await safeFetch(url, {
        timeoutMs: 10000,
        maxBytes: 3 * 1024 * 1024,
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) throw new AdminError(422, `Страница недоступна (HTTP ${response.status})`);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("html")) throw new AdminError(422, "По ссылке не HTML-страница");
      const html = (await readLimited(response, 3 * 1024 * 1024)).toString("utf8");

      const ld = findJsonLdProduct(html) || {};
      const ldOffer = firstOfferPrice(ld.offers);

      const name = decodeHtmlEntities(ld.name || metaTag(html, "og:title") || metaContent(html, [/<title[^>]*>([^<]*)<\/title>/i]));
      const image = ld.image
        ? Array.isArray(ld.image)
          ? ld.image[0]
          : typeof ld.image === "object"
            ? ld.image.url
            : ld.image
        : metaTag(html, "og:image");

      const rawPrice = ldOffer.price || metaTag(html, "product:price:amount") || metaTag(html, "og:price:amount");
      const priceMatch = String(rawPrice || "").match(/[\d\s.,]+/);
      const price = priceMatch ? Number(priceMatch[0].replace(/\s/g, "").replace(",", ".")) : null;

      const currencyRaw = (ldOffer.currency || metaTag(html, "product:price:currency") || metaTag(html, "og:price:currency") || "").toUpperCase();
      const currency = CURRENCIES.includes(currencyRaw) ? currencyRaw : null;

      if (!name && !image && !price) {
        throw new AdminError(422, "Не нашли ни название, ни фото, ни цену на странице — вводите вручную");
      }

      res.json({
        name: decodeHtmlEntities(name).slice(0, 200),
        image: image ? new URL(image, url).href : "",
        price: Number.isFinite(price) && price > 0 ? price : null,
        currency,
        sourceUrl: url,
      });
    } catch (e) {
      if (e instanceof FetchGuardError) return res.status(422).json({ error: e.message });
      handleError(res, e, "admin.import_url_failed");
    }
  });

  router.post("/upload", (req, res) => {
    upload.single("file")(req, res, async (err) => {
      if (err) {
        const message = err.code === "LIMIT_FILE_SIZE" ? "Файл слишком большой" : "Не удалось загрузить файл";
        return res.status(400).json({ error: message });
      }
      if (!req.file) return res.status(400).json({ error: "Файл не передан или это не изображение" });

      // Проверка магических байтов — content-type в multipart можно подделать.
      const buf = req.file.buffer;
      const size = imageSize(buf);
      if (!size) {
        return res.status(422).json({ error: "Файл не похож на настоящее изображение" });
      }
      if (size.width < config.images.minWidth) {
        return res.status(422).json({ error: `Слишком маленькое изображение (${size.width}px, нужно ≥ ${config.images.minWidth}px)` });
      }

      const animated = req.file.mimetype === "image/gif";
      const filename = `${crypto.randomBytes(16).toString("hex")}.webp`;
      const outputPath = path.join(config.uploads.dir, filename);

      try {
        const image = sharp(buf, { animated, failOn: "error" });
        if (!animated) image.rotate();
        await image
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 84, alphaQuality: 92, effort: 4, smartSubsample: true })
          .toFile(outputPath);
      } catch (conversionError) {
        logger.warn("admin.upload_invalid", { error: conversionError.message });
        return res.status(422).json({ error: "Не удалось обработать изображение" });
      }

      logger.info("admin.upload_ok", { file: filename, width: size.width, height: size.height });
      res.status(201).json({
        url: `/uploads/${filename}`,
        width: size.width,
        height: size.height,
        format: "webp",
      });
    });
  });

  router.get("/products", (req, res) => {
    const rows = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
    res.json({ products: rows.map(toAdminJson), groups: GROUPS, categorySuggestions: CATEGORY_SUGGESTIONS });
  });

  router.get("/products/:slug", (req, res) => {
    const row = db.prepare("SELECT * FROM products WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found" });
    res.json({ product: toAdminJson(row) });
  });

  router.post("/products", express.json(), async (req, res) => {
    try {
      const data = validateBody(req.body);
      const baseStorage = data.storageOptions[0] || null;
      const key = normalizedKey({ brand: data.brand, model: data.name, storage: baseStorage, color: data.color, variant: data.variant });

      const conflict = db.prepare("SELECT slug FROM products WHERE normalized_key = ?").get(key);
      if (conflict) {
        throw new AdminError(409, "Такой товар уже есть в каталоге", { existingSlug: conflict.slug });
      }

      const { mainImage, extraImages, warnings } = await verifyImages(data);
      const mkey = matchKey({ brand: data.brand, model: data.name, storage: baseStorage, color: data.color, variant: data.variant });
      const slug = slugForProduct(db, { name: data.name, storage: baseStorage, color: data.color, variant: data.variant });
      const specifications = data.storageOptions.length > 1 ? { Память: data.storageOptions.join(" / ") } : {};
      const storageColumn = data.storageOptions.length === 1 ? data.storageOptions[0] : null;
      const productGroup = data.productGroup || guessGroup(data.category) || "Другое";

      const id = transaction(db, () => {
        db.prepare(
          `INSERT INTO products
             (slug, normalized_key, match_key, official_name, brand, model, category, variant, storage, color,
              price, currency, available, description, specifications,
              main_image_url, image_urls, image_is_external, image_last_checked_at,
              status, confidence, research_status, researched_at, origin,
              last_sync_status, last_synced_at,
              product_group, swatches, discount_percent, discount_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', 1, ?, ?, 'manual', 'ok', datetime('now'), ?, ?, ?, ?)`
        ).run(
          slug,
          key,
          mkey,
          data.name,
          data.brand,
          data.name,
          data.category,
          data.variant,
          storageColumn,
          data.color,
          data.price,
          data.currency,
          data.available === false ? 0 : 1,
          data.description,
          JSON.stringify(specifications),
          mainImage,
          JSON.stringify(extraImages),
          mainImage ? new Date().toISOString() : null,
          mainImage || data.description ? "done" : "skipped",
          mainImage || data.description ? new Date().toISOString() : null,
          productGroup,
          JSON.stringify(data.swatches),
          data.discountPercent,
          data.discountLabel
        );
        const newId = db.prepare("SELECT last_insert_rowid() AS id").get().id;
        logPriceChange(db, { productId: newId, slug, name: data.name, oldPrice: null, newPrice: data.price, currency: data.currency, source: "admin" });
        return newId;
      });

      const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
      logger.info("admin.product_created", { slug: row.slug, name: data.name });
      res.status(201).json({ product: toAdminJson(row), warnings });
    } catch (e) {
      handleError(res, e, "admin.create_failed");
    }
  });

  router.put("/products/:slug", express.json(), async (req, res) => {
    try {
      const existing = db.prepare("SELECT * FROM products WHERE slug = ?").get(req.params.slug);
      if (!existing) return res.status(404).json({ error: "not_found" });

      const data = validateBody(req.body, { partial: true });
      const merged = {
        name: data.name ?? existing.official_name,
        brand: data.brand !== undefined ? data.brand : existing.brand,
        category: data.category !== undefined ? data.category : existing.category,
        color: data.color !== undefined ? data.color : existing.color,
        variant: data.variant !== undefined ? data.variant : existing.variant,
      };
      const existingStorageOptions = existing.specifications
        ? parseJson(existing.specifications, {})["Память"]?.split(" / ")
        : existing.storage
          ? [existing.storage]
          : [];
      const storageOptions = data.storageOptions !== undefined ? data.storageOptions : existingStorageOptions || [];
      const baseStorage = storageOptions[0] || null;

      const key = normalizedKey({ brand: merged.brand, model: merged.name, storage: baseStorage, color: merged.color, variant: merged.variant });
      const conflict = db.prepare("SELECT slug FROM products WHERE normalized_key = ? AND id != ?").get(key, existing.id);
      if (conflict) throw new AdminError(409, "Такой ключ товара уже занят другим товаром", { existingSlug: conflict.slug });

      let mainImage = existing.main_image_url;
      let extraImages = parseJson(existing.image_urls, []);
      let warnings = [];
      if (data.image !== undefined || data.images !== undefined) {
        const verified = await verifyImages({
          image: data.image !== undefined ? data.image : existing.main_image_url,
          images: data.images !== undefined ? data.images : extraImages,
        });
        mainImage = verified.mainImage;
        extraImages = verified.extraImages;
        warnings = verified.warnings;
      }

      const mkey = matchKey({ brand: merged.brand, model: merged.name, storage: baseStorage, color: merged.color, variant: merged.variant });
      const specifications = storageOptions.length > 1 ? { Память: storageOptions.join(" / ") } : {};
      const storageColumn = storageOptions.length === 1 ? storageOptions[0] : null;
      const productGroup = data.productGroup !== undefined ? data.productGroup : existing.product_group;
      const swatches = data.swatches !== undefined ? data.swatches : parseJson(existing.swatches, []);
      const discountPercent = data.discountPercent !== undefined ? data.discountPercent : existing.discount_percent;
      const discountLabel = data.discountLabel !== undefined ? data.discountLabel : existing.discount_label;

      transaction(db, () => {
        db.prepare(
          `UPDATE products SET
             normalized_key = ?, match_key = ?, official_name = ?, brand = ?, model = ?, category = ?,
             variant = ?, storage = ?, color = ?, price = ?, currency = ?, available = ?, description = ?,
             specifications = ?, main_image_url = ?, image_urls = ?, image_last_checked_at = ?,
             product_group = ?, swatches = ?, discount_percent = ?, discount_label = ?,
             updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          key,
          mkey,
          merged.name,
          merged.brand,
          merged.name,
          merged.category,
          merged.variant,
          storageColumn,
          merged.color,
          data.price ?? existing.price,
          data.currency ?? existing.currency,
          data.available !== undefined ? (data.available ? 1 : 0) : existing.available,
          data.description !== undefined ? data.description : existing.description,
          JSON.stringify(specifications),
          mainImage,
          JSON.stringify(extraImages),
          mainImage ? new Date().toISOString() : existing.image_last_checked_at,
          productGroup,
          JSON.stringify(swatches),
          discountPercent,
          discountLabel,
          existing.id
        );
        const newPrice = data.price ?? existing.price;
        if (existing.price !== newPrice || existing.currency !== (data.currency ?? existing.currency)) {
          logPriceChange(db, {
            productId: existing.id,
            slug: existing.slug,
            name: merged.name,
            oldPrice: existing.price,
            newPrice,
            currency: data.currency ?? existing.currency,
            source: "admin",
          });
        }
      });

      const row = db.prepare("SELECT * FROM products WHERE id = ?").get(existing.id);
      logger.info("admin.product_updated", { slug: row.slug });
      res.json({ product: toAdminJson(row), warnings });
    } catch (e) {
      handleError(res, e, "admin.update_failed");
    }
  });

  // Безвозвратное удаление. Связанные алиасы и привязки к сообщениям
  // удаляются каскадно; журнал цен сохраняется с product_id = NULL.
  router.delete("/products/:slug/permanent", (req, res) => {
    const row = db.prepare("SELECT id, slug, official_name FROM products WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare("DELETE FROM products WHERE id = ?").run(row.id);
    logger.info("admin.product_deleted", { slug: row.slug, name: row.official_name });
    res.json({ deleted: true, slug: row.slug });
  });

  // Мягкое удаление: товар скрывается с витрины, но не стирается из базы.
  router.delete("/products/:slug", (req, res) => {
    const row = db.prepare("SELECT * FROM products WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare("UPDATE products SET status = 'hidden', updated_at = datetime('now') WHERE id = ?").run(row.id);
    logger.info("admin.product_hidden", { slug: row.slug });
    res.json({ product: toAdminJson({ ...row, status: "hidden" }) });
  });

  router.post("/products/:slug/restore", (req, res) => {
    const row = db.prepare("SELECT * FROM products WHERE slug = ?").get(req.params.slug);
    if (!row) return res.status(404).json({ error: "not_found" });
    db.prepare("UPDATE products SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(row.id);
    logger.info("admin.product_restored", { slug: row.slug });
    res.json({ product: toAdminJson({ ...row, status: "active" }) });
  });

  // Перечитать канал и обновить цены/наличие всех товаров из Telegram.
  // Сначала подтягиваем свежую публичную ленту, затем прогоняем через
  // тот же SyncService, что и обычный webhook (force=true — игнорирует
  // совпадение хеша текста, чтобы точно пересчитать цену).
  router.post("/resync", async (req, res) => {
    try {
      const imported = await syncPublicChannelPosts({ db });
      const sync = req.app.locals.services.sync;
      const rows = db.prepare("SELECT * FROM telegram_messages WHERE is_deleted = 0 ORDER BY id").all();
      const stats = { created: 0, updated: 0, deactivated: 0, failed: 0 };
      for (const row of rows) {
        try {
          const r = await sync.syncMessage({
            chatId: row.telegram_chat_id,
            messageId: row.telegram_message_id,
            text: row.telegram_original_text,
            messageUpdatedAt: row.telegram_message_updated_at,
            force: true,
          });
          stats.created += r.created || 0;
          stats.updated += r.updated || 0;
          stats.deactivated += r.deactivated || 0;
        } catch (e) {
          stats.failed++;
          logger.error("admin.resync_message_failed", { messageId: row.telegram_message_id, error: e.message });
        }
      }
      logger.info("admin.resync_done", { imported: imported.found, messages: rows.length, ...stats });
      res.json({ imported, messages: rows.length, ...stats });
    } catch (e) {
      handleError(res, e, "admin.resync_failed");
    }
  });

  // Вкладка «Обновления»: когда и где менялась цена.
  router.get("/price-history", (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const rows = db.prepare("SELECT * FROM price_history ORDER BY changed_at DESC, id DESC LIMIT ?").all(limit);
    res.json({
      changes: rows.map((r) => ({
        id: r.id,
        productSlug: r.product_slug,
        productName: r.product_name,
        oldPrice: r.old_price,
        newPrice: r.new_price,
        currency: r.currency,
        source: r.source,
        changedAt: r.changed_at,
      })),
    });
  });

  return router;
}

// --- Новости --------------------------------------------------------------

function uniquePostSlug(db, base) {
  const root = slugify(base);
  let slug = root;
  let i = 2;
  while (db.prepare("SELECT 1 FROM posts WHERE slug = ?").get(slug)) slug = `${root}-${i++}`;
  return slug;
}

function toPostJson(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    image: row.image,
    status: row.status,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function validatePostBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    const title = str(body.title, { max: 200 });
    if (!title) throw new AdminError(400, "Заголовок обязателен");
    out.title = title;
  }
  if (!partial || body.body !== undefined) {
    const text = str(body.body, { max: 5000 });
    if (!text) throw new AdminError(400, "Текст новости обязателен");
    out.body = text;
  }
  if (!partial || body.image !== undefined) out.image = str(body.image, { max: 2000 });
  if (!partial || body.status !== undefined) {
    const status = str(body.status) || "published";
    if (!["published", "draft"].includes(status)) throw new AdminError(400, "Статус должен быть published или draft");
    out.status = status;
  }
  return out;
}

function createPostsRoutes(router, db) {
  router.get("/posts", (req, res) => {
    const rows = db.prepare("SELECT * FROM posts ORDER BY published_at DESC").all();
    res.json({ posts: rows.map(toPostJson) });
  });

  router.post("/posts", express.json(), async (req, res) => {
    try {
      const data = validatePostBody(req.body);
      let image = null;
      if (data.image) {
        if (isLocalUpload(data.image)) image = data.image;
        else {
          const r = await verifyImageUrl(data.image);
          if (!r.ok) throw new AdminError(422, `Фото недоступно: ${r.reason}`);
          image = data.image;
        }
      }
      const slug = uniquePostSlug(db, data.title);
      const status = data.status || "published";
      const id = transaction(db, () => {
        db.prepare(
          `INSERT INTO posts (slug, title, body, image, status, published_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
        ).run(slug, data.title, data.body, image, status);
        return db.prepare("SELECT last_insert_rowid() AS id").get().id;
      });
      const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
      logger.info("admin.post_created", { slug: row.slug });
      res.status(201).json({ post: toPostJson(row) });
    } catch (e) {
      handleError(res, e, "admin.post_create_failed");
    }
  });

  router.put("/posts/:slug", express.json(), async (req, res) => {
    try {
      const existing = db.prepare("SELECT * FROM posts WHERE slug = ?").get(req.params.slug);
      if (!existing) return res.status(404).json({ error: "not_found" });
      const data = validatePostBody(req.body, { partial: true });

      let image = existing.image;
      if (data.image !== undefined) {
        if (!data.image) image = null;
        else if (isLocalUpload(data.image)) image = data.image;
        else {
          const r = await verifyImageUrl(data.image);
          if (!r.ok) throw new AdminError(422, `Фото недоступно: ${r.reason}`);
          image = data.image;
        }
      }

      transaction(db, () => {
        db.prepare(
          `UPDATE posts SET title = ?, body = ?, image = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(
          data.title ?? existing.title,
          data.body ?? existing.body,
          image,
          data.status ?? existing.status,
          existing.id
        );
      });
      const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(existing.id);
      logger.info("admin.post_updated", { slug: row.slug });
      res.json({ post: toPostJson(row) });
    } catch (e) {
      handleError(res, e, "admin.post_update_failed");
    }
  });

  router.delete("/posts/:slug", (req, res) => {
    const existing = db.prepare("SELECT * FROM posts WHERE slug = ?").get(req.params.slug);
    if (!existing) return res.status(404).json({ error: "not_found" });
    db.prepare("DELETE FROM posts WHERE id = ?").run(existing.id);
    logger.info("admin.post_deleted", { slug: existing.slug });
    res.json({ ok: true });
  });
}

function handleError(res, e, event) {
  if (e instanceof AdminError) {
    return res.status(e.status).json({ error: e.message, ...e.extra });
  }
  logger.error(event, { error: e.message });
  res.status(500).json({ error: "internal_error" });
}

module.exports = { createAdminRouter, validateBody, parseStorageOptions, parseImageList, parseSwatches, AdminError };
