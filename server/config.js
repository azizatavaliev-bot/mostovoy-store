// Конфиг из переменных окружения. Ключи в коде не хранятся.
// .env читается вручную (без dotenv) — лишняя зависимость не нужна.
const fs = require("fs");
const path = require("path");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (/^".*"$|^'.*'$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, "..", ".env"));

const int = (v, def) => (Number.isFinite(+v) && +v > 0 ? +v : def);

// Корень проекта. Относительные пути из .env считаем от него, а не от cwd:
// сервер могут запустить из другого каталога, и тогда «./data/mostovoy.db»
// создаст пустую базу не там, где лежит настоящая.
const ROOT = path.join(__dirname, "..");
const resolvePath = (p, def) => {
  const value = p || def;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
};

const config = {
  port: int(process.env.PORT, 5190),
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  logLevel: process.env.LOG_LEVEL || "info",
  databasePath:
    process.env.DATABASE_PATH === ":memory:"
      ? ":memory:"
      : resolvePath(process.env.DATABASE_PATH, "data/mostovoy.db"),

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    channelId: process.env.TELEGRAM_CHANNEL_ID || "",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    apiBase: process.env.TELEGRAM_API_BASE || "https://api.telegram.org",
  },

  amocrm: {
    baseUrl: (process.env.AMOCRM_BASE_URL || "").replace(/\/+$/, ""),
    accessToken: process.env.AMOCRM_ACCESS_TOKEN || "",
    amojoBaseUrl: (process.env.AMOJO_BASE_URL || "https://amojo.amocrm.ru").replace(/\/+$/, ""),
    webhookSecret: process.env.AMOCRM_WEBHOOK_SECRET || "",
  },

  azisCrm: {
    baseUrl: (process.env.AZIS_CRM_BASE_URL || "").replace(/\/+$/, ""),
    integrationSecret: process.env.AZIS_CRM_INTEGRATION_SECRET || "",
    projectId: process.env.AZIS_CRM_PROJECT_ID || "",
    timeoutMs: int(process.env.AZIS_CRM_TIMEOUT_MS, 10000),
  },

  // MostovoyCRM: витрина сообщает ей о новом клиенте, чтобы там завелась
  // сделка в воронке. Токен тот же, что у /api/internal/* в CRM.
  crmDeals: {
    baseUrl: (process.env.CRM_BASE_URL || "").replace(/\/+$/, ""),
    internalToken: process.env.CRM_INTERNAL_TOKEN || "",
    timeoutMs: int(process.env.CRM_TIMEOUT_MS, 5000),
  },

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
    // deepseek-chat / deepseek-reasoner устарели 2026-07-24 → deepseek-v4-flash.
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    timeoutMs: int(process.env.DEEPSEEK_TIMEOUT_MS, 60000),
    maxRetries: int(process.env.DEEPSEEK_MAX_RETRIES, 3),
    // Не больше N запросов в минуту — бережём квоту.
    rateLimitPerMinute: int(process.env.DEEPSEEK_RATE_LIMIT_PER_MINUTE, 20),
    maxTokens: int(process.env.DEEPSEEK_MAX_TOKENS, 4096),
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    baseUrl: (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseUrl: (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  },

  research: {
    // none | tavily | brave
    provider: process.env.PRODUCT_RESEARCH_PROVIDER || "none",
    tavilyApiKey: process.env.TAVILY_API_KEY || "",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
    timeoutMs: int(process.env.RESEARCH_TIMEOUT_MS, 20000),
    // Сколько дней результат исследования считается свежим.
    cacheTtlDays: int(process.env.RESEARCH_CACHE_TTL_DAYS, 90),
  },

  images: {
    timeoutMs: int(process.env.IMAGE_CHECK_TIMEOUT_MS, 10000),
    maxBytes: int(process.env.IMAGE_MAX_BYTES, 8 * 1024 * 1024),
    // Меньше — считаем иконкой/логотипом/превью.
    minBytes: int(process.env.IMAGE_MIN_BYTES, 6 * 1024),
    minWidth: int(process.env.IMAGE_MIN_WIDTH, 400),
    maxPerProduct: int(process.env.IMAGE_MAX_PER_PRODUCT, 6),
  },

  // Контакт для кнопки «Связаться». Telegram — тот же, что в STORE.tg на витрине.
  contact: {
    // Заказы уходят в WhatsApp: он умеет предзаполнять текст сообщения.
    // Номер в межд. формате без «+». По умолчанию рабочий 0999 110 110.
    whatsapp: (process.env.WHATSAPP_PHONE || "996999110110").replace(/\D/g, ""),
    // Кнопка «Связаться» — личный чат магазина в Telegram.
    telegram: (process.env.TELEGRAM_CONTACT_USERNAME || "mostovoyshop").replace(/^@/, ""),
    // Публичный канал — ссылка «Следите за нами».
    channel: (process.env.TELEGRAM_CHANNEL_USERNAME || "mostovoyshopp").replace(/^@/, ""),
    // Телефоны для футера.
    phones: [
      { number: "996999110110", label: "0999 110 110", who: "рабочий номер" },
      { number: "996700922622", label: "0700 922 622", who: "Рахмон" },
      { number: "996708933633", label: "0708 933 633", who: "Ислам" },
    ],
    // Шоу-рум магазина — для блока «Где мы находимся» на главной.
    address: {
      line1: "ТЦ ЦУМ «Айчурек», проспект Чуй, 155",
      line2: "1 этаж, отдел D14 (2-й филиал)",
      line3: "Свердловский район, Бишкек, 720011",
      mapQuery: "ЦУМ Айчурек, проспект Чуй 155, Бишкек",
    },
  },

  // Курсы ТОЛЬКО для показа цены в другой валюте на витрине.
  // В базе цена и валюта всегда хранятся как есть, из Telegram, и не пересчитываются.
  rates: {
    base: "USD",
    USD: 1,
    KGS: Number(process.env.RATE_USD_KGS) || 87.5,
    RUB: Number(process.env.RATE_USD_RUB) || 79,
  },

  // Админка (/admin.html и /api/admin/*): ручное добавление и правка товаров.
  // Два независимых способа войти:
  //  - token — для CLI/скриптов (npm run admin, curl), заголовок x-admin-token;
  //  - username/passwordHash — для входа в браузере по логину и паролю,
  //    выдаёт подписанную сессионную cookie (см. server/lib/auth.js).
  // Без обоих способов раздел выключен целиком — дефолтов нет.
  admin: {
    token: process.env.ADMIN_TOKEN || "",
    username: process.env.ADMIN_USERNAME || "",
    passwordHash: process.env.ADMIN_PASSWORD_HASH || "",
    // Подпись сессионных cookie. Без него вход по паролю недоступен —
    // подписывать сессии нечем.
    sessionSecret: process.env.SESSION_SECRET || "",
    sessionTtlMs: int(process.env.ADMIN_SESSION_TTL_HOURS, 12) * 60 * 60 * 1000,
  },

  uploads: {
    dir: resolvePath(process.env.UPLOADS_DIR, "uploads"),
    maxBytes: int(process.env.UPLOAD_MAX_BYTES, 8 * 1024 * 1024),
  },
};

// Что реально настроено — используется в /api/health и при старте.
config.features = {
  telegram: Boolean(config.telegram.botToken && config.telegram.webhookSecret),
  deepseek: Boolean(config.deepseek.apiKey),
  openai: Boolean(config.openai.apiKey),
  gemini: Boolean(config.gemini.apiKey),
  anthropic: Boolean(config.anthropic.apiKey),
  research: config.research.provider !== "none",
  contact: Boolean(config.contact.telegram),
  adminToken: Boolean(config.admin.token),
  adminLogin: Boolean(config.admin.username && config.admin.passwordHash && config.admin.sessionSecret),
  amocrm: Boolean(config.amocrm.baseUrl && config.amocrm.accessToken),
  azisCrm: Boolean(config.azisCrm.baseUrl && config.azisCrm.integrationSecret),
  crmDeals: Boolean(config.crmDeals.baseUrl && config.crmDeals.internalToken),
};
config.features.admin = config.features.adminToken || config.features.adminLogin;

module.exports = config;
