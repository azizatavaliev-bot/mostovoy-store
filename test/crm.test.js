const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const {
  CrmService,
  buildTelegramCatalogForAssistant,
  narrowCatalogForRequest,
  catalogRequestFromHistory,
  enforceCatalogPriceReply,
  stageActionForInbound,
  telegramHtml,
  FIRST_CONTACT_CATALOG_TEXT,
} = require("../server/services/crm");
const { parseAmoWebhook } = require("../server/services/amocrm");
const config = require("../server/config");

test("Markdown-оформление ответа преобразуется в безопасный Telegram HTML", () => {
  assert.equal(
    telegramHtml("1. **iPhone 17 Pro Max** — <флагман>\n*В наличии*\n`128 < 256`"),
    "1. <b>iPhone 17 Pro Max</b> — &lt;флагман&gt;\n<i>В наличии</i>\n<code>128 &lt; 256</code>",
  );
  assert.equal(
    telegramHtml("__Подчёркнуто__ и ~~зачёркнуто~~"),
    "<u>Подчёркнуто</u> и <s>зачёркнуто</s>",
  );
});

test("намерение клиента преобразуется в этап воронки", () => {
  assert.equal(stageActionForInbound("Нужен MacBook до 140000 сом"), "need_identified");
  assert.equal(stageActionForInbound("Этот вариант меня устраивает"), "interest_confirmed");
  assert.equal(stageActionForInbound("Оформляйте заказ"), "ready_to_buy");
  assert.equal(stageActionForInbound("Привет"), null);
});

test("каталог для ИИ отдаёт структурированные цены только из Telegram", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insertProduct = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, price, currency, status) VALUES (?, ?, ?, ?, ?, 'active')"
  );
  const iphone = insertProduct.run("iphone-15-test", "iphone-15-test", "iPhone 15", 99999, "RUB").lastInsertRowid;
  const premium = insertProduct.run("macbook-pro-test", "macbook-pro-test", "MacBook Pro 14", 99999, "RUB").lastInsertRowid;
  insertProduct.run("legacy-test", "legacy-test", "Старый товар сайта", 1, "RUB");
  db.prepare("UPDATE products SET origin = 'legacy' WHERE slug = 'legacy-test'").run();
  const whoop = insertProduct.run("whoop-test", "whoop-test", "Whoop 5.0 Peak", 255, "USD").lastInsertRowid;
  db.prepare("UPDATE products SET origin = 'manual', brand = 'Whoop', category = 'Фитнес-трекеры' WHERE id = ?").run(whoop);
  const message = db.prepare(
    `INSERT INTO telegram_messages
      (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', 1, '2026-07-31T10:00:00.000Z', 'Прайс', 'hash', 'ok')`
  ).run().lastInsertRowid;
  const link = db.prepare(
    "INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, ?, ?, ?, 1, 1)"
  );
  link.run(message, iphone, 900, "USD");
  link.run(message, premium, 1590, "USD");

  const catalog = JSON.parse(buildTelegramCatalogForAssistant(db));
  assert.equal(catalog.source, "telegram_channel");
  assert.deepEqual(catalog.products.map(({ name, price, currency, available }) => ({ name, price, currency, available })), [
    { name: "iPhone 15", price: 900, currency: "USD", available: true },
    { name: "MacBook Pro 14", price: 1590, currency: "USD", available: true },
  ]);
  assert.deepEqual(catalog.pendingPosts, []);
  assert.equal(catalog.products.some((product) => product.name === "Старый товар сайта"), false);
  assert.equal(catalog.products.some((product) => product.name === "Whoop 5.0 Peak"), false);
});

test("подбор по категории отбирает товары из канала без вызова ИИ", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const iphone = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, price, currency, status) VALUES (?, ?, ?, ?, ?, 'active')"
  ).run("iphone-17-test", "iphone-17-test", "iPhone 17", 87000, "KGS").lastInsertRowid;
  const message = db.prepare(
    `INSERT INTO telegram_messages
      (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', 777, '2026-08-02T10:00:00.000Z', 'iPhone 17 256 GB — 87 000 с', 'hash-777', 'ok')`
  ).run().lastInsertRowid;
  db.prepare(
    "INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, ?, ?, ?, 1, 1)"
  ).run(message, iphone, 87000, "KGS");

  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  const selection = crm._selectCatalogProducts({
    conversationId: null,
    customerRequest: "Посоветуй iPhone до 120 000 сомов",
    catalog: buildTelegramCatalogForAssistant(db),
  });

  const expectedKzt = Math.ceil((87000 / config.rates.KGS) * config.rates.KZT);
  assert.match(selection, /АКТУАЛЬНЫЙ КАТАЛОГ/);
  assert.match(selection, /"price":87000/);
  assert.match(selection, /"currency":"KGS"/);
  assert.match(selection, new RegExp(`"priceKzt":${expectedKzt}`));
  assert.doesNotMatch(selection, /\[Пост канала/);
});

test("незавершённые посты другой категории не мешают подбору по категории", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  db.prepare(
    `INSERT INTO telegram_messages
      (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', 777, '2026-08-02T10:00:00.000Z', 'Dyson Airwrap 500$', 'hash-777', 'raw')`
  ).run();

  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  const selection = crm._selectCatalogProducts({
    conversationId: null,
    customerRequest: "Посоветуй iPhone до 120 000 сомов",
    catalog: buildTelegramCatalogForAssistant(db),
  });

  assert.match(selection, /АКТУАЛЬНЫЙ КАТАЛОГ/);
  assert.doesNotMatch(selection, /Dyson/);
});

test("валюта ответа по умолчанию — сомы для любой стоимости", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insert = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, price, currency, status) VALUES (?, ?, ?, ?, 'USD', 'active')"
  );
  insert.run("iphone-15-snapshot", "iphone-15-snapshot", "iPhone 15", 900);
  insert.run("macbook-pro-snapshot", "macbook-pro-snapshot", "MacBook Pro 16", 1600);

  const catalog = buildTelegramCatalogForAssistant(db);
  // Курс доллар→сом обновлён на 83 (был 87.5).
  assert.match(catalog, /iPhone 15: цена по умолчанию 74\s700 с/);
  assert.match(catalog, /MacBook Pro 16: цена по умолчанию 132\s800 с/);

  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  const prompt = crm._composePrompt(crm.getSettings(), "");
  assert.match(prompt, /прямо сообщил, что он находится в России/);
  assert.match(prompt, /независимо от стоимости товара/);
  assert.match(prompt, /сообщил, что он из Казахстана[^.]*цену в тенге \(priceKzt\)/);
  assert.match(prompt, /по умолчанию называй цену в сомах|называй цену в сомах/);
});

test("поиск для товароведа оставляет посты только нужной категории", () => {
  const catalog = JSON.stringify({
    source: "telegram_channel",
    products: [],
    pendingPosts: [
      { telegramMessageId: 1, text: "iPhone 17 256 GB — 840$" },
      { telegramMessageId: 2, text: "Dyson Airwrap — 500$" },
      { telegramMessageId: 3, text: "iPhone 16 128 GB — 700$" },
    ],
  });
  const narrowed = JSON.parse(narrowCatalogForRequest(catalog, "Посоветуй айфон до 120000 сом"));
  assert.deepEqual(narrowed.pendingPosts.map((post) => post.telegramMessageId), [3]);
});

test("старый raw-прайс не перебивает более новый разобранный пост канала", () => {
  const catalog = JSON.stringify({
    source: "telegram_channel",
    products: [
      { name: "PlayStation 5 Slim", brand: "Sony", category: "Игровые приставки", price: 620, currency: "USD", telegramMessageId: 777 },
    ],
    pendingPosts: [
      { telegramMessageId: 452, text: "Sony 5 slim 650$" },
    ],
  });
  const narrowed = JSON.parse(narrowCatalogForRequest(catalog, "Какие приставки есть?"));
  assert.deepEqual(narrowed.products.map((product) => product.price), [620]);
  assert.deepEqual(narrowed.pendingPosts, []);
});

test("новая категория клиента не перехватывается старым iPhone из истории", () => {
  const catalog = JSON.stringify({
    source: "telegram_channel",
    products: [
      { name: "iPhone 17", brand: "Apple", category: "Смартфоны", price: 87000, currency: "KGS" },
      { name: "Whoop 5.0 Peak", brand: "Whoop", category: "Фитнес-трекеры", price: 255, currency: "USD" },
      { name: "Philips OneBlade", brand: "Philips", category: "Триммеры", price: 2500, currency: "KGS" },
      { name: "Meta Ray-Ban Wayfarer Gen 2", brand: "Meta", category: "Смарт-очки", price: 42000, currency: "KGS" },
      { name: "Dyson Airwrap HS09", brand: "Dyson", category: "Фены и стайлеры", price: 610, currency: "USD" },
    ],
    pendingPosts: [],
  });
  const whoop = JSON.parse(narrowCatalogForRequest(catalog, "КЛИЕНТ: Сколько стоит iPhone 17?\nКОНСУЛЬТАНТ: 87 000 сом\nКЛИЕНТ: А Whoop есть?"));
  assert.deepEqual(whoop.products.map((product) => product.name), ["Whoop 5.0 Peak"]);

  const razor = JSON.parse(narrowCatalogForRequest(catalog, "КЛИЕНТ: Покажи iPhone\nКЛИЕНТ: А бритва есть?"));
  assert.deepEqual(razor.products.map((product) => product.name), ["Philips OneBlade"]);

  const glasses = JSON.parse(narrowCatalogForRequest(catalog, "КЛИЕНТ: Покажи iPhone\nКЛИЕНТ: Ray-Ban есть?"));
  assert.deepEqual(glasses.products.map((product) => product.name), ["Meta Ray-Ban Wayfarer Gen 2"]);

  const dyson = JSON.parse(narrowCatalogForRequest(catalog, "КЛИЕНТ: Покажи iPhone\nКЛИЕНТ: Какие Dyson есть?"));
  assert.deepEqual(dyson.products.map((product) => product.name), ["Dyson Airwrap HS09"]);
});

test("короткое уточнение валюты сохраняет модель из контекста диалога", () => {
  const request = catalogRequestFromHistory([
    { role: "user", content: "Скок стоит iPhone 17 Pro Max 256" },
    { role: "assistant", content: "iPhone 17 Pro Max 256 ГБ — 1 235 $." },
    { role: "user", content: "А в сомах?" },
  ]);

  assert.match(request, /iPhone 17 Pro Max 256/);
  assert.match(request, /КЛИЕНТ: А в сомах\?/);
});

test("отказ назвать цену из подборки заменяется проверенной ценой в нужной валюте", () => {
  const selection = `ПОДБОРКА ТОВАРОВЕДА ИЗ КАНАЛА:\n${JSON.stringify({
    products: [{
      name: "iPhone 17 Pro Max",
      storage: "256 ГБ",
      color: "Синий",
      price: 1235,
      currency: "USD",
      priceKgs: 108063,
      priceUsd: 1235,
      priceRub: 97565,
      priceKzt: 629850,
      available: true,
    }],
  })}`;

  const kgs = enforceCatalogPriceReply({
    reply: "Точной цены в сомах нет, поэтому назвать сумму не смогу.",
    request: "А в сомах?",
    selection,
  });
  assert.match(kgs, /108\s100 с/);
  assert.match(kgs, /Могу сразу оформить заказ/);
  assert.doesNotMatch(kgs, /не смогу|цены.*нет/i);

  const usd = enforceCatalogPriceReply({
    reply: "Подтверждённой цены в долларах нет.",
    request: "В $?",
    selection,
  });
  assert.match(usd, /1\s240 \$/);
  assert.doesNotMatch(usd, /цены.*нет/i);

  const wrongKgs = enforceCatalogPriceReply({
    reply: "iPhone 17 Pro Max 256 ГБ — 94 800 сом. В наличии.",
    request: "А в сомах?",
    selection,
  });
  assert.match(wrongKgs, /108\s100 с/);
  assert.doesNotMatch(wrongKgs, /94\s800/);

  const rubWithoutRussia = enforceCatalogPriceReply({
    reply: "iPhone 17 Pro Max 256 ГБ — 97 600 ₽.",
    request: "А в рублях?",
    selection,
  });
  assert.match(rubWithoutRussia, /108\s100 с/);
  assert.doesNotMatch(rubWithoutRussia, /₽/);

  const rubForRussia = enforceCatalogPriceReply({
    reply: "iPhone 17 Pro Max 256 ГБ — 97 600 ₽. В наличии.",
    request: "Сколько стоит?",
    context: "КЛИЕНТ: Я живу в России\nКЛИЕНТ: Сколько стоит?",
    selection,
  });
  assert.match(rubForRussia, /97\s600 ₽/);
  assert.doesNotMatch(rubForRussia, /108\s100 с/);
});

test("личное сообщение Telegram создаёт CRM-диалог без дублей", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({
    db,
    deepseek: { enabled: false },
    amocrm: { enabled: false },
  });
  const message = {
    message_id: 77,
    date: 1_700_000_000,
    text: "Есть iPhone 17?",
    chat: { id: 123, type: "private" },
    from: { id: 123, first_name: "Азиз", username: "aziz" },
  };

  await crm.receiveTelegram(message);
  await crm.receiveTelegram(message);

  const conversations = crm.listConversations();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].source, "telegram");
  assert.equal(conversations[0].customerName, "Азиз");
  assert.equal(crm.getConversation(conversations[0].id).messages.length, 1);
});

test("очистка истории лида удаляет сообщения, но сохраняет сам диалог", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  await crm.receiveTelegram({
    message_id: 78,
    text: "Хочу iPhone",
    chat: { id: 124, type: "private" },
    from: { id: 124, first_name: "Клиент" },
  });
  const conversation = crm.listConversations()[0];
  const result = crm.clearConversationHistory(conversation.id);

  assert.equal(result.messages, 1);
  assert.equal(crm.listConversations().length, 1);
  assert.equal(crm.getConversation(conversation.id).messages.length, 0);
});

test("удаление диалога убирает сам диалог — следующее сообщение снова первый контакт", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  await crm.receiveTelegram({
    message_id: 78,
    text: "Хочу iPhone",
    chat: { id: 124, type: "private" },
    from: { id: 124, first_name: "Клиент" },
  });
  const conversation = crm.listConversations()[0];

  const result = crm.deleteConversation(conversation.id);
  assert.deepEqual(result, { deleted: true });
  assert.equal(crm.listConversations().length, 0);
  assert.equal(crm.deleteConversation(conversation.id), null);
});

test("amoCRM form webhook разбирает WhatsApp-сообщение", () => {
  const parsed = parseAmoWebhook({
    "message[add][0][text]": "Здравствуйте",
    "message[add][0][type]": "incoming",
    "message[add][0][chat_id]": "chat-1",
    "message[add][0][id]": "msg-1",
    "message[add][0][author][name]": "Клиент",
    "message[add][0][element_id]": "991",
    "message[add][0][origin]": "whatsapp",
  });
  assert.equal(parsed.text, "Здравствуйте");
  assert.equal(parsed.chatId, "chat-1");
  assert.equal(parsed.leadId, "991");
  assert.equal(parsed.source, "whatsapp");
});

test("amoCRM JSON webhook разбирает Instagram-сообщение", () => {
  const parsed = parseAmoWebhook({
    message: {
      add: [{
        text: "Хочу заказать",
        type: "incoming",
        chat_id: "ig-chat-1",
        id: "ig-message-1",
        origin: "instagram",
        author: { id: "7", name: "Instagram client" },
      }],
    },
  });
  assert.equal(parsed.text, "Хочу заказать");
  assert.equal(parsed.chatId, "ig-chat-1");
  assert.equal(parsed.source, "instagram");
});

test("Instagram из amoCRM сохраняется отдельным каналом и зеркалируется в Azis CRM", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const events = [];
  const crm = new CrmService({
    db,
    ai: { enabled: false },
    amocrm: { enabled: false },
    azisCrm: {
      enabled: true,
      publishEvent: async (type, payload) => events.push({ type, payload }),
    },
  });

  await crm.receiveAmo(
    {
      text: "Нужен MacBook",
      direction: "incoming",
      chatId: "instagram-chat-7",
      messageId: "instagram-message-7",
      customerName: "Клиент",
      source: "instagram",
      createdAt: "2026-07-28T12:00:00.000Z",
    },
    { raw: true },
  );

  assert.equal(crm.listConversations()[0].source, "instagram");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message");
  assert.equal(events[0].payload.channel, "instagram");
  assert.equal(events[0].payload.externalMessageId, "instagram-message-7");
});

test("ответ из Azis CRM отправляется в исходный amoCRM-чат", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const sent = [];
  const events = [];
  const crm = new CrmService({
    db,
    ai: { enabled: false },
    amocrm: {
      enabled: true,
      sendMessage: async (payload) => sent.push(payload),
    },
    azisCrm: {
      enabled: true,
      publishEvent: async (type, payload) => events.push({ type, payload }),
    },
  });

  await crm.receiveAmo({
    text: "Есть iPhone 17?",
    direction: "incoming",
    chatId: "wa-chat-9",
    messageId: "wa-message-9",
    leadId: "901",
    contactId: "902",
    source: "whatsapp",
  });
  const result = await crm.sendExternal({
    source: "whatsapp",
    chatId: "wa-chat-9",
    leadId: "901",
    contactId: "902",
    text: "Да, есть в наличии.",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "wa-chat-9");
  assert.equal(sent[0].leadId, "901");
  assert.equal(result.conversationId, crm.listConversations()[0].id);
  assert.ok(result.messageId);
  assert.equal(events.at(-1).payload.direction, "outgoing");
});

test("CRM хранит заметку и переключатель AI", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  await crm.receiveTelegram({
    message_id: 1,
    text: "Привет",
    chat: { id: 555, type: "private" },
    from: { first_name: "Клиент" },
  });
  const id = crm.listConversations()[0].id;
  const updated = crm.updateConversation(id, { aiEnabled: false, notes: "Ищет MacBook" });
  assert.equal(updated.conversation.aiEnabled, false);
  assert.equal(updated.conversation.notes, "Ищет MacBook");
});

test("ответ бота ждёт подтверждения и отправляется только после решения менеджера", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let sent = 0;
  const crm = new CrmService({
    db,
    deepseek: {
      enabled: true,
      chatText: async () => "Да, iPhone 17 есть в наличии.",
    },
    amocrm: { enabled: false },
    // _autoReply перед каждым ответом синхронизирует публикации канала
    // (t.me/s/...) — считаем только реальную отправку клиенту через Bot API,
    // а не эту фоновую синхронизацию.
    fetchImpl: async (url) => {
      if (!String(url).includes("api.telegram.org")) return { ok: true, status: 200, text: async () => "" };
      sent += 1;
      return { ok: true, status: 200 };
    },
    autoReplyDebounceMs: 0,
  });

  await crm.receiveTelegram({
    message_id: 91,
    date: 1_700_000_000,
    text: "Есть iPhone 17?",
    chat: { id: 991, type: "private" },
    from: { id: 991, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const [draft] = crm.listApprovals("pending");
  assert.equal(sent, 0);
  assert.equal(draft.customerMessage, "Есть iPhone 17?");
  assert.equal(draft.aiReply, `Да, iPhone 17 есть в наличии.\n\n${FIRST_CONTACT_CATALOG_TEXT}`);

  await crm.approveReply(draft.id, "Да, есть. Какой цвет вас интересует?");

  assert.equal(sent, 1);
  assert.equal(crm.listApprovals("pending").length, 0);
  assert.equal(crm.listApprovals("approved")[0].editedReply, "Да, есть. Какой цвет вас интересует?");
  assert.equal(crm.getConversation(draft.conversationId).messages.at(-1).sender, "assistant");
  assert.equal(crm.getBuyAnalytics(30).summary.handoffs, 1);
});

test("Telegram-фото анализируется и попадает в контекст диалога", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let analyzed = null;
  const ai = {
    enabled: true,
    listModels: () => [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "deepseek", enabled: true }],
    analyzeMedia: async (payload) => {
      analyzed = payload;
      return "на фото белый iPhone 17 Pro Max";
    },
    chatText: async () => "Да, такая модель есть в каталоге.",
  };
  const crm = new CrmService({
    db,
    ai,
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (String(url).includes("/getFile")) {
        return { ok: true, json: async () => ({ result: { file_path: "photos/phone.jpg" } }) };
      }
      return {
        ok: true,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    },
    autoReplyDebounceMs: 0,
  });

  await crm.receiveTelegram({
    message_id: 92,
    date: 1_700_000_000,
    caption: "Есть такой?",
    photo: [{ file_id: "small" }, { file_id: "large", file_size: 3 }],
    chat: { id: 992, type: "private" },
    from: { id: 992, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(analyzed.kind, "image");
  assert.equal(analyzed.mimeType, "image/jpeg");
  const detail = crm.getConversation(crm.listConversations()[0].id);
  assert.match(detail.messages[0].text, /Есть такой/);
  assert.match(detail.messages[0].text, /белый iPhone 17 Pro Max/);
  assert.equal(crm.listApprovals("pending").length, 1);
});

test("настройки бота сохраняют модель, подтверждение и гипервизор контекста", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: true }, amocrm: { enabled: false } });

  const settings = crm.saveSettings({
    approvalEnabled: false,
    aggressiveLearning: true,
    model: "deepseek-v4-pro",
    systemPrompt: "Система",
    hypervisorPrompt: "Только перескажи контекст",
    characterPrompt: "Характер",
    rulesPrompt: "Правила",
    taskPrompt: "Задача",
  });

  assert.equal(settings.approvalEnabled, false);
  assert.equal(settings.aggressiveLearning, true);
  assert.equal(settings.model, "deepseek-v4-pro");
  assert.equal(settings.systemPrompt, "Система");
  assert.equal(settings.hypervisorPrompt, "Только перескажи контекст");
  assert.equal(settings.characterPrompt, "Характер");
  assert.equal(settings.rulesPrompt, "Правила");
  assert.equal(settings.taskPrompt, "Задача");
});

test("гипервизор получает только историю диалога и сохраняет её резюме отдельно от ответа", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const calls = [];
  const ai = {
    enabled: true,
    chatText: async (payload) => {
      calls.push(payload);
      return payload.system.includes("Только факты из истории")
        ? "Клиент ищет iPhone 17 и уточняет наличие. Цвет пока не выбран."
        : "Да, iPhone 17 есть в наличии.";
    },
  };
  const crm = new CrmService({
    db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    // Без мока _autoReply бил бы в реальную сеть на синхронизации канала.
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
  });
  crm.saveSettings({ hypervisorPrompt: "Только факты из истории. Не оценивай ответ." });

  await crm.receiveTelegram({
    message_id: 122,
    text: "Есть iPhone 17?",
    chat: { id: 122, type: "private" },
    from: { first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const draft = crm.listApprovals("pending")[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].system.includes("Только факты из истории"), false);
  assert.equal(calls[1].system, "Только факты из истории. Не оценивай ответ.");
  assert.deepEqual(calls[1].messages, [{ role: "user", content: "Есть iPhone 17?" }]);
  assert.equal("user" in calls[1], false);
  assert.equal(draft.aiReply, `Да, iPhone 17 есть в наличии.\n\n${FIRST_CONTACT_CATALOG_TEXT}`);
  assert.equal(draft.summary, "Клиент ищет iPhone 17 и уточняет наличие. Цвет пока не выбран.");
});

test("агрессивное обучение сохраняет отклонение и точечно обновляет системный промпт", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const deepseek = {
    enabled: true,
    chatText: async ({ onUsage }) => {
      onUsage?.({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, "deepseek-v4-flash");
      return "Конечно, скидка 50%.";
    },
    chatJson: async ({ onUsage }) => {
      onUsage?.({ prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 }, "deepseek-v4-flash");
      return {
        prompt_patch: "Не обещай скидку, если она не указана в каталоге.",
        reasoning: "Ответ содержал выдуманную скидку.",
      };
    },
  };
  const crm = new CrmService({
    db, deepseek, amocrm: { enabled: false }, autoReplyDebounceMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
  });
  crm.saveSettings({ aggressiveLearning: true, systemPrompt: "Базовый промпт." });

  await crm.receiveTelegram({
    message_id: 120,
    date: 1_700_000_000,
    text: "Дадите скидку?",
    chat: { id: 120, type: "private" },
    from: { id: 120, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const draft = crm.listApprovals("pending")[0];
  await crm.rejectReply(draft.id, "Бот придумал скидку");

  const rejected = crm.listApprovals("rejected")[0];
  assert.equal(rejected.rejectReason, "Бот придумал скидку");
  assert.match(crm.getSettings().systemPrompt, /Не обещай скидку/);
  const example = db.prepare("SELECT * FROM bot_training_examples WHERE approval_id = ?").get(draft.id);
  assert.equal(example.quality_label, "rejected");
  assert.equal(example.reject_reason, "Бот придумал скидку");
  assert.equal(JSON.parse(db.prepare(
    "SELECT value FROM crm_settings WHERE key = 'bot_system_prompt_history'"
  ).get().value).length, 1);

  const usage = crm.getAiUsageAnalytics();
  assert.equal(usage.tasks.find((item) => item.task === "sales_agent").tokens, 120);
  assert.equal(usage.tasks.find((item) => item.task === "aggressive_learning").tokens, 90);
  assert.ok(usage.periods.all.costUsd > 0);
  assert.equal(usage.customers.total, 1);
  assert.equal(usage.customers.telegram, 1);
  assert.equal(usage.customers.returning, 0);
});

test("сбой агрессивного обучения не отменяет отклонение ответа", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({
    db,
    deepseek: {
      enabled: true,
      chatText: async () => "Неудачный ответ",
      chatJson: async () => {
        throw new Error("DeepSeek временно недоступен");
      },
    },
    amocrm: { enabled: false },
    autoReplyDebounceMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }),
  });
  crm.saveSettings({ aggressiveLearning: true });
  await crm.receiveTelegram({
    message_id: 121,
    text: "Вопрос",
    chat: { id: 121, type: "private" },
    from: { first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const draft = crm.listApprovals("pending")[0];
  await crm.rejectReply(draft.id, "Ответ неверный");

  assert.equal(crm.listApprovals("rejected").length, 1);
  assert.equal(crm.listEvents({ level: "error" })[0].event, "learning.failed");
});

// ─── Сделки в MostovoyCRM ────────────────────────────────────────────────────
// Витрина только сообщает «пришёл новый клиент»; воронку ведёт CRM.

function makeDealsSpy({ fail = false } = {}) {
  const calls = [];
  const advanceCalls = [];
  const orderCalls = [];
  return {
    calls,
    advanceCalls,
    orderCalls,
    enabled: true,
    async createDeal(payload) {
      calls.push(payload);
      if (fail) throw new Error("CRM недоступна");
      return { ok: true, created: true };
    },
    async advanceStage(payload) {
      advanceCalls.push(payload);
      if (fail) throw new Error("CRM недоступна");
      return { ok: true, moved: true, stageName: payload.action };
    },
    async createOrder(payload) {
      orderCalls.push(payload);
      if (fail) throw new Error("CRM недоступна");
      return { ok: true, id: "order-1" };
    },
  };
}

test("заказ записывается только в сделку текущего Telegram-клиента", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crmDeals = makeDealsSpy();
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, crmDeals });
  const selection = 'ТОЧНЫЕ ТОВАРЫ: {"products":[{"name":"iPhone 17 Pro Max","storage":"1 TB","color":"Синий","price":1610,"priceKgs":140875,"currency":"USD","available":true}]}';

  // _publishOrderIfConfirmed передаёт conversation.id в _scheduleOrderCareFollowUps,
  // а та пишет в order_follow_ups с внешним ключом на crm_conversations(id) —
  // строка обязана реально существовать в базе, голый литерал с придуманным
  // id здесь не подходит (тест падал с "FOREIGN KEY constraint failed",
  // сам код при этом рабочий: в реальном пути conversation всегда приходит
  // из getConversation(), то есть уже вставлен). Сеем через тот же путь,
  // которым пользуется прод, — _upsertConversation.
  const first = crm._upsertConversation({
    externalKey: "telegram:111", source: "telegram", chatId: "111", name: "Первый", inbound: true,
  });
  crm._publishOrderIfConfirmed(
    first,
    [{ role: "user", content: "Оформляйте этот iPhone" }],
    selection
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(crmDeals.orderCalls.length, 1);
  assert.equal(crmDeals.orderCalls[0].externalKey, "telegram:111");
  assert.equal(crmDeals.orderCalls[0].customerName, "Первый");

  // Второй клиент (другой chatId) не должен писать заказ в сделку первого,
  // даже если бы где-то по ошибке подставили тот же externalKey, — отсюда
  // и название теста. _upsertConversation с новым chatId настоящего второго
  // клиента здесь и должен получить собственный externalKey.
  const second = crm._upsertConversation({
    externalKey: "telegram:222", source: "telegram", chatId: "222", name: "Второй", inbound: true,
  });
  crm._publishOrderIfConfirmed(
    second,
    [{ role: "user", content: "Оформляйте этот iPhone" }],
    selection
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(crmDeals.orderCalls.length, 2);
  assert.equal(crmDeals.orderCalls[1].externalKey, "telegram:222");
  assert.equal(crmDeals.orderCalls[1].customerName, "Второй");
});

test("входящая потребность и ответ с ценой двигают сделку вперёд", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  const crmDeals = makeDealsSpy();
  const crm = new CrmService({
    db,
    ai: { enabled: false },
    amocrm: { enabled: false },
    crmDeals,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  await crm.receiveTelegram({
    message_id: 490,
    text: "Сколько стоит iPhone?",
    chat: { id: 490, type: "private" },
    from: { id: 490, first_name: "Клиент" },
  });
  const conversation = crm.listConversations()[0];

  await crm._send(conversation.id, "Заказ — **iPhone 17 Pro Max 1 ТБ за 140\u202f875 сом**. Оформить резерв?", "assistant");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(crmDeals.advanceCalls, [
    { externalKey: "telegram:490", action: "need_identified" },
    { externalKey: "telegram:490", action: "options_offered" },
  ]);
});

test("фото одного товара отправляется только один раз за диалог", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  const previousPublicUrl = config.publicUrl;
  config.telegram.botToken = "test-token";
  config.publicUrl = "https://store.example";
  t.after(() => {
    config.telegram.botToken = previousToken;
    config.publicUrl = previousPublicUrl;
    db.close();
  });
  db.prepare(
    `INSERT INTO products
      (slug, normalized_key, official_name, price, currency, status, main_image_url)
     VALUES ('iphone-17-pro-max-photo', 'iphone-17-pro-max-photo', 'iPhone 17 Pro Max', 1235, 'USD', 'active', '/iphone.webp')`
  ).run();
  const requests = [];
  const crm = new CrmService({
    db,
    ai: { enabled: false },
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200 };
    },
  });
  await crm.receiveTelegram({
    message_id: 491,
    text: "Покажите iPhone 17 Pro Max",
    chat: { id: 491, type: "private" },
    from: { id: 491, first_name: "Клиент" },
  });
  const conversation = crm.listConversations()[0];

  await crm._send(conversation.id, "iPhone 17 Pro Max — 1 235 $. В наличии.", "assistant");
  await crm._send(conversation.id, "Оформим iPhone 17 Pro Max?", "assistant");

  assert.equal(requests.filter((url) => url.includes("/sendMessage")).length, 2);
  assert.equal(requests.filter((url) => url.includes("/sendPhoto")).length, 1);
  assert.equal(crm.listEvents().filter((event) => event.event === "product_photo.sent").length, 1);
});

test("первое входящее заводит сделку, а смена этапа делает безопасный upsert", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crmDeals = makeDealsSpy();
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, crmDeals });
  const message = {
    message_id: 501,
    date: 1_700_000_000,
    text: "Есть iPhone 17?",
    chat: { id: 501, type: "private" },
    from: { id: 501, first_name: "Азиз", username: "aziz" },
  };

  await crm.receiveTelegram(message);
  await crm.receiveTelegram({ ...message, message_id: 502, text: "Сколько стоит?" });

  assert.equal(crmDeals.calls.length, 2);
  assert.deepEqual(crmDeals.calls[0], {
    externalKey: "telegram:501",
    source: "telegram",
    customerName: "Азиз",
    customerPhone: null,
    customerUsername: "@aziz",
  });
  assert.deepEqual(crmDeals.calls[1], crmDeals.calls[0]);
  assert.deepEqual(crmDeals.advanceCalls, [
    { externalKey: "telegram:501", action: "need_identified" },
  ]);
  assert.equal(crm.listConversations()[0].externalKey, "telegram:501");
});

test("входящее из amoCRM заводит сделку с каналом Instagram", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crmDeals = makeDealsSpy();
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, crmDeals });

  await crm.receiveAmo({
    text: "Нужен MacBook",
    direction: "incoming",
    chatId: "ig-chat-77",
    messageId: "ig-message-77",
    customerName: "Клиент",
    customerPhone: "996700000000",
    source: "instagram",
  });

  assert.equal(crmDeals.calls.length, 2);
  assert.equal(crmDeals.calls[0].externalKey, "amo:ig-chat-77");
  assert.equal(crmDeals.calls[0].source, "instagram");
  assert.equal(crmDeals.calls[0].customerPhone, "996700000000");
  assert.deepEqual(crmDeals.calls[1], crmDeals.calls[0]);
  assert.deepEqual(crmDeals.advanceCalls, [
    { externalKey: "amo:ig-chat-77", action: "need_identified" },
  ]);
});

test("исходящее менеджера диалог создаёт, а сделку — нет", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crmDeals = makeDealsSpy();
  const crm = new CrmService({
    db,
    ai: { enabled: false },
    amocrm: { enabled: true, sendMessage: async () => {} },
    crmDeals,
  });

  await crm.sendExternal({ source: "whatsapp", chatId: "wa-chat-31", text: "Здравствуйте!" });

  assert.equal(crm.listConversations().length, 1);
  assert.equal(crmDeals.calls.length, 0);
});

test("недоступная CRM не ломает приём сообщения", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crmDeals = makeDealsSpy({ fail: true });
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, crmDeals });

  await crm.receiveTelegram({
    message_id: 601,
    text: "Здравствуйте",
    chat: { id: 601, type: "private" },
    from: { first_name: "Клиент" },
  });
  // Отказ CRM асинхронный — даём промису отработать и убеждаемся, что он не всплыл.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(crmDeals.calls.length, 1);
  assert.equal(crm.listConversations().length, 1);
  assert.equal(crm.getConversation(crm.listConversations()[0].id).messages.length, 1);
});

test("без настроенного адреса CRM сделки не публикуются", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const { CrmDealsClient } = require("../server/services/crm-deals");
  const client = new CrmDealsClient({ baseUrl: "", internalToken: "" });
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false }, crmDeals: client });

  await crm.receiveTelegram({
    message_id: 701,
    text: "Привет",
    chat: { id: 701, type: "private" },
    from: { first_name: "Клиент" },
  });

  assert.equal(client.enabled, false);
  assert.equal(crm.listConversations().length, 1);
});

test("клиент сделок шлёт внутренний токен и нормализует канал amocrm", async (t) => {
  const { CrmDealsClient } = require("../server/services/crm-deals");
  const seen = [];
  const client = new CrmDealsClient({
    baseUrl: "https://crm.example/",
    internalToken: "secret-token",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => init.method === "PATCH"
          ? ({ ok: true, moved: true, stageName: "Заявка получена" })
          : ({ ok: true, created: true }),
      };
    },
  });

  const result = await client.createDeal({
    externalKey: "amo:chat-1",
    source: "amocrm",
    customerName: "Клиент",
  });

  assert.equal(result.created, true);
  assert.equal(seen[0].url, "https://crm.example/api/internal/deals");
  assert.equal(seen[0].init.headers["x-internal-token"], "secret-token");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.source, "whatsapp");
  assert.equal(body.externalKey, "amo:chat-1");
  assert.equal(body.customerPhone, null);

  const advanced = await client.advanceToPrimaryContact({ externalKey: "amo:chat-1" });
  assert.equal(advanced.moved, true);
  assert.equal(seen[1].url, "https://crm.example/api/internal/deals");
  assert.equal(seen[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(seen[1].init.body), {
    externalKey: "amo:chat-1",
    action: "primary_contact",
  });

  await client.advanceStage({ externalKey: "amo:chat-1", action: "interest_confirmed" });
  assert.deepEqual(JSON.parse(seen[2].init.body), {
    externalKey: "amo:chat-1",
    action: "interest_confirmed",
  });

  const order = await client.createOrder({
    externalKey: "amo:chat-1",
    productName: "iPhone 17 Pro Max, 256 GB",
    amount: 108063,
    currency: "KGS",
    orderType: "trade_in",
    customerPhone: "+996700000000",
  });
  assert.equal(order.ok, true);
  assert.equal(seen[3].init.method, "PATCH");
  assert.deepEqual(JSON.parse(seen[3].init.body), {
    action: "order",
    externalKey: "amo:chat-1",
    productName: "iPhone 17 Pro Max, 256 GB",
    amount: 108063,
    currency: "KGS",
    orderType: "trade_in",
    customerName: null,
    customerPhone: "+996700000000",
    note: null,
  });
});

test("возражение «я подумаю» отвечает готовым текстом без вызова ИИ", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let aiCalled = false;
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => { aiCalled = true; return "не должно вызываться"; } },
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (!String(url).includes("api.telegram.org")) return { ok: true, status: 200, text: async () => "" };
      return { ok: true, status: 200 };
    },
    autoReplyDebounceMs: 0,
  });

  await crm.receiveTelegram({
    message_id: 601,
    date: 1_700_000_000,
    text: "Я подумаю пока",
    chat: { id: 1601, type: "private" },
    from: { id: 1601, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(aiCalled, false);
  const messages = crm.listConversations()[0];
  const detail = crm.getConversation(messages.id);
  assert.equal(
    detail.messages.at(-1).text,
    "Хорошо, понимаю. Подскажите только, что пока останавливает: цена, сомнения в результате или хотите сравнить с другими вариантами?"
  );
});

test("возражение «дорого» отвечает готовым текстом без вызова ИИ", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let aiCalled = false;
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => { aiCalled = true; return "не должно вызываться"; } },
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (!String(url).includes("api.telegram.org")) return { ok: true, status: 200, text: async () => "" };
      return { ok: true, status: 200 };
    },
    autoReplyDebounceMs: 0,
  });

  await crm.receiveTelegram({
    message_id: 602,
    date: 1_700_000_000,
    text: "Ой, дороговато для меня",
    chat: { id: 1602, type: "private" },
    from: { id: 1602, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(aiCalled, false);
  const conversation = crm.listConversations()[0];
  const detail = crm.getConversation(conversation.id);
  assert.equal(
    detail.messages.at(-1).text,
    "Понимаю вас. Могу подобрать более доступный вариант с похожим назначением. На какую сумму вы примерно рассчитываете?"
  );
});

test("после обычного автоответа ставится цепочка напоминаний о простое", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => "Здравствуйте! Чем могу помочь?" },
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (!String(url).includes("api.telegram.org")) return { ok: true, status: 200, text: async () => "" };
      return { ok: true, status: 200 };
    },
    autoReplyDebounceMs: 0,
  });
  crm.saveSettings({ ...crm.getSettings(), approvalEnabled: false });

  await crm.receiveTelegram({
    message_id: 603,
    date: 1_700_000_000,
    text: "Здравствуйте",
    chat: { id: 1603, type: "private" },
    from: { id: 1603, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const conversation = crm.listConversations()[0];
  const rows = db.prepare(
    "SELECT kind FROM nudge_follow_ups WHERE conversation_id = ? AND sent_at IS NULL ORDER BY kind"
  ).all(conversation.id);
  assert.deepEqual(rows.map((row) => row.kind).sort(), ["day", "hours", "last"]);
});

test("клиент, сказавший «беру» и пропавший, получает одно напоминание вместо обычной цепочки", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  const crm = new CrmService({
    db,
    deepseek: { enabled: true, chatText: async () => "Хорошо, оформляю." },
    amocrm: { enabled: false },
    fetchImpl: async (url) => {
      if (!String(url).includes("api.telegram.org")) return { ok: true, status: 200, text: async () => "" };
      return { ok: true, status: 200 };
    },
    autoReplyDebounceMs: 0,
  });
  crm.saveSettings({ ...crm.getSettings(), approvalEnabled: false });

  await crm.receiveTelegram({
    message_id: 604,
    date: 1_700_000_000,
    text: "Беру, оформляйте",
    chat: { id: 1604, type: "private" },
    from: { id: 1604, first_name: "Клиент" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const conversation = crm.listConversations()[0];
  const rows = db.prepare(
    "SELECT kind FROM nudge_follow_ups WHERE conversation_id = ? AND sent_at IS NULL"
  ).all(conversation.id);
  assert.deepEqual(rows.map((row) => row.kind), ["order_incomplete"]);
});

test("новое сообщение клиента отменяет все ожидающие напоминания о простое", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, deepseek: { enabled: false }, amocrm: { enabled: false } });
  const conversation = crm._upsertConversation({
    externalKey: "telegram:1605",
    source: "telegram",
    inbound: true,
    chatId: "1605",
    name: "Клиент",
  });
  crm._scheduleNudgeFollowUps(conversation.id, "iPhone 17");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM nudge_follow_ups WHERE conversation_id = ? AND sent_at IS NULL").get(conversation.id).c,
    3
  );

  crm._cancelNudgeFollowUps(conversation.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM nudge_follow_ups WHERE conversation_id = ? AND sent_at IS NULL").get(conversation.id).c,
    0
  );
});

test("просроченное напоминание «через несколько часов» подставляет имя и товар", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => {
    config.telegram.botToken = previousToken;
    db.close();
  });
  let sentText = null;
  const crm = new CrmService({
    db,
    deepseek: { enabled: false },
    amocrm: { enabled: false },
    fetchImpl: async (url, init) => {
      if (String(url).includes("api.telegram.org") && init) {
        sentText = JSON.parse(init.body).text;
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) };
    },
  });
  const conversation = crm._upsertConversation({
    externalKey: "telegram:1606",
    source: "telegram",
    inbound: true,
    chatId: "1606",
    name: "Айгерим",
  });
  db.prepare(
    "INSERT INTO crm_messages (conversation_id, direction, sender, text, created_at) VALUES (?, 'outgoing', 'assistant', 'Ответ', datetime('now'))"
  ).run(conversation.id);
  db.prepare(
    "INSERT INTO nudge_follow_ups (conversation_id, kind, product_name, due_at) VALUES (?, 'hours', 'iPhone 17', datetime('now', '-1 minute'))"
  ).run(conversation.id);

  await crm.processDueNudgeFollowUps();

  assert.equal(
    sentText,
    "Здравствуйте, Айгерим. Хотела уточнить, остались ли у вас вопросы по iPhone 17? Могу коротко подсказать по применению или помочь подобрать другой вариант."
  );
});
