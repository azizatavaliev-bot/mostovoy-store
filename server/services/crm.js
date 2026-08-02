const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics, getProductViewAnalytics } = require("./buy-analytics");
const { MODELS, modelInfo } = require("./ai");
const { syncPublicChannelPosts } = require("../cli/import-public-channel");

function escapeTelegramHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function telegramHtml(markdown) {
  const protectedBlocks = [];
  const protect = (html) => {
    const token = `\uE000${protectedBlocks.length}\uE001`;
    protectedBlocks.push(html);
    return token;
  };

  let text = String(markdown || "");
  text = text.replace(/```(?:[a-z0-9_-]+)?\s*\n?([\s\S]*?)```/gi, (_, code) =>
    protect(`<pre>${escapeTelegramHtml(code.trim())}</pre>`)
  );
  text = text.replace(/`([^`\n]+)`/g, (_, code) =>
    protect(`<code>${escapeTelegramHtml(code)}</code>`)
  );
  text = escapeTelegramHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");

  return text.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedBlocks[Number(index)] || "");
}

const DEFAULT_PROMPT = `Ты продавец-консультант магазина техники МОСТОВОЙ в Бишкеке.
Отвечай кратко, дружелюбно и на языке клиента. Используй только цены и наличие из актуального каталога ниже.
Не придумывай характеристики, скидки и сроки доставки. Сначала сам подбери и предложи подходящие товары; не пиши «сейчас уточню», «уточню у менеджера», «каталог не показывает» или «подключу менеджера».
Помоги выбрать товар и мягко предложи оформить заказ. Не упоминай, что ты AI.`;
const DEFAULT_HYPERVISOR_PROMPT = `Ты создаёшь краткое резюме контекста диалога для менеджера магазина техники.
Перескажи только факты из переписки: что хочет клиент, какие товары и условия обсуждались, что уже выяснено и какой вопрос остался открытым.
Не оценивай ответ консультанта, не исправляй его, не предлагай свой ответ и ничего не выдумывай.
Ответ — не более трёх коротких предложений.`;
const DEFAULT_CHARACTER_PROMPT = `Доброжелательный, уверенный и внимательный консультант. Общается естественно, без канцелярита и навязчивости.`;
const DEFAULT_RULES_PROMPT = `Не выдумывай наличие, цены и условия. Не обещай то, чего нет в каталоге. На вопрос о наличии, рассрочке, доставке или характеристиках отвечай сам по данным каталога. Если клиент просит совет, бюджет или категорию — сразу предложи 2–3 подходящих товара с ценами. Один уточняющий вопрос допустим только после подборки или если подходящих товаров действительно нет. Менеджера можно упомянуть только по прямой просьбе клиента либо когда клиент просит оформить заказ, резерв или живой осмотр. После цены или подборки не заканчивай ответ: предложи один конкретный следующий шаг — оформить заказ, зарезервировать выбранную модель либо рассчитать Trade-in или рассрочку.`;
const DEFAULT_TASK_PROMPT = `Помоги клиенту выбрать подходящий товар, ответь на вопрос и веди продажу до конкретного следующего действия. Не начинай с вопросов, если уже можно показать подходящие варианты. После выбора или цены предложи оформить заказ или резерв; только после согласия попроси имя и удобный способ связи.`;
const ALLOWED_MODELS = MODELS.map((item) => item.id);
const DEEPSEEK_INPUT_USD_PER_MILLION = 0.07;
const DEEPSEEK_OUTPUT_USD_PER_MILLION = 1.10;
const EXPENSIVE_PRICE_KGS = 100_000;
const INSTALLMENT_COEFFICIENTS = { 3: 0.94, 6: 0.89, 12: 0.84 };
const TRADE_IN_OPTIONS = [
  ["iphone 15 pro max", 900], ["iphone 15 pro", 800], ["iphone 15", 620],
  ["iphone 14 pro", 600], ["iphone 14", 480], ["iphone 13", 360], ["iphone 12", 260],
  ["galaxy s24 ultra", 740], ["galaxy s24", 520], ["galaxy s23", 380], ["galaxy s22", 260],
  ["macbook air m1", 450], ["macbook air m2", 650], ["macbook air m3", 850], ["macbook air m4", 850],
  ["macbook pro 14", 1050], ["macbook pro 16", 1250],
];

function roundAssistantPrice(amount, currency) {
  const step = currency === "USD" ? 10 : 100;
  return Math.ceil(Number(amount) / step) * step;
}

function convertAssistantPrice(amount, from, to) {
  const sourceRate = Number(config.rates[String(from || "").toUpperCase()]) || 1;
  const targetRate = Number(config.rates[String(to || "").toUpperCase()]) || 1;
  return Number(amount) / sourceRate * targetRate;
}

function formatAssistantPrice(amount, from, to) {
  const value = roundAssistantPrice(convertAssistantPrice(amount, from, to), to);
  const suffix = to === "KGS" ? "с" : to === "RUB" ? "₽" : to === "KZT" ? "₸" : "$";
  return `${value.toLocaleString("ru-RU")} ${suffix}`;
}

function tradeInEstimate(message) {
  const normalized = String(message || "").toLowerCase().replace(/ё/g, "е");
  const model = TRADE_IN_OPTIONS.find(([name]) => normalized.includes(name));
  const generic = /(?:android.*флагман|флагман.*android)/.test(normalized) ? ["Другой Android (флагман)", 180]
    : /(?:android.*бюджет|бюджет.*android)/.test(normalized) ? ["Другой Android (бюджет)", 65] : null;
  const device = model || generic;
  if (!device) return null;
  const condition = /дефект|трещин|скол|не работает|плох/.test(normalized) ? ["С дефектами", 0.45]
    : /хорош/.test(normalized) ? ["Хорошее", 0.7] : ["Отличное", 1];
  return { device: device[0], condition: condition[0], usd: Number(device[1]) * Number(condition[1]) };
}

function selectedCatalogProduct(selection) {
  const match = String(selection || "").match(/\{\s*"products"[\s\S]*\}/);
  if (!match) return null;
  try {
    const products = JSON.parse(match[0]).products;
    const product = Array.isArray(products) ? products.find((item) => item?.available && Number.isFinite(Number(item.price))) : null;
    return product ? { ...product, price: Number(product.price), currency: String(product.currency).toUpperCase() } : null;
  } catch { return null; }
}

function financeToolContext(request, selection) {
  const text = String(request || "").toLowerCase();
  const wantsInstallment = /рассроч|в кредит|платеж.*месяц|ежемесяч/.test(text);
  const wantsTradeIn = /trade.?in|трейд.?ин|обменять|сдать.*(?:айфон|iphone|телефон|macbook|макбук)/.test(text);
  if (!wantsInstallment && !wantsTradeIn) return "";
  const product = selectedCatalogProduct(selection);
  const trade = wantsTradeIn ? tradeInEstimate(request) : null;
  const lines = ["ИНСТРУМЕНТЫ РАСЧЁТА САЙТА (данные уже рассчитаны, не меняй формулу):"];
  if (trade) lines.push(`Trade-in: ${trade.device}, состояние «${trade.condition}» — предварительная оценка ${formatAssistantPrice(trade.usd, "USD", "KGS")} (точную подтвердит диагностика).`);
  if (wantsInstallment && product) {
    const months = Number((text.match(/\b(3|6|12)\s*(?:мес|месяц)/) || [])[1]) || 12;
    const coefficient = INSTALLMENT_COEFFICIENTS[months];
    const productKgs = convertAssistantPrice(product.price, product.currency, "KGS");
    const tradeKgs = trade ? convertAssistantPrice(trade.usd, "USD", "KGS") : 0;
    const principal = Math.max(productKgs - tradeKgs, 0);
    const total = principal / coefficient;
    const monthly = total / months;
    lines.push(`Рассрочка: ${product.name}; ${months} мес.; стоимость ${formatAssistantPrice(productKgs, "KGS", "KGS")}; после Trade-in ${formatAssistantPrice(principal, "KGS", "KGS")}; платёж ${formatAssistantPrice(monthly, "KGS", "KGS")} в месяц; всего ${formatAssistantPrice(total, "KGS", "KGS")}; переплата ${formatAssistantPrice(total - principal, "KGS", "KGS")}.`);
  } else if (wantsInstallment) lines.push("Для точного расчёта рассрочки сначала назови товар и срок: 3, 6 или 12 месяцев.");
  lines.push("Используй расчёт в ответе. Если клиент подтвердил расчёт, попроси имя и телефон для оформления.");
  return lines.join("\n");
}

function buildTelegramCatalogForAssistant(db) {
  // Товаровед работает со структурированной базой, полученной только из
  // публикаций канала. Для каждой позиции берём самое новое активное
  // упоминание — старая цена той же модели в подсказку не попадёт.
  const products = db.prepare(
    `SELECT p.official_name, p.brand, p.category, p.color, p.storage,
            mp.price, mp.currency, mp.available,
            tm.telegram_message_id, tm.telegram_message_updated_at
       FROM products p
       JOIN message_products mp ON mp.product_id = p.id
       JOIN telegram_messages tm ON tm.id = mp.message_id
      WHERE p.status != 'hidden' AND mp.active = 1 AND tm.is_deleted = 0 AND mp.price IS NOT NULL
        AND tm.id = (
          SELECT tm2.id
            FROM message_products mp2
            JOIN telegram_messages tm2 ON tm2.id = mp2.message_id
           WHERE mp2.product_id = p.id AND mp2.active = 1 AND tm2.is_deleted = 0 AND mp2.price IS NOT NULL
           ORDER BY COALESCE(tm2.telegram_message_updated_at, tm2.updated_at, tm2.created_at) DESC, tm2.id DESC
           LIMIT 1
        )
      ORDER BY tm.telegram_message_updated_at DESC, tm.id DESC`
  ).all();
  // Новый или отредактированный пост сначала имеет статус raw. Добавляем
  // его в payload товароведа сразу: он новее структурированной карточки и
  // должен иметь приоритет до фонового разбора всей истории.
  const pendingPosts = db.prepare(
    `SELECT telegram_message_id, telegram_message_updated_at, telegram_original_text
       FROM telegram_messages
      WHERE is_deleted = 0 AND last_sync_status IN ('raw', 'pending')
        AND trim(telegram_original_text) != ''
      ORDER BY COALESCE(telegram_message_updated_at, updated_at, created_at) DESC, telegram_message_id DESC`
  ).all().map((post) => ({
    telegramMessageId: Number(post.telegram_message_id),
    updatedAt: post.telegram_message_updated_at || null,
    text: post.telegram_original_text,
  }));

  if (products.length || pendingPosts.length) return JSON.stringify({
    source: "telegram_channel",
    products: products.map((p) => ({
      name: p.official_name,
      brand: p.brand || null,
      category: p.category || null,
      storage: p.storage || null,
      color: p.color || null,
      price: Number(p.price),
      currency: p.currency,
      available: Boolean(p.available),
      telegramMessageId: Number(p.telegram_message_id),
      updatedAt: p.telegram_message_updated_at || null,
    })),
    pendingPosts,
  });
  // Старые импортированные позиции могут не иметь привязки message_products,
  // но их цена уже получена из канала и актуальна в таблице products.
  const snapshots = db.prepare(
    `SELECT official_name, color, storage, price, currency, available
       FROM products
      WHERE status != 'hidden' AND price IS NOT NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 180`
  ).all();
  return snapshots.map((p) => {
    const title = `${p.official_name}${p.storage ? ` ${p.storage}` : ""}${p.color ? `, ${p.color}` : ""}`;
    const defaultCurrency = convertAssistantPrice(p.price, p.currency, "KGS") >= EXPENSIVE_PRICE_KGS ? "USD" : "KGS";
    return `- ${title}: цена по умолчанию ${formatAssistantPrice(p.price, p.currency, defaultCurrency)}; USD ${formatAssistantPrice(p.price, p.currency, "USD")}; RUB ${formatAssistantPrice(p.price, p.currency, "RUB")}; KZT ${formatAssistantPrice(p.price, p.currency, "KZT")}${p.available ? "" : " (нет в наличии)"}`;
  }).join("\n");
}

const CATALOG_FAMILIES = [
  { request: /айфон|iphone/i, terms: ["iphone"] },
  { request: /макбук|macbook/i, terms: ["macbook"] },
  { request: /айпад|ipad/i, terms: ["ipad"] },
  { request: /airpods|аирпод|эирпод/i, terms: ["airpods"] },
  { request: /apple watch|эпл вотч|часы apple/i, terms: ["apple watch"] },
  { request: /samsung|самсунг/i, terms: ["samsung", "galaxy"] },
  { request: /xiaomi|сяоми|poco/i, terms: ["xiaomi", "poco"] },
  { request: /dyson|дайсон|фен|стайлер/i, terms: ["dyson", "airwrap", "airstrait"] },
  { request: /garmin|гармин/i, terms: ["garmin"] },
  { request: /whoop|вуп/i, terms: ["whoop"] },
  { request: /очки|ray.?ban|meta/i, terms: ["ray ban", "ray•ban", "meta oakley"] },
  { request: /пристав|playstation|xbox|nintendo|steam deck/i, terms: ["playstation", "sony 5", "xbox", "nintendo", "steam deck"] },
  { request: /бритв|триммер|oneblade|philips/i, terms: ["oneblade", "one blade", "philips"] },
];

function narrowCatalogForRequest(catalog, request) {
  try {
    const data = JSON.parse(catalog);
    if (!Array.isArray(data.pendingPosts)) return catalog;
    const family = CATALOG_FAMILIES.find((item) => item.request.test(String(request || "")));
    if (!family) return JSON.stringify({ ...data, pendingPosts: data.pendingPosts.slice(0, 40) });
    const matches = (value) => family.terms.some((term) => String(value || "").toLowerCase().includes(term));
    const pricedPosts = data.pendingPosts
      .filter((post) => matches(post.text) && /\d[\d\s.,]*\s*(?:\$|с(?:\s|$)|сом|usd|kgs)/i.test(post.text))
      .sort((a, b) => Number(b.telegramMessageId) - Number(a.telegramMessageId));
    // Канал публикует новый полный прайс категории отдельным постом. Старые
    // прайсы остаются в истории, поэтому для ответа используем только самый
    // новый ценовой пост этой категории.
    if (pricedPosts.length) return JSON.stringify({ ...data, products: [], pendingPosts: pricedPosts.slice(0, 1) });
    return JSON.stringify({
      ...data,
      products: Array.isArray(data.products)
        ? data.products.filter((product) => matches(`${product.name} ${product.brand} ${product.category}`))
        : [],
      pendingPosts: data.pendingPosts.filter((post) => matches(post.text)).slice(0, 30),
    });
  } catch {
    return catalog;
  }
}

const ASSISTANT_PRICE_POLICY = `ЦЕНЫ И ИСТОЧНИК:
Каталог ниже синхронизирован только с публикациями Telegram-канала магазина. Не используй старые цены сайта, память модели или цены без строки из этого каталога.
Если клиент не назвал страну и не попросил валюту, называй цену в сомах (priceKgs). Если priceKgs равна или выше ${EXPENSIVE_PRICE_KGS}, называй цену в долларах (priceUsd), потому что это дорогое устройство.
Рубли (priceRub) называй только если клиент прямо сказал, что он из России, доставка нужна в Россию, либо сам попросил RUB/рубли. Для клиента из Казахстана называй цену в тенге (priceKzt). Не определяй страну по языку сообщения. Если клиент явно попросил USD или KGS — назови цену в этой валюте. Если клиент пишет по-английски и страну не назвал — используй USD. Не называй несколько валют сразу, если клиент не просит сравнение.
Товаровед получает структурированную базу, построенную из публикаций Telegram-канала, и возвращает только подходящие актуальные позиции. Это единственный источник цены. В подборке price/currency — исходная цена канала, а priceKgs, priceUsd, priceRub и priceKzt — её пересчёт по курсу магазина; для ответа в нужной валюте используй соответствующее готовое поле. Если точного товара нет, не выдумывай цену и предложи 1–3 ближайшие позиции из подборки; задай один конкретный вопрос только если подобрать альтернативу нельзя.

ПРОДАЖА:
Если клиент просит посоветовать товар, называет бюджет или категорию, сразу предложи 2–3 наиболее подходящих товара из актуального каталога с ценами. Не отвечай «сейчас уточню», «уточню у менеджера» и не перекладывай подбор на клиента, пока в каталоге есть подходящие варианты.
Никогда не пиши «каталог не показывает актуальные модели», «подключу менеджера» или похожие фразы. Менеджера упоминай только если клиент сам просит оформить заказ, резерв или живой осмотр.
После любой названной цены или подборки обязательно продолжи продажу одним коротким призывом: предложи оформить заказ, зарезервировать конкретную модель либо рассчитать Trade-in или рассрочку. Не заканчивай сообщение последней строкой прайса.`;

const CATALOG_SPECIALIST_PROMPT = `Ты товаровед магазина техники. Тебе даны актуальная база товаров из Telegram-канала и последнее сообщение клиента.
Найди от 1 до 5 товаров, которые подходят запросу, бюджету и категории. Бери названия, цены, валюты и наличие только из переданной базы. Не используй память, сайт или догадки. Если подходящих товаров нет — верни пустой массив.
Поле products содержит уже разобранные позиции. Поле pendingPosts содержит новые или изменённые исходные посты, которые ещё обрабатываются; если они описывают тот же товар, данные из более нового pendingPosts имеют приоритет.
Для сравнения с бюджетом используй курсы магазина: 1 USD = ${config.rates.KGS} KGS, 1 USD = ${config.rates.RUB} RUB, 1 USD = ${config.rates.KZT} KZT. В JSON всё равно верни исходную цену и валюту из канала, не пересчитывай поле price.
Не добавляй к цене наценку, комиссию, налог или запас: переданная цена и её пересчёт по указанному курсу уже являются ценой магазина. Если пересчитанная цена не превышает бюджет клиента, товар подходит и должен быть возвращён в products.
Верни JSON строго такого вида:
{"products":[{"name":"iPhone 15 Pro Max","brand":"Apple","category":"smartphone","storage":"256GB","color":"Natural Titanium","price":1099,"currency":"USD","available":true,"reason":"кратко почему подходит"}],"note":"одно короткое уточнение только если товаров нет"}
price — число без пробелов и символов. currency — только USD, KGS, RUB или KZT. Поля brand, category, storage и color заполняй только если они прямо есть в посте; иначе null. available — true только если наличие указано или не опровергнуто в свежем посте.`;

function toConversation(row) {
  return {
    id: Number(row.id),
    // Ключ идемпотентности для внешних систем (в CRM это deals.external_key).
    externalKey: row.external_key,
    source: row.source,
    externalChatId: row.external_chat_id,
    externalLeadId: row.external_lead_id,
    customerName: row.customer_name || row.customer_username || "Без имени",
    customerUsername: row.customer_username,
    customerPhone: row.customer_phone,
    aiEnabled: Boolean(row.ai_enabled),
    unreadCount: Number(row.unread_count || 0),
    notes: row.notes || "",
    status: row.status,
    lastMessageAt: row.last_message_at,
    lastMessage: row.last_message || "",
  };
}

class CrmService {
  constructor({ db, ai, deepseek, amocrm, azisCrm, crmDeals, fetchImpl } = {}) {
    this.db = db;
    this.deepseek = deepseek;
    this.ai = ai || deepseek;
    this.amocrm = amocrm;
    this.azisCrm = azisCrm;
    this.crmDeals = crmDeals;
    this.fetchImpl = fetchImpl || globalThis.fetch;
  }

  // Новый клиент → сделка в воронке MostovoyCRM.
  // Ничего не ждём и не бросаем: недоступная CRM не должна ни задерживать
  // ответ клиенту, ни ронять обработку сообщения. Пропуск не потеряется —
  // CRM сверяется с /api/admin/crm/conversations.
  _publishDeal(conversation) {
    if (!this.crmDeals?.enabled) return;
    void this.crmDeals
      .createDeal({
        externalKey: conversation.external_key,
        source: conversation.source,
        customerName: conversation.customer_name,
        customerPhone: conversation.customer_phone,
        customerUsername: conversation.customer_username,
      })
      .catch((error) =>
        logger.error("crm_deals.publish_failed", {
          externalKey: conversation.external_key,
          error: error.message,
        })
      );
  }

  _publishPrimaryContact(conversation) {
    if (!this.crmDeals?.enabled || typeof this.crmDeals.advanceToPrimaryContact !== "function") return;
    void this.crmDeals
      .advanceToPrimaryContact({ externalKey: conversation.external_key })
      .then((result) => {
        this._logEvent(conversation.id, "info", "crm", "deal.primary_contact", "Сделка переведена в первичный контакт", {
          moved: Boolean(result?.moved),
          stageName: result?.stageName || null,
        });
      })
      .catch((error) =>
        logger.error("crm_deals.advance_failed", {
          externalKey: conversation.external_key,
          error: error.message,
        })
      );
  }

  _publishAzis(type, payload) {
    if (!this.azisCrm?.enabled) return;
    void this.azisCrm.publishEvent(type, payload).catch((error) =>
      logger.error("azis_crm.publish_failed", { type, error: error.message })
    );
  }

  _publishMessage(conversation, data) {
    this._publishAzis("message", {
      channel: conversation.source,
      externalChatId: conversation.external_chat_id,
      externalLeadId: conversation.external_lead_id,
      externalContactId: conversation.external_contact_id,
      customerName: conversation.customer_name,
      customerUsername: conversation.customer_username,
      customerPhone: conversation.customer_phone,
      externalMessageId: data.externalMessageId,
      direction: data.direction,
      sender: data.sender,
      text: data.text,
      status: data.status || "stored",
      createdAt: data.createdAt || new Date().toISOString(),
      raw: data.raw,
    });
  }

  listConversations() {
    return this.db.prepare(
      `SELECT c.*,
        (SELECT text FROM crm_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
       FROM crm_conversations c ORDER BY c.last_message_at DESC, c.id DESC`
    ).all().map(toConversation);
  }

  getConversation(id, { markRead = false } = {}) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    if (markRead) this.db.prepare("UPDATE crm_conversations SET unread_count = 0 WHERE id = ?").run(id);
    const messages = this.db.prepare(
      "SELECT id, direction, sender, text, status, created_at FROM crm_messages WHERE conversation_id = ? ORDER BY id ASC"
    ).all(id).map((m) => ({
      id: Number(m.id),
      direction: m.direction,
      sender: m.sender,
      text: m.text,
      status: m.status,
      createdAt: m.created_at,
    }));
    return { conversation: toConversation({ ...row, unread_count: markRead ? 0 : row.unread_count }), messages };
  }

  updateConversation(id, patch) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    const aiEnabled = patch.aiEnabled === undefined ? row.ai_enabled : patch.aiEnabled ? 1 : 0;
    const notes = patch.notes === undefined ? row.notes : String(patch.notes || "").slice(0, 4000);
    const status = patch.status === "closed" ? "closed" : patch.status === "open" ? "open" : row.status;
    this.db.prepare(
      "UPDATE crm_conversations SET ai_enabled = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(aiEnabled, notes, status, id);
    return this.getConversation(id);
  }

  // Сбрасывает только переписку лида. Контакт, сделка, привязка к каналу,
  // продажи и аналитика остаются — новый диалог начинается с чистого листа.
  clearConversationHistory(id) {
    const conversation = this.db.prepare("SELECT id, created_at FROM crm_conversations WHERE id = ?").get(id);
    if (!conversation) return null;
    this.db.exec("BEGIN");
    try {
      const approvals = this.db.prepare("DELETE FROM bot_approvals WHERE conversation_id = ?").run(id).changes;
      const messages = this.db.prepare("DELETE FROM crm_messages WHERE conversation_id = ?").run(id).changes;
      this.db.prepare(
        "UPDATE crm_conversations SET unread_count = 0, last_message_at = created_at, updated_at = datetime('now') WHERE id = ?"
      ).run(id);
      this.db.exec("COMMIT");
      const removed = { messages: Number(messages), approvals: Number(approvals) };
      this._logEvent(id, "warn", "inbox", "conversation.history_cleared", "История лида очищена", removed);
      return { ...removed, conversation: this.getConversation(id) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getStatus() {
    const base = config.publicUrl || "https://mostovoy-store-production.up.railway.app";
    const secretPath = config.amocrm.webhookSecret
      ? `/${encodeURIComponent(config.amocrm.webhookSecret)}`
      : "";
    const azisSecretPath = config.azisCrm.integrationSecret
      ? `/${encodeURIComponent(config.azisCrm.integrationSecret)}`
      : "";
    return {
      telegram: Boolean(config.telegram.botToken),
      amocrm: Boolean(this.amocrm?.enabled),
      azisCrm: Boolean(this.azisCrm?.enabled),
      ai: Boolean(this.ai?.enabled),
      amocrmWebhook: `${base}/api/amocrm/webhook${secretPath}`,
      primaryWebhook: config.azisCrm.baseUrl
        ? `${config.azisCrm.baseUrl}/api/integrations/amo/webhook${azisSecretPath}`
        : `${base}/api/amocrm/webhook${secretPath}`,
    };
  }

  getSettings() {
    const rows = Object.fromEntries(
      this.db.prepare("SELECT key, value FROM crm_settings").all().map((row) => [row.key, row.value])
    );
    return {
      approvalEnabled: rows.bot_approval_enabled !== "false",
      aggressiveLearning: rows.bot_learning_mode === "aggressive",
      model: ALLOWED_MODELS.includes(rows.bot_model) ? rows.bot_model : config.deepseek.model,
      systemPrompt: rows.bot_system_prompt || rows.sales_prompt || DEFAULT_PROMPT,
      hypervisorPrompt: rows.bot_hypervisor_prompt || DEFAULT_HYPERVISOR_PROMPT,
      characterPrompt: rows.bot_character_prompt || DEFAULT_CHARACTER_PROMPT,
      rulesPrompt: rows.bot_rules_prompt || DEFAULT_RULES_PROMPT,
      taskPrompt: rows.bot_task_prompt || DEFAULT_TASK_PROMPT,
      models: typeof this.ai?.listModels === "function"
        ? this.ai.listModels()
        : MODELS.map((item) => ({ ...item, enabled: item.provider === "deepseek" && Boolean(this.ai?.enabled) })),
    };
  }

  saveSettings(payload = {}) {
    const current = this.getSettings();
    const values = {
      bot_approval_enabled: String(payload.approvalEnabled ?? current.approvalEnabled),
      bot_learning_mode: (payload.aggressiveLearning ?? current.aggressiveLearning) ? "aggressive" : "manual",
      bot_model: ALLOWED_MODELS.includes(payload.model) ? payload.model : current.model,
      bot_system_prompt: String(payload.systemPrompt ?? current.systemPrompt).trim().slice(0, 16000) || DEFAULT_PROMPT,
      bot_hypervisor_prompt: String(payload.hypervisorPrompt ?? current.hypervisorPrompt).trim().slice(0, 8000) || DEFAULT_HYPERVISOR_PROMPT,
      bot_character_prompt: String(payload.characterPrompt ?? current.characterPrompt).trim().slice(0, 8000) || DEFAULT_CHARACTER_PROMPT,
      bot_rules_prompt: String(payload.rulesPrompt ?? current.rulesPrompt).trim().slice(0, 8000) || DEFAULT_RULES_PROMPT,
      bot_task_prompt: String(payload.taskPrompt ?? current.taskPrompt).trim().slice(0, 8000) || DEFAULT_TASK_PROMPT,
    };
    const upsert = this.db.prepare(
      `INSERT INTO crm_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    for (const [key, value] of Object.entries(values)) upsert.run(key, value);
    this._logEvent(null, "info", "settings", "settings.saved", "Настройки бота сохранены", {
      model: values.bot_model,
      approvalEnabled: values.bot_approval_enabled === "true",
      aggressiveLearning: values.bot_learning_mode === "aggressive",
    });
    return this.getSettings();
  }

  getBuyAnalytics(days = 30) {
    const analytics = getBuyClickAnalytics(this.db, days);
    const since = `-${analytics.periodDays - 1} days`;
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT conversation_id) AS count FROM (
         SELECT conversation_id FROM bot_approvals
          WHERE status = 'approved' AND decided_at >= datetime('now', ?)
         UNION
         SELECT conversation_id FROM crm_messages
          WHERE sender = 'manager' AND created_at >= datetime('now', ?)
       )`
    ).get(since, since);
    analytics.summary.handoffs = Number(row.count || 0);
    // Просмотры карточек — отдельная метрика, не смешиваем с кликами «Купить».
    analytics.views = getProductViewAnalytics(this.db, analytics.periodDays);
    return analytics;
  }

  _recordUsage(task, conversationId, model, usage = {}) {
    const promptTokens = Math.max(0, Number(usage.prompt_tokens || 0));
    const completionTokens = Math.max(0, Number(usage.completion_tokens || 0));
    const totalTokens = Math.max(0, Number(usage.total_tokens || promptTokens + completionTokens));
    const hasKnownPricing = String(model || "").startsWith("deepseek-");
    const inputCost = hasKnownPricing ? promptTokens / 1_000_000 * DEEPSEEK_INPUT_USD_PER_MILLION : 0;
    const outputCost = hasKnownPricing ? completionTokens / 1_000_000 * DEEPSEEK_OUTPUT_USD_PER_MILLION : 0;
    this.db.prepare(
      `INSERT INTO ai_usage
        (conversation_id, task, model, prompt_tokens, completion_tokens, total_tokens,
         input_cost_usd, output_cost_usd, total_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId == null ? null : Number(conversationId),
      task,
      String(model || this.getSettings().model),
      promptTokens,
      completionTokens,
      totalTokens,
      inputCost,
      outputCost,
      inputCost + outputCost
    );
    const conversation = conversationId == null
      ? null
      : this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    this._publishAzis("ai_usage", {
      task,
      model: String(model || this.getSettings().model),
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd: inputCost + outputCost,
      channel: conversation?.source || "amocrm",
      externalChatId: conversation?.external_chat_id || null,
      externalLeadId: conversation?.external_lead_id || null,
      externalContactId: conversation?.external_contact_id || null,
    });
  }

  _usageRecorder(task, conversationId, fallbackModel) {
    return (usage, model) => this._recordUsage(task, conversationId, model || fallbackModel, usage);
  }

  getAiUsageAnalytics() {
    const period = (modifier) => this.db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(total_cost_usd), 0) AS cost
       FROM ai_usage ${modifier ? "WHERE created_at >= datetime('now', ?)" : ""}`
    ).get(...(modifier ? [modifier] : []));
    const today = period("start of day");
    const month = period("-30 days");
    const year = period("-365 days");
    const all = period();
    const activeDays = this.db.prepare(
      "SELECT COUNT(DISTINCT date(created_at)) AS count FROM ai_usage"
    ).get();
    const tasks = this.db.prepare(
      `SELECT task, model, COUNT(*) AS calls, SUM(total_tokens) AS tokens,
              SUM(total_cost_usd) AS cost
       FROM ai_usage GROUP BY task, model ORDER BY cost DESC, tokens DESC`
    ).all().map((row) => ({
      task: row.task,
      model: row.model,
      calls: Number(row.calls || 0),
      tokens: Number(row.tokens || 0),
      costUsd: Number(row.cost || 0),
    }));
    const overview = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM crm_conversations) AS conversations,
        (SELECT COUNT(*) FROM crm_messages) AS messages,
        (SELECT COUNT(*) FROM bot_approvals) AS aiReplies,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'approved') AS approved,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'approved' AND edited_reply IS NULL) AS withoutEdits,
        (SELECT COUNT(*) FROM bot_approvals WHERE status = 'rejected') AS rejected`
    ).get();
    const normalize = (row) => ({ tokens: Number(row.tokens || 0), costUsd: Number(row.cost || 0) });
    return {
      overview: Object.fromEntries(Object.entries(overview).map(([key, value]) => [key, Number(value || 0)])),
      periods: {
        today: normalize(today),
        averageDay: {
          tokens: Math.round(Number(all.tokens || 0) / Math.max(1, Number(activeDays.count || 0))),
          costUsd: Number(all.cost || 0) / Math.max(1, Number(activeDays.count || 0)),
        },
        month: normalize(month),
        year: normalize(year),
        all: normalize(all),
      },
      tasks,
      pricing: {
        inputUsdPerMillion: DEEPSEEK_INPUT_USD_PER_MILLION,
        outputUsdPerMillion: DEEPSEEK_OUTPUT_USD_PER_MILLION,
      },
    };
  }

  _logEvent(conversationId, level, stage, event, message, details) {
    this.db.prepare(
      `INSERT INTO bot_events (conversation_id, level, stage, event, message, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId == null ? null : Number(conversationId),
      level,
      stage,
      event,
      message || null,
      details ? JSON.stringify(details) : null
    );
  }

  listEvents({ level, limit = 150 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 150));
    const rows = level === "error"
      ? this.db.prepare("SELECT * FROM bot_events WHERE level = 'error' ORDER BY id DESC LIMIT ?").all(safeLimit)
      : this.db.prepare("SELECT * FROM bot_events ORDER BY id DESC LIMIT ?").all(safeLimit);
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: row.conversation_id == null ? null : Number(row.conversation_id),
      level: row.level,
      stage: row.stage,
      event: row.event,
      message: row.message,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: row.created_at,
    }));
  }

  getDeveloperStatus() {
    const approvals = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM bot_approvals`
    ).get();
    const errors = this.db.prepare(
      "SELECT COUNT(*) AS count FROM bot_events WHERE level = 'error' AND created_at >= datetime('now', '-24 hours')"
    ).get();
    return {
      enabled: Boolean(this.ai?.enabled),
      settings: this.getSettings(),
      approvals: {
        total: Number(approvals.total || 0),
        pending: Number(approvals.pending || 0),
        approved: Number(approvals.approved || 0),
        rejected: Number(approvals.rejected || 0),
      },
      errors24h: Number(errors.count || 0),
    };
  }

  listApprovals(status = "pending") {
    const allowed = ["pending", "approved", "rejected", "all"];
    const selected = allowed.includes(status) ? status : "pending";
    const rows = selected === "all"
      ? this.db.prepare(
        `SELECT a.*, c.customer_name, c.source FROM bot_approvals a
         JOIN crm_conversations c ON c.id = a.conversation_id
         ORDER BY a.id DESC LIMIT 100`
      ).all()
      : this.db.prepare(
        `SELECT a.*, c.customer_name, c.source FROM bot_approvals a
         JOIN crm_conversations c ON c.id = a.conversation_id
         WHERE a.status = ? ORDER BY a.id DESC LIMIT 100`
      ).all(selected);
    return rows.map((row) => ({
      id: Number(row.id),
      conversationId: Number(row.conversation_id),
      customerName: row.customer_name || "Без имени",
      source: row.source,
      customerMessage: row.customer_message,
      aiReply: row.ai_reply,
      editedReply: row.edited_reply,
      rejectReason: row.reject_reason,
      summary: row.conversation_summary,
      model: row.model,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
    }));
  }

  async approveReply(id, text) {
    const row = this.db.prepare("SELECT * FROM bot_approvals WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Черновик не найден");
    if (row.status !== "pending") throw new Error("Черновик уже обработан");
    const finalText = String(text || row.edited_reply || row.ai_reply).trim().slice(0, 4000);
    if (!finalText) throw new Error("Ответ пустой");
    await this._send(Number(row.conversation_id), finalText, "assistant");
    this.db.prepare(
      `UPDATE bot_approvals SET status = 'approved', edited_reply = ?, decided_at = datetime('now')
       WHERE id = ?`
    ).run(finalText === row.ai_reply ? null : finalText, row.id);
    this._saveTrainingExample(row, {
      qualityLabel: "accepted",
      finalReply: finalText,
      wasEdited: finalText !== row.ai_reply,
    });
    this._logEvent(row.conversation_id, "info", "approval", "approval.approved", "Ответ подтверждён и отправлен", {
      approvalId: Number(row.id),
      edited: finalText !== row.ai_reply,
    });
    return this.listApprovals("all").find((item) => item.id === Number(row.id));
  }

  async rejectReply(id, reason) {
    const row = this.db.prepare("SELECT * FROM bot_approvals WHERE id = ?").get(Number(id));
    if (!row) throw new Error("Черновик не найден");
    if (row.status !== "pending") throw new Error("Черновик уже обработан");
    const rejectReason = String(reason || "").trim().slice(0, 2000);
    if (!rejectReason) throw new Error("Укажите причину отклонения");
    this.db.prepare(
      `UPDATE bot_approvals SET status = 'rejected', reject_reason = ?,
       decided_at = datetime('now') WHERE id = ?`
    ).run(rejectReason, row.id);
    this._saveTrainingExample(row, {
      qualityLabel: "rejected",
      rejectReason,
    });
    this._logEvent(row.conversation_id, "warn", "approval", "approval.rejected", "Ответ отклонён менеджером", {
      approvalId: Number(row.id),
      reason: rejectReason,
    });
    if (this.getSettings().aggressiveLearning) {
      try {
        await this._calibratePromptFromReject(row, rejectReason);
      } catch (error) {
        this._logEvent(row.conversation_id, "error", "learning", "learning.failed", error.message, {
          approvalId: Number(row.id),
        });
      }
    }
    return this.listApprovals("all").find((item) => item.id === Number(row.id));
  }

  _saveTrainingExample(row, { qualityLabel, finalReply = null, wasEdited = false, rejectReason = null }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO bot_training_examples
        (approval_id, conversation_id, customer_message, ai_reply, final_reply,
         was_edited, quality_label, reject_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      row.conversation_id,
      row.customer_message,
      row.ai_reply,
      finalReply,
      wasEdited ? 1 : 0,
      qualityLabel,
      rejectReason
    );
  }

  async _calibratePromptFromReject(row, reason) {
    if (!this.ai?.enabled || typeof this.ai.chatJson !== "function") return;
    const settings = this.getSettings();
    const result = await this.ai.chatJson({
      system: `Ты калибруешь системный промпт продавца магазина техники.
Верни JSON с полями prompt_patch и reasoning.
prompt_patch — не больше двух коротких предложений, только универсальное правило.
Если замечание относится лишь к единичному случаю, верни пустой prompt_patch.`,
      user: JSON.stringify({
        customer_message: row.customer_message,
        rejected_reply: row.ai_reply,
        reject_reason: reason,
        current_system_prompt: settings.systemPrompt,
      }),
      temperature: 0.2,
      maxTokens: 350,
      model: settings.model,
      onUsage: this._usageRecorder("aggressive_learning", row.conversation_id, settings.model),
    });
    const patch = String(result?.prompt_patch || "").trim().slice(0, 1000);
    if (!patch || settings.systemPrompt.includes(patch)) return;
    const nextPrompt = `${settings.systemPrompt}\n\n${patch}`.slice(0, 16000);
    const upsert = this.db.prepare(
      `INSERT INTO crm_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    );
    let history = [];
    try {
      const saved = this.db.prepare("SELECT value FROM crm_settings WHERE key = 'bot_system_prompt_history'").get();
      history = saved?.value ? JSON.parse(saved.value) : [];
    } catch {
      history = [];
    }
    history.push({
      at: new Date().toISOString(),
      approvalId: Number(row.id),
      reason,
      patch,
      reasoning: String(result?.reasoning || "").slice(0, 2000),
      previousPrompt: settings.systemPrompt,
    });
    upsert.run("bot_system_prompt", nextPrompt);
    upsert.run("bot_system_prompt_history", JSON.stringify(history.slice(-200)));
    this._logEvent(row.conversation_id, "info", "learning", "prompt.auto_calibrated", "Системный промпт обновлён", {
      approvalId: Number(row.id),
      patch,
    });
  }

  async testBot({ message, history = [], model, prompts = {} } = {}) {
    const text = String(message || "").trim();
    if (!text) throw new Error("Введите сообщение тестового клиента");
    const settings = { ...this.getSettings(), ...prompts };
    const selectedModel = ALLOWED_MODELS.includes(model) ? model : settings.model;
    const startedAt = Date.now();
    const catalog = buildTelegramCatalogForAssistant(this.db);
    const selection = await this._selectCatalogProducts({
      conversationId: null,
      customerRequest: text,
      catalog,
    });
    const financeRequest = [...(Array.isArray(history) ? history : []), { role: "user", content: text }]
      .filter((message) => message?.role === "user")
      .map((message) => message.content)
      .join("\n");
    const finance = financeToolContext(financeRequest, selection);
    const reply = await this.ai.chatText({
      system: this._composePrompt(settings, [selection, finance].filter(Boolean).join("\n\n")),
      messages: Array.isArray(history) ? history.slice(-20) : [],
      user: text,
      model: selectedModel,
      onUsage: this._usageRecorder("laboratory", null, selectedModel),
    });
    this._logEvent(null, "info", "laboratory", "lab.reply_generated", "Лаборатория получила ответ", {
      model: selectedModel,
      latencyMs: Date.now() - startedAt,
    });
    return { reply, model: selectedModel, latencyMs: Date.now() - startedAt };
  }

  _composePrompt(settings, catalog) {
    return [
      settings.systemPrompt,
      `ХАРАКТЕР:\n${settings.characterPrompt}`,
      `ПРАВИЛА:\n${settings.rulesPrompt}`,
      `ЗАДАЧА:\n${settings.taskPrompt}`,
      ASSISTANT_PRICE_POLICY,
      catalog ? `АКТУАЛЬНЫЙ КАТАЛОГ:\n${catalog}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async _summarizeConversation(conversationId, history, settings) {
    this._logEvent(conversationId, "info", "hypervisor", "hypervisor.started", "Гипервизор пересказывает контекст диалога");
    try {
      const summary = await this.ai.chatText({
        system: settings.hypervisorPrompt,
        messages: history,
        model: settings.model,
        maxTokens: 260,
        temperature: 0.1,
        onUsage: this._usageRecorder("hypervisor_context", conversationId, settings.model),
      });
      const value = String(summary || "").trim().slice(0, 2000);
      this._logEvent(conversationId, "info", "hypervisor", "hypervisor.completed", "Контекст диалога подготовлен");
      return value || null;
    } catch (error) {
      this._logEvent(conversationId, "warn", "hypervisor", "hypervisor.failed", error.message);
      return null;
    }
  }

  _upsertConversation(data) {
    // Был ли диалог до этого — от этого зависит, сообщать ли CRM о новом клиенте.
    const known = this.db
      .prepare("SELECT 1 FROM crm_conversations WHERE external_key = ?")
      .get(data.externalKey);
    this.db.prepare(
      `INSERT INTO crm_conversations
        (external_key, source, external_chat_id, external_lead_id, external_contact_id,
         customer_name, customer_username, customer_phone, unread_count, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(external_key) DO UPDATE SET
         source = excluded.source,
         customer_name = COALESCE(excluded.customer_name, customer_name),
         customer_username = COALESCE(excluded.customer_username, customer_username),
         customer_phone = COALESCE(excluded.customer_phone, customer_phone),
         external_lead_id = COALESCE(excluded.external_lead_id, external_lead_id),
         external_contact_id = COALESCE(excluded.external_contact_id, external_contact_id),
         unread_count = unread_count + 1,
         last_message_at = excluded.last_message_at,
         updated_at = datetime('now')`
    ).run(
      data.externalKey, data.source, data.chatId, data.leadId || null, data.contactId || null,
      data.name || null, data.username || null, data.phone || null, data.createdAt || new Date().toISOString()
    );
    const conversation = this.db
      .prepare("SELECT * FROM crm_conversations WHERE external_key = ?")
      .get(data.externalKey);
    // Сделку заводим только на первое входящее от клиента: ручная отправка
    // менеджером (sendExternal) диалог тоже создаёт, но это не заявка.
    if (!known && data.inbound) this._publishDeal(conversation);
    return conversation;
  }

  _storeMessage(conversationId, data) {
    try {
      const result = this.db.prepare(
        `INSERT INTO crm_messages
          (conversation_id, external_message_id, direction, sender, text, status, raw_payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        conversationId, data.externalMessageId || null, data.direction, data.sender, data.text,
        data.status || "stored", data.raw ? JSON.stringify(data.raw) : null, data.createdAt || new Date().toISOString()
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) return null;
      throw error;
    }
  }

  async receiveTelegram(message) {
    const hasMedia = Boolean(message?.photo?.length || message?.voice || message?.audio);
    if ((!message?.text?.trim() && !message?.caption?.trim() && !hasMedia) || message.from?.is_bot || message.chat?.type !== "private") return;
    const chatId = String(message.chat.id);
    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
    const conversation = this._upsertConversation({
      externalKey: `telegram:${chatId}`,
      source: "telegram",
      inbound: true,
      chatId,
      name,
      username: message.from?.username ? `@${message.from.username}` : null,
      createdAt: new Date(Number(message.date || Date.now() / 1000) * 1000).toISOString(),
    });
    let text = String(message.text || message.caption || "").trim();
    if (hasMedia) {
      try {
        const media = message.photo?.length
          ? { kind: "image", file: message.photo.at(-1), mimeType: "image/jpeg" }
          : { kind: "audio", file: message.voice || message.audio, mimeType: (message.voice || message.audio)?.mime_type || "audio/ogg" };
        if (Number(media.file?.file_size || 0) > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const fileRes = await this.fetchImpl(
          `${config.telegram.apiBase}/bot${config.telegram.botToken}/getFile?file_id=${encodeURIComponent(media.file.file_id)}`
        );
        if (!fileRes.ok) throw new Error(`Telegram getFile: HTTP ${fileRes.status}`);
        const fileData = await fileRes.json();
        const filePath = fileData?.result?.file_path;
        if (!filePath) throw new Error("Telegram не вернул путь к файлу");
        const download = await this.fetchImpl(
          `${config.telegram.apiBase}/file/bot${config.telegram.botToken}/${filePath}`
        );
        if (!download.ok) throw new Error(`Telegram file: HTTP ${download.status}`);
        const bytes = Buffer.from(await download.arrayBuffer());
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const analysis = await this.ai.analyzeMedia({
          kind: media.kind,
          bytes,
          mimeType: media.mimeType,
          caption: text,
          onUsage: this._usageRecorder("media_analysis", conversation.id, this.getSettings().model),
        });
        text = [text, media.kind === "image" ? `[Изображение: ${analysis}]` : `[Аудио: ${analysis}]`]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "info", "media", "media.analyzed", "Вложение проанализировано", {
          kind: media.kind,
          bytes: bytes.length,
        });
      } catch (error) {
        text = [text, message.photo?.length ? "[Клиент прислал изображение]" : "[Клиент прислал аудио]"]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "error", "media", "media.failed", error.message);
      }
    }
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: String(message.message_id),
      direction: "incoming",
      sender: "customer",
      text,
      raw: message,
    });
    if (inserted) {
      this._publishMessage(conversation, {
        externalMessageId: String(message.message_id),
        direction: "incoming",
        sender: "customer",
        text,
        raw: message,
      });
      this._logEvent(conversation.id, "info", "inbox", "message.received", "Получено сообщение из Telegram", {
        messageId: inserted,
      });
    }
    if (inserted && conversation.ai_enabled) {
      if (this._isDuplicateInbound(conversation.id, inserted, text)) {
        this._logEvent(conversation.id, "info", "inbox", "message.duplicate_suppressed", "Дубликат сообщения не запустил повторный ответ", { windowSeconds: 40 });
      } else {
        await this._autoReply(conversation.id, inserted);
      }
    }
  }

  async receiveAmo(incoming, raw) {
    if (!incoming.text || !incoming.chatId || incoming.direction !== "incoming") return { ignored: true };
    const source = /instagram/i.test(incoming.source)
      ? "instagram"
      : /whatsapp/i.test(incoming.source)
        ? "whatsapp"
        : "amocrm";
    const conversation = this._upsertConversation({
      externalKey: `amo:${incoming.chatId}`,
      source,
      inbound: true,
      chatId: incoming.chatId,
      leadId: incoming.leadId,
      contactId: incoming.contactId,
      name: incoming.customerName,
      username: incoming.customerUsername,
      phone: incoming.customerPhone,
      createdAt: incoming.createdAt,
    });
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: incoming.messageId,
      direction: "incoming",
      sender: "customer",
      text: incoming.text,
      raw,
      createdAt: incoming.createdAt,
    });
    if (inserted) {
      this._publishMessage(conversation, {
        externalMessageId: incoming.messageId,
        direction: "incoming",
        sender: "customer",
        text: incoming.text,
        raw,
        createdAt: incoming.createdAt,
      });
      this._logEvent(conversation.id, "info", "inbox", "message.received", `Получено сообщение из ${source}`, {
        messageId: inserted,
      });
    }
    if (inserted && conversation.ai_enabled) await this._autoReply(conversation.id, inserted);
    return { stored: Boolean(inserted), conversationId: Number(conversation.id) };
  }

  async _autoReply(conversationId, incomingMessageId) {
    if (!this.ai?.enabled) return;
    const detail = this.getConversation(conversationId);
    if (!detail?.conversation.aiEnabled) return;
    const settings = this.getSettings();
    // Перед каждым ответом берём свежую витрину Telegram-канала. Это поиск
    // по первоисточнику до вызова модели, а не ответ по памяти DeepSeek.
    try {
      const sync = await syncPublicChannelPosts({ db: this.db, maxPages: 1, fetchImpl: this.fetchImpl });
      this._logEvent(conversationId, "info", "catalog", "catalog.channel_synced", "Перед ответом обновлены публикации канала", sync);
    } catch (error) {
      this._logEvent(conversationId, "warn", "catalog", "catalog.channel_sync_failed", error.message);
    }
    const catalog = buildTelegramCatalogForAssistant(this.db);
    const history = detail.messages.slice(-14).map((m) => ({
      role: m.direction === "incoming" ? "user" : "assistant",
      content: m.text,
    }));
    const customerRequest = [...history].reverse().find((message) => message.role === "user")?.content || "";
    const selection = await this._selectCatalogProducts({
      conversationId,
      customerRequest,
      catalog,
    });
    const financeRequest = history.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    const finance = financeToolContext(financeRequest, selection);
    if (finance) this._recordFinanceRequest(conversationId, financeRequest, selection);
    const prompt = this._composePrompt(settings, [selection, finance].filter(Boolean).join("\n\n"));
    this._logEvent(conversationId, "info", "generation", "generation.started", "ИИ формирует черновик", {
      model: settings.model,
      incomingMessageId,
    });
    try {
      const reply = await this.ai.chatText({
        system: prompt,
        messages: history,
        model: settings.model,
        onUsage: this._usageRecorder("sales_agent", conversationId, settings.model),
      });
      const newestInbound = this.db.prepare(
        `SELECT id FROM crm_messages
          WHERE conversation_id = ? AND direction = 'incoming'
          ORDER BY id DESC LIMIT 1`
      ).get(conversationId);
      if (Number(newestInbound?.id) !== Number(incomingMessageId)) {
        this._logEvent(conversationId, "info", "generation", "generation.stale_discarded", "Черновик для устаревшего сообщения не отправлен", {
          incomingMessageId,
          newestIncomingMessageId: newestInbound?.id || null,
        });
        return;
      }
      if (settings.approvalEnabled) {
        const summary = await this._summarizeConversation(conversationId, history, settings);
        const customerMessage = [...detail.messages].reverse().find((message) => message.direction === "incoming")?.text || "";
        const result = this.db.prepare(
          `INSERT INTO bot_approvals
            (conversation_id, incoming_message_id, customer_message, ai_reply, conversation_summary, model)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(conversationId, incomingMessageId || null, customerMessage, reply, summary, settings.model);
        this._logEvent(conversationId, "info", "approval", "approval.created", "Черновик ждёт подтверждения", {
          approvalId: Number(result.lastInsertRowid),
        });
      } else {
        await this._send(conversationId, reply, "assistant");
        this._logEvent(conversationId, "info", "delivery", "reply.sent", "Автоответ отправлен без подтверждения");
      }
    } catch (error) {
      logger.error("crm.auto_reply_failed", { conversationId, error: error.message });
      this._logEvent(conversationId, "error", "generation", "generation.failed", error.message, {
        incomingMessageId,
      });
    }
  }

  async _selectCatalogProducts({ conversationId, customerRequest, catalog }) {
    if (!catalog) return "Товаровед не нашёл свежих публикаций канала.";
    if (!this.deepseek?.enabled || typeof this.deepseek.chatJson !== "function") {
      this._logEvent(conversationId, "warn", "catalog", "catalog.specialist_unavailable", "Товаровед DeepSeek недоступен");
      return "Товаровед временно недоступен. Не называй неподтверждённую цену; предложи только товары с известными данными или попроси один конкретный критерий выбора.";
    }
    try {
      const result = await this.deepseek.chatJson({
        system: CATALOG_SPECIALIST_PROMPT,
        user: `ЗАПРОС КЛИЕНТА:\n${customerRequest}\n\nАКТУАЛЬНАЯ БАЗА ИЗ TELEGRAM-КАНАЛА:\n${narrowCatalogForRequest(catalog, customerRequest)}`,
        maxTokens: 900,
        onUsage: this._usageRecorder("catalog_specialist", conversationId, config.deepseek.model),
      });
      const products = Array.isArray(result?.products)
        ? result.products.slice(0, 5).map((item) => {
          const price = Number(item?.price);
          const currency = String(item?.currency || "").toUpperCase();
          return {
            name: String(item?.name || "").trim(),
            brand: item?.brand ? String(item.brand).trim() : null,
            category: item?.category ? String(item.category).trim() : null,
            storage: item?.storage ? String(item.storage).trim() : null,
            color: item?.color ? String(item.color).trim() : null,
            price,
            currency,
            priceKgs: Math.ceil(convertAssistantPrice(price, currency, "KGS")),
            priceUsd: Math.ceil(convertAssistantPrice(price, currency, "USD")),
            priceRub: Math.ceil(convertAssistantPrice(price, currency, "RUB")),
            priceKzt: Math.ceil(convertAssistantPrice(price, currency, "KZT")),
            available: item?.available === true,
            reason: String(item?.reason || "").trim(),
          };
        }).filter((item) => item.name && Number.isFinite(item.price) && ["USD", "KGS", "RUB", "KZT"].includes(item.currency))
        : [];
      const selection = JSON.stringify({ products, note: String(result?.note || "").trim() });
      this._logEvent(conversationId, "info", "catalog", "catalog.specialist_selected", "Товаровед отобрал товары из канала", {
        productCount: products.length,
      });
      return `ПОДБОРКА ТОВАРОВЕДА ИЗ КАНАЛА:\n${selection}\n\nОтвечай только по этой подборке. Не говори, что обращался к товароведу или каналу.`;
    } catch (error) {
      this._logEvent(conversationId, "warn", "catalog", "catalog.specialist_failed", error.message);
      return "Товаровед временно не смог отобрать товары. Не называй неподтверждённую цену; попроси один конкретный критерий выбора и не упоминай менеджера.";
    }
  }

  _recordFinanceRequest(conversationId, request, selection) {
    if (!conversationId) return;
    const trade = tradeInEstimate(request);
    const product = selectedCatalogProduct(selection);
    const kind = /рассроч|в кредит|платеж.*месяц|ежемесяч/i.test(request) ? "Рассрочка" : "Trade-in";
    const details = [kind, product?.name, trade && `${trade.device} (${trade.condition})`].filter(Boolean).join(": ");
    const row = this.db.prepare("SELECT notes FROM crm_conversations WHERE id = ?").get(conversationId);
    if (!row || String(row.notes || "").includes(details)) return;
    const note = [String(row.notes || "").trim(), `Заявка: ${details}`].filter(Boolean).join("\n").slice(-4000);
    this.db.prepare("UPDATE crm_conversations SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(note, conversationId);
    this._logEvent(conversationId, "info", "commerce", "commerce.calculated", `Рассчитано: ${details}`, { kind, product: product?.name || null, tradeIn: trade || null });
  }

  _isDuplicateInbound(conversationId, messageId, text) {
    const value = String(text || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
    if (!value) return false;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM crm_messages
        WHERE conversation_id = ? AND direction = 'incoming' AND id != ?
          AND lower(trim(text)) = ?
          AND created_at >= datetime('now', '-40 seconds')
        LIMIT 1`
    ).get(conversationId, messageId, value));
  }

  async sendManual(conversationId, text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Сообщение пустое");
    return this._send(conversationId, value.slice(0, 4000), "manager");
  }

  async sendExternal({ source, chatId, leadId, contactId, text }) {
    const value = String(text || "").trim().slice(0, 4000);
    if (!value) throw new Error("Сообщение пустое");
    if (!chatId) throw new Error("chatId required");
    const normalizedSource = /instagram/i.test(source)
      ? "instagram"
      : /whatsapp/i.test(source)
        ? "whatsapp"
        : "amocrm";
    let conversation = this.db.prepare(
      "SELECT * FROM crm_conversations WHERE external_chat_id = ? ORDER BY id DESC LIMIT 1"
    ).get(String(chatId));
    if (!conversation) {
      conversation = this._upsertConversation({
        externalKey: `amo:${chatId}`,
        source: normalizedSource,
        chatId: String(chatId),
        leadId: leadId || null,
        contactId: contactId || null,
        createdAt: new Date().toISOString(),
      });
    }
    const detail = await this._send(Number(conversation.id), value, "manager");
    return { messageId: detail.messageId, conversationId: Number(conversation.id) };
  }

  _recommendedProductImage(text) {
    const reply = String(text || "").toLocaleLowerCase("ru-RU");
    if (!reply) return null;
    const products = this.db.prepare(
      `SELECT official_name, main_image_url FROM products
       WHERE status != 'hidden' AND main_image_url IS NOT NULL AND main_image_url != ''
       ORDER BY length(official_name) DESC`
    ).all();
    return products.find((product) => reply.includes(String(product.official_name).toLocaleLowerCase("ru-RU"))) || null;
  }

  async _sendTelegramProductPhoto(conversation, product) {
    if (!config.publicUrl || !product?.main_image_url) return;
    const photo = `${config.publicUrl}/api/images/webp?src=${encodeURIComponent(product.main_image_url)}&w=1200`;
    const res = await this.fetchImpl(`${config.telegram.apiBase}/bot${config.telegram.botToken}/sendPhoto`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: conversation.external_chat_id, photo }),
    });
    if (!res.ok) throw new Error(`Telegram photo: HTTP ${res.status}`);
  }

  async _send(conversationId, text, sender) {
    const c = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    if (!c) throw new Error("Диалог не найден");
    if (c.source === "telegram") {
      if (!config.telegram.botToken) throw new Error("Telegram bot не настроен");
      const res = await this.fetchImpl(`${config.telegram.apiBase}/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: c.external_chat_id,
          text: telegramHtml(text),
          parse_mode: "HTML",
        }),
      });
      if (!res.ok) throw new Error(`Telegram: HTTP ${res.status}`);
      if (sender === "assistant") {
        const product = this._recommendedProductImage(text);
        if (product) {
          try {
            await this._sendTelegramProductPhoto(c, product);
          } catch (error) {
            this._logEvent(c.id, "warn", "delivery", "product_photo.failed", error.message, { product: product.official_name });
          }
        }
      }
    } else {
      await this.amocrm.sendMessage({
        chatId: c.external_chat_id,
        leadId: c.external_lead_id,
        contactId: c.external_contact_id,
        text,
      });
    }
    const externalMessageId = `${sender}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._storeMessage(c.id, {
      externalMessageId,
      direction: "outgoing",
      sender,
      text,
      status: "sent",
    });
    this._publishMessage(c, {
      externalMessageId,
      direction: "outgoing",
      sender,
      text,
      status: "sent",
    });
    this.db.prepare(
      "UPDATE crm_conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(c.id);
    this._logEvent(c.id, "info", "delivery", "message.sent", "Сообщение отправлено клиенту", { sender });
    if (sender === "assistant" && /(?:\$\s*\d|\d[\d\s\u202f.,]*\s*(?:\$|сом\b|с\b|₽|₸))/iu.test(text)) {
      this._publishPrimaryContact(c);
    }
    return { ...this.getConversation(c.id), messageId: externalMessageId };
  }
}

module.exports = {
  CrmService,
  DEFAULT_PROMPT,
  DEFAULT_HYPERVISOR_PROMPT,
  DEFAULT_CHARACTER_PROMPT,
  DEFAULT_RULES_PROMPT,
  DEFAULT_TASK_PROMPT,
  buildTelegramCatalogForAssistant,
  narrowCatalogForRequest,
  formatAssistantPrice,
  telegramHtml,
  toConversation,
};
