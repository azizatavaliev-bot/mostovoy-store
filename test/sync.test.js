const test = require("node:test");
const assert = require("node:assert/strict");
const { SyncService, priceAppearsInText } = require("../server/services/sync");
const { makeDb, FakeDeepSeek, StubResearchService, extractedProduct } = require("./helpers");

// Реальный пример поста из канала магазина.
const SAMPLE_POST = `Sony 5 slim 650$
Sony 5 pro 765$

Nintendo 2 470$
Steam deck oled 512g 550$

Meta Quest 3 . 4k 512gb 512$

Триммер
Philips one blade 2500 сом
Philips one blade x3 body+face 4500 сом

Самая топовая Петличка
Dji mic 3 - 290$

Также есть петличка
dji mic mini 95$

Подарочный набор Instax
11000 сом

Amazon Kindle 16GB Black $135
Kindle PaperWhite 16GB Jade $195
Kindle PaperWhite 16GB Raspberry $195`;

test("цена с точкой-разделителем тысяч считается ценой из Telegram", () => {
  assert.equal(priceAppearsInText(30000, "Размер 50 - 30.000с"), true);
  assert.equal(priceAppearsInText(37500, "Размер 53 - 37.500с"), true);
  assert.equal(priceAppearsInText(39000, "Размер 53 - 37.500с"), false);
});

const SAMPLE_EXTRACTION = {
  products: [
    extractedProduct(),
    extractedProduct({ source_name: "Sony 5 pro", official_name: "PlayStation 5 Pro", model: "PlayStation 5 Pro", price: 765 }),
    extractedProduct({
      source_name: "Nintendo 2", official_name: "Nintendo Switch 2", brand: "Nintendo",
      model: "Nintendo Switch 2", price: 470,
    }),
    extractedProduct({
      source_name: "Steam deck oled 512g", official_name: "Valve Steam Deck OLED 512 GB", brand: "Valve",
      model: "Steam Deck OLED", storage: "512 GB", price: 550,
    }),
    extractedProduct({
      source_name: "Philips one blade", official_name: "Philips OneBlade", brand: "Philips",
      model: "OneBlade", category: "Триммеры", price: 2500, currency: "KGS",
    }),
    extractedProduct({
      source_name: "dji mic mini", official_name: "DJI Mic Mini", brand: "DJI",
      model: "Mic Mini", category: "Микрофоны", price: 95,
    }),
    extractedProduct({
      source_name: "Kindle PaperWhite 16GB Jade", official_name: "Amazon Kindle Paperwhite 16 GB", brand: "Amazon",
      model: "Kindle Paperwhite", storage: "16GB", color: "Jade", category: "Электронные книги", price: 195,
    }),
    extractedProduct({
      source_name: "Kindle PaperWhite 16GB Raspberry", official_name: "Amazon Kindle Paperwhite 16 GB", brand: "Amazon",
      model: "Kindle Paperwhite", storage: "16GB", color: "Raspberry", category: "Электронные книги", price: 195,
    }),
  ],
};

function makeService(extraction, researchResult) {
  const db = makeDb();
  const deepseek = new FakeDeepSeek({ extract: extraction });
  const research = new StubResearchService(
    researchResult || {
      status: "ok",
      data: {
        description: "Короткое описание на русском.",
        specifications: { Вес: "10 г" },
        main_image_url: "https://www.dji.com/img/mic-mini.webp",
        image_urls: ["https://www.dji.com/img/mic-mini.webp"],
        source_page_url: "https://www.dji.com/mic-mini",
      },
    }
  );
  return { db, deepseek, research, sync: new SyncService({ db, deepseek, research }) };
}

const post = (over = {}) => ({ chatId: "-1001", messageId: 100, text: SAMPLE_POST, ...over });

test("новая публикация с несколькими товарами создаёт все товары", async () => {
  const { db, sync } = makeService(SAMPLE_EXTRACTION);
  const res = await sync.syncMessage(post());

  assert.equal(res.status, "ok");
  assert.equal(res.created, 8);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 8);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_products WHERE active = 1").get().n, 8);

  const ps5 = db.prepare("SELECT * FROM products WHERE normalized_key = ?").get("sony|playstation-5-slim|||standard");
  assert.equal(ps5.official_name, "PlayStation 5 Slim");
  assert.equal(ps5.price, 650);
  assert.equal(ps5.currency, "USD");
  assert.equal(ps5.available, 1);
});

test("заголовки без цены («Триммер», «Также есть петличка») товарами не становятся", async () => {
  const { db, sync } = makeService(SAMPLE_EXTRACTION);
  await sync.syncMessage(post());
  const names = db.prepare("SELECT official_name FROM products").all().map((r) => r.official_name);
  assert.ok(!names.some((n) => /^Триммер$|петличка/i.test(n)));
});

test("две валюты в одном посте сохраняются раздельно, без конвертации", async () => {
  const { db, sync } = makeService(SAMPLE_EXTRACTION);
  await sync.syncMessage(post());
  const philips = db.prepare("SELECT * FROM products WHERE brand = 'Philips'").get();
  const sony = db.prepare("SELECT * FROM products WHERE brand = 'Sony' LIMIT 1").get();
  assert.equal(philips.currency, "KGS");
  assert.equal(philips.price, 2500);
  assert.equal(sony.currency, "USD");
});

test("товары, отличающиеся только цветом, не сливаются в один", async () => {
  const { db, sync } = makeService(SAMPLE_EXTRACTION);
  await sync.syncMessage(post());
  const kindles = db.prepare("SELECT * FROM products WHERE model = 'Kindle Paperwhite' ORDER BY color").all();
  assert.equal(kindles.length, 2);
  assert.deepEqual(kindles.map((k) => k.color), ["Jade", "Raspberry"]);
  assert.notEqual(kindles[0].normalized_key, kindles[1].normalized_key);
  assert.notEqual(kindles[0].slug, kindles[1].slug);
});

test("повторная обработка того же текста ничего не создаёт и не зовёт модель", async () => {
  const { db, deepseek, sync } = makeService(SAMPLE_EXTRACTION);
  await sync.syncMessage(post());
  const callsAfterFirst = deepseek.calls.extract;

  const second = await sync.syncMessage(post());
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "unchanged");
  assert.equal(deepseek.calls.extract, callsAfterFirst, "модель не должна вызываться повторно");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 8);
});

test("редактирование цены обновляет товар, а не создаёт дубликат", async () => {
  const cheaper = { products: [extractedProduct({ price: 600 })] };
  const { db, sync, research } = makeService([{ products: [extractedProduct()] }, cheaper]);

  await sync.syncMessage(post({ text: "Sony 5 slim 650$" }));
  const researchCallsAfterCreate = research.calls;

  await sync.syncMessage(post({ text: "Sony 5 slim 600$" }));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
  const row = db.prepare("SELECT * FROM products").get();
  assert.equal(row.price, 600);
  // Для известного товара повторное исследование не запускается.
  assert.equal(research.calls, researchCallsAfterCreate);
});

test("товар, удалённый из сообщения, помечается неактивным именно в этом источнике", async () => {
  const two = { products: [extractedProduct(), extractedProduct({ source_name: "dji mic mini", official_name: "DJI Mic Mini", brand: "DJI", model: "Mic Mini", price: 95 })] };
  const one = { products: [extractedProduct()] };
  const { db, sync } = makeService([two, one]);

  await sync.syncMessage(post({ text: "Sony 5 slim 650$\ndji mic mini 95$" }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE available = 1").get().n, 2);

  const res = await sync.syncMessage(post({ text: "Sony 5 slim 650$" }));
  assert.equal(res.deactivated, 1);

  const dji = db.prepare("SELECT * FROM products WHERE brand = 'DJI'").get();
  assert.equal(dji.available, 0, "пропал из поста → нет в наличии");
  // Сам товар не удаляется, только связь гасится.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 2);
  assert.equal(db.prepare("SELECT active FROM message_products WHERE product_id = ?").get(dji.id).active, 0);
});

test("товар остаётся в наличии, если он есть в другой актуальной публикации", async () => {
  const both = { products: [extractedProduct()] };
  const { db, sync } = makeService([both, both, { products: [] }]);

  await sync.syncMessage(post({ messageId: 100, text: "Sony 5 slim 650$" }));
  await sync.syncMessage(post({ messageId: 200, text: "PS5 slim 650$ второй пост" }));

  const product = db.prepare("SELECT * FROM products").get();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_products WHERE product_id = ?").get(product.id).n, 2);

  // Из первого поста товар убрали, во втором он остался.
  await sync.syncMessage(post({ messageId: 100, text: "пост опустел" }));
  const after = db.prepare("SELECT * FROM products").get();
  assert.equal(after.available, 1, "второй пост всё ещё продаёт товар");
});

test("низкая уверенность даёт статус needs_research, а не выдуманные данные", async () => {
  const vague = { products: [extractedProduct({ source_name: "какая-то штука", confidence: 0.4, warning: "модель неоднозначна" })] };
  const { db, sync } = makeService(vague);
  await sync.syncMessage(post({ text: "какая-то штука 650$" }));

  const row = db.prepare("SELECT * FROM products").get();
  assert.equal(row.status, "needs_research");
  assert.equal(row.price, 650, "цена всё равно сохраняется");
});

test("без провайдера поиска товар создаётся с ценой, но без фото и с needs_research", async () => {
  const { db, sync } = makeService({ products: [extractedProduct()] }, { status: "skipped", data: null, reason: "research_provider_disabled" });
  await sync.syncMessage(post({ text: "Sony 5 slim 650$" }));

  const row = db.prepare("SELECT * FROM products").get();
  assert.equal(row.status, "needs_research");
  assert.equal(row.main_image_url, null, "ссылки не выдумываются");
  assert.equal(row.research_status, "skipped");
  assert.equal(row.price, 650);
});

test("цена, которой нет в тексте поста, отбрасывается", async () => {
  // Модель «вспомнила» рыночную цену 699 вместо телеграмной.
  const { db, sync } = makeService({ products: [extractedProduct({ price: 699 })] });
  const res = await sync.syncMessage(post({ text: "Sony 5 slim 650$" }));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /цена отсутствует/i);
});

test("товар с пометкой «нет в наличии» помечается отсутствующим", async () => {
  const { db, sync } = makeService({ products: [extractedProduct({ source_name: "Sony 5 slim — нет в наличии", available: false })] });
  await sync.syncMessage(post({ text: "Sony 5 slim 650$ нет в наличии" }));
  assert.equal(db.prepare("SELECT available FROM products").get().available, 0);
});

test("одна битая позиция не мешает обработать остальные", async () => {
  const mixed = {
    products: [
      extractedProduct(),
      { official_name: "Сломанный товар", price: "не число", currency: "XXX" },
      extractedProduct({ source_name: "dji mic mini", official_name: "DJI Mic Mini", brand: "DJI", model: "Mic Mini", price: 95 }),
    ],
  };
  const { db, sync } = makeService(mixed);
  const res = await sync.syncMessage(post({ text: "Sony 5 slim 650$\nсломанный\ndji mic mini 95$" }));

  assert.equal(res.created, 2);
  assert.equal(res.rejected.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 2);
});

test("невалидный JSON от модели помечает публикацию ошибкой", async () => {
  const { ValidationError } = require("../server/lib/validate");
  const { db, sync } = makeService(new ValidationError("Ответ модели — не JSON-объект"));

  await assert.rejects(() => sync.syncMessage(post()), /не JSON-объект/);

  const row = db.prepare("SELECT * FROM telegram_messages").get();
  assert.equal(row.last_sync_status, "error");
  assert.match(row.last_sync_error, /не JSON-объект/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 0);
});

test("признак, переехавший из variant в color, не создаёт дубликат", async () => {
  // Настоящее поведение живой модели: между прогонами один и тот же токен
  // оказывается то в variant, то в color, то внутри model.
  const run1 = {
    products: [
      extractedProduct({
        source_name: "Kindle PaperWhite Kids 16GB Starfish", official_name: "Amazon Kindle Paperwhite Kids 16 GB",
        brand: "Amazon", model: "Kindle Paperwhite Kids", storage: "16GB", variant: "Starfish", price: 185,
      }),
    ],
  };
  const run2 = {
    products: [
      extractedProduct({
        source_name: "Kindle PaperWhite Kids 16GB Starfish", official_name: "Amazon Kindle PaperWhite Kids 16GB Starfish",
        brand: "Amazon", model: "Kindle PaperWhite Kids", storage: "16 GB", color: "Starfish", price: 185,
      }),
    ],
  };
  const { db, sync } = makeService([run1, run2]);

  await sync.syncMessage(post({ messageId: 1, text: "Kindle PaperWhite Kids 16GB Starfish $185" }));
  await sync.syncMessage(post({ messageId: 2, text: "Kindle PaperWhite Kids 16GB Starfish $185 повтор" }));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 1, "должен остаться один товар");
});

test("признак, переехавший из variant внутрь model, не создаёт дубликат", async () => {
  const run1 = { products: [extractedProduct({
    source_name: "Philips one blade x3 body+face", official_name: "Philips OneBlade X3",
    brand: "Philips", model: "OneBlade X3", variant: "Body+Face", price: 4500, currency: "KGS" })] };
  const run2 = { products: [extractedProduct({
    source_name: "Philips one blade x3 body+face", official_name: "Philips OneBlade X3 Body+Face",
    brand: "Philips", model: "OneBlade X3 Body+Face", variant: null, price: 4500, currency: "KGS" })] };
  const { db, sync } = makeService([run1, run2]);

  await sync.syncMessage(post({ messageId: 1, text: "Philips one blade x3 body+face 4500 сом" }));
  await sync.syncMessage(post({ messageId: 2, text: "Philips one blade x3 body+face 4500 сом ." }));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
});

test("разные цвета остаются разными товарами и при новом ключе", async () => {
  const two = {
    products: [
      extractedProduct({ source_name: "Kindle PaperWhite 16GB Jade", official_name: "Amazon Kindle Paperwhite 16 GB",
        brand: "Amazon", model: "Kindle Paperwhite", storage: "16GB", color: "Jade", price: 195 }),
      extractedProduct({ source_name: "Kindle PaperWhite 16GB Raspberry", official_name: "Amazon Kindle Paperwhite 16 GB",
        brand: "Amazon", model: "Kindle Paperwhite", storage: "16GB", color: "Raspberry", price: 195 }),
    ],
  };
  const { db, sync } = makeService(two);
  await sync.syncMessage(post({ text: "Kindle PaperWhite 16GB Jade $195\nKindle PaperWhite 16GB Raspberry $195" }));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 2);
});

test("алиасы накапливаются: разговорное написание находит тот же товар", async () => {
  const { db, sync } = makeService([{ products: [extractedProduct()] }, { products: [extractedProduct({ source_name: "PS5 slim" })] }]);
  await sync.syncMessage(post({ messageId: 1, text: "Sony 5 slim 650$" }));
  await sync.syncMessage(post({ messageId: 2, text: "PS5 slim 650$" }));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
  const aliases = db.prepare("SELECT alias FROM product_aliases ORDER BY alias").all().map((a) => a.alias);
  assert.ok(aliases.includes("Sony 5 slim"));
  assert.ok(aliases.includes("PS5 slim"));
});
