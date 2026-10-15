// Переменные окружения задаём до загрузки config — он читается один раз.
process.env.TELEGRAM_WEBHOOK_SECRET = "test-secret";
process.env.TELEGRAM_CHANNEL_ID = "-1001";
process.env.TELEGRAM_BOT_TOKEN = "test-token";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server/app");
const { SyncQueue } = require("../server/queue");
const { SyncService } = require("../server/services/sync");
const { makeDb, FakeDeepSeek, StubResearchService, channelPostUpdate, extractedProduct } = require("./helpers");

function startApp({ extraction } = {}) {
  const db = makeDb();
  const deepseek = new FakeDeepSeek({ extract: extraction || { products: [extractedProduct()] } });
  const research = new StubResearchService({ status: "skipped", data: null, reason: "disabled" });
  const sync = new SyncService({ db, deepseek, research });
  const queue = new SyncQueue({ db, syncService: sync });
  const app = createApp({ db, deepseek, research, queue });
  // Эти тесты проверяют путь «пост канала → очередь → товар», поэтому автосинк
  // включаем явно, независимо от значения по умолчанию.
  app.locals.services.crm.saveSettings({ channelAutoSyncEnabled: true });
  const server = app.listen(0);
  const port = server.address().port;
  return {
    db,
    queue,
    deepseek,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const postUpdate = (base, update, secret = "test-secret") =>
  fetch(`${base}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });

test("вебхук без правильного секрета отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);

  const res = await postUpdate(app.base, channelPostUpdate({ text: "Sony 5 slim 650$" }), "wrong");
  assert.equal(res.status, 401);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sync_jobs").get().n, 0);
});

test("вебхук принимает channel_post и сразу ставит задачу в очередь", async (t) => {
  const app = startApp();
  t.after(app.close);

  const res = await postUpdate(app.base, channelPostUpdate({ text: "Sony 5 slim 650$" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, queued: true });

  // Ответ отдан ДО обработки: товаров ещё нет, задача есть.
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE status = 'pending'").get().n, 1);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM products").get().n, 0);

  await app.queue.drain();
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
});

test("edited_channel_post обрабатывается как редактирование", async (t) => {
  const app = startApp({
    extraction: [{ products: [extractedProduct()] }, { products: [extractedProduct({ price: 600 })] }],
  });
  t.after(app.close);

  await postUpdate(app.base, channelPostUpdate({ updateId: 1, messageId: 500, text: "Sony 5 slim 650$" }));
  await app.queue.drain();

  await postUpdate(app.base, channelPostUpdate({ updateId: 2, messageId: 500, text: "Sony 5 slim 600$", edited: true }));
  await app.queue.drain();

  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM products").get().n, 1);
  assert.equal(app.db.prepare("SELECT price FROM products").get().price, 600);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM telegram_messages").get().n, 1);
});

test("повторная доставка того же update игнорируется", async (t) => {
  const app = startApp();
  t.after(app.close);

  const update = channelPostUpdate({ updateId: 42, text: "Sony 5 slim 650$" });
  const first = await postUpdate(app.base, update);
  const second = await postUpdate(app.base, update);

  assert.deepEqual(await first.json(), { ok: true, queued: true });
  assert.deepEqual(await second.json(), { ok: true, duplicate: true });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sync_jobs").get().n, 1, "задача поставлена один раз");
});

test("пост из чужого чата игнорируется", async (t) => {
  const app = startApp();
  t.after(app.close);

  const res = await postUpdate(app.base, channelPostUpdate({ chatId: "-9999", text: "Sony 5 slim 650$" }));
  assert.deepEqual(await res.json(), { ok: true, ignored: "foreign_chat" });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sync_jobs").get().n, 0);
});

test("пустой пост игнорируется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await postUpdate(app.base, channelPostUpdate({ text: "   " }));
  assert.deepEqual(await res.json(), { ok: true, ignored: "empty_post" });
});

test("/api/catalog отдаёт товары, контакты и курсы", async (t) => {
  const app = startApp();
  t.after(app.close);

  await postUpdate(app.base, channelPostUpdate({ text: "Sony 5 slim 650$" }));
  await app.queue.drain();

  const data = await (await fetch(`${app.base}/api/catalog`)).json();
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "PlayStation 5 Slim");
  assert.equal(data.products[0].price, 650);
  assert.equal(data.products[0].currency, "USD");
  assert.equal(data.contact.url, "https://t.me/mostovoyshop");
  assert.equal(data.contact.channelUrl, "https://t.me/mostovoyshopp");
  assert.equal(data.contact.whatsappUrl, "https://wa.me/996999110110");
  assert.equal(data.rates.USD, 1);
  assert.ok(data.rates.KGS > 1 && data.rates.RUB > 1 && data.rates.KZT > 1);
});

test("/api/products/:slug отдаёт товар и готовое сообщение для Telegram", async (t) => {
  const app = startApp();
  t.after(app.close);

  await postUpdate(app.base, channelPostUpdate({ text: "Sony 5 slim 650$" }));
  await app.queue.drain();

  const slug = app.db.prepare("SELECT slug FROM products").get().slug;
  const data = await (await fetch(`${app.base}/api/products/${slug}`)).json();

  assert.equal(data.product.name, "PlayStation 5 Slim");
  assert.equal(data.contact.url, "https://t.me/mostovoyshop");
  assert.equal(
    data.contact.text,
    "Здравствуйте! Меня интересует PlayStation 5 Slim за 650 USD. Подскажите, товар сейчас в наличии?"
  );
  // Заказ уходит в WhatsApp — там текст предзаполняется.
  assert.ok(data.order.url.startsWith("https://wa.me/996999110110?text="));
  assert.equal(data.order.text, data.contact.text);
  assert.equal(data.sources.length, 1);

  const missing = await fetch(`${app.base}/api/products/no-such-product`);
  assert.equal(missing.status, 404);
});

test("витрина собирается отдельно (frontend/), без сборки — 404", async (t) => {
  // Фронт теперь на Vite (frontend/), Express отдаёт только frontend/dist —
  // в тестовом окружении сборки нет, поэтому статика не подключена.
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/index.html`);
  assert.equal(res.status, 404);
});

test("при выключенном автосинке пост канала игнорируется, а не ставится в очередь", async (t) => {
  const app = startApp();
  t.after(app.close);
  app.db.prepare("INSERT INTO crm_settings (key, value) VALUES ('channel_auto_sync_enabled', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

  const res = await postUpdate(app.base, channelPostUpdate({ text: "Sony 5 slim 650$" }));
  assert.deepEqual(await res.json(), { ok: true, ignored: "channel_auto_sync_disabled" });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM sync_jobs").get().n, 0);
});

test("сайт показывает одну, самую свежую запись товара, а не старый прайс рядом с новым", async (t) => {
  const app = startApp();
  t.after(app.close);
  const insert = app.db.prepare(
    `INSERT INTO products (slug, normalized_key, official_name, color, storage, variant, price, currency, status, origin, updated_at)
     VALUES (?, ?, ?, 'синий', ?, ?, ?, 'USD', 'active', ?, ?)`
  );
  insert.run("old", "old", "iPhone 17 Pro 256GB eSIM", null, null, 1165, "manual", "2026-09-14 11:11:07");
  insert.run("new", "new", "Apple iPhone 17 Pro 256 GB", "256 GB", "eSIM", 1200, "telegram", "2026-10-12 03:24:40");
  insert.run("phys", "phys", "Apple iPhone 17 Pro 256 GB", "256 GB", "1 физическая SIM + eSIM", 1210, "telegram", "2026-10-12 03:24:40");
  const catalog = await (await fetch(`${app.base}/api/catalog`)).json();
  const iphones = catalog.products.filter((p) => /iPhone 17 Pro 256/.test(p.name)).map((p) => p.price).sort();
  assert.deepEqual(iphones, [1200, 1210]);
});
