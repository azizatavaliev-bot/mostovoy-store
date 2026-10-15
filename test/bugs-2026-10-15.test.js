// Регрессии багов, найденных 2026-10-15 прогоном 60 сценариев и ревью кода.
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../server/config");
const { createConnection } = require("../server/db");
const crm = require("../server/services/crm");
const { buildMapping, findPhone } = require("../server/services/privacy");
const { classifyTemplate } = require("../server/services/templates");

const { CrmService } = crm;

test("распроданная запись не прячет тот же товар, живой в другом посте", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insert = db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, color, storage, variant, price, currency, status, origin, available, updated_at)
     VALUES (?, ?, 'Apple iPhone 17 Pro 256 GB', 'оранжевый', '256 GB', 'eSIM', ?, 'USD', 'active', 'telegram', ?, ?)`
  );
  const soldOut = insert.run("x", "x", 1100, 0, "2026-10-15 10:00:00").lastInsertRowid;
  const live = insert.run("y", "y", 1130, 1, "2026-10-14 10:00:00").lastInsertRowid;
  const message = db.prepare(
    "INSERT INTO telegram_messages (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status) VALUES ('-1', ?, '2025-07-01', 't', ?, 'ok')"
  );
  const m1 = message.run(1, "h1").lastInsertRowid;
  const m2 = message.run(2, "h2").lastInsertRowid;
  const link = db.prepare("INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, ?, ?, 'USD', ?, ?)");
  link.run(m1, soldOut, 1100, 0, 0);
  link.run(m2, live, 1130, 1, 1);
  assert.deepEqual(crm.searchCatalogProducts(db, "iPhone 17 Pro 256 оранжевый").map((p) => p.price), [1130]);
});

test("«в наличии, переплаты нет» — не отказ, страховка ответ не подменяет", () => {
  const reply = "iPhone 17 Pro 256 оранжевый — 99 440 сом. В наличии, переплаты нет при оплате сразу.";
  const groundedProducts = [{ name: "iPhone 17 Pro", storage: "256 GB", color: "оранжевый", priceKgs: 99440, available: true }];
  assert.equal(crm.enforceGroundedAvailabilityReply({ reply, groundedProducts, request: "17 pro 256 оранжевый" }), reply);
});

test("честное «зелёного нет» не подменяется списком других цветов", () => {
  const reply = "Зелёного iPhone 18 Pro Max нет в наличии.";
  const groundedProducts = [
    { name: "iPhone 18 Pro Max", storage: "256 GB", color: "Silver", priceKgs: 164560, available: true },
    { name: "iPhone 18 Pro Max", storage: "256 GB", color: "Black", priceKgs: 164560, available: true },
  ];
  assert.equal(crm.enforceGroundedAvailabilityReply({ reply, groundedProducts, request: "Есть iPhone 18 Pro Max зелёный?" }), reply);
  assert.match(crm.enforceGroundedAvailabilityReply({ reply: "Чёрного нет в наличии.", groundedProducts, request: "18 Pro Max черный есть?" }), /Black/);
});

test("рассрочка: срок из последнего сообщения, телефон в истории не мешает найти товар", () => {
  const selection = "X: " + JSON.stringify({ products: [
    { name: "iPhone 17 Pro", storage: "256 GB", color: "оранжевый", variant: "eSIM", price: 1130, currency: "USD", priceKgs: 99440, available: true },
    { name: "AirPods 4", price: 120, currency: "USD", priceKgs: 10560, available: true },
  ] });
  assert.match(crm.financeToolContext("iPhone 17 Pro 256 рассрочка на 3 мес\nа на 12 месяцев?", selection), /12 мес\./);
  assert.match(crm.financeToolContext("iPhone 17 Pro 256 рассрочка\nмой номер 0555123456", selection), /Рассрочка: iPhone 17 Pro/);
});

test("«предзаказ есть?» и «где мой заказ?» — не готовность купить", () => {
  assert.notEqual(crm.stageActionForInbound("предзаказ на iphone 18 есть?"), "ready_to_buy");
  assert.notEqual(crm.stageActionForInbound("я заказал вчера, где мой заказ?"), "ready_to_buy");
  assert.equal(crm.stageActionForInbound("беру, оформляйте"), "ready_to_buy");
});

test("один и тот же MacBook из поста и из админки — один ключ, цвет «космический оранжевый» = «Cosmic Orange»", () => {
  const keys = ["Apple MacBook Air 13.6 M5 16 GB 512 GB", "Apple MacBook Air 13.6\" (M5, 16 ГБ / 512 ГБ)", "MacBook Air M5 13.6\" 16/512GB"]
    .map((name) => crm.catalogIdentityKey({ official_name: name }));
  assert.equal(new Set(keys).size, 1);
  assert.notEqual(keys[0], crm.catalogIdentityKey({ official_name: "MacBook Air M5 13.6\" 16GB/1TB" }));
  assert.equal(
    crm.catalogIdentityKey({ official_name: "iPhone 17 Pro 256", color: "Космический оранжевый" }),
    crm.catalogIdentityKey({ official_name: "iPhone 17 Pro 256", color: "Cosmic Orange" })
  );
});

test("скрытие персональных данных: все форматы телефона, адрес рядом с телефоном, одно имя", () => {
  for (const phone of ["+996 555 123 456", "0555 123 456", "996555123456", "+996 (555) 12-34-56", "0555123456"]) {
    assert.deepEqual([...buildMapping([phone]).keys()], [phone], phone);
  }
  assert.deepEqual([...buildMapping(["ул Ленина 5 тел 0555123456 завтра"]).keys()].sort(), ["0555123456", "ул Ленина 5"]);
  assert.deepEqual([...buildMapping(["меня зовут Азиз хочу айфон"]).keys()], ["Азиз"]);
  assert.deepEqual([...buildMapping([JSON.stringify({ a: "адрес мкр Джал 12\nТелефон позже" })]).keys()], ["мкр Джал 12"]);
  assert.equal(findPhone("бюджет 100 000 - 120 000 сом"), null);
});

test("теги <b>/<i> от модели не видны клиенту буквально", () => {
  assert.equal(crm.telegramHtml("<b>iPhone 18 Pro</b> — 132 000 сом & < 5"), "<b>iPhone 18 Pro</b> — 132 000 сом &amp; &lt; 5");
});

test("шаблоны: «хочу подъехать» распознаётся, «айфон про» — не голый запрос линейки", (t) => {
  assert.equal(classifyTemplate("хочу подъехать сегодня", { hasHistory: true })?.kind, "showroom_visit");
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const service = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  assert.equal(service._isBareCategoryRequest("айфон про"), false);
  assert.equal(service._isBareCategoryRequest("самсунг ультра"), false);
  assert.equal(service._isBareCategoryRequest("айфоны есть?"), true);
});

test("фото товара — только к ответу про одну модель и не к отказу", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insert = db.prepare("INSERT INTO products (slug, normalized_key, official_name, price, currency, status, main_image_url) VALUES (?, ?, ?, 1, 'USD', 'active', '/img.png')");
  insert.run("a", "a", "iPhone 18 Pro");
  insert.run("b", "b", "iPhone 17e 256GB");
  const service = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  assert.equal(service._recommendedProductImage("iPhone 18 Pro 256 — 132 000 сом")?.official_name, "iPhone 18 Pro");
  assert.equal(service._recommendedProductImage("За 40 000 iPhone, к сожалению, нет — iPhone 18 Pro от 132 000"), null);
  assert.equal(service._recommendedProductImage("Есть iPhone 18 Pro от 132 000 и iPhone 17e от 63 360"), null);
});

test("дубль ещё не отвеченного сообщения перезапускает ожидание — клиент получает ровно один ответ", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });
  let calls = 0;
  const service = new CrmService({
    db,
    ai: { enabled: true, chatText: async () => { calls += 1; return "Ответ"; } },
    amocrm: { enabled: false },
    autoReplyDebounceMs: 30,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) }),
  });
  service.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });
  const message = { date: 1_700_000_000, chat: { id: 7001, type: "private" }, from: { id: 7001, first_name: "К" } };
  await service.receiveTelegram({ ...message, message_id: 1, text: "Привет, 17 Pro есть?" });
  await service.receiveTelegram({ ...message, message_id: 2, text: "Привет, 17 Pro есть?" });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls, 1);
});

test("ИИ не ответил — клиент получает сообщение о задержке, а не тишину", async (t) => {
  const db = createConnection(":memory:");
  const previousToken = config.telegram.botToken;
  config.telegram.botToken = "test-token";
  t.after(() => { config.telegram.botToken = previousToken; db.close(); });
  const sent = [];
  const service = new CrmService({
    db,
    ai: { enabled: true, chatText: async () => { throw new Error("DeepSeek ответил 402: Insufficient Balance"); } },
    amocrm: { enabled: false },
    autoReplyDebounceMs: 0,
    fetchImpl: async (url, init) => {
      if (String(url).includes("sendMessage") && init?.body) sent.push(JSON.parse(init.body).text);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ ok: true }) };
    },
  });
  service.saveSettings({ approvalEnabled: false, supervisorEnabled: false, templateRouterEnabled: false });
  await service.receiveTelegram({ message_id: 1, date: 1_700_000_000, text: "Сколько iPhone 17 Pro?", chat: { id: 7002, type: "private" }, from: { id: 7002, first_name: "К" } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(sent.some((text) => /техническая заминка/.test(text)), JSON.stringify(sent));
});

test("«вы бот?» — не вызов менеджера; шаблон статуса заказа не обещает «вернусь»", () => {
  assert.equal(classifyTemplate("Вы бот?", { hasHistory: false })?.kind, "bot_question");
  assert.equal(classifyTemplate("Позовите живого менеджера", { hasHistory: true })?.kind, "human_request");
  const { templateById } = require("../server/services/templates");
  assert.doesNotMatch(templateById("order_status"), /вернусь/);
});

test("«уточню и вернусь» заменяется на честное «подскажет менеджер»", () => {
  assert.match(crm.stripCallbackPromises("Уточню этот момент и вернусь с ответом. Что присматриваете?"), /^Этот вопрос подскажет менеджер.*Что присматриваете\?$/);
  assert.equal(crm.stripCallbackPromises("iPhone 17e — 63 360 сом."), "iPhone 17e — 63 360 сом.");
});

test("trade-in + рассрочка в одной фразе: сдаваемый телефон не мешает найти покупку, оценка вычитается", () => {
  const selection = "X: " + JSON.stringify({ products: [
    { name: "iPhone 18 Pro", storage: "256 GB", color: "Black", variant: "Физическая SIM + eSIM", price: 1530, currency: "USD", priceKgs: 134640, available: true },
  ] });
  const context = crm.financeToolContext("Сдам iPhone 14 Pro 128 в отличном состоянии, остальное в рассрочку на 12 месяцев за 18 Pro 256 black", selection);
  assert.match(context, /Trade-in: iphone 14 pro/i);
  assert.match(context, /Рассрочка: iPhone 18 Pro; 12 мес\.; стоимость 134\s640 с; после Trade-in/);
});

test("заказ из двух товаров — одна строка с общей суммой", () => {
  const selection = "X: " + JSON.stringify({ products: [
    { name: "Apple iPhone 17 256 GB", storage: "256 GB", variant: "eSIM", price: 920, currency: "USD", priceKgs: 80960, available: true },
    { name: "AirPods 4", price: 10500, currency: "KGS", priceKgs: 10500, available: true },
  ] });
  const product = crm.orderedCatalogProduct({ selection, history: [{ role: "assistant", content: "iPhone 17 256 ГБ (eSIM) — 80 960 сомов\nAirPods 4 — 10 500 сомов\nИтого: 91 460 сомов" }] });
  assert.equal(product.name, "Apple iPhone 17 256 GB eSIM + AirPods 4");
  assert.equal(product.priceKgs, 91460);
});

test("ссылка на пост своего канала превращается в текст поста для бота", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  db.prepare("INSERT INTO telegram_messages (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status) VALUES ('-1', 444, '2026-10-10', 'iPhone 17e 256gb 720$', 'h', 'ok')").run();
  const service = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  const channel = config.contact.channel;
  assert.match(service._augmentWithChannelPost(`https://t.me/${channel}/444 вот этот есть?`), /Пост канала по ссылке клиента:\niPhone 17e 256gb 720\$/);
  assert.equal(service._augmentWithChannelPost("привет"), "привет");
});

test("роутер не шлёт тот же шаблон, если прошлый ответ начинался с него (с меню в хвосте)", async () => {
  const { templateById } = require("../server/services/templates");
  const service = Object.create(CrmService.prototype);
  service.ai = { chatJson: async () => ({ template_id: "payment_methods" }) };
  service._usageRecorder = () => () => {};
  service._logEvent = () => {};
  const settings = { templateRouterEnabled: true };
  const first = [{ direction: "incoming", text: "Как оплатить?" }];
  assert.equal(await service._routeTemplate(1, settings, first, "Как оплатить?"), "payment_methods");
  const second = [
    { direction: "incoming", text: "Как оплатить?" },
    { direction: "outgoing", text: `${templateById("payment_methods")}\n\nВот наш актуальный каталог товаров…` },
    { direction: "incoming", text: "А переводом на Мбанк?" },
  ];
  assert.equal(await service._routeTemplate(1, settings, second, "А переводом на Мбанк?"), null);
});
