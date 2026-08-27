const fs = require("node:fs");
const path = require("node:path");
const config = require("../config");
const logger = require("../logger");
const { getBuyClickAnalytics, getProductViewAnalytics } = require("./buy-analytics");
const { MODELS, modelInfo } = require("./ai");
const { syncPublicChannelPosts } = require("../cli/import-public-channel");
const { classifyTemplate, templateById, ROUTED_TEMPLATE_IDS, ROUTE_TOOL_DESCRIPTION } = require("./templates");
const { toGreenApiChatId } = require("./greenapi");
const { findInstagramStoryUrls } = require("./instagram/parser");
const { formatStoryContext } = require("./instagram/contextFormatter");

// Диалоги лаборатории WhatsApp (external_key "lab:…"): проходят ровно тот же
// пайплайн, что настоящие клиенты, но ничего не уходит наружу — ни в Green
// API, ни сделкой/этапом/уведомлением в CRM, ни событием в Azis CRM.
const LAB_KEY_PREFIX = "lab:";
function isLabConversation(conversation) {
  return String(conversation?.external_key || "").startsWith(LAB_KEY_PREFIX);
}

// Категории/бренды, которых нет в самих постах канала (посты — только
// конкретные SKU с ценой). Читается один раз при старте процесса: если
// файла нет, бот просто не получает этот контекст, не падает.
const KNOWLEDGE_BASE = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, "..", "..", "knowledge_base.md"), "utf-8").trim();
  } catch {
    return "";
  }
})();

function escapeTelegramHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function amoMediaKind(messageType) {
  const type = String(messageType || "").toLowerCase();
  if (["picture", "image", "photo"].includes(type)) return "image";
  if (["voice", "audio"].includes(type)) return "audio";
  return null;
}

function mediaMimeType(kind, url, header) {
  const contentType = String(header || "").split(";")[0].trim();
  if (contentType.startsWith(`${kind}/`)) return contentType;
  const extension = String(url || "").split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (kind === "image") return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  return "audio/ogg";
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
const DEFAULT_RULES_PROMPT = `Не выдумывай наличие, цены и условия. Не обещай то, чего нет в каталоге. На вопрос о наличии, рассрочке, доставке или характеристиках отвечай сам по данным каталога. Если клиент назвал конкретный бюджет или категорию — сразу предложи 2–3 подходящих товара с ценами. Если клиент просит именно СОВЕТ («какой посоветуете», «что лучше взять»), не называя бюджет или конкретную линейку, — не вываливай голый список всех моделей без цены: сначала одним вопросом уточни бюджет («На какой бюджет ориентируетесь?» или похожее), и только получив ответ — порекомендуй 2–3 конкретных варианта с ценами и коротким объяснением, почему именно они подходят. Один уточняющий вопрос допустим только после подборки или если подходящих товаров действительно нет. Менеджера можно упомянуть только по прямой просьбе клиента либо когда клиент просит оформить заказ, резерв или живой осмотр. После цены или подборки не заканчивай ответ: предложи один конкретный следующий шаг — оформить заказ, зарезервировать выбранную модель либо рассчитать Trade-in или рассрочку.
Если клиент спрашивает в целом, что за техника есть, какие категории или бренды в наличии (не называя конкретную модель или категорию) — не переспрашивай и не проси уточнить задачу или цель. Сразу перечисли реальные категории магазина: iPhone, Samsung, MacBook, iPad, Apple Watch, AirPods, Dyson, Garmin, Whoop, Ray-Ban Meta, Canon, умные колонки, Trade-in телефонов, рассрочка. После списка можно одним коротким вопросом уточнить, что из этого интересует. Если клиент прямо говорит «я не знаю» или «назовите все категории» — не предлагай ему сформулировать задачу, а повтори список категорий.
Отвечай как живой продажник, а не справочник: не обрывай сообщение сразу после списка товаров или ответа на вопрос. Если назвал несколько моделей на выбор — в конце спроси что-то вроде «Определились с выбором?» или «Какая больше нравится?». Если назвал одну модель с ценой — предложи следующий шаг (оформить, зарезервировать, рассчитать рассрочку). Ответ должен вести разговор вперёд, а не просто закрывать вопрос клиента.
Когда клиент спрашивает про конкретный товар (особенно менее известные категории вроде фитнес-браслетов, умных часов, колонок — не только iPhone и MacBook), не отвечай одной сухой фразой вроде «это браслет для здоровья». В подборке у товара есть поле description — используй его, чтобы презентовать товар: что он умеет, чем впечатляет, какие ощущения от использования. Пересказывай своими словами живо и кратко, а не зачитывай description дословно длинным блоком. Если description не пришёл — опиши товар по названию и категории коротко и честно, не выдумывая характеристик, которых не называл.
Используй уместные эмодзи для тепла и живости (😊 🔥 ✅ и похожие) — не сухим текстом, но не более одного-двух на сообщение. Если клиент сам обращается «брат» или «бро» — поддержи этот тон по-свойски, например «Брат, что из техники присматриваете?», но обращайся к клиенту по-прежнему на «вы» и не используй эти слова в каждом сообщении подряд — только когда это звучит естественно.
Никогда не хвали «выбор» клиента фразами вроде «Отличный выбор!», «Хороший выбор!», если клиент ничего конкретного ещё не выбрал — например, просто попросил совет, назвал категорию или задал общий вопрос («какой айфон посоветуете», «что у вас есть»). Такую похвалу уместно говорить только после того, как клиент сам назвал конкретную модель, цвет или вариант. На просьбу совета сразу переходи к сути: покажи 2–3 подходящих варианта без вступительной похвалы.
Никогда не проси имя, телефон, город или адрес и не пиши «оформим»/«оформляем», пока в этом диалоге не была названа ТОЧНАЯ цена КОНКРЕТНОЙ модели (с памятью и цветом, если они у товара есть) и клиент явно не подтвердил именно её. Общее пожелание («самую жирную», «подороже», «что покруче», «беру» без названной модели) — это ещё не подтверждение: сначала покажи точный товар с ценой и предложи выбрать между вариантами, и только когда клиент назовёт или подтвердит конкретный вариант — переходи к сбору контактов.`;
const DEFAULT_TASK_PROMPT = `Помоги клиенту выбрать подходящий товар, ответь на вопрос и веди продажу до конкретного следующего действия. Не начинай с вопросов, если уже можно показать подходящие варианты. После выбора или цены предложи оформить заказ или резерв; только после согласия попроси имя и удобный способ связи.`;
const DEFAULT_SUPERVISOR_PROMPT = `Ты — внутренний контролёр качества ответов продавца-консультанта магазина техники МОСТОВОЙ. Клиент тебя не видит, это второй проход перед отправкой черновика.

Проверь черновик по истории переписки и последнему сообщению клиента:
- отвечает по существу на вопрос клиента, не игнорирует его и не уходит от ответа;
- не использует внутренние термины «подборка», «каталог», «база», «мне передали список» — клиент не должен видеть кухню;
- не выдумывает цену, наличие, скидку, характеристику или срок доставки, которых нет в переданных клиенту данных; фраза «нет в наличии» без явного подтверждения из этих данных — ошибка;
- если клиент явно просил показать все модели или весь ассортимент категории — черновик должен перечислять реально много позиций, а не 2–3 штуки; короткий ответ на такой прямой запрос тоже ошибка;
- после названной цены или подборки заканчивается конкретным следующим шагом (оформить, зарезервировать, рассчитать рассрочку или Trade-in), а не обрывается на списке;
- не повторяет приветствие, если это не первое сообщение диалога;
- не признаётся, что это ИИ или бот;
- не содержит незакрытых или нестандартных тегов вроде <ЧТО-ТО>...</ЧТО-ТО> — таких меток в системе нет, весь текст клиент увидит буквально, включая любые теги.

Если черновик уже хороший — верни status "approved", corrected_reply оставь пустой строкой.
Если есть проблема — верни status "rewrite" и в corrected_reply готовый естественный текст для отправки клиенту (сам ответ, а не описание проблемы), который исправляет её и сохраняет всё верное из черновика.

Верни только JSON без markdown: {"status": "approved" или "rewrite", "corrected_reply": "строка", "issue": "коротко в чём проблема, пусто если approved"}.`;

// Первый контакт с новым клиентом. Если это просто приветствие/старт диалога —
// шлём это сообщение как есть, без ИИ. Если клиент сразу задал вопрос — ИИ
// отвечает на вопрос, а этот текст (в укороченном виде, см. FIRST_CONTACT_CATALOG_TEXT)
// добавляется в конец ответа.
const FIRST_CONTACT_WELCOME_TEXT = `Здравствуйте! 😊 Очень рады видеть вас в MOSTOVOY SHOP!
У нас только оригинальная техника: смартфоны, ноутбуки, наушники, часы, камеры и многое другое.

Выберите нужную категорию:

📱 iPhone
📱 Samsung
⌚ Apple Watch
🎧 AirPods
💻 MacBook
📲 iPad
⌚ Garmin
🌪️ Dyson
🏃 Whoop 5.0
🕶️ Ray-Ban Meta Gen 2
📷 Canon G7X Mark III
🔊 Яндекс Станция

Также у нас доступны:

🔄 Trade-in — обмен старого смартфона на новый с доплатой.
💳 Рассрочка — покупка техники с оплатой частями.

Какую технику хотите? 😊 Напишите, и мы подберём лучший вариант под ваш бюджет.`;

const FIRST_CONTACT_CATALOG_TEXT = `Вот наш актуальный каталог товаров:

📱 iPhone
📱 Samsung
⌚ Apple Watch
🎧 AirPods
💻 MacBook
📲 iPad
⌚ Garmin
🌪️ Dyson
🏃 Whoop 5.0
🕶️ Ray-Ban Meta Gen 2
📷 Canon G7X Mark III
🔊 Яндекс Станция

Также доступны:

🔄 Trade-in — обмен старого смартфона на новый с доплатой.
💳 Рассрочка — покупка техники с оплатой частями.

Какую технику хотите? 😊 Выберите категорию или напишите, что именно ищете.`;

// Первое сообщение нового клиента без конкретного вопроса ("привет",
// "/start" и т.п.) — просто открывает диалог, ответа по существу не требует.
function isFirstContactGreeting(text) {
  const value = String(text || "").trim().toLocaleLowerCase("ru");
  if (!value) return true;
  return /^[/!]?(привет|здравствуй(?:те)?|добрый\s+(?:день|вечер|утро)|хай|start|hi|hello|здрасте|йо)[\s!.,]*$/u.test(value);
}

function isStartCommand(text) {
  return /^\/start(?:\s.*)?$/iu.test(String(text || "").trim());
}

// Клиент не ответил после подборки/вопроса — бот сам напоминает о себе,
// а не ждёт молча. Цепочка из трёх ступеней: через несколько часов, на
// следующий день (либо после развёрнутой консультации — другой текст), и
// финальное сообщение, если клиент так и не откликнулся.
const NUDGE_HOURS_DELAY = "+3 hours";
const NUDGE_DAY_DELAY = "+27 hours";
const NUDGE_LAST_DELAY = "+75 hours";
// «Не завершил заказ»: клиент сказал «беру»/«оформляйте», но не ответил
// дальше — напоминаем один раз через тот же интервал, что и первую ступень.
const NUDGE_ORDER_INCOMPLETE_DELAY = "+3 hours";
// Диалог длиннее этого числа входящих сообщений считается развёрнутой
// консультацией — тогда на второй ступени другой текст.
const CONSULTATION_MESSAGE_THRESHOLD = 3;
// Пауза перед автоответом, чтобы собрать несколько сообщений клиента подряд
// в один ответ вместо серии отдельных.
const AUTO_REPLY_DEBOUNCE_MS = 3000;

// Имя клиента в Telegram — это его собственный профильный first_name, не то,
// что бот сам разобрал из текста. Спам/бот-аккаунты иногда ставят себе имя
// вроде ссылки ("https://...") — такое в шаблон не подставляем, выглядит
// неуместно в сообщении от менеджера. Настоящее имя человека такому не
// соответствует.
function isLikelyHumanName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return false;
  if (/https?:|www\.|t\.me\/|@|\d{3,}/i.test(trimmed)) return false;
  return true;
}

function fillNudgeTemplate(template, { clientName, productName } = {}) {
  const safeName = isLikelyHumanName(clientName) ? clientName : null;
  let text = String(template || "");
  text = safeName
    ? text.replaceAll("{{client_name}}", safeName)
    : text.replace(/,?\s*\{\{client_name\}\}/g, "").replace(/^,\s*/, "");
  text = text.replaceAll("{{product_name}}", productName || "интересующим вас товаром");
  return text.trim();
}

// Кыргызстан — фиксированный UTC+6 круглый год, без перехода на летнее
// время, поэтому окно активности можно держать как простой сдвиг по UTC-часам,
// без Intl/часовых поясов. 9:00–22:00 в Бишкеке — это 03:00–16:00 UTC.
const ACTIVE_HOURS_START_UTC = 3;
const ACTIVE_HOURS_END_UTC = 16;

function isWithinActiveHours(date) {
  const hour = date.getUTCHours();
  return hour >= ACTIVE_HOURS_START_UTC && hour < ACTIVE_HOURS_END_UTC;
}

// Следующее начало окна активности (9:00 по Бишкеку) после переданного момента.
function nextActiveWindowStart(date) {
  const next = new Date(date);
  next.setUTCMinutes(0, 0, 0);
  if (date.getUTCHours() < ACTIVE_HOURS_START_UTC) {
    next.setUTCHours(ACTIVE_HOURS_START_UTC);
  } else {
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(ACTIVE_HOURS_START_UTC);
  }
  return next;
}

// Проактивные сообщения, отправленные в первые часы окна (9:00–11:00 по
// Бишкеку), здороваются «Доброе утро» вместо «Здравствуйте»/«Добрый день» —
// особенно заметно для напоминаний, перенесённых с ночи на утро.
function withTimeAwareGreeting(text, date) {
  const hour = date.getUTCHours();
  const isMorning = hour >= ACTIVE_HOURS_START_UTC && hour < ACTIVE_HOURS_START_UTC + 2;
  if (!isMorning) return text;
  return text.replace(/^(Здравствуйте|Добрый день)([.,!]?)/, "Доброе утро$2");
}

function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const NUDGE_TEMPLATES = {
  hours: "Здравствуйте, {{client_name}} 😊 Хотела уточнить, остались ли у вас вопросы по {{product_name}}? Могу коротко рассказать подробнее или помочь подобрать другой вариант.",
  day: "Добрый день, {{client_name}}! Вчера вы интересовались {{product_name}}. Подскажите, вы ещё рассматриваете его или пока решили отложить покупку? 😊",
  consultation: "Добрый день! 😊 Хотела узнать, удалось ли вам определиться после нашей консультации? Могу ещё раз коротко сравнить подходящие варианты.",
  last: "{{client_name}}, больше не буду отвлекать 🙂 Если вопрос по {{product_name}} ещё актуален, просто напишите — продолжим с того места, где остановились.",
  order_incomplete: "Здравствуйте 😊 Вижу, что мы не закончили оформление {{product_name}}. Хотите продолжить или заказ уже неактуален?",
};

// Реактивные ответы на явные возражения — отправляются вместо полноценной
// генерации ИИ, экономят токены и звучат последовательно при частом
// повторении одного и того же возражения в разных диалогах.
const REACTIVE_TEMPLATES = [
  {
    kind: "thinking",
    pattern: /(?:я\s+)?подума(?:ю|ем)|над(?:о|а)\s+подумать|дай(?:те)?\s+подумать|мне\s+нужно\s+время|рассмотрю\s+ещ[её]/iu,
    text: "Хорошо, понимаю. Подскажите только, что пока останавливает: цена, сомнения в результате или хотите сравнить с другими вариантами?",
  },
  {
    kind: "expensive",
    pattern: /дорог(?:о|овато|ая|ой)|не\s+потяну|не\s+укладываюсь\s+в\s+бюджет|дешевле\s+есть|скидк[уи]\s+можно/iu,
    text: "Понимаю вас. Могу подобрать более доступный вариант с похожим назначением. На какую сумму вы примерно рассчитываете?",
  },
];

// Системный промпт ИИ-роутера шаблонов (см. _routeTemplate и templates.js).
const TEMPLATE_ROUTE_PROMPT = `Ты — маршрутизатор ответов продавца магазина техники МОСТОВОЙ. Если сообщение клиента однозначно попадает под один из готовых сценариев ниже — верни его id. Учитывай историю диалога: не выбирай шаблон, если такой ответ уже отправлялся на этот же вопрос или противоречит тому, что клиент уже говорил. Выбирай только если уверен; при малейшем сомнении, шутке, вопросе про конкретный товар, цену или наличие, составном вопросе с другими темами — верни null.`;

const MOSTOVOY_SALES_TEMPLATES = {
  location: {
    ru: "Мы находимся в Бишкеке, в Свердловском районе. Хотите приехать в шоу-рум или оформить доставку?",
    ky: "Биз Бишкектин Свердлов районунда жайгашканбыз. Шоурумга келесизби же жеткирүү керекпи?",
  },
  delivery: {
    ru: "Доставим с радостью! 😊 По Бишкеку обычно занимает 1–2 дня, также доставляем по всему Кыргызстану. Какую технику и в какой город вам доставить?",
    ky: "Жеткиребиз! 😊 Бишкек боюнча адатта 1–2 күнгө созулат, Кыргызстандын башка аймактарына да жеткиребиз. Кайсы техниканы кайсы шаарга жеткирүү керек?",
  },
  warranty: {
    ru: "На технику действует официальная гарантия 1 год. Какую модель рассматриваете?",
    ky: "Техникага 1 жылдык расмий кепилдик берилет. Кайсы моделди карап жатасыз?",
  },
  installment: {
    ru: "Да, доступна рассрочка на 3, 6 или 12 месяцев. Назовите модель и срок — рассчитаю ежемесячный платёж.",
    ky: "Ооба, 3, 6 же 12 айга бөлүп төлөө бар. Моделди жана мөөнөттү жазыңыз — айлык төлөмдү эсептеп берем.",
  },
  trade_in: {
    ru: "Да, у нас есть Trade-in: оценим ваше устройство и вычтем его стоимость из цены нового. Напишите модель и состояние устройства.",
    ky: "Ооба, Trade-in бар: түзмөгүңүздү баалап, анын баасын жаңы товардын наркынан алып салабыз. Моделин жана абалын жазыңыз.",
  },
  trust: {
    ru: "Мы — магазин техники MOSTOVOY SHOP в Бишкеке. Можно приехать в шоу-рум, посмотреть товар лично и получить официальную гарантию на 1 год. Какую модель хотите проверить?",
    ky: "Биз Бишкектеги MOSTOVOY SHOP техника дүкөнүбүз. Шоурумга келип, товарды өзүңүз көрүп, 1 жылдык расмий кепилдик ала аласыз. Кайсы моделди текшергиңиз келет?",
  },
  order: {
    ru: "Оформим 😊 Пришлите имя, номер телефона и выбранную модель с памятью и цветом. Для доставки также укажите город и адрес.",
    ky: "Оформдойбуз 😊 Атыңызды, телефон номериңизди жана тандалган моделдин эс тутуму менен түсүн жазыңыз. Жеткирүү үчүн шаарды жана даректи да көрсөтүңүз.",
  },
};

const KYRGYZ_SALES_MARKERS = /баа|канча|кайда|дарек|жеткир|кепилдик|бөлүп\s+төл|алмаштыр|сатып|алсам|керекпи|барбы|шаар/iu;

function classifySalesTemplate(text) {
  const value = String(text || "").trim();
  const normalized = value.toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
  const language = KYRGYZ_SALES_MARKERS.test(normalized) ? "ky" : "ru";
  let kind = null;
  // «беру» одним словом раньше тоже уводило сюда — но это слово нередко
  // просто означает «беру эту модель» внутри более широкой фразы («мне
  // самую жирную, я для жены беру»), где ещё не названы ни конкретная
  // модель, ни цена. Готовый шаблон «пришлите имя, телефон...» в такой
  // момент выглядит как бот, который прыгает в оформление, не показав
  // товар. Оставлены только однозначные формулировки прямого заказа.
  if (/оформ(?:ить|ляйте)|хочу\s+(?:заказать|купить)|можно\s+(?:заказать|оформить)/iu.test(normalized)) kind = "order";
  else if (/где\s+(?:вы|находитесь)|ваш\s+адрес|как\s+(?:вас|к\s+вам)\s+найти|кайда\s+жайгаш|дареги[ңн]ер/iu.test(normalized)) kind = "location";
  else if (/гаранти|кепилдик/iu.test(normalized)) kind = "warranty";
  else if (/мошенник|не\s+обман|можно\s+(?:вам\s+)?доверять|ишенсе\s+болобу|алдамч/iu.test(normalized)) kind = "trust";
  else if (/^(?:(?:у\s+вас|сиздерде)\s+)?(?:есть|барбы)?\s*(?:рассроч|бөлүп\s+төл)/iu.test(normalized)) kind = "installment";
  else if (/^(?:(?:у\s+вас|сиздерде)\s+)?(?:есть|барбы)?\s*(?:trade.?in|трейд.?ин|алмаштыр)/iu.test(normalized)) kind = "trade_in";
  else if (/доставк|жеткир/iu.test(normalized) && !/(?:росси|казахстан|узбекистан|москв|алмат|астан|ташкент)/iu.test(normalized)) kind = "delivery";
  return kind ? { kind, text: MOSTOVOY_SALES_TEMPLATES[kind][language] } : null;
}

function classifyReactiveTemplate(text) {
  const value = String(text || "");
  const match = REACTIVE_TEMPLATES.find((item) => item.pattern.test(value));
  return match ? match.text : null;
}
const ALLOWED_MODELS = MODELS.map((item) => item.id);
const DEEPSEEK_INPUT_USD_PER_MILLION = 0.07;
const DEEPSEEK_OUTPUT_USD_PER_MILLION = 1.10;
const INSTALLMENT_COEFFICIENTS = { 3: 0.94, 6: 0.89, 12: 0.84 };
const TRADE_IN_OPTIONS = [
  ["iphone 15 pro max", 900], ["iphone 15 pro", 800], ["iphone 15", 620],
  ["iphone 14 pro", 600], ["iphone 14", 480], ["iphone 13", 360], ["iphone 12", 260],
  ["galaxy s24 ultra", 740], ["galaxy s24", 520], ["galaxy s23", 380], ["galaxy s22", 260],
  ["macbook air m1", 450], ["macbook air m2", 650], ["macbook air m3", 850], ["macbook air m4", 850],
  ["macbook pro 14", 1050], ["macbook pro 16", 1250],
];

function roundAssistantPrice(amount, currency) {
  // USD и сомы из каталога показываем точно: 860 $ × 88 = 75 680 сом,
  // а не 75 700. Крупные RUB/KZT оставляем округлёнными до сотни.
  const step = currency === "RUB" || currency === "KZT" ? 100 : 1;
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

function catalogRequestFromHistory(history) {
  return (Array.isArray(history) ? history : [])
    .slice(-8)
    .filter((message) => message && message.content)
    .map((message) => `${message.role === "assistant" ? "КОНСУЛЬТАНТ" : "КЛИЕНТ"}: ${String(message.content).trim()}`)
    .join("\n");
}

function productsFromSelection(selection) {
  const match = String(selection || "").match(/\{\s*"products"[\s\S]*\}/);
  if (!match) return [];
  try {
    const products = JSON.parse(match[0]).products;
    return Array.isArray(products) ? products.filter((item) => item?.available && item?.name) : [];
  } catch {
    return [];
  }
}

function relevantProductsForContext(products, request, context = request) {
  if (!Array.isArray(products) || products.length <= 1) return products || [];
  const normalize = (value) => String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/(\d+)\s*мм/gu, "$1mm")
    .replace(/[^a-zа-я0-9]+/gu, " ")
    .trim();
  const recent = normalize(String(context || request || "").slice(-1600));
  const latest = normalize(String(request || ""));
  let candidates = [...products];

  // «обычный / просто / не Pro» — это явное отрицание Pro, а не повод
  // выбрать первый Pro из каталога. Обратное правило действует для явного Pro.
  const nonPro = /(?:обычн|не\s+(?:pro\b|про(?![а-яё]))|просто\s+(?:garmin\s+)?(?:fenix\s+)?\d)/u.test(`${recent} ${latest}`);
  const explicitPro = !nonPro && /(?:\bpro\b|(?<![а-яё])про(?![а-яё]))/u.test(latest || recent.slice(-500));
  if (nonPro) {
    const filtered = candidates.filter((product) => !/(?:\bpro\b|(?<![а-яё])про(?![а-яё]))/u.test(normalize(product.name)));
    if (filtered.length) candidates = filtered;
  } else if (explicitPro) {
    const filtered = candidates.filter((product) => /(?:\bpro\b|(?<![а-яё])про(?![а-яё]))/u.test(normalize(product.name)));
    if (filtered.length) candidates = filtered;
  }

  const sizes = [...recent.matchAll(/\b(\d{2})mm\b/gu)];
  const lastSize = sizes.at(-1)?.[1];
  if (lastSize) {
    const filtered = candidates.filter((product) => normalize(product.name).includes(`${lastSize}mm`));
    if (filtered.length) candidates = filtered;
  }

  const stop = new Set(["garmin", "apple", "samsung", "модель", "стоит", "цена", "есть", "обычный", "просто", "про", "pro"]);
  const score = (product) => normalize(product.name).split(" ").reduce((total, token) => {
    if (stop.has(token) || token.length < 2) return total;
    return total + (recent.includes(token) ? (/[0-9]/.test(token) ? 3 : 1) : 0);
  }, 0);
  const scored = candidates.map((product) => ({ product, score: score(product) }));
  const best = Math.max(...scored.map((item) => item.score));
  return best >= 2 ? scored.filter((item) => item.score === best).map((item) => item.product) : candidates;
}

function requestedReplyCurrency(request, context = request) {
  const text = String(request || "").toLowerCase().replace(/ё/g, "е");
  const dialog = String(context || request || "").toLowerCase().replace(/ё/g, "е");
  if (/(?:\bkgs\b|сом(?:ах|ы|ов)?|(?:^|\s)с\s*\?*$)/iu.test(text)) return "KGS";
  if (/(?:\busd\b|доллар|\$)/iu.test(text)) return "USD";
  if (/(?:\bkzt\b|тенге|₸)/iu.test(text)) return "KZT";
  const isFromRussia = /(?:я|мы)\s+(?:из|в)\s+росси|жив[а-яё]*\s+в\s+росси|нахож[а-яё]*\s+в\s+росси|достав[а-яё]*[^\n]{0,30}\s(?:в|до)\s+росси/iu.test(dialog);
  if (isFromRussia) return "RUB";
  const isFromKazakhstan = /(?:я|мы)\s+(?:из|в)\s+казахстан|жив[а-яё]*\s+в\s+казахстан|нахож[а-яё]*\s+в\s+казахстан|достав[а-яё]*[^\n]{0,30}\s(?:в|до)\s+казахстан/iu.test(dialog);
  if (isFromKazakhstan) return "KZT";
  return null;
}

function pricesMentionedInReply(reply, currency) {
  const text = String(reply || "");
  const pattern = currency === "KGS"
    ? /(\d[\d \u00a0\u202f.,]*)\s*(?:сом\w*|с)(?=\s|$|[.,;!?])/giu
    : currency === "USD"
      ? /\$\s*(\d[\d \u00a0\u202f.,]*)|(\d[\d \u00a0\u202f.,]*)\s*(?:\$|usd\b|доллар\w*)/giu
      : currency === "RUB"
        ? /(\d[\d \u00a0\u202f.,]*)\s*(?:₽|rub\b|рубл\w*)/giu
        : /(\d[\d \u00a0\u202f.,]*)\s*(?:₸|kzt\b|тенге)/giu;
  return [...text.matchAll(pattern)]
    .map((match) => Number(String(match[1] || match[2] || "").replace(/\D/g, "")))
    .filter(Number.isFinite);
}

function hasPriceInReply(reply) {
  return /(?:\$\s*\d|\d[\d\s\u00a0\u202f.,]*\s*(?:\$|сом(?:а|ов)?|с|₽|₸)(?=\s|$|[.,;!?*]))/iu.test(String(reply || ""));
}

function stageActionForInbound(text) {
  const value = String(text || "").toLowerCase().replace(/ё/g, "е");
  // \b не распознаёт границу слова после кириллицы (см. комментарий у Dyson
  // в CATALOG_FAMILIES) — «беру\b» и «хочу\b» никогда не матчились,
  // заменено на отрицательный lookahead по кириллице.
  if (/(?:оформ(?:ить|ляйте)|заказ(?:ать|ываю)?|беру(?![а-яё])|покупаю(?![а-яё])|заброниру|резервиру)/iu.test(value)) {
    return "ready_to_buy";
  }
  if (/(?:хочу(?![а-яё])|подходит|устраивает|интересует|готов\s+(?:взять|купить)|давайте\s+(?:этот|эту|его|ее))/iu.test(value)) {
    return "interest_confirmed";
  }
  if (/(?:iphone|айфон|macbook|макбук|airpods|наушник|dyson|дайсон|whoop|garmin|samsung|playstation|xbox|nintendo|бюджет|до\s+\d|цвет|памят|trade.?in|трейд.?ин|обмен|рассроч)/iu.test(value)) {
    return "need_identified";
  }
  return null;
}

// Диалог, который должен разобрать человек, а не автоответ бота: жалоба на
// права/юрисдикцию (защита прав потребителей, суд, жалоба в надзорный орган),
// прямая просьба администратора/живого человека или явный немотивированный
// негатив (обвинение в мошенничестве). Отдельно от stageActionForInbound —
// это не про этап воронки, а про то, что боту тут отвечать не стоит.
const IMPORTANT_ESCALATION_PATTERN = /юрисдикци|мои\s+права|нарушаете\s+закон|защит[аы]\s+прав\s+потребител|роспотребнадзор|подам\s+в\s+суд|обращусь\s+в\s+суд|адвокат|позовите\s+администратора|дайте\s+администратора|соедините\s+с\s+администратором|нужен\s+администратор|живого\s+человека|мошенник|развод(?:ите|ят)?\s+на\s+деньги|кинул[аи]?\s+меня/iu;

function classifyImportantEscalation(text) {
  return IMPORTANT_ESCALATION_PATTERN.test(String(text || ""));
}

function enforceCatalogPriceReply({ reply, request, context = request, selection }) {
  const products = relevantProductsForContext(productsFromSelection(selection), request, context);
  if (!products.length) return reply;
  // relevantProductsForContext иногда не находит уверенного совпадения и
  // возвращает ВЕСЬ список товаров как есть (см. её собственный комментарий
  // про best >= 2) — это осознанный безопасный дефолт ДЛЯ НЕЁ, но не для
  // нас: ниже мы бы взяли первые 3 товара из этого списка как «то, о чём
  // спросил клиент», а это буквально просто последние посты канала. Именно
  // так на вопрос про iPhone 17 клиент получал Steam Deck и Xiaomi — товары,
  // которые никак не пересекались по смыслу с запросом, а просто раньше
  // всех оказались в неотфильтрованном списке. Когда уверенного сужения не
  // произошло, безопаснее довериться черновику ИИ (он видел тот же каталог
  // целиком), чем подменять его случайной тройкой.
  const CONFIDENT_MATCH_LIMIT = 10;
  if (products.length > CONFIDENT_MATCH_LIMIT) return reply;

  const text = String(request || "");
  const explicitCurrency = requestedReplyCurrency(text, context);
  const asksPrice = /сколько|скок|почем|цена|стоит|в\s+(?:сом|доллар|рубл|тенге|\$)|\b(?:kgs|usd|rub|kzt)\b/iu.test(text);
  if (!asksPrice) return reply;

  const first = products[0];
  const currency = explicitCurrency || "KGS";
  const output = String(reply || "");
  const valueField = { KGS: "priceKgs", USD: "priceUsd", RUB: "priceRub", KZT: "priceKzt" }[currency];
  const expectedPrices = products.map((product) => roundAssistantPrice(Number(product[valueField]), currency));
  const mentionedPrices = pricesMentionedInReply(output, currency);
  const hasCatalogPrice = mentionedPrices.some((price) => expectedPrices.includes(price));
  const refusesPrice = /(?:не\s+могу|не\s+смогу|не\s+назову|нет|отсутствует)[^.!?\n]{0,90}(?:точн\w*\s+)?(?:цен\w*|сумм\w*)|(?:точн\w*\s+)?(?:цен\w*|сумм\w*)[^.!?\n]{0,90}(?:нет|не\s+могу|не\s+смогу)|пересч[её]т[^.!?\n]{0,60}не\s+буду/iu.test(output);
  const wrongDefaultRub = currency !== "RUB" && /(?:₽|\brub\b|рубл)/iu.test(output);
  if (!refusesPrice && hasCatalogPrice && !wrongDefaultRub) return reply;

  const suffix = { KGS: "с", USD: "$", RUB: "₽", KZT: "₸" }[currency];
  const lines = products.slice(0, 3).map((product) => {
    const details = [product.storage, product.color].filter(Boolean).join(", ");
    const value = roundAssistantPrice(Number(product[valueField]), currency);
    return `• ${product.name}${details ? `, ${details}` : ""} — ${value.toLocaleString("ru-RU")} ${suffix}`;
  });
  return `${lines.join("\n")}\n\nВ наличии. Могу сразу оформить заказ или рассчитать Trade-in/рассрочку.`;
}

// Страховка от галлюцинации «в наличии нет» вопреки реальным данным
// каталога — модель иногда так отвечает, хотя товар реально есть и
// помечен доступным (замечено на iPhone 17 при исправных данных). Работает
// как enforceCatalogPriceReply выше: не переписывает промптом, а ловит уже
// готовый ответ и подменяет его, если он противоречит каталогу.
// Есть ли у request/context хоть одно значимое слово общее с названием
// хотя бы одного товара — грубая, но дешёвая проверка «это вообще о том,
// что спросил клиент», без учёта отсечения Pro/mm-размеров и т.п. из
// relevantProductsForContext (та функция при отсутствии совпадений
// возвращает ВСЕ кандидаты как есть — этого достаточно для «сузить
// подборку», но недостаточно для «доверять ли странице целиком»).
function productsMentionRequest(products, request, context = request) {
  const normalize = (value) => String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, " ")
    .trim();
  // Только строки клиента — если считать и «КОНСУЛЬТАНТ:», собственная более
  // ранняя (и, возможно, ошибочная) фраза бота навсегда «подтверждает» сама
  // себя на каждом следующем сообщении. На проде это выглядело так: бот один
  // раз ошибочно предложил Xiaomi вместо iPhone, и дальше эта же страховка
  // считала Xiaomi «упомянутым в разговоре», хотя клиент говорил только про
  // iPhone — держало неверный ответ в цикле.
  const customerText = String(context || request || "")
    .split("\n")
    .filter((line) => !line.startsWith("КОНСУЛЬТАНТ:"))
    .join("\n");
  const recent = normalize(`${customerText}\n${request || ""}`.slice(-1600));
  const stop = new Set(["для", "есть", "стоит", "цена", "модель", "хочу", "нужен", "нужна", "нужно", "какой", "какая", "какие"]);
  return products.some((product) =>
    normalize(product.name).split(" ").some((token) => token.length >= 3 && !stop.has(token) && recent.includes(token))
  );
}

function enforceCatalogAvailabilityReply({ reply, request, context = request, selection }) {
  const candidates = productsFromSelection(selection);
  if (!candidates.length) return reply;
  const output = String(reply || "");
  // \b не распознаёт кириллицу как word-символ, поэтому границы слов здесь
  // не через \b, а через явные разделители/пробелы.
  const claimsUnavailable = /(?:подтверждённых|подтвержденных|в\s+наличии|сейчас)[^.!?\n]{0,40}(?:^|\s)нет(?=[\s.,!?]|$)|(?:^|\s)нет\s+в\s+наличии(?=[\s.,!?]|$)|отсутствует\s+в\s+наличии|товар[а-я]*\s+закончил/iu.test(output);
  if (!claimsUnavailable) return reply;
  // Раньше здесь брались первые 5 товаров ИЗ ВСЕЙ подборки без фильтрации —
  // на проде это выглядело так: клиент несколько сообщений подряд спрашивал
  // про Garmin Lily 2 (которого нет в базе), ИИ честно писал «в наличии
  // нет», а эта страховка подменяла ответ на первые 5 позиций из подборки,
  // которая после более раннего вопроса про игровые приставки состояла из
  // PlayStation 5, Steam Deck, Meta Quest и OneBlade. Клиент вместо ответа
  // про часы получал один и тот же список приставок на каждое сообщение.
  // Сужаем как в enforceCatalogPriceReply, и — раз это страховка именно от
  // ГАЛЛЮЦИНАЦИИ, а не общий «покажи что есть» — дополнительно проверяем,
  // что в подборке в принципе есть товар, который называется похоже на то,
  // что спросил клиент. Нет совпадения — значит клиента скорее всего
  // спросили про то, чего у нас правда нет, и «в наличии нет» от ИИ верно.
  const products = relevantProductsForContext(candidates, request, context);
  if (!productsMentionRequest(products, request, context)) return reply;
  const lines = products.slice(0, 5).map((product) => {
    const details = [product.storage, product.color].filter(Boolean).join(", ");
    const value = roundAssistantPrice(Number(product.priceKgs), "KGS");
    return `• ${product.name}${details ? `, ${details}` : ""} — ${value.toLocaleString("ru-RU")} с`;
  });
  return `Есть в наличии:\n${lines.join("\n")}\n\nКакой вариант вас интересует?`;
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

// Легаси-товары (импортированы без AI-исследования, research_status='skipped')
// не имеют колонок color/storage — но у части из них те же данные есть в
// specifications ("Цвета", "Память"), см. products.specifications. Без этого
// фолбэка товаровед считает, что цвета не указаны, хотя они есть в базе.
function specFallback(specifications, key) {
  if (!specifications) return null;
  try {
    const value = JSON.parse(specifications)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// Источник истины по актуальной цене/наличию — самое новое активное
// упоминание товара в постах канала, без дублей по official_name (см.
// комментарий ниже про конфликт цены между карточками одного названия).
// Используется и в buildTelegramCatalogForAssistant (текст для промпта),
// и в search_catalog (инструмент, который вызывает модель вместо того,
// чтобы придумывать цифры самой).
function getDedupedCatalogProducts(db) {
  const products = db.prepare(
    `SELECT p.official_name, p.brand, p.category, p.color, p.storage, p.specifications, p.description,
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
  const seenProductNames = new Set();
  return products.filter((p) => {
    if (seenProductNames.has(p.official_name)) return false;
    seenProductNames.add(p.official_name);
    return true;
  });
}

// Нормализация под поиск по токенам: без регистра, «ё»→«е», знаки препинания
// в пробелы — то же самое, что делает productsMentionRequest ниже.
function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gu, " ")
    .trim();
}

const SEARCH_STOP_WORDS = new Set(["для", "есть", "стоит", "цена", "модель", "хочу", "нужен", "нужна", "нужно", "какой", "какая", "какие", "сколько", "почем", "почём"]);

// Инструмент search_catalog для tool calling (см. AiRouter.chatTextWithTools):
// модель обязана вызвать его перед тем, как назвать клиенту цену/наличие
// конкретного товара, вместо того чтобы придумывать цифры самой — цена и
// наличие приходят из БД, а не генерируются текстом.
function searchCatalogProducts(db, query) {
  const products = getDedupedCatalogProducts(db);
  const tokens = normalizeSearchText(query).split(" ").filter((t) => t.length >= 2 && !SEARCH_STOP_WORDS.has(t));
  if (!tokens.length) return [];
  const scored = products.map((p) => {
    const haystack = normalizeSearchText(`${p.official_name} ${p.brand || ""} ${p.category || ""} ${p.color || ""} ${p.storage || ""}`);
    const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    return { p, score };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score || String(a.p.official_name).localeCompare(String(b.p.official_name), "ru"));
  // Те же готовые поля priceKgs/priceUsd/priceRub/priceKzt, что и в тексте
  // каталога (см. ASSISTANT_PRICE_POLICY) — модель не должна сама переводить
  // валюту, а сумма без округления такая же, как в остальном каталоге.
  return scored.slice(0, 12).map(({ p }) => ({
    name: p.official_name,
    brand: p.brand || null,
    category: p.category || null,
    storage: p.storage || specFallback(p.specifications, "Память") || null,
    color: p.color || specFallback(p.specifications, "Цвета") || null,
    price: Number(p.price),
    currency: p.currency,
    priceKgs: Math.ceil(convertAssistantPrice(p.price, p.currency, "KGS")),
    priceUsd: Math.ceil(convertAssistantPrice(p.price, p.currency, "USD")),
    priceRub: Math.ceil(convertAssistantPrice(p.price, p.currency, "RUB")),
    priceKzt: Math.ceil(convertAssistantPrice(p.price, p.currency, "KZT")),
    available: Boolean(p.available),
  }));
}

const CATALOG_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_catalog",
    description: "Ищет товары в РЕАЛЬНОМ каталоге магазина по названию модели, бренду или категории и возвращает точную цену, валюту и наличие на складе. Обязательно вызывай эту функцию перед тем, как назвать клиенту цену, наличие, цвет или объём памяти КОНКРЕТНОГО товара — никогда не придумывай и не вспоминай эти цифры сам, используй только то, что вернула функция. Если функция ничего не нашла — так и скажи клиенту, не выдумывай товар.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Что искать: название модели, бренд или категория, например «iPhone 17 Pro 256» или «Гармин»",
        },
      },
      required: ["query"],
    },
  },
};

function buildTelegramCatalogForAssistant(db) {
  // Товаровед работает со структурированной базой, полученной только из
  // публикаций канала. Для каждой позиции берём самое новое активное
  // упоминание — старая цена той же модели в подсказку не попадёт. У части
  // товаров синк создал НЕСКОЛЬКО разных строк products (разных product_id)
  // под одним и тем же official_name с РАЗНЫМИ ценами — getDedupedCatalogProducts
  // оставляет только самую свежую запись на каждое название (проверено на
  // проде: 65 из 651 названий имели такой конфликт цены).
  const dedupedProducts = getDedupedCatalogProducts(db);
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

  if (dedupedProducts.length || pendingPosts.length) return JSON.stringify({
    source: "telegram_channel",
    products: dedupedProducts.map((p) => ({
      name: p.official_name,
      brand: p.brand || null,
      category: p.category || null,
      storage: p.storage || specFallback(p.specifications, "Память"),
      color: p.color || specFallback(p.specifications, "Цвета"),
      description: p.description || null,
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
    return `- ${title}: цена по умолчанию ${formatAssistantPrice(p.price, p.currency, "KGS")}; USD ${formatAssistantPrice(p.price, p.currency, "USD")}; RUB ${formatAssistantPrice(p.price, p.currency, "RUB")}; KZT ${formatAssistantPrice(p.price, p.currency, "KZT")}${p.available ? "" : " (нет в наличии)"}`;
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
  // У Dyson несколько совсем разных линеек товаров под одним брендом — один
  // общий триггер на "dyson" отдавал фены, стайлеры, пылесосы и очистители
  // воздуха одним списком на 50+ позиций (найдено на проде: спросили про
  // фен, получили вперемешку ещё и реальные пылесосы V15/V16/SV50).
  // Специфичные запросы (фен/стайлер/пылесос/очиститель) разведены по своим
  // семействам; общий "Dyson" без уточнения остаётся как раньше — единственный
  // случай, где показать весь бренд действительно уместно.
  // \b не распознаёт границу слова после кириллицы (не считает «н» словесным
  // символом) — «фен\b» никогда не матчился и запрос молча проваливался в
  // общее семейство ниже. Проверено: /фен\b/i.test("Дайсон фен есть?") === false.
  { request: /фен(?:а|ом|ы)?(?:\s|$|[?!.,])|стайлер|выпрямител|укладк|airwrap|airstrait|corrale|supersonic/i, terms: ["airwrap", "airstrait", "corrale", "supersonic", "расческа"] },
  { request: /пылесос|\bvacuum\b|\bv1[0-9]\b|sv50|pencil\s*vac/i, terms: ["v15", "v16", "sv50", "gen5", "pencil vac"] },
  { request: /увлажнител|очистител.{0,12}возду|purifier|\bph0\d\b|\btp0\d\b/i, terms: ["ph04", "tp09", "purifier", "humidify"] },
  { request: /dyson|дайсон/i, terms: ["dyson", "airwrap", "airstrait", "corrale", "supersonic", "v15", "v16", "sv50", "gen5", "ph04", "tp09"] },
  { request: /garmin|гармин/i, terms: ["garmin"] },
  { request: /whoop|вуп/i, terms: ["whoop"] },
  { request: /очки|ray.?ban|meta/i, terms: ["ray ban", "ray-ban", "rayban", "ray•ban", "meta oakley"] },
  { request: /пристав|playstation|xbox|nintendo|steam deck/i, terms: ["playstation", "sony 5", "xbox", "nintendo", "steam deck"] },
  { request: /бритв|триммер|oneblade|philips/i, terms: ["oneblade", "one blade", "philips"] },
  { request: /яндекс|станци|колонк/i, terms: ["яндекс", "станция"] },
  // Фотоаппараты и экшн-камеры — отдельно от петличек ниже: это разные
  // товары, хотя оба всплывают на слово «камера».
  { request: /canon|кэнон|фотоаппарат|экшн.?камер|осмо|osmo|dji\s*(?:osmo|action|pocket)|gopro|гопро|камер/i, terms: ["canon", "g7x", "osmo", "dji osmo", "gopro", "action"] },
  // Петлички/микрофоны (DJI Mic и подобные) — отдельная категория, раньше
  // не распознавалась вообще ни одним семейством.
  { request: /петличк|петлич|микрофон|dji\s*mic|lavalier/i, terms: ["dji mic", "петличк", "микрофон", "lavalier", "wireless mic"] },
];

// official_name в базе — это полный SKU канала: память, цвет и тип SIM
// зашиты прямо в название («Apple iPhone 15 Pro 1 TB (Black, Blue)»,
// «Apple iPhone 15 Pro 256 GB Black Titanium»). Для списка линейки в
// _categoryBrowseReply это бесполезно — 909 товаров дают полсотни строк на
// одну модель разного объёма/цвета. Срезаем до базовой модели: убираем
// бренд-префикс и всё начиная с объёма памяти (а с ним заодно и цвет, и
// тип SIM, которые в названии всегда идут следом).
function baseModelLine(name) {
  return String(name || "")
    .replace(/^(?:Apple|Samsung|Xiaomi|Garmin|Dyson|DJI|Sony|Canon|Google|Huawei)\s+/i, "")
    .replace(/\s*\d+\s*(?:GB|TB)\b.*$/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function narrowCatalogForRequest(catalog, request) {
  try {
    const data = JSON.parse(catalog);
    if (!Array.isArray(data.pendingPosts)) return catalog;
    const requestText = String(request || "");
    // История нужна для уточнений вроде «а в сомах?», но новую категорию
    // определяем по последней реплике клиента. Иначе старое слово «iPhone»
    // перехватывало последующий запрос «покажи Whoop/бритвы/Dyson».
    const customerMessages = requestText.split("\n")
      .filter((line) => line.startsWith("КЛИЕНТ:"))
      .map((line) => line.slice("КЛИЕНТ:".length).trim())
      .reverse();
    const family = customerMessages
      .map((message) => CATALOG_FAMILIES.find((item) => item.request.test(message)))
      .find(Boolean)
      || CATALOG_FAMILIES.find((item) => item.request.test(requestText));
    // Структурированные товары НЕ фильтруем по категории: фильтр по regex
    // терял реальные товары (русские названия, «MacBook Pro» в другом посте,
    // категории вне списка семейств) — и бот отвечал «нет в наличии» про то,
    // что есть. Полный структурированный каталог компактен, DeepSeek дешёвый:
    // модель всегда видит весь ассортимент. Сужаем только объёмные сырые
    // посты (pendingPosts).
    if (!family) return JSON.stringify({ ...data, pendingPosts: data.pendingPosts.slice(0, 40) });
    const matches = (value) => family.terms.some((term) => String(value || "").toLowerCase().includes(term));
    const newestStructuredMessageId = (Array.isArray(data.products) ? data.products : [])
      .filter((product) => matches(`${product.name} ${product.brand} ${product.category}`))
      .reduce((latest, product) => Math.max(latest, Number(product.telegramMessageId) || 0), 0);
    const matchingPendingPosts = data.pendingPosts
      .filter((post) => matches(post.text))
      // raw/pending означает «ещё не разобран», а не «обязательно новее».
      // Старый raw-пост не должен перебивать уже разобранный свежий прайс.
      .filter((post) => Number(post.telegramMessageId) > newestStructuredMessageId);
    const pricedPosts = matchingPendingPosts
      .filter((post) => /\d[\d\s.,]*\s*(?:\$|с(?:\s|$)|сом|usd|kgs)/i.test(post.text))
      .sort((a, b) => Number(b.telegramMessageId) - Number(a.telegramMessageId));
    // Канал может публиковать прайс категории несколькими постами (например
    // MacBook Air и MacBook Pro отдельно) — один самый новый пост терял
    // половину линейки. Берём несколько свежих, модель сама возьмёт
    // актуальную цену: старые прайсы уже отсечены фильтром выше.
    if (pricedPosts.length) return JSON.stringify({ ...data, pendingPosts: pricedPosts.slice(0, 5) });
    return JSON.stringify({
      ...data,
      pendingPosts: matchingPendingPosts.slice(0, 30),
    });
  } catch {
    return catalog;
  }
}

const ASSISTANT_PRICE_POLICY = `ЦЕНЫ И ИСТОЧНИК:
Каталог ниже синхронизирован только с публикациями Telegram-канала магазина. Не используй старые цены сайта, память модели или цены без строки из этого каталога.
Всегда называй цену в сомах (priceKgs) по умолчанию — независимо от стоимости товара, языка сообщения и исходной валюты публикации.
Доллары (priceUsd) называй только если клиент прямо попросил USD/доллары/$. Рубли (priceRub) называй только если клиент прямо сообщил, что он находится в России, живёт в России или доставка нужна в Россию. Одной просьбы «в рублях?» без сообщения о России недостаточно: отвечай в сомах. Для клиента, который прямо сообщил, что он из Казахстана, называй цену в тенге (priceKzt). Не определяй страну по языку сообщения. Не называй несколько валют сразу, если клиент не просит сравнение.
Каталог ниже включает ВЕСЬ актуальный ассортимент магазина (products — все категории сразу; pendingPosts — свежие ещё не разобранные посты по теме запроса) — это единственный источник цены. Прежде чем сказать «такого товара нет», проверь весь список products целиком: товар может называться по-русски, стоять в другой категории или в конце списка. В нём price/currency — исходная цена канала, а priceKgs, priceUsd, priceRub и priceKzt — её пересчёт по курсу магазина; для ответа в нужной валюте используй соответствующее готовое поле.
Клиенту никогда не говори «подборка» или «каталог» — это внутренние термины. Если клиент называет модельную линейку без конкретной модификации («iPhone 17», «MacBook», «Apple Watch») — перечисли все модификации этой линейки, которые есть ниже, а не только одну случайную. Если запрошенной модели буквально нет — не проси у клиента бюджет вместо ответа: сам подбери 2–3 ближайшие реальные модели той же линейки и категории (например вместо iPhone 13 — iPhone 14 или iPhone 15, если они есть) и назови их с ценами.
Если клиент прямо просит показать все модели категории целиком («покажи все айфоны», «весь ассортимент MacBook», «какие вообще есть модели») — лимит 2–3 не действует: перечисли КАЖДУЮ модель и конфигурацию этой категории, которая есть в каталоге ниже, а не только последнее поколение и не только «самые популярные». Для длинного списка группируй по модели и объёму памяти, чтобы легко читалось. Данные в каталоге ниже уже включают все категории и поколения товара — никогда не отказывайся показать список и не говори, что не можешь его вывести, если категория есть в каталоге.
Если клиент коротко уточняет валюту («в сомах?», «в $?», «а в тенге?»), товар уже указан в контексте диалога и его надо взять из подборки. Никогда не отвечай, что точной суммы в другой валюте нет: готовые priceKgs, priceUsd, priceRub и priceKzt уже являются подтверждённым пересчётом цены канала.
Если клиент просит цену в валюте, которой нет среди готовых полей (евро, лиры, сум, любая другая) — переведи цену из priceUsd в нужную валюту по своему приблизительному знанию текущего рыночного курса и явно скажи, что это ориентировочный курс, а не фиксированный курс магазина: точную сумму нужно уточнять на момент оплаты. Если совсем не уверен в порядке курса этой валюты — честно скажи, что не можешь точно перевести, и назови цену в долларах или сомах.

ПРОВЕРКА ЧЕРЕЗ search_catalog:
У тебя есть функция search_catalog — она обращается напрямую к базе магазина и возвращает точную и самую свежую цену/наличие/цвет по названию, бренду или категории. Каталог выше уже даёт тебе общую картину, но прежде чем НАЗВАТЬ клиенту конкретную цифру (цену, наличие, цвет, объём памяти) по конкретному товару — обязательно вызови search_catalog по этому товару и возьми числа из её ответа, а не из своей памяти о каталоге выше: между сборкой этого сообщения и твоим ответом каталог мог обновиться. Если search_catalog не нашла товар, которого не было и в каталоге выше — так и скажи клиенту, не выдумывай.

ТОВАРЫ ПОД ЗАКАЗ БЕЗ УКАЗАННОЙ ЦЕНЫ:
Если товар отмечен как «под заказ» и цена для него не указана, не говори, что цена отсутствует, неизвестна или временно недоступна. Сообщи, что стоимость договорная и зависит от выбранной конфигурации и условий заказа; не придумывай примерную цену и не рассчитывай её сам.
Предложи обсудить стоимость с менеджером и укажи контакты: Рахмон — 0700 922 622, Ислам — 0708 933 633. Если клиент уже назвал конкретную конфигурацию — повтори её в ответе перед контактами менеджеров. Для товаров с указанной ценой номера менеджеров не давай, если клиент сам не попросил связаться с человеком.

ПРОДАЖА:
Если клиент просит посоветовать товар, называет бюджет или категорию, сразу предложи 2–3 наиболее подходящих товара из актуального каталога с ценами. Не отвечай «сейчас уточню», «уточню у менеджера» и не перекладывай подбор на клиента, пока в каталоге есть подходящие варианты.
Никогда не пиши «каталог не показывает актуальные модели», «подключу менеджера» или похожие фразы. Менеджера упоминай только если клиент сам просит оформить заказ, резерв или живой осмотр.
После любой названной цены или подборки обязательно продолжи продажу одним коротким призывом: предложи оформить заказ, зарезервировать конкретную модель либо рассчитать Trade-in или рассрочку. Не заканчивай сообщение последней строкой прайса.`;

const ASSISTANT_COLOR_POLICY = `ЦВЕТ ТОВАРА:
В подборке у части товаров (особенно iPhone, MacBook и другой техники с разными расцветками) заполнено поле color — это реальный цвет из поста канала, а не выдумка.
Если клиент интересуется конкретной моделью и ещё не назвал цвет, а в подборке для этой модели есть цвет — спроси, какой цвет ему нужен, и перечисли только цвета, реально присутствующие в подборке по этой модели. Не предлагай цвета, которых нет в канале, и не выдумывай их.
Если у модели в канале указан лишь один цвет — не спрашивай, а сразу назови его вместе с ценой.
Если клиент уже назвал цвет (сейчас или раньше в диалоге) — используй его и не переспрашивай повторно.
Если ни один пост о модели не содержит цвета — не упоминай цвет вообще, не сочиняй его.`;

// Клиент, который написал что-то грубое или раздражённое, — это не повод
// прекращать диалог: живой менеджер извиняется по существу и продолжает
// помогать, а не «на этом остановлюсь». Правило появилось из разбора
// реального диалога, где на грубость и жалобу бот отвечал общей формулировкой
// без разбора сути и переставал вести диалог вместо того, чтобы разобраться,
// что случилось, или предложить менеджера.
const ASSISTANT_TONE_POLICY = `ЕСЛИ КЛИЕНТ РАЗДРАЖЁН ИЛИ ГРУБИТ:
Никогда не заканчивай диалог фразой вроде «на этом остановлюсь», «больше не буду продолжать» и не переставай отвечать. Ты не можешь отказаться помогать из-за тона сообщения.
Извинись один раз, коротко и по существу конкретной причины (не путай с жалобой на другой товар — жалоба «нет эффекта» и «дорого» это разные ситуации), и продолжи разбираться: задай уточняющий вопрос по сути проблемы или прямо предложи передать обращение менеджеру.
Не повторяй одну и ту же извиняющуюся фразу в соседних сообщениях — если уже извинился в этом диалоге, переходи сразу к сути следующего ответа.`;

const ASSISTANT_CLOSING_POLICY = `ДОЖИМ И РАБОТА С ВОЗРАЖЕНИЯМИ:
Цель — мягко довести клиента до следующего действия: выбор модели, резерв, рассрочка, Trade-in или оформление заказа. Не дави и не повторяй одно и то же предложение несколько раз подряд.

После того как клиент проявил интерес, используй такую последовательность: 1) подтверди выбор клиента; 2) коротко напомни главную выгоду выбранного товара; 3) убери основное сомнение клиента; 4) предложи одно конкретное следующее действие. Не предлагай сразу несколько действий в одном сообщении — выбирай только одно наиболее подходящее (оформить заказ, поставить в резерв, рассчитать рассрочку, рассчитать Trade-in, связать с менеджером, уточнить цвет или объём памяти).

Если клиент пишет «дорого» — не спорь; предложи более доступную модель, рассрочку или Trade-in; если для товара разрешена скидка — предложи специальную цену.
Если клиент пишет «подумаю» — не дави; уточни, что именно мешает решить (цена, модель, цвет, память или сравнение), и предложи помочь именно по этой причине.
Если клиент пишет «позже» — коротко уточни, сохранить ли выбранную модель или вернуться к вопросу позже; не повторяй продажу в том же сообщении.
Если клиент выбирает между двумя товарами — сравни их, дай ясную рекомендацию, какой вариант лучше именно для его задачи, и предложи оформить рекомендованный вариант.
Если клиент уже выбрал модель, цвет и память — не продолжай предлагать другие товары, а сразу предложи оформить заказ или резерв.
Если клиент дважды отказался — не дави дальше, спокойно оставь возможность вернуться: «Хорошо, если решите вернуться к выбору, я помогу подобрать подходящий вариант».

Запрещено: создавать ложную срочность; писать, что товар скоро закончится, если этого нет в данных; придумывать ограниченную скидку; давление, вину или манипуляции; повторять «оформить заказ?» в каждом сообщении.`;

const ASSISTANT_PRIVACY_POLICY = `КОНФИДЕНЦИАЛЬНОСТЬ:
Телефон, адрес и имя клиента ты видишь не как есть, а в виде токена вида {{PHONE_1}}, {{ADDRESS_1}}, {{NAME_1}} — так система защищает персональные данные. Никогда не пытайся угадать, что скрыто за токеном, и не выдумывай свои цифры или адрес взамен. Если нужно упомянуть эти данные клиенту (например, подтвердить номер или адрес) — вставь токен в ответ точно в том виде, в котором он тебе дан; система сама подставит реальное значение перед отправкой.`;


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
  constructor({ db, ai, deepseek, amocrm, azisCrm, crmDeals, greenapi, storyResolver, fetchImpl, autoReplyDebounceMs, now } = {}) {
    this.db = db;
    this.deepseek = deepseek;
    this.ai = ai || deepseek;
    this.amocrm = amocrm;
    this.azisCrm = azisCrm;
    this.crmDeals = crmDeals;
    // WhatsApp напрямую через Green API (без amoCRM). Необязателен: без него
    // канал просто выключен, как amocrm без токена.
    this.greenapi = greenapi;
    // Instagram Story/Highlight по ссылке (HikerAPI + vision) — необязателен,
    // без HIKER_API_KEY просто ничего не резолвит (см. _augmentWithInstagramStory).
    this.storyResolver = storyResolver;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this._autoReplyDebounceMs = autoReplyDebounceMs ?? AUTO_REPLY_DEBOUNCE_MS;
    // Инжектируемые часы — только чтобы тесты «тихих часов» не зависели от
    // реального времени запуска. В проде всегда реальный Date.
    this._now = now || (() => new Date());
    // Клиент часто пишет мыслями через несколько сообщений подряд — без
    // задержки на каждое уходил отдельный вызов ИИ, и клиенту прилетало
    // несколько ответов вперемешку. Ждём паузу, потом отвечаем один раз.
    this._autoReplyTimers = new Map();
    // Диалоги, где первое сообщение клиента уже было вопросом: ответ ИИ на
    // это сообщение нужно дополнить каталогом категорий (см. receiveTelegram).
    this._pendingFirstContactCatalog = new Set();
  }

  // Откладывает автоответ на AUTO_REPLY_DEBOUNCE_MS: если за это время придёт
  // ещё сообщение, таймер сбрасывается и переставляется на новое сообщение.
  // Сработает только последний таймер — _autoReply сам отбрасывает ответ на
  // устаревшее сообщение (сверяет incomingMessageId с новейшим входящим),
  // так что комбинировать текст сообщений вручную не нужно: когда пауза
  // наступит, _autoReply возьмёт всю свежую историю целиком.
  _debouncedAutoReply(conversationId, incomingMessageId) {
    const existing = this._autoReplyTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._autoReplyTimers.delete(conversationId);
      void this._autoReply(conversationId, incomingMessageId).catch((error) =>
        logger.error("crm.auto_reply_failed", { conversationId, error: error.message })
      );
    }, this._autoReplyDebounceMs);
    timer.unref?.();
    this._autoReplyTimers.set(conversationId, timer);
  }

  // Клиент написал сам (или менеджер вмешался) — все неотправленные
  // напоминания об этом диалоге больше не нужны, новое сообщение и так
  // запустит свой автоответ (или, для order_incomplete, значит клиент ещё
  // не пропал).
  _cancelNudgeFollowUps(conversationId) {
    this.db.prepare(
      `UPDATE nudge_follow_ups SET sent_at = datetime('now') WHERE conversation_id = ? AND sent_at IS NULL`
    ).run(conversationId);
  }

  // Ставит цепочку напоминаний об одном простое: через несколько часов, на
  // следующий день (или после консультации, если диалог был длинным), и
  // финальное сообщение — все три сразу, чтобы processDueNudgeFollowUps не
  // зависел от setTimeout и переживал рестарт деплоя. Если клиент ответит
  // раньше — _cancelNudgeFollowUps отменит все три.
  _scheduleNudgeFollowUps(conversationId, productName) {
    this._cancelNudgeFollowUps(conversationId);
    for (const [kind, delay] of [["hours", NUDGE_HOURS_DELAY], ["day", NUDGE_DAY_DELAY], ["last", NUDGE_LAST_DELAY]]) {
      this.db.prepare(
        `INSERT INTO nudge_follow_ups (conversation_id, kind, product_name, due_at) VALUES (?, ?, ?, datetime('now', ?))`
      ).run(conversationId, kind, productName || null, delay);
    }
  }

  // Клиент явно сказал «беру»/«оформляйте», но не дал данные для заказа —
  // одно напоминание вместо обычной цепочки простоя (обе бессмысленны
  // одновременно).
  _scheduleOrderIncompleteNudge(conversationId, productName) {
    this._cancelNudgeFollowUps(conversationId);
    this.db.prepare(
      `INSERT INTO nudge_follow_ups (conversation_id, kind, product_name, due_at) VALUES (?, 'order_incomplete', ?, datetime('now', ?))`
    ).run(conversationId, productName || null, NUDGE_ORDER_INCOMPLETE_DELAY);
  }

  // Вызывается периодически из index.js, как и processDueOrderFollowUps.
  async processDueNudgeFollowUps() {
    const due = this.db.prepare(
      `UPDATE nudge_follow_ups SET sent_at = datetime('now')
        WHERE id IN (
          SELECT id FROM nudge_follow_ups
           WHERE sent_at IS NULL AND due_at <= datetime('now')
           ORDER BY due_at LIMIT 20
        )
       RETURNING id, conversation_id, kind, product_name`
    ).all();
    for (const row of due) {
      try {
        const conversation = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(row.conversation_id);
        if (!conversation?.ai_enabled) continue;
        const lastOutgoing = this.db.prepare(
          `SELECT sender FROM crm_messages WHERE conversation_id = ? AND direction = 'outgoing' ORDER BY id DESC LIMIT 1`
        ).get(row.conversation_id);
        // Менеджер мог вмешаться и написать сам — тогда напоминание от бота лишнее.
        if (lastOutgoing?.sender && lastOutgoing.sender !== "assistant") continue;
        let templateKey = row.kind;
        if (row.kind === "day") {
          const incomingCount = this.db.prepare(
            `SELECT COUNT(*) AS count FROM crm_messages WHERE conversation_id = ? AND direction = 'incoming'`
          ).get(row.conversation_id)?.count || 0;
          templateKey = incomingCount >= CONSULTATION_MESSAGE_THRESHOLD ? "consultation" : "day";
        }
        const now = this._now();
        if (!isWithinActiveHours(now)) {
          // Ночью (00:00–9:00 по Бишкеку) проактивно не пишем — переносим то же
          // напоминание на ближайшие 9:00, с «Доброе утро» при самой отправке.
          this.db.prepare(
            `INSERT INTO nudge_follow_ups (conversation_id, kind, product_name, due_at) VALUES (?, ?, ?, ?)`
          ).run(row.conversation_id, row.kind, row.product_name, toSqliteUtc(nextActiveWindowStart(now)));
          this._logEvent(row.conversation_id, "info", "delivery", "nudge.rescheduled_quiet_hours", "Напоминание перенесено на утро (тихие часы)", { kind: row.kind });
          continue;
        }
        const text = withTimeAwareGreeting(fillNudgeTemplate(NUDGE_TEMPLATES[templateKey], {
          clientName: conversation.customer_name,
          productName: row.product_name,
        }), now);
        await this._send(row.conversation_id, text, "assistant");
        this._logEvent(row.conversation_id, "info", "delivery", "nudge.sent", "Напоминание клиенту об открытом диалоге", { kind: row.kind });
      } catch (error) {
        logger.error("crm.nudge_follow_up_failed", { id: row.id, conversationId: row.conversation_id, error: error.message });
      }
    }
  }

  // Забота после продажи: клиент подтвердил заказ — через сутки бот
  // спрашивает, подтвердили ли заказ менеджеры, а через ~4 дня (примерная
  // оценка срока доставки по Бишкеку, не точный расчёт) — не было ли
  // проблем с товаром. Очередь в БД, а не setTimeout: этот срок легко
  // переживает рестарт деплоя, в отличие от короткого idle-напоминания.
  _scheduleOrderCareFollowUps(conversationId) {
    // Забота о заказе замещает напоминания о простое/незавершённом заказе —
    // теперь бот следит за клиентом по-другому.
    this._cancelNudgeFollowUps(conversationId);
    const hasPending = (kind) => this.db.prepare(
      `SELECT 1 FROM order_follow_ups WHERE conversation_id = ? AND kind = ? AND sent_at IS NULL LIMIT 1`
    ).get(conversationId, kind);
    if (!hasPending("confirm")) {
      this.db.prepare(
        `INSERT INTO order_follow_ups (conversation_id, kind, due_at) VALUES (?, 'confirm', datetime('now', '+20 hours'))`
      ).run(conversationId);
    }
    if (!hasPending("delivery")) {
      this.db.prepare(
        `INSERT INTO order_follow_ups (conversation_id, kind, due_at) VALUES (?, 'delivery', datetime('now', '+4 days'))`
      ).run(conversationId);
    }
  }

  // Вызывается периодически из index.js. Не бросает исключение наружу —
  // сбой одного напоминания не должен останавливать остальные в очереди.
  async processDueOrderFollowUps() {
    // UPDATE...RETURNING захватывает строки атомарно одним запросом — если
    // два прохода воркера (например старый и новый инстанс на рестарте
    // деплоя) пересекутся по времени, они не смогут выбрать одни и те же
    // due-строки и отправить клиенту дублирующее напоминание.
    const due = this.db.prepare(
      `UPDATE order_follow_ups SET sent_at = datetime('now')
        WHERE id IN (
          SELECT id FROM order_follow_ups
           WHERE sent_at IS NULL AND due_at <= datetime('now')
           ORDER BY due_at LIMIT 20
        )
       RETURNING id, conversation_id, kind`
    ).all();
    for (const row of due) {
      try {
        const conversation = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(row.conversation_id);
        if (conversation?.ai_enabled) {
          const now = this._now();
          if (!isWithinActiveHours(now)) {
            this.db.prepare(
              `INSERT INTO order_follow_ups (conversation_id, kind, due_at) VALUES (?, ?, ?)`
            ).run(row.conversation_id, row.kind, toSqliteUtc(nextActiveWindowStart(now)));
            this._logEvent(row.conversation_id, "info", "delivery", "order_care.rescheduled_quiet_hours", "Забота о заказе перенесена на утро (тихие часы)", { kind: row.kind });
            continue;
          }
          const text = row.kind === "confirm"
            ? "Кстати, подскажите — вам уже подтвердили заказ? 😊"
            : "Как всё прошло с заказом — товар пришёл в порядке, без проблем? 😊";
          await this._send(row.conversation_id, text, "assistant");
          this._logEvent(row.conversation_id, "info", "delivery",
            row.kind === "confirm" ? "order_care.confirm_sent" : "order_care.delivery_sent",
            row.kind === "confirm" ? "Уточнение подтверждения заказа" : "Проверка после получения товара");
        }
      } catch (error) {
        logger.error("crm.order_care_failed", { id: row.id, conversationId: row.conversation_id, error: error.message });
      }
    }
  }

  // Новый клиент → сделка в воронке MostovoyCRM.
  // Ничего не ждём и не бросаем: недоступная CRM не должна ни задерживать
  // ответ клиенту, ни ронять обработку сообщения. Пропуск не потеряется —
  // CRM сверяется с /api/admin/crm/conversations.
  _publishDeal(conversation) {
    if (!this.crmDeals?.enabled || isLabConversation(conversation)) return;
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

  // Диалог, который должен разобрать человек, а не автоответ — жалоба на
  // права/юрисдикцию, немотивированный негатив, прямая просьба администратора.
  // Уходит важным уведомлением в CRM параллельно с обычным ответом клиенту,
  // не вместо него: клиент всё равно должен получить ответ.
  _publishImportantNotify(conversation, text) {
    if (!this.crmDeals?.enabled || typeof this.crmDeals.notifyImportant !== "function" || isLabConversation(conversation)) return;
    void this.crmDeals
      .notifyImportant({
        title: `Требует внимания человека (${conversation.customer_name || conversation.source})`,
        body: `Сообщение клиента: ${String(text || "").slice(0, 500)}`,
        externalKey: conversation.external_key,
      })
      .then(() => {
        this._logEvent(conversation.id, "warn", "crm", "notify.important_sent", "Важное уведомление отправлено в CRM");
      })
      .catch((error) =>
        logger.error("crm_deals.notify_failed", { externalKey: conversation.external_key, error: error.message })
      );
  }

  _publishStage(conversation, action) {
    if (!this.crmDeals?.enabled || typeof this.crmDeals.advanceStage !== "function" || isLabConversation(conversation)) return;
    void this.crmDeals
      .createDeal({
        externalKey: conversation.external_key,
        source: conversation.source,
        customerName: conversation.customer_name,
        customerPhone: conversation.customer_phone,
        customerUsername: conversation.customer_username,
      })
      .then(() => this.crmDeals.advanceStage({ externalKey: conversation.external_key, action }))
      .then((result) => {
        this._logEvent(conversation.id, "info", "crm", "deal.stage_advanced", "Этап сделки синхронизирован", {
          action,
          moved: Boolean(result?.moved),
          stageName: result?.stageName || null,
        });
      })
      .catch((error) =>
        logger.error("crm_deals.advance_failed", {
          externalKey: conversation.external_key,
          action,
          error: error.message,
        })
      );
  }

  _publishOrderIfConfirmed(conversation, history, selection) {
    if (isLabConversation(conversation)) return false;
    const messages = Array.isArray(history) ? history : [];
    const customerText = messages
      .filter((message) => message?.role === "user")
      .map((message) => String(message.content || ""))
      .join("\n");
    const latestUserIndex = messages.findLastIndex((message) => message?.role === "user");
    const latestCustomerText = latestUserIndex >= 0 ? String(messages[latestUserIndex].content || "") : "";
    const previousAssistantText = latestUserIndex > 0 && messages[latestUserIndex - 1]?.role === "assistant"
      ? String(messages[latestUserIndex - 1].content || "")
      : "";
    // Заказ появляется после явного подтверждения клиента. Сообщения вроде
    // «сколько стоит» или обычная подборка заказом не считаются.
    const explicitOrder = /(?:оформ(?:ить|ляйте|ляем)|заказ(?:ать|ываю)?|беру(?![а-яё])|покупаю(?![а-яё])|заброниру|резервиру)/iu.test(latestCustomerText);
    const confirmedOffer = /^(?:да|давайте|конечно|хорошо|согласен|согласна|беру|оформляйте)[.!\s]*$/iu.test(latestCustomerText.trim())
      && /(?:оформ|заказ|резерв|покуп)/iu.test(previousAssistantText);
    if (!explicitOrder && !confirmedOffer) return false;
    const product = selectedCatalogProduct(selection);
    if (!product) return false;

    const externalKey = conversation.external_key || conversation.externalKey;
    if (!externalKey) return false;
    const externalChatId = conversation.external_chat_id || conversation.externalChatId;
    if (conversation.source === "telegram" && externalChatId && externalKey !== `telegram:${externalChatId}`) {
      logger.error("crm_deals.order_identity_mismatch", { externalKey, externalChatId });
      return false;
    }

    // Забота о клиенте работает всегда, даже если интеграция с CRM (ниже)
    // не настроена — это чисто разговорная функция бота.
    this._scheduleOrderCareFollowUps(conversation.id);

    if (!this.crmDeals?.enabled || typeof this.crmDeals.createOrder !== "function") return true;
    const phone = conversation.customer_phone || conversation.customerPhone
      || (customerText.match(/(?:\+?\d[\d\s()\-]{7,}\d)/u) || [])[0]
      || null;
    const orderType = /рассроч|в\s+кредит|плат[её]ж.*месяц/iu.test(customerText)
      ? "installment"
      : /trade.?in|трейд.?ин|обмен(?:ять|а)|сдать.*(?:телефон|iphone|айфон|macbook|макбук)/iu.test(customerText)
        ? "trade_in"
        : "standard";
    const amount = Number.isFinite(Number(product.priceKgs))
      ? Math.ceil(Number(product.priceKgs))
      : Math.ceil(convertAssistantPrice(product.price, product.currency, "KGS"));

    void this.crmDeals.createOrder({
      externalKey,
      productName: [product.name, product.storage, product.color].filter(Boolean).join(", "),
      amount,
      currency: "KGS",
      orderType,
      customerName: conversation.customer_name || conversation.customerName,
      customerPhone: phone,
      note: `Источник: ${conversation.source}`,
    }).then((result) => {
      this._logEvent(conversation.id, "info", "commerce", "order.published", "Заказ передан в CRM", {
        orderId: result?.id || null,
        product: product.name,
        orderType,
      });
    }).catch((error) => logger.error("crm_deals.order_failed", {
      externalKey,
      error: error.message,
    }));
    return true;
  }

  _publishAzis(type, payload) {
    if (!this.azisCrm?.enabled) return;
    void this.azisCrm.publishEvent(type, payload).catch((error) =>
      logger.error("azis_crm.publish_failed", { type, error: error.message })
    );
  }

  _publishMessage(conversation, data) {
    if (isLabConversation(conversation)) return;
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
        (SELECT text FROM crm_messages m WHERE m.conversation_id = c.id ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT 1) AS last_message
       FROM crm_conversations c
       WHERE c.external_key NOT LIKE 'lab:%'
       ORDER BY c.last_message_at DESC, c.id DESC`
    ).all().map(toConversation);
  }

  getConversation(id, { markRead = false } = {}) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    if (markRead) this.db.prepare("UPDATE crm_conversations SET unread_count = 0 WHERE id = ?").run(id);
    const messages = this.db.prepare(
      "SELECT id, direction, sender, text, status, created_at FROM crm_messages WHERE conversation_id = ? ORDER BY datetime(created_at) ASC, id ASC"
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

  async getConversationWithRemoteHistory(id, options = {}) {
    const row = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(id);
    if (!row) return null;
    if (row.source !== "telegram") {
      try {
        await this._syncAmoHistory(row);
      } catch (error) {
        this._logEvent(row.id, "warn", "amocrm", "amocrm.history_failed", error.message);
      }
    }
    return this.getConversation(id, options);
  }

  async _syncAmoHistory(conversation) {
    if (!this.amocrm?.getChatHistory || !conversation?.external_chat_id) return;
    const remote = await this.amocrm.getChatHistory(conversation.external_chat_id, 200);
    const local = this.db.prepare(
      "SELECT external_message_id, direction, sender, text, created_at FROM crm_messages WHERE conversation_id = ? ORDER BY id"
    ).all(conversation.id);
    const ids = new Set(local.map((message) => String(message.external_message_id || "")));
    let managerFound = false;
    for (const message of remote) {
      if (!message.messageId || ids.has(message.messageId)) continue;
      if (message.direction === "outgoing") {
        const timestamp = new Date(message.createdAt).getTime();
        const botEcho = local.some((saved) =>
          saved.sender === "assistant"
          && saved.text === message.text
          && Math.abs(new Date(saved.created_at).getTime() - timestamp) <= 15 * 60_000
        );
        if (botEcho) continue;
        managerFound = true;
      }
      this._storeMessage(conversation.id, {
        externalMessageId: message.messageId,
        direction: message.direction,
        sender: message.direction === "incoming" ? "customer" : "manager",
        text: message.text,
        createdAt: message.createdAt,
      });
      ids.add(message.messageId);
    }
    if (managerFound) {
      this.db.prepare(
        "UPDATE crm_conversations SET ai_enabled = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(conversation.id);
    }
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

  // В отличие от clearConversationHistory (чистит переписку, диалог остаётся
  // «известным» для CRM) — полностью убирает сам диалог: следующее сообщение
  // от этого chat_id снова считается первым контактом (приветствие, заведение
  // сделки). Нужно для повторного тестирования одними и теми же тестовыми
  // аккаунтами. ON DELETE CASCADE/SET NULL в схеме сами подчищают связанные
  // сообщения, события и очереди напоминаний.
  deleteConversation(id) {
    const conversation = this.db.prepare("SELECT id FROM crm_conversations WHERE id = ?").get(id);
    if (!conversation) return null;
    this.db.prepare("DELETE FROM crm_conversations WHERE id = ?").run(id);
    logger.info("crm.conversation_deleted", { conversationId: id });
    return { deleted: true };
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
      whatsapp: Boolean(this.greenapi?.enabled),
      whatsappWebhookConfigured: Boolean(config.greenapi.webhookToken),
      ai: Boolean(this.ai?.enabled),
      amocrmWebhook: `${base}/api/amocrm/webhook${secretPath}`,
      whatsappWebhook: `${base}/api/greenapi/webhook`,
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
      supervisorEnabled: rows.bot_supervisor_enabled !== "false",
      supervisorPrompt: rows.bot_supervisor_prompt || DEFAULT_SUPERVISOR_PROMPT,
      // ИИ-роутер готовых шаблонов (templates.js). По умолчанию включён;
      // выключение оставляет только regex-шаблоны.
      templateRouterEnabled: rows.bot_template_router_enabled !== "false",
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
      bot_supervisor_enabled: String(payload.supervisorEnabled ?? current.supervisorEnabled),
      bot_supervisor_prompt: String(payload.supervisorPrompt ?? current.supervisorPrompt).trim().slice(0, 8000) || DEFAULT_SUPERVISOR_PROMPT,
      bot_template_router_enabled: String(payload.templateRouterEnabled ?? current.templateRouterEnabled),
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
    const customers = this.db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM crm_conversations) AS total,
        (SELECT COUNT(*) FROM crm_conversations WHERE date(created_at) = date('now')) AS newToday,
        (SELECT COUNT(DISTINCT conversation_id) FROM crm_messages
          WHERE direction = 'incoming' AND date(created_at) = date('now')) AS activeToday,
        (SELECT COUNT(DISTINCT conversation_id) FROM crm_messages
          WHERE direction = 'incoming' AND created_at >= datetime('now', '-7 days')) AS active7d,
        (SELECT COUNT(*) FROM (
          SELECT conversation_id FROM crm_messages
           WHERE direction = 'incoming' GROUP BY conversation_id HAVING COUNT(*) >= 2
        )) AS returningCustomers,
        (SELECT COUNT(*) FROM crm_conversations WHERE source = 'telegram') AS telegram,
        (SELECT COUNT(*) FROM crm_conversations WHERE source = 'whatsapp') AS whatsapp,
        (SELECT COUNT(*) FROM crm_conversations WHERE source = 'instagram') AS instagram`
    ).get();
    const normalize = (row) => ({ tokens: Number(row.tokens || 0), costUsd: Number(row.cost || 0) });
    const { returningCustomers, ...customerCounts } = customers;
    return {
      overview: Object.fromEntries(Object.entries(overview).map(([key, value]) => [key, Number(value || 0)])),
      customers: {
        ...Object.fromEntries(Object.entries(customerCounts).map(([key, value]) => [key, Number(value || 0)])),
        returning: Number(returningCustomers || 0),
      },
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
    const catalogRequest = catalogRequestFromHistory([...(Array.isArray(history) ? history : []), { role: "user", content: text }]);
    const selection = this._selectCatalogProducts({
      conversationId: null,
      customerRequest: catalogRequest,
      catalog,
    });
    const financeRequest = [...(Array.isArray(history) ? history : []), { role: "user", content: text }]
      .filter((message) => message?.role === "user")
      .map((message) => message.content)
      .join("\n");
    const finance = financeToolContext(financeRequest, selection);
    const generated = await this._chatWithCatalogTool({
      system: this._composePrompt(settings, [selection, finance].filter(Boolean).join("\n\n")),
      messages: Array.isArray(history) ? history.slice(-20) : [],
      user: text,
      model: selectedModel,
      onUsage: this._usageRecorder("laboratory", null, selectedModel),
    });
    let reply = generated.reply;
    reply = await this._reviewReply({
      conversationId: null,
      settings: { ...settings, model: selectedModel },
      history: Array.isArray(history) ? history : [],
      customerRequest: text,
      draft: reply,
      groundedProductNames: generated.groundedProductNames,
    });
    // Если search_catalog реально подтвердил товар в этом ответе — доверяем
    // ему, а не старой эвристике relevantProductsForContext ниже. Та
    // выбирает "то, о чём спросил клиент" по пересечению ключевых слов и при
    // неуверенном совпадении может подставить случайный товар из непричастной
    // части каталога (проверено на проде: подменила верный Garmin Fenix 8 на
    // Canon PowerShot). search_catalog — код, бьющий в БД по факту, ему
    // подмена не грозит в принципе.
    if (!generated.groundedProductNames.size) {
      reply = enforceCatalogPriceReply({ reply, request: text, context: catalogRequest, selection });
      reply = enforceCatalogAvailabilityReply({ reply, request: text, context: catalogRequest, selection });
    }
    this._logEvent(null, "info", "laboratory", "lab.reply_generated", "Лаборатория получила ответ", {
      model: selectedModel,
      latencyMs: Date.now() - startedAt,
    });
    return { reply, model: selectedModel, latencyMs: Date.now() - startedAt };
  }

  // Основная генерация ответа: та же самая система/история/пользовательское
  // сообщение, что и раньше через ai.chatText, но модели дополнительно дан
  // инструмент search_catalog (см. CATALOG_SEARCH_TOOL) — он бьёт напрямую в
  // БД, поэтому цена/наличие в его ответе не могут быть выдумкой модели.
  // Если провайдер не поддерживает function calling (только DeepSeek
  // поддержан в AiRouter.chatTextWithTools) —тихо откатываемся на обычный
  // chatText, чтобы бот не переставал отвечать.
  // Возвращает { reply, groundedProductNames } — groundedProductNames это
  // union всех товаров, которые search_catalog реально вернул по запросам
  // модели за этот ответ. Нужны отдельно от текста ответа, чтобы супервизор
  // (см. _reviewReply) не мог подменить проверенный товар на выдуманный —
  // такое найдено на проде: супервизор переписал верный черновик про Garmin
  // Fenix 8 (после успешного tool call) на случайный Canon.
  async _chatWithCatalogTool({ system, messages, user, model, onUsage, conversationId = null }) {
    if (typeof this.ai.chatTextWithTools !== "function") {
      const reply = await this.ai.chatText({ system, messages, user, model, onUsage });
      return { reply, groundedProductNames: new Set() };
    }
    let toolCalled = false;
    const groundedProductNames = new Set();
    try {
      const reply = await this.ai.chatTextWithTools({
        system,
        messages,
        user,
        model,
        tools: [CATALOG_SEARCH_TOOL],
        // Инструкция в промпте "обязательно вызови search_catalog" модель
        // может проигнорировать, если ей кажется, что она и так знает ответ
        // из каталога в системном промпте (проверено на проде: один раз
        // ответила про Canon вместо Garmin Fenix 8, ни разу не вызвав
        // инструмент). tool_choice на первом раунде убирает этот выбор —
        // ответить текстом сразу физически нельзя.
        forceToolOnFirstRound: "search_catalog",
        executeTool: async (name, args) => {
          if (name !== "search_catalog") return { error: "неизвестная функция" };
          toolCalled = true;
          const products = searchCatalogProducts(this.db, args?.query);
          products.forEach((p) => groundedProductNames.add(p.name));
          this._logEvent(conversationId, "info", "generation", "tool.search_catalog", "Модель запросила каталог через инструмент", {
            query: args?.query,
            resultCount: products.length,
            resultNames: products.slice(0, 5).map((p) => p.name),
          });
          return { products };
        },
        onUsage,
      });
      if (!toolCalled) {
        this._logEvent(conversationId, "warn", "generation", "tool.search_catalog_skipped", "Модель ответила, ни разу не вызвав search_catalog");
      }
      return { reply, groundedProductNames };
    } catch (error) {
      if (/Function calling пока поддержан только для DeepSeek/.test(error.message)) {
        const reply = await this.ai.chatText({ system, messages, user, model, onUsage });
        return { reply, groundedProductNames: new Set() };
      }
      throw error;
    }
  }

  _composePrompt(settings, catalog) {
    return [
      settings.systemPrompt,
      `ХАРАКТЕР:\n${settings.characterPrompt}`,
      `ПРАВИЛА:\n${settings.rulesPrompt}`,
      `ЗАДАЧА:\n${settings.taskPrompt}`,
      ASSISTANT_PRICE_POLICY,
      ASSISTANT_COLOR_POLICY,
      ASSISTANT_TONE_POLICY,
      ASSISTANT_CLOSING_POLICY,
      ASSISTANT_PRIVACY_POLICY,
      KNOWLEDGE_BASE ? `БАЗА ЗНАНИЙ О КАТЕГОРИЯХ (фон для презентации, не источник цены/наличия):\n${KNOWLEDGE_BASE}` : "",
      catalog ? `АКТУАЛЬНЫЙ КАТАЛОГ:\n${catalog}` : "",
    ].filter(Boolean).join("\n\n");
  }

  // Роутер шаблонов (идея из SmileKit, service.py ROUTE_TOOL): дешёвый вызов
  // модели, который либо выбирает id готового ответа из templates.js, либо
  // ничего — тогда идёт обычная генерация. Не бросает наружу: сбой роутера
  // не должен ломать ответ клиенту (fail-open, как у супервизора).
  async _routeTemplate(conversationId, settings, messages, customerMessage) {
    if (!settings.templateRouterEnabled || typeof this.ai?.chatJson !== "function") return null;
    if (!customerMessage.trim() || ROUTED_TEMPLATE_IDS.length === 0) return null;
    const history = messages.slice(-7, -1).map((m) => `${m.direction === "incoming" ? "клиент" : "продавец"}: ${m.text}`).join("\n") || "(новый диалог)";
    try {
      const result = await this.ai.chatJson({
        system: `${TEMPLATE_ROUTE_PROMPT}\n\n${ROUTE_TOOL_DESCRIPTION}\n\nВерни JSON {"template_id": "<id>"} с одним из id: ${ROUTED_TEMPLATE_IDS.join(", ")}. Если не уверен — {"template_id": null}.`,
        user: `ИСТОРИЯ:\n${history}\n\nСООБЩЕНИЕ КЛИЕНТА:\n${customerMessage}`,
        temperature: 0,
        maxTokens: 60,
        model: settings.model,
        onUsage: this._usageRecorder("template_router", conversationId, settings.model),
      });
      const id = typeof result?.template_id === "string" ? result.template_id.trim() : null;
      if (!id || !ROUTED_TEMPLATE_IDS.includes(id)) return null;
      // Один и тот же шаблон на тот же вопрос второй раз подряд — не шлём,
      // пусть ответит модель с учётом контекста.
      const alreadySent = messages.some((m) => m.direction !== "incoming" && m.text === templateById(id));
      if (alreadySent) return null;
      this._logEvent(conversationId, "info", "generation", "template_router.matched", "Роутер выбрал готовый шаблон", { templateId: id });
      return id;
    } catch (error) {
      this._logEvent(conversationId, "warn", "generation", "template_router.failed", error.message);
      return null;
    }
  }

  // Второй агент: проверяет черновик продавца перед отправкой (факты,
  // тон, полнота списка, внутренние термины, самопризнание в том, что бот).
  // Отдельный вызов ИИ, не текстовые regex-патчи — те (enforceCatalogPriceReply/
  // enforceCatalogAvailabilityReply) остаются и выполняются уже ПОСЛЕ этого
  // ревью, как финальная страховка на случай, если сам супервизор ошибся.
  // Сбой или таймаут ревью не блокирует ответ клиенту — уходит исходный
  // черновик (fail-open, тот же принцип, что и у остальных вызовов ИИ здесь).
  async _reviewReply({ conversationId, settings, history, customerRequest, draft, groundedProductNames }) {
    if (!settings.supervisorEnabled || !this.ai?.enabled || typeof this.ai.chatJson !== "function") return draft;
    try {
      const result = await this.ai.chatJson({
        system: settings.supervisorPrompt,
        user: JSON.stringify({
          customer_message: customerRequest,
          history: history.slice(-6),
          draft_reply: draft,
        }),
        temperature: 0,
        maxTokens: 1800,
        model: settings.model,
        onUsage: this._usageRecorder("supervisor", conversationId, settings.model),
      });
      const status = String(result?.status || "approved");
      const corrected = String(result?.corrected_reply || "").trim();
      if (status === "rewrite" && corrected) {
        // Супервизор — отдельный вызов ИИ без доступа к search_catalog: он
        // может переписать формулировку и заодно подменить проверенный товар
        // на выдуманный (найдено на проде: верный черновик про Garmin Fenix 8
        // после успешного tool call супервизор переписал на случайный Canon,
        // якобы исправляя незакрытый тег в тексте). Если этот ответ уже был
        // проверен через search_catalog (draft ссылается на один из найденных
        // товаров), исправление обязано сохранить ссылку хотя бы на один из
        // них — иначе это не исправление формулировки, а подмена факта.
        const draftIsGrounded = groundedProductNames?.size > 0
          && [...groundedProductNames].some((name) => draft.includes(name));
        const correctedKeepsGrounding = !groundedProductNames?.size
          || [...groundedProductNames].some((name) => corrected.includes(name));
        if (draftIsGrounded && !correctedKeepsGrounding) {
          this._logEvent(conversationId, "warn", "supervisor", "supervisor.rewrite_rejected", "Исправление супервизора потеряло проверенный через search_catalog товар — оставлен черновик", {
            issue: String(result?.issue || "").slice(0, 300),
          });
          return draft;
        }
        this._logEvent(conversationId, "info", "supervisor", "supervisor.rewrite", "Супервизор исправил черновик", {
          issue: String(result?.issue || "").slice(0, 300),
        });
        return corrected;
      }
      return draft;
    } catch (error) {
      this._logEvent(conversationId, "warn", "supervisor", "supervisor.failed", error.message);
      return draft;
    }
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
    const isNewConversation = !this.db
      .prepare("SELECT 1 FROM crm_conversations WHERE external_key = ?")
      .get(`telegram:${chatId}`);
    const conversation = this._upsertConversation({
      externalKey: `telegram:${chatId}`,
      source: "telegram",
      inbound: true,
      chatId,
      name,
      username: message.from?.username ? `@${message.from.username}` : null,
      createdAt: new Date(Number(message.date || Date.now() / 1000) * 1000).toISOString(),
    });
    // Клиент написал сам — отложенное напоминание больше не нужно, новый
    // автоответ на это сообщение сформирует свой собственный.
    this._cancelNudgeFollowUps(conversation.id);
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
    text = await this._augmentWithInstagramStory(text, conversation.id);
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
      const stageAction = stageActionForInbound(text);
      if (stageAction) this._publishStage(conversation, stageAction);
      if (classifyImportantEscalation(text)) this._publishImportantNotify(conversation, text);
    }
    if (inserted && conversation.ai_enabled) {
      if (this._isDuplicateInbound(conversation.id, inserted, text)) {
        this._logEvent(conversation.id, "info", "inbox", "message.duplicate_suppressed", "Дубликат сообщения не запустил повторный ответ", { windowSeconds: 40 });
      } else if (isStartCommand(text) || (isNewConversation && isFirstContactGreeting(text) && this.ai?.enabled)) {
        try {
          await this._send(conversation.id, FIRST_CONTACT_WELCOME_TEXT, "assistant");
          this._logEvent(conversation.id, "info", "delivery", "reply.sent_welcome", "Отправлено приветственное сообщение новому клиенту");
          this._scheduleNudgeFollowUps(conversation.id, null);
        } catch (error) {
          logger.error("crm.welcome_send_failed", { conversationId: conversation.id, error: error.message });
          this._logEvent(conversation.id, "error", "delivery", "reply.welcome_failed", error.message);
        }
      } else {
        if (isNewConversation) this._pendingFirstContactCatalog.add(conversation.id);
        this._debouncedAutoReply(conversation.id, inserted);
      }
    }
  }

  // ─── WhatsApp напрямую через Green API ──────────────────────────────────
  // Входящее из вебхука (см. services/greenapi.js parseGreenApiWebhook).
  // Логика первого контакта — как в Telegram: «привет» → приветствие магазина
  // без ИИ, вопрос сразу → ответ ИИ + каталог категорий в конце.
  async receiveGreenApi(incoming, raw) {
    if (!incoming?.phone || (!incoming.text && !incoming.mediaUrl)) return { ignored: true };
    const externalKey = `greenapi:${incoming.phone}`;
    const isNewConversation = !this.db.prepare("SELECT 1 FROM crm_conversations WHERE external_key = ?").get(externalKey);
    const conversation = this._upsertConversation({
      externalKey,
      source: "whatsapp",
      inbound: incoming.type === "incoming",
      chatId: incoming.phone,
      name: incoming.type === "incoming" ? incoming.name : null,
      phone: incoming.phone,
      createdAt: incoming.createdAt,
    });
    if (incoming.type === "outgoing") {
      // Сообщение ушло с самого телефона — чат взял живой менеджер, AI выключается.
      // Эхо наших же отправок Green API шлёт отдельным типом и сюда не попадает.
      const echo = this.db.prepare(
        `SELECT 1 FROM crm_messages
          WHERE conversation_id = ? AND direction = 'outgoing' AND text = ?
            AND created_at >= datetime(?, '-15 minutes')
          LIMIT 1`
      ).get(conversation.id, incoming.text, incoming.createdAt);
      if (echo) return { stored: false, conversationId: Number(conversation.id), echo: true };
      const inserted = this._storeMessage(conversation.id, {
        externalMessageId: incoming.messageId,
        direction: "outgoing",
        sender: "manager",
        text: incoming.text,
        raw,
        createdAt: incoming.createdAt,
      });
      this.db.prepare("UPDATE crm_conversations SET ai_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(conversation.id);
      return { stored: Boolean(inserted), conversationId: Number(conversation.id), manager: true };
    }
    this._cancelNudgeFollowUps(conversation.id);
    let text = String(incoming.text || "").trim();
    const mediaKind = /image/i.test(incoming.typeMessage) ? "image" : /audio|voice|ptt/i.test(incoming.typeMessage) ? "audio" : null;
    if (mediaKind && incoming.mediaUrl) {
      try {
        if (!this.ai?.analyzeMedia) throw new Error("Анализ вложений не настроен");
        const response = await this.fetchImpl(incoming.mediaUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Green API file: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const analysis = await this.ai.analyzeMedia({
          kind: mediaKind,
          bytes,
          mimeType: mediaMimeType(mediaKind, incoming.mediaUrl, response.headers?.get?.("content-type")),
          caption: text,
          onUsage: this._usageRecorder("media_analysis", conversation.id, this.getSettings().model),
        });
        text = [text, mediaKind === "image" ? `[Изображение: ${analysis}]` : `[Аудио: ${analysis}]`].filter(Boolean).join("\n");
        this._logEvent(conversation.id, "info", "media", "media.analyzed", "Вложение WhatsApp проанализировано", { kind: mediaKind, bytes: bytes.length });
      } catch (error) {
        text = [text, mediaKind === "image" ? "[Клиент прислал изображение]" : "[Клиент прислал аудио]"].filter(Boolean).join("\n");
        this._logEvent(conversation.id, "error", "media", "media.failed", error.message);
      }
    }
    return this._handleInboundText(conversation, {
      externalMessageId: incoming.messageId,
      text,
      raw,
      createdAt: incoming.createdAt,
      sourceLabel: "WhatsApp",
      isNewConversation,
    });
  }

  // Общий хвост приёма текста для WhatsApp и лаборатории: сохранить,
  // опубликовать в CRM, решить — приветствие, автоответ или ничего.
  // immediate: true — ответить сразу и дождаться (лаборатория), иначе
  // через debounce, как для настоящих клиентов.
  async _handleInboundText(conversation, { externalMessageId, text, raw, createdAt, sourceLabel, isNewConversation, immediate = false, bypassApproval = false }) {
    text = await this._augmentWithInstagramStory(text, conversation.id);
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId,
      direction: "incoming",
      sender: "customer",
      text,
      raw,
      createdAt,
    });
    if (!inserted) return { stored: false, conversationId: Number(conversation.id) };
    this._publishMessage(conversation, { externalMessageId, direction: "incoming", sender: "customer", text, raw, createdAt });
    this._logEvent(conversation.id, "info", "inbox", "message.received", `Получено сообщение из ${sourceLabel}`, { messageId: inserted });
    const stageAction = stageActionForInbound(text);
    if (stageAction) this._publishStage(conversation, stageAction);
    if (classifyImportantEscalation(text)) this._publishImportantNotify(conversation, text);
    if (!conversation.ai_enabled) return { stored: true, conversationId: Number(conversation.id) };
    if (this._isDuplicateInbound(conversation.id, inserted, text)) {
      this._logEvent(conversation.id, "info", "inbox", "message.duplicate_suppressed", "Дубликат сообщения не запустил повторный ответ", { windowSeconds: 40 });
    } else if (isStartCommand(text) || (isNewConversation && isFirstContactGreeting(text) && this.ai?.enabled)) {
      try {
        await this._send(conversation.id, FIRST_CONTACT_WELCOME_TEXT, "assistant");
        this._logEvent(conversation.id, "info", "delivery", "reply.sent_welcome", "Отправлено приветственное сообщение новому клиенту");
        this._scheduleNudgeFollowUps(conversation.id, null);
      } catch (error) {
        logger.error("crm.welcome_send_failed", { conversationId: conversation.id, error: error.message });
        this._logEvent(conversation.id, "error", "delivery", "reply.welcome_failed", error.message);
      }
    } else {
      if (isNewConversation) this._pendingFirstContactCatalog.add(conversation.id);
      if (immediate) await this._autoReply(conversation.id, inserted, { bypassApproval });
      else this._debouncedAutoReply(conversation.id, inserted);
    }
    return { stored: true, conversationId: Number(conversation.id) };
  }

  // ─── Лаборатория WhatsApp ───────────────────────────────────────────────
  // Тот же пайплайн, что у настоящих клиентов WhatsApp (шаблоны, роутер,
  // каталог, ИИ, супервизор, страховки цен), но: chatId с префиксом lab —
  // никогда не пересечётся с реальным номером; наружу ничего не уходит
  // (см. isLabConversation); подтверждение ответов не блокирует — ответ
  // сразу в истории. Идея из CRM SmileKit (actions/whatsapp-lab.ts).
  labChatId() {
    return `lab-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  }

  async labSend({ chatId, text } = {}) {
    const value = String(text || "").trim();
    if (!value) throw new Error("Введите сообщение тестового клиента");
    if (!this.ai?.enabled) throw new Error("ИИ не настроен: лаборатория не может ответить");
    const id = /^lab-[a-z0-9]+$/i.test(String(chatId || "")) ? String(chatId) : this.labChatId();
    const externalKey = `${LAB_KEY_PREFIX}${id}`;
    const isNewConversation = !this.db.prepare("SELECT 1 FROM crm_conversations WHERE external_key = ?").get(externalKey);
    const conversation = this._upsertConversation({
      externalKey,
      source: "whatsapp",
      inbound: true,
      chatId: id,
      name: "Тест (Лаборатория)",
      createdAt: new Date().toISOString(),
    });
    this._cancelNudgeFollowUps(conversation.id);
    await this._handleInboundText(conversation, {
      externalMessageId: `lab-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: value.slice(0, 4000),
      raw: null,
      createdAt: new Date().toISOString(),
      sourceLabel: "лаборатории WhatsApp",
      isNewConversation,
      immediate: true,
      bypassApproval: true,
    });
    return { chatId: id, history: this.labHistory(id) };
  }

  labHistory(chatId) {
    const conversation = this.db.prepare("SELECT id FROM crm_conversations WHERE external_key = ?").get(`${LAB_KEY_PREFIX}${chatId}`);
    if (!conversation) return [];
    return this.db.prepare(
      "SELECT sender, text, created_at FROM crm_messages WHERE conversation_id = ? ORDER BY datetime(created_at), id"
    ).all(conversation.id).map((row) => ({
      sender: row.sender === "customer" ? "client" : row.sender === "assistant" ? "bot" : "manager",
      text: row.text,
      createdAt: row.created_at,
    }));
  }

  labReset(chatId) {
    const conversation = this.db.prepare("SELECT id FROM crm_conversations WHERE external_key = ?").get(`${LAB_KEY_PREFIX}${chatId}`);
    if (!conversation) return { deleted: false };
    this.deleteConversation(Number(conversation.id));
    return { deleted: true };
  }

  // Состояние инстанса Green API и включение вебхука на наш адрес — для
  // страницы настроек WhatsApp в CRM.
  async getWhatsappState() {
    if (!this.greenapi?.enabled) return { enabled: false, state: null, webhookUrl: this.getStatus().whatsappWebhook, webhookConfigured: Boolean(config.greenapi.webhookToken) };
    const state = await this.greenapi.getState();
    return { enabled: true, state, webhookUrl: this.getStatus().whatsappWebhook, webhookConfigured: Boolean(config.greenapi.webhookToken) };
  }

  async setupWhatsappWebhook() {
    if (!this.greenapi?.enabled) throw new Error("Green API не настроен");
    if (!config.greenapi.webhookToken) throw new Error("GREENAPI_WEBHOOK_TOKEN не задан — без него вебхук закрыт");
    const webhookUrl = this.getStatus().whatsappWebhook;
    await this.greenapi.setWebhook({ webhookUrl, webhookUrlToken: config.greenapi.webhookToken });
    this._logEvent(null, "info", "settings", "whatsapp.webhook_set", "Вебхук Green API направлен на витрину", { webhookUrl });
    return { webhookUrl };
  }

  async receiveAmo(incoming, raw) {
    if (!incoming.text || !incoming.chatId) return { ignored: true };
    const source = /instagram/i.test(incoming.source)
      ? "instagram"
      : /whatsapp/i.test(incoming.source)
        ? "whatsapp"
        : "amocrm";
    const conversation = this._upsertConversation({
      externalKey: `amo:${incoming.chatId}`,
      source,
      inbound: incoming.direction === "incoming",
      chatId: incoming.chatId,
      leadId: incoming.leadId,
      contactId: incoming.contactId,
      name: incoming.direction === "incoming" ? incoming.customerName : null,
      username: incoming.customerUsername,
      phone: incoming.customerPhone,
      createdAt: incoming.createdAt,
    });
    if (incoming.direction === "outgoing") {
      // Эхо недавней отправки бота/менеджера уже есть локально. Любое другое
      // исходящее означает, что чат взял живой менеджер — AI выключается.
      const echo = this.db.prepare(
        `SELECT 1 FROM crm_messages
          WHERE conversation_id = ? AND direction = 'outgoing' AND text = ?
            AND created_at >= datetime(?, '-15 minutes')
          LIMIT 1`
      ).get(conversation.id, incoming.text, incoming.createdAt);
      if (echo) return { stored: false, conversationId: Number(conversation.id), echo: true };
      const inserted = this._storeMessage(conversation.id, {
        externalMessageId: incoming.messageId,
        direction: "outgoing",
        sender: "manager",
        text: incoming.text,
        raw,
        createdAt: incoming.createdAt,
      });
      this.db.prepare(
        "UPDATE crm_conversations SET ai_enabled = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(conversation.id);
      return { stored: Boolean(inserted), conversationId: Number(conversation.id), manager: true };
    }
    this._cancelNudgeFollowUps(conversation.id);
    let incomingText = incoming.text;
    const mediaKind = amoMediaKind(incoming.messageType);
    if (mediaKind && incoming.mediaUrl) {
      try {
        if (!this.ai?.analyzeMedia) throw new Error("Анализ вложений не настроен");
        const response = await this.fetchImpl(incoming.mediaUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`amoCRM file: HTTP ${response.status}`);
        const declaredSize = Number(response.headers?.get?.("content-length") || 0);
        if (declaredSize > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ");
        const analysis = await this.ai.analyzeMedia({
          kind: mediaKind,
          bytes,
          mimeType: mediaMimeType(mediaKind, incoming.mediaUrl, response.headers?.get?.("content-type")),
          caption: incoming.text.replace(/^\[(?:voice|audio|picture|image|photo)\]\s+https?:\/\/\S+$/i, ""),
          onUsage: this._usageRecorder("media_analysis", conversation.id, this.getSettings().model),
        });
        incomingText = [incoming.text, mediaKind === "image" ? `[Изображение: ${analysis}]` : `[Аудио: ${analysis}]`]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "info", "media", "media.analyzed", "Вложение amoCRM проанализировано", {
          kind: mediaKind,
          bytes: bytes.length,
        });
      } catch (error) {
        incomingText = [incoming.text, mediaKind === "image" ? "[Клиент прислал изображение]" : "[Клиент прислал аудио]"]
          .filter(Boolean).join("\n");
        this._logEvent(conversation.id, "error", "media", "media.failed", error.message);
      }
    }
    incomingText = await this._augmentWithInstagramStory(incomingText, conversation.id);
    const inserted = this._storeMessage(conversation.id, {
      externalMessageId: incoming.messageId,
      direction: "incoming",
      sender: "customer",
      text: incomingText,
      raw,
      createdAt: incoming.createdAt,
    });
    if (inserted) {
      this._publishMessage(conversation, {
        externalMessageId: incoming.messageId,
        direction: "incoming",
        sender: "customer",
        text: incomingText,
        raw,
        createdAt: incoming.createdAt,
      });
      this._logEvent(conversation.id, "info", "inbox", "message.received", `Получено сообщение из ${source}`, {
        messageId: inserted,
      });
      const stageAction = stageActionForInbound(incomingText);
      if (stageAction) this._publishStage(conversation, stageAction);
      if (classifyImportantEscalation(incomingText)) this._publishImportantNotify(conversation, incomingText);
    }
    if (inserted) {
      try {
        await this._syncAmoHistory(conversation);
      } catch (error) {
        this._logEvent(conversation.id, "warn", "amocrm", "amocrm.history_failed", error.message);
      }
      const current = this.db.prepare("SELECT ai_enabled FROM crm_conversations WHERE id = ?").get(conversation.id);
      const testPhones = String(config.amocrm.testPhone || "")
        .split(",")
        .map(normalizePhone)
        .filter(Boolean);
      const customerPhone = normalizePhone(conversation.customer_phone);
      const testPhoneAllowed = !testPhones.length || testPhones.includes(customerPhone);
      if (current?.ai_enabled && testPhoneAllowed) {
        this._debouncedAutoReply(conversation.id, inserted);
      } else if (!testPhoneAllowed) {
        this._logEvent(conversation.id, "info", "delivery", "reply.test_phone_skipped", "Автоответ отключён для номера вне теста");
      }
    }
    return { stored: Boolean(inserted), conversationId: Number(conversation.id) };
  }

  // Слова, из-за которых сообщение перестаёт быть «голым» запросом линейки:
  // цифры (модель/память/год), явные модификаторы. Консервативно — при
  // сомнении НЕ считаем запрос голым и отдаём его обычной генерации, а не
  // наоборот (безопасный дефолт — старое поведение, а не новый шаг).
  _isBareCategoryRequest(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (/\d/u.test(value)) return false;
    if (/\b(?:pro|max|plus|mini|ultra|air|se|gb|tb|про|макс|плюс|мини|эйр|титан|titan)\b/iu.test(value)) return false;
    // «Мне не нужна приставка» матчит семью по слову «пристав», но это
    // отказ, а не запрос — без этой проверки список консолей вылезал на
    // прямое «не нужна» (найдено на проде вместе с багом enforceCatalogAvailabilityReply).
    if (/не\s+нуж(?:ен|на|но)|не\s+хочу|без\s+/iu.test(value)) return false;
    // «Какой айфон посоветуете?» — клиент просит совет, а не список: голый
    // перечень моделей без цены и без вопроса о бюджете выглядит так, будто
    // бот не услышал вопрос (найдено на проде). Такие сообщения должны идти
    // в обычную генерацию, где промпт учит сначала спросить бюджет.
    if (/посовет|что.{0,15}(?:посовету|выбрать|лучше\s+взять)|какой.{0,15}(?:лучше|посовет)|подскаж[иу]/iu.test(value)) return false;
    const wordCount = value.split(/\s+/u).filter(Boolean).length;
    return wordCount <= 6;
  }

  // Список реальных названий моделей линейки (Distinct по official_name из
  // тех же активных структурированных карточек, что и основной каталог) —
  // без цены и без вызова ИИ. null — линейка не распознана или в ней меньше
  // двух разных моделей (тогда список бессмысленен, пусть отвечает ИИ сам).
  _categoryBrowseReply(customerText) {
    if (!this._isBareCategoryRequest(customerText)) return null;
    const family = CATALOG_FAMILIES.find((item) => item.request.test(customerText));
    if (!family) return null;
    const rows = this.db.prepare(
      `SELECT DISTINCT p.official_name AS name, p.brand AS brand, p.category AS category
         FROM products p
         JOIN message_products mp ON mp.product_id = p.id
         JOIN telegram_messages tm ON tm.id = mp.message_id
        WHERE p.status != 'hidden' AND mp.active = 1 AND tm.is_deleted = 0 AND mp.price IS NOT NULL`
    ).all();
    const matches = (row) => family.terms.some((term) =>
      `${row.name} ${row.brand || ""} ${row.category || ""}`.toLocaleLowerCase("ru-RU").includes(term)
    );
    const names = [...new Set(
      rows.filter(matches).map((row) => baseModelLine(row.name)).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
    if (names.length < 2) return null;
    const lines = names.map((name) => `• ${name}`).join("\n");
    return `У нас в наличии несколько моделей:\n${lines}\n\nКакая интересует? Назовите модель — сразу назову актуальную цену, цвета и объём памяти.`;
  }

  // Первое сообщение нового клиента уже было вопросом (не просто «привет») —
  // к первому же ответу (каким бы путём он ни ушёл: шаблон или ИИ) нужно
  // дописать список категорий, иначе новый клиент так и не увидит каталог.
  // Флаг обязательно снимаем здесь же — иначе он зависает в Set навсегда
  // для диалогов, где первый ответ всегда уходит через шаблон, и текст
  // каталога однажды приклеится к случайному более позднему ответу.
  _withPendingCatalog(conversationId, text) {
    if (!this._pendingFirstContactCatalog.has(conversationId)) return text;
    this._pendingFirstContactCatalog.delete(conversationId);
    return `${text}\n\n${FIRST_CONTACT_CATALOG_TEXT}`;
  }

  // Клиент прислал ссылку на Instagram Story/Highlight — резолвим её через
  // storyResolver (HikerAPI + vision, см. services/instagram/) и дописываем
  // результат в текст сообщения тем же приёмом, что и [Изображение: ...]/
  // [Аудио: ...] в receiveTelegram/receiveAmo: контекст для ИИ, а не второй
  // чат-бот — сам ответ клиенту формирует обычная генерация ниже. Падение
  // резолвера НЕ бросается наружу — либо контекст, либо честный
  // story_analysis_failed-блок с просьбой уточнить, но не выдумка.
  async _augmentWithInstagramStory(text, conversationId) {
    if (!this.storyResolver?.enabled) return text;
    const urls = findInstagramStoryUrls(text);
    if (!urls.length) return text;
    // Одно сообщение — одна ссылка на практике; если клиент прислал
    // несколько, резолвим только первую, чтобы не плодить параллельные
    // download+vision на одно сообщение.
    let result;
    try {
      result = await this.storyResolver.resolve(urls[0].normalizedUrl);
    } catch (error) {
      // storyResolver.resolve() сам ловит свои ошибки и возвращает
      // { story_analysis_failed: true } — сюда попадаем только если сам
      // вызов подвис/упал неожиданно (например storyResolver сконфигурирован
      // некорректно). Тред клиента это не должно останавливать.
      this._logEvent(conversationId, "warn", "instagram", "instagram_story.failed", error.message);
      result = { ok: false, story_analysis_failed: true, reason: "resolver_error" };
    }
    const context = formatStoryContext(result);
    if (!context) return text;
    this._logEvent(conversationId, result.ok ? "info" : "warn", "instagram", "instagram_story.resolved", result.ok ? "Story проанализирована" : "Story не удалось получить/проанализировать", { reason: result.reason || null, cached: result.cached || false });
    return [text, context].filter(Boolean).join("\n");
  }

  async _autoReply(conversationId, incomingMessageId, options = {}) {
    if (!this.ai?.enabled) return;
    const detail = this.getConversation(conversationId);
    if (!detail?.conversation.aiEnabled) return;
    // Явное возражение («я подумаю», «дорого») — готовый ответ вместо
    // полноценной генерации: быстрее, дешевле и звучит последовательно.
    const latestCustomerMessage = [...detail.messages].reverse().find((m) => m.direction === "incoming")?.text || "";
    const salesTemplate = classifySalesTemplate(latestCustomerMessage);
    if (salesTemplate) {
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) return;
      await this._send(conversationId, this._withPendingCatalog(conversationId, salesTemplate.text), "assistant");
      this._logEvent(conversationId, "info", "delivery", `reply.sent_template.${salesTemplate.kind}`, "Отправлен готовый сценарий магазина");
      if (salesTemplate.kind === "order") this._scheduleOrderIncompleteNudge(conversationId, null);
      else this._scheduleNudgeFollowUps(conversationId, null);
      return;
    }
    const reactiveText = classifyReactiveTemplate(latestCustomerMessage);
    if (reactiveText) {
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) return;
      await this._send(conversationId, this._withPendingCatalog(conversationId, reactiveText), "assistant");
      this._logEvent(conversationId, "info", "delivery", "reply.sent_template", "Готовый ответ на возражение вместо генерации ИИ");
      this._scheduleNudgeFollowUps(conversationId, null);
      return;
    }
    // Расширенный слой готовых ответов (server/services/templates.js, по
    // образцу SmileKit): сперва regex для однозначных фраз (жалоба, опт,
    // «позовите человека», повторное «привет»), затем дешёвый ИИ-роутер,
    // который выбирает id шаблона или ничего. Оба — до сборки каталога и
    // полной генерации: экономим токены и отвечаем одинаково на одинаковое.
    const hasHistory = detail.messages.filter((m) => m.direction === "incoming").length > 1;
    const localTemplate = classifyTemplate(latestCustomerMessage, { hasHistory });
    if (localTemplate) {
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) return;
      await this._send(conversationId, this._withPendingCatalog(conversationId, localTemplate.text), "assistant");
      this._logEvent(conversationId, "info", "delivery", `reply.sent_template.${localTemplate.kind}`, "Готовый шаблон по ключевым словам вместо генерации ИИ");
      if (localTemplate.kind === "complaint" || localTemplate.kind === "human_request") {
        this._publishImportantNotify(detail.conversation, `Клиент: ${latestCustomerMessage}`);
      } else {
        this._scheduleNudgeFollowUps(conversationId, null);
      }
      return;
    }
    const settings = this.getSettings();
    const routedTemplateId = await this._routeTemplate(conversationId, settings, detail.messages, latestCustomerMessage);
    const routedText = routedTemplateId ? templateById(routedTemplateId) : null;
    if (routedText) {
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) return;
      await this._send(conversationId, this._withPendingCatalog(conversationId, routedText), "assistant");
      this._logEvent(conversationId, "info", "delivery", `reply.routed_template.${routedTemplateId}`, "Готовый шаблон по решению роутера вместо генерации ИИ", { templateId: routedTemplateId });
      this._scheduleNudgeFollowUps(conversationId, null);
      return;
    }
    // Голый запрос по линейке («айфон», «покажите макбуки») без конкретной
    // модели — список названий БЕЗ цены, без вызова ИИ. Модель путала цены
    // именно на широких запросах: полный каталог (сотни товаров с ценами в
    // 4 валютах каждый) заставлял её выбирать между похожими карточками.
    // Когда клиент называет конкретную модель следующим сообщением, обычная
    // генерация ниже почти всегда сужается до одного реального кандидата —
    // цену перепутать почти не с чем.
    const categoryBrowseText = this._categoryBrowseReply(latestCustomerMessage);
    if (categoryBrowseText) {
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) return;
      await this._send(conversationId, this._withPendingCatalog(conversationId, categoryBrowseText), "assistant");
      this._logEvent(conversationId, "info", "delivery", "reply.category_browse", "Список моделей линейки без цены — клиент ещё не назвал конкретную модель");
      this._scheduleNudgeFollowUps(conversationId, null);
      return;
    }
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
    const catalogRequest = catalogRequestFromHistory(history);
    const selection = this._selectCatalogProducts({
      conversationId,
      customerRequest: catalogRequest,
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
      const generated = await this._chatWithCatalogTool({
        system: prompt,
        messages: history,
        model: settings.model,
        onUsage: this._usageRecorder("sales_agent", conversationId, settings.model),
        conversationId,
      });
      let reply = generated.reply;
      reply = await this._reviewReply({ conversationId, settings, history, customerRequest, draft: reply, groundedProductNames: generated.groundedProductNames });
      // См. комментарий в testBot: если search_catalog подтвердил товар,
      // старой эвристике relevantProductsForContext ниже доверять не нужно —
      // она может подменить проверенный товар на случайный при слабом
      // совпадении по ключевым словам (проверено на проде: Garmin Fenix 8 →
      // Canon PowerShot).
      if (!generated.groundedProductNames.size) {
        reply = enforceCatalogPriceReply({ reply, request: customerRequest, context: catalogRequest, selection });
        reply = enforceCatalogAvailabilityReply({ reply, request: customerRequest, context: catalogRequest, selection });
      }
      if (!this._canSendAutoReply(conversationId, incomingMessageId)) {
        this._logEvent(conversationId, "info", "generation", "generation.stale_discarded", "Черновик для устаревшего сообщения не отправлен", {
          incomingMessageId,
        });
        return;
      }
      reply = this._withPendingCatalog(conversationId, reply);
      if (settings.approvalEnabled && !options.bypassApproval) {
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
        const orderCareStarted = this._publishOrderIfConfirmed(detail.conversation, history, selection);
        this._logEvent(conversationId, "info", "delivery", "reply.sent", "Автоответ отправлен без подтверждения");
        if (!orderCareStarted) {
          const product = selectedCatalogProduct(selection);
          const productName = product ? [product.name, product.storage, product.color].filter(Boolean).join(", ") : null;
          if (stageActionForInbound(customerRequest) === "ready_to_buy") {
            this._scheduleOrderIncompleteNudge(conversationId, productName);
          } else {
            this._scheduleNudgeFollowUps(conversationId, productName);
          }
        }
      }
    } catch (error) {
      logger.error("crm.auto_reply_failed", { conversationId, error: error.message });
      this._logEvent(conversationId, "error", "generation", "generation.failed", error.message, {
        incomingMessageId,
      });
    }
  }

  // Раньше подборку по категории делал отдельный AI-товаровед — лишний
  // вызов модели, который иногда путался и терял реально существующие
  // товары (например не находил MacBook Air M5, хотя он есть в канале).
  // Отбор по категории — это фильтрация по ключевым словам, для нее ИИ не
  // нужен: narrowCatalogForRequest уже это делает, здесь только пересчёт
  // цены в разные валюты (чистая математика).
  _selectCatalogProducts({ conversationId, customerRequest, catalog }) {
    if (!catalog) return "Свежих публикаций канала не найдено.";
    let data;
    try {
      data = JSON.parse(narrowCatalogForRequest(catalog, customerRequest));
    } catch {
      // Старые импортированные позиции без message_products возвращаются
      // уже готовой строкой (см. buildTelegramCatalogForAssistant) — как есть.
      return catalog;
    }
    if (!data || typeof data !== "object") return catalog;
    // Теперь в подборку идёт весь структурированный каталог целиком (см.
    // narrowCatalogForRequest) — лимит только страховочный, чтобы промпт не
    // взорвался при аномальном росте базы.
    const products = Array.isArray(data.products)
      ? data.products.slice(0, 400).map((item) => {
        const price = Number(item?.price);
        const currency = String(item?.currency || "").toUpperCase();
        return {
          name: item?.name || null,
          brand: item?.brand || null,
          category: item?.category || null,
          storage: item?.storage || null,
          color: item?.color || null,
          description: item?.description || null,
          price,
          currency,
          priceKgs: Math.ceil(convertAssistantPrice(price, currency, "KGS")),
          priceUsd: Math.ceil(convertAssistantPrice(price, currency, "USD")),
          priceRub: Math.ceil(convertAssistantPrice(price, currency, "RUB")),
          priceKzt: Math.ceil(convertAssistantPrice(price, currency, "KZT")),
          available: Boolean(item?.available),
        };
      }).filter((item) => item.name && Number.isFinite(item.price) && ["USD", "KGS", "RUB", "KZT"].includes(item.currency))
      : [];
    const pendingPosts = Array.isArray(data.pendingPosts) ? data.pendingPosts.slice(0, 10) : [];
    this._logEvent(conversationId, "info", "catalog", "catalog.matched", "Каталог отфильтрован по категории запроса", {
      productCount: products.length,
      pendingPostCount: pendingPosts.length,
    });
    return `АКТУАЛЬНЫЙ КАТАЛОГ ИЗ TELEGRAM-КАНАЛА:\n${JSON.stringify({ products, pendingPosts })}\n\nОтвечай только по этому каталогу. Не говори, что обращался к товароведу или каналу.`;
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
          AND datetime(created_at) >= datetime('now', '-40 seconds')
        LIMIT 1`
    ).get(conversationId, messageId, value));
  }

  _canSendAutoReply(conversationId, incomingMessageId) {
    const state = this.db.prepare(
      `SELECT c.ai_enabled,
        (SELECT id FROM crm_messages
          WHERE conversation_id = c.id AND direction = 'incoming'
          ORDER BY id DESC LIMIT 1) AS newest_incoming_id
       FROM crm_conversations c WHERE c.id = ?`
    ).get(conversationId);
    return Boolean(state?.ai_enabled)
      && Number(state.newest_incoming_id) === Number(incomingMessageId);
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
    // По external_key с префиксом amo:, а не по голому external_chat_id —
    // тот не уникален между каналами (тот же числовой chat_id может
    // совпасть у Telegram/GreenAPI/лаборатории), и ответ менеджера ушёл бы
    // не в тот диалог.
    const externalKey = `amo:${chatId}`;
    let conversation = this.db.prepare(
      "SELECT * FROM crm_conversations WHERE external_key = ? ORDER BY id DESC LIMIT 1"
    ).get(externalKey);
    if (!conversation) {
      conversation = this._upsertConversation({
        externalKey,
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
    const matches = products.filter((product) => reply.includes(String(product.official_name).toLocaleLowerCase("ru-RU")));
    // Короткое совпадение, целиком входящее в более длинное («iPhone 17»
    // внутри «iPhone 17 Pro Max 256GB Black»), — тот же товар, не считаем
    // отдельным.
    const maximal = matches.filter((product) => {
      const name = String(product.official_name).toLocaleLowerCase("ru-RU");
      return !matches.some((other) =>
        other !== product
        && other.official_name.length > product.official_name.length
        && String(other.official_name).toLocaleLowerCase("ru-RU").includes(name)
      );
    });
    const distinct = [...new Map(maximal.map((product) => [product.official_name, product])).values()];
    // Если в ответе упомянуто несколько РАЗНЫХ товаров (например общий список
    // категорий в приветствии — «iPhone 17, MacBook, Apple Watch, Dyson...»),
    // это не конкретная рекомендация: непонятно, к какому товару относить
    // фото. На проде из-за этого к обычному приветствию прилипало случайное
    // фото iPhone 17, хотя клиент ещё ничего не спросил.
    if (distinct.length !== 1) return null;
    return distinct[0];
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

  _hasSentProductPhoto(conversationId, productName) {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM bot_events
        WHERE conversation_id = ? AND event = 'product_photo.sent' AND details = ?
        LIMIT 1`
    ).get(Number(conversationId), JSON.stringify({ product: String(productName) })));
  }

  async _send(conversationId, text, sender) {
    const c = this.db.prepare("SELECT * FROM crm_conversations WHERE id = ?").get(conversationId);
    if (!c) throw new Error("Диалог не найден");
    if (sender === "manager") {
      const timer = this._autoReplyTimers.get(c.id);
      if (timer) clearTimeout(timer);
      this._autoReplyTimers.delete(c.id);
      this._cancelNudgeFollowUps(c.id);
      this.db.prepare(
        "UPDATE crm_conversations SET ai_enabled = 0, updated_at = datetime('now') WHERE id = ?"
      ).run(c.id);
    } else if (sender === "assistant" && !c.ai_enabled) {
      throw new Error("Автоответ отменён: диалог передан менеджеру");
    }
    if (isLabConversation(c)) {
      // Лаборатория: наружу ничего не уходит, сообщение только ложится в историю.
    } else if (c.source === "whatsapp" && String(c.external_key).startsWith("greenapi:")) {
      if (!this.greenapi?.enabled) throw new Error("Green API не настроен");
      await this.greenapi.sendMessage(toGreenApiChatId(c.external_chat_id), text);
    } else if (c.source === "telegram") {
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
        if (product && !this._hasSentProductPhoto(c.id, product.official_name)) {
          try {
            await this._sendTelegramProductPhoto(c, product);
            this._logEvent(c.id, "info", "delivery", "product_photo.sent", "Фото товара отправлено", {
              product: product.official_name,
            });
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
    if (sender === "assistant") {
      this._publishStage(c, hasPriceInReply(text) ? "options_offered" : "primary_contact");
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
  DEFAULT_SUPERVISOR_PROMPT,
  buildTelegramCatalogForAssistant,
  narrowCatalogForRequest,
  formatAssistantPrice,
  catalogRequestFromHistory,
  relevantProductsForContext,
  enforceCatalogPriceReply,
  enforceCatalogAvailabilityReply,
  stageActionForInbound,
  classifyImportantEscalation,
  telegramHtml,
  toConversation,
  FIRST_CONTACT_WELCOME_TEXT,
  FIRST_CONTACT_CATALOG_TEXT,
  MOSTOVOY_SALES_TEMPLATES,
  classifySalesTemplate,
  baseModelLine,
};
