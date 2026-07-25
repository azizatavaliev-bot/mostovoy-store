// Серверная валидация ответа модели.
// DeepSeek поддерживает только response_format {"type":"json_object"} — строгой
// JSON Schema на стороне API нет, поэтому структуру проверяем сами и никогда
// не доверяем модели напрямую.
const { SUPPORTED_CURRENCIES } = require("./normalize");

class ValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(v, { max = 500 } = {}) {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
  return s.slice(0, max);
}

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function bool(v, def) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return def;
}

function clamp01(v) {
  const n = num(v);
  if (n == null) return null;
  return Math.max(0, Math.min(1, n));
}

function strArray(v, { max = 20, maxLen = 2000 } = {}) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, { max: maxLen })).filter(Boolean).slice(0, max);
}

// Один товар из шага извлечения (extract).
function validateExtractedProduct(raw, index) {
  const issues = [];
  if (!isPlainObject(raw)) throw new ValidationError(`Товар #${index}: ожидался объект`);

  const officialName = str(raw.official_name) || str(raw.source_name);
  if (!officialName) throw new ValidationError(`Товар #${index}: пустое название`);

  const price = num(raw.price);
  if (price == null || price <= 0) throw new ValidationError(`Товар #${index}: некорректная цена`);

  let currency = str(raw.currency);
  currency = currency ? currency.toUpperCase() : null;
  if (!currency || !SUPPORTED_CURRENCIES.includes(currency)) {
    throw new ValidationError(`Товар #${index}: неподдерживаемая валюта ${currency || "—"}`);
  }

  const confidence = clamp01(raw.confidence);
  if (confidence == null) issues.push("нет confidence, взят 0.5");

  return {
    product: {
      source_name: str(raw.source_name) || officialName,
      official_name: officialName,
      brand: str(raw.brand, { max: 80 }),
      model: str(raw.model, { max: 160 }),
      category: str(raw.category, { max: 80 }),
      variant: str(raw.variant, { max: 80 }),
      storage: str(raw.storage, { max: 40 }),
      color: str(raw.color, { max: 60 }),
      price,
      currency,
      available: bool(raw.available, true),
      confidence: confidence == null ? 0.5 : confidence,
      warning: str(raw.warning, { max: 400 }),
    },
    issues,
  };
}

// Ответ шага извлечения целиком. Плохой товар не роняет остальные.
function validateExtraction(raw) {
  if (!isPlainObject(raw)) throw new ValidationError("Ответ модели — не JSON-объект");
  const list = Array.isArray(raw.products) ? raw.products : null;
  if (!list) throw new ValidationError("В ответе нет массива products");

  const products = [];
  const rejected = [];
  list.forEach((item, i) => {
    try {
      products.push(validateExtractedProduct(item, i).product);
    } catch (e) {
      rejected.push({ index: i, reason: e.message, raw: item });
    }
  });
  return { products, rejected };
}

// Ответ шага исследования (research). Здесь всё опционально:
// нет данных — товар всё равно создаётся, просто беднее.
function validateResearch(raw) {
  if (!isPlainObject(raw)) throw new ValidationError("Ответ модели — не JSON-объект");

  const specsRaw = isPlainObject(raw.specifications) ? raw.specifications : {};
  const specifications = {};
  for (const [k, v] of Object.entries(specsRaw).slice(0, 30)) {
    const key = str(k, { max: 60 });
    const val = str(typeof v === "number" || typeof v === "boolean" ? String(v) : v, { max: 300 });
    if (key && val) specifications[key] = val;
  }

  return {
    official_name: str(raw.official_name, { max: 200 }),
    brand: str(raw.brand, { max: 80 }),
    model: str(raw.model, { max: 160 }),
    category: str(raw.category, { max: 80 }),
    description: str(raw.description, { max: 900 }),
    specifications,
    main_image_url: str(raw.main_image_url, { max: 2000 }),
    image_urls: strArray(raw.image_urls, { max: 10 }),
    image_source_url: str(raw.image_source_url, { max: 2000 }),
    source_page_url: str(raw.source_page_url, { max: 2000 }),
    confidence: clamp01(raw.confidence) ?? 0.5,
    warning: str(raw.warning, { max: 400 }),
  };
}

// Выбор кандидата при неоднозначном сопоставлении.
function validateMatchChoice(raw) {
  if (!isPlainObject(raw)) throw new ValidationError("Ответ модели — не JSON-объект");
  const key = str(raw.normalized_key, { max: 300 });
  return {
    normalized_key: key && key.toLowerCase() !== "none" ? key : null,
    confidence: clamp01(raw.confidence) ?? 0,
    reason: str(raw.reason, { max: 300 }),
  };
}

module.exports = {
  ValidationError,
  validateExtraction,
  validateExtractedProduct,
  validateResearch,
  validateMatchChoice,
};
