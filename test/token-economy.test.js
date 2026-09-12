const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { CrmService, renderCatalogForPrompt, buildTelegramCatalogForAssistant } = require("../server/services/crm");

test("каталог для модели рендерится таблицей: те же поля и цены, но без повторяющихся JSON-ключей", () => {
  const selection = `АКТУАЛЬНЫЙ КАТАЛОГ ИЗ TELEGRAM-КАНАЛА:\n${JSON.stringify({
    products: [
      ...Array.from({ length: 20 }, (_, i) => ({ name: `Товар ${i}`, brand: "Apple", category: "Смартфоны", storage: null, color: null, description: null, price: 100 + i, currency: "USD", priceKgs: 8800 + i * 88, priceUsd: 100 + i, priceRub: 7900, priceKzt: 51000, available: true })),
      { name: "iPhone 17 Pro 256GB eSIM", brand: "Apple", category: "Смартфоны", storage: "256GB", color: null, description: null, price: 1140, currency: "USD", priceKgs: 100320, priceUsd: 1140, priceRub: 90060, priceKzt: 581400, available: true },
      { name: "Dyson | Airwrap", brand: null, category: "Dyson", storage: null, color: "розовый", description: "стайлер  с насадками", price: 500, currency: "USD", priceKgs: 44000, priceUsd: 500, priceRub: 39500, priceKzt: 255000, available: false },
    ],
    pendingPosts: [],
  })}\n\nОтвечай только по этому каталогу.`;
  const rendered = renderCatalogForPrompt(selection);
  assert.match(rendered, /^name \| brand \| category \| storage \| color \| price currency \| priceKgs \| priceUsd \| priceRub \| priceKzt \| available \| description$/m);
  assert.match(rendered, /^iPhone 17 Pro 256GB eSIM \| Apple \| Смартфоны \| 256GB \| - \| 1140 USD \| 100320 \| 1140 \| 90060 \| 581400 \| в наличии \| -$/m);
  assert.match(rendered, /^Dyson \/ Airwrap \| - \| Dyson \| - \| розовый \| 500 USD \| 44000 \| 500 \| 39500 \| 255000 \| нет в наличии \| стайлер с насадками$/m);
  assert.match(rendered, /pendingPosts: нет/);
  assert.match(rendered, /Отвечай только по этому каталогу/);
  assert.doesNotMatch(rendered, /"priceKgs"/, "JSON-ключи в промпт не попадают");
  assert.ok(rendered.length < selection.length * 0.7, `таблица должна быть заметно короче JSON: ${rendered.length} vs ${selection.length}`);
  assert.equal(renderCatalogForPrompt("Свежих публикаций канала не найдено."), "Свежих публикаций канала не найдено.");
});

test("снимок каталога без привязки к постам: подписи валют один раз, товары не обрезаются на 180", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const insert = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, price, currency, available, status, origin) VALUES (?, ?, ?, ?, 'USD', ?, 'active', 'manual')"
  );
  for (let i = 0; i < 230; i++) insert.run(`p${i}`, `p${i}`, `Товар ${i}`, 100 + i, i === 5 ? 0 : 1);
  const catalog = buildTelegramCatalogForAssistant(db);
  const lines = catalog.split("\n");
  assert.equal(lines[0], "230 позиций, по одной строке на товар, поля разделены «|», цены — целые числа:");
  assert.equal(lines[1], "товар | цена по умолчанию в сомах (priceKgs) | USD (priceUsd) | RUB (priceRub) | KZT (priceKzt) | наличие");
  assert.equal(lines.length, 232, "все 230 товаров попадают в промпт");
  assert.ok(lines.some((line) => /^Товар 5 \| 9240 \| 105 \| \d+ \| \d+ \| нет в наличии$/.test(line)), lines.find((l) => l.startsWith("Товар 5 ")));
  assert.equal((catalog.match(/цена по умолчанию/g) || []).length, 1);
});

test("в системный промпт модели уходит таблица каталога, а страховки по-прежнему читают JSON-подборку", async (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const productId = db.prepare(
    "INSERT INTO products (slug, normalized_key, official_name, brand, category, price, currency, available, status) VALUES ('ip17', 'ip17', 'iPhone 17 256GB eSIM', 'Apple', 'Смартфоны', 840, 'USD', 1, 'active')"
  ).run().lastInsertRowid;
  const messageId = db.prepare(
    `INSERT INTO telegram_messages (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', 1, '2026-09-01T10:00:00.000Z', 'iPhone 17 840$', 'hash', 'ok')`
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, ?, 840, 'USD', 1, 1)").run(messageId, productId);
  let system = null;
  const ai = {
    enabled: true,
    chatTextWithTools: async (args) => {
      system = args.system;
      await args.executeTool("search_catalog", { query: "iPhone 17" });
      return "К сожалению, iPhone 17 в наличии нет.";
    },
  };
  const crm = new CrmService({ db, ai, amocrm: { enabled: false }, autoReplyDebounceMs: 0 });
  crm.saveSettings({ supervisorEnabled: false, templateRouterEnabled: false });
  const result = await crm.testBot({ message: "iPhone 17 есть?" });
  assert.match(system, /^iPhone 17 256GB eSIM \| Apple \| Смартфоны \| - \| - \| 840 USD \| 73920 \| 840 \|/m);
  assert.doesNotMatch(system, /\{\s*"products"/);
  assert.match(result.reply, /Есть в наличии/, "страховка по search_catalog всё ещё чинит ложное «нет»");
});

test("учёт токенов: cache hit DeepSeek пишется отдельно и тарифицируется дешевле", (t) => {
  const db = createConnection(":memory:");
  t.after(() => db.close());
  const crm = new CrmService({ db, ai: { enabled: false }, amocrm: { enabled: false } });
  crm._recordUsage("sales_agent", null, "deepseek-v4-flash", { prompt_tokens: 10000, completion_tokens: 100, total_tokens: 10100, prompt_cache_hit_tokens: 9000 });
  crm._recordUsage("sales_agent", null, "deepseek-v4-flash", { prompt_tokens: 10000, completion_tokens: 100, total_tokens: 10100 });
  const rows = db.prepare("SELECT cached_prompt_tokens, input_cost_usd FROM ai_usage ORDER BY id").all();
  assert.equal(rows[0].cached_prompt_tokens, 9000);
  assert.equal(rows[1].cached_prompt_tokens, 0);
  assert.ok(rows[0].input_cost_usd < rows[1].input_cost_usd / 3, "вызов с кэшем должен стоить в разы дешевле");
  const analytics = crm.getAiUsageAnalytics();
  assert.equal(analytics.periods.all.cachedTokens, 9000);
  assert.equal(analytics.tasks[0].cachedTokens, 9000);
});
