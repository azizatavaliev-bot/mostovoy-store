// Тесты админки: товары (фото/описание/цена/память/цвета/акции), логин по
// паролю, загрузка фото файлом, новости, журнал изменения цен.
const os = require("os");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

process.env.ADMIN_TOKEN = "test-admin-token";
process.env.ADMIN_USERNAME = "azis";
// Хеш пароля "test-password-123", посчитан один раз при написании теста —
// hashPassword рандомизирует соль, поэтому нельзя просто продублировать вызов.
process.env.SESSION_SECRET = "test-session-secret";
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mostovoy-uploads-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword } = require("../server/lib/auth");
process.env.ADMIN_PASSWORD_HASH = hashPassword("test-password-123");

const { createApp } = require("../server/app");
const config = require("../server/config");
const { makeDb, StubResearchService, makeFetch, pngBuffer } = require("./helpers");

const IMG = { headers: { "content-type": "image/png" }, body: pngBuffer(800, 600) };

function startApp({ fetchImpl } = {}) {
  const db = makeDb();
  const research = new StubResearchService({ status: "skipped", data: null, reason: "disabled" });
  const app = createApp({ db, research });
  if (fetchImpl) {
    // verifyImageUrl использует globalThis.fetch — подменяем на время теста.
    app.locals._restoreFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => (String(url).startsWith("http://127.0.0.1") ? app.locals._restoreFetch(url, opts) : fetchImpl(url, opts));
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    close: () => {
      if (app.locals._restoreFetch) globalThis.fetch = app.locals._restoreFetch;
      return new Promise((r) => server.close(r));
    },
  };
}

const H = { "content-type": "application/json", "x-admin-token": "test-admin-token" };
// Для multipart-запросов: content-type с boundary должен выставить сам fetch
// по объекту FormData — если задать его руками, сервер решит, что это JSON.
const H_UPLOAD = { "x-admin-token": "test-admin-token" };

test("без токена запросы к админке отклоняются", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`);
  assert.equal(res.status, 401);
});

test("с неверным токеном — 401", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, { headers: { "x-admin-token": "wrong" } });
  assert.equal(res.status, 401);
});

test("создание товара с диапазоном памяти", async (t) => {
  const app = startApp({ fetchImpl: makeFetch({ "photo.png": IMG }) });
  t.after(app.close);

  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: "Xiaomi Redmi Note 14",
      brand: "Xiaomi",
      category: "Смартфоны",
      price: 220,
      currency: "USD",
      color: "Чёрный",
      storageOptions: "128GB, 256GB, 512GB",
      description: "Тестовый товар",
      image: "https://dji.com/photo.png",
    }),
  });
  assert.equal(res.status, 201);
  const { product } = await res.json();
  assert.equal(product.name, "Xiaomi Redmi Note 14");
  assert.deepEqual(product.storageOptions, ["128 GB", "256 GB", "512 GB"]);
  assert.equal(product.image, "https://dji.com/photo.png");
  assert.equal(product.status, "active");
  assert.equal(product.origin, "manual");

  // Товар сразу виден в публичном каталоге.
  const cat = await (await fetch(`${app.base}/api/catalog`)).json();
  assert.ok(cat.products.some((p) => p.id === product.slug));
});

test("название и цена обязательны", async (t) => {
  const app = startApp();
  t.after(app.close);

  const noName = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H, body: JSON.stringify({ price: 10, currency: "USD" }),
  });
  assert.equal(noName.status, 400);

  const badPrice = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H, body: JSON.stringify({ name: "Товар", price: -5, currency: "USD" }),
  });
  assert.equal(badPrice.status, 400);

  const badCurrency = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H, body: JSON.stringify({ name: "Товар", price: 10, currency: "EUR" }),
  });
  assert.equal(badCurrency.status, 400);
});

test("недоступное фото отклоняется, товар не создаётся", async (t) => {
  const app = startApp({ fetchImpl: makeFetch({}) });
  t.after(app.close);

  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Товар с битым фото", price: 10, currency: "USD", image: "https://cdn.example.com/gone.png" }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /Главное фото недоступно/);

  const cat = await (await fetch(`${app.base}/api/catalog`)).json();
  assert.ok(!cat.products.some((p) => p.name === "Товар с битым фото"));
});

test("недоступные дополнительные фото отбрасываются с предупреждением, товар всё равно создаётся", async (t) => {
  const app = startApp({ fetchImpl: makeFetch({ "good.png": IMG }) });
  t.after(app.close);

  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: "Товар с разными фото", price: 10, currency: "USD",
      images: ["https://dji.com/good.png", "https://cdn.example.com/bad.png"],
    }),
  });
  assert.equal(res.status, 201);
  const { product, warnings } = await res.json();
  assert.deepEqual(product.images, ["https://dji.com/good.png"]);
  assert.equal(warnings.length, 1);
});

test("точный дубликат отклоняется с указанием существующего слага", async (t) => {
  const app = startApp();
  t.after(app.close);
  const body = { name: "Повторный товар", brand: "Brand", price: 50, currency: "USD" };

  const first = await fetch(`${app.base}/api/admin/products`, { method: "POST", headers: H, body: JSON.stringify(body) });
  assert.equal(first.status, 201);

  const second = await fetch(`${app.base}/api/admin/products`, { method: "POST", headers: H, body: JSON.stringify(body) });
  assert.equal(second.status, 409);
  const err = await second.json();
  assert.ok(err.existingSlug);
});

test("товары, отличающиеся цветом или памятью, дубликатами не считаются", async (t) => {
  const app = startApp();
  t.after(app.close);
  const base = { name: "Kindle Paperwhite", brand: "Amazon", price: 195, currency: "USD", storageOptions: "16GB" };

  const jade = await fetch(`${app.base}/api/admin/products`, { method: "POST", headers: H, body: JSON.stringify({ ...base, color: "Jade" }) });
  assert.equal(jade.status, 201);

  const raspberry = await fetch(`${app.base}/api/admin/products`, { method: "POST", headers: H, body: JSON.stringify({ ...base, color: "Raspberry" }) });
  assert.equal(raspberry.status, 201);
});

test("обновление цены не требует остальных полей", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H, body: JSON.stringify({ name: "Товар", brand: "B", price: 100, currency: "USD" }),
    })
  ).json();

  const res = await fetch(`${app.base}/api/admin/products/${created.product.slug}`, {
    method: "PUT", headers: H, body: JSON.stringify({ price: 150 }),
  });
  assert.equal(res.status, 200);
  const { product } = await res.json();
  assert.equal(product.price, 150);
  assert.equal(product.name, "Товар", "остальные поля не затронуты");
});

test("скрытие и восстановление товара", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H, body: JSON.stringify({ name: "Скрываемый товар", price: 10, currency: "USD" }),
    })
  ).json();
  const slug = created.product.slug;

  const hidden = await fetch(`${app.base}/api/admin/products/${slug}`, { method: "DELETE", headers: H });
  assert.equal(hidden.status, 200);
  assert.equal((await hidden.json()).product.status, "hidden");

  let cat = await (await fetch(`${app.base}/api/catalog`)).json();
  assert.ok(!cat.products.some((p) => p.id === slug), "скрытый товар не виден на витрине");

  const restored = await fetch(`${app.base}/api/admin/products/${slug}/restore`, { method: "POST", headers: H });
  assert.equal((await restored.json()).product.status, "active");

  cat = await (await fetch(`${app.base}/api/catalog`)).json();
  assert.ok(cat.products.some((p) => p.id === slug), "восстановленный товар снова виден");
});

test("безвозвратное удаление товара", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H, body: JSON.stringify({ name: "Удаляемый товар", price: 10, currency: "USD" }),
    })
  ).json();
  const slug = created.product.slug;

  const deleted = await fetch(`${app.base}/api/admin/products/${slug}/permanent`, { method: "DELETE", headers: H });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true, slug });

  const get = await fetch(`${app.base}/api/admin/products/${slug}`, { headers: H });
  assert.equal(get.status, 404);
  const repeated = await fetch(`${app.base}/api/admin/products/${slug}/permanent`, { method: "DELETE", headers: H });
  assert.equal(repeated.status, 404);
});

test("несуществующий товар — 404 при обновлении и скрытии", async (t) => {
  const app = startApp();
  t.after(app.close);
  const put = await fetch(`${app.base}/api/admin/products/no-such-slug`, { method: "PUT", headers: H, body: JSON.stringify({ price: 1 }) });
  assert.equal(put.status, 404);
  const del = await fetch(`${app.base}/api/admin/products/no-such-slug`, { method: "DELETE", headers: H });
  assert.equal(del.status, 404);
});

test("GET /api/admin/products отдаёт все статусы, включая скрытые", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H, body: JSON.stringify({ name: "Товар для списка", price: 10, currency: "USD" }),
    })
  ).json();
  await fetch(`${app.base}/api/admin/products/${created.product.slug}`, { method: "DELETE", headers: H });

  const list = await (await fetch(`${app.base}/api/admin/products`, { headers: H })).json();
  const found = list.products.find((p) => p.slug === created.product.slug);
  assert.ok(found);
  assert.equal(found.status, "hidden");
});

test("админ выключена без ADMIN_TOKEN и без логина/пароля", async (t) => {
  // Два независимых способа включить админку: токен (терминал) и
  // логин/пароль (браузер). Выключаем оба — иначе тест зависит от того,
  // что реально прописано в .env разработчика.
  const keys = ["ADMIN_TOKEN", "ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "SESSION_SECRET"];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  // Пустая строка, а не delete: config.js подставляет значение из .env только
  // если process.env[key] === undefined.
  keys.forEach((k) => (process.env[k] = ""));
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/routes/admin")];
  delete require.cache[require.resolve("../server/app")];
  const { createApp: createAppNoAdmin } = require("../server/app");
  const db = require("./helpers").makeDb();
  const app = createAppNoAdmin({ db, research: new StubResearchService() });
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/products`, {
    headers: { "x-admin-token": "anything" },
  });
  assert.equal(res.status, 503);

  keys.forEach((k) => (process.env[k] = original[k]));
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/routes/admin")];
  delete require.cache[require.resolve("../server/app")];
});

// --- Вход по логину и паролю ------------------------------------------

function sessionCookie(res) {
  const raw = res.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

test("вход по верному логину/паролю выдаёт рабочую сессию", async (t) => {
  const app = startApp();
  t.after(app.close);

  const login = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "azis", password: "test-password-123" }),
  });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  assert.ok(cookie.startsWith("mostovoy_admin_session="));

  const check = await fetch(`${app.base}/api/admin/session`, { headers: { cookie } });
  assert.deepEqual(await check.json(), { authenticated: true, loginEnabled: true });

  // Сессия работает и без x-admin-token — это отдельный, независимый способ входа.
  const products = await fetch(`${app.base}/api/admin/products`, { headers: { cookie } });
  assert.equal(products.status, 200);
});

test("ADMIN_PASSWORD_HASH через запятую — работают оба пароля одного логина", async (t) => {
  // Нужно, когда старый пароль забыт, а владелец, который его помнит,
  // недоступен: новый пароль добавляется вторым через запятую, не заменяя
  // старый — вход возможен любым из двух, пока кто-то не сменит пароль явно.
  const previousHash = config.admin.passwordHash;
  config.admin.passwordHash = `${previousHash},${hashPassword("second-password-456")}`;
  t.after(() => { config.admin.passwordHash = previousHash; });

  const app = startApp();
  t.after(app.close);

  const oldLogin = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "azis", password: "test-password-123" }),
  });
  assert.equal(oldLogin.status, 200, "старый пароль должен продолжать работать");

  const newLogin = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "azis", password: "second-password-456" }),
  });
  assert.equal(newLogin.status, 200, "новый пароль тоже должен работать");
});

test("вход с неверным паролем — 401, сессия не выдаётся", async (t) => {
  const app = startApp();
  t.after(app.close);

  const res = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "azis", password: "wrong" }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("вход с неверным логином — тоже 401 (не подсказываем, что логина не существует)", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "no-such-user", password: "test-password-123" }),
  });
  assert.equal(res.status, 401);
});

test("после нескольких неудачных попыток вход блокируется, даже с верным паролем", async (t) => {
  const app = startApp();
  t.after(app.close);
  const attempt = (password) =>
    fetch(`${app.base}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "azis", password }),
    });

  let last;
  for (let i = 0; i < 5; i++) last = await attempt("wrong");
  assert.equal(last.status, 401, "пятая попытка ещё не заблокирована");

  const blocked = await attempt("wrong");
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.ok(body.retryAfterSec > 0);

  const evenCorrect = await attempt("test-password-123");
  assert.equal(evenCorrect.status, 429, "блокировка держит даже верный пароль");
});

test("logout стирает сессию", async (t) => {
  const app = startApp();
  t.after(app.close);
  const login = await fetch(`${app.base}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "azis", password: "test-password-123" }),
  });
  const cookie = sessionCookie(login);

  const before = await fetch(`${app.base}/api/admin/session`, { headers: { cookie } });
  assert.equal((await before.json()).authenticated, true);

  await fetch(`${app.base}/api/admin/logout`, { method: "POST", headers: { cookie } });

  const after = await fetch(`${app.base}/api/admin/session`, { headers: { cookie } });
  assert.equal((await after.json()).authenticated, false);
});

test("сессия с чужим/поддельным токеном не работает", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    headers: { cookie: "mostovoy_admin_session=fake.forged" },
  });
  assert.equal(res.status, 401);
});

// --- Загрузка фото файлом -----------------------------------------------

async function pngFile(name, width = 800, height = 600) {
  const buf = await sharp({
    create: { width, height, channels: 4, background: { r: 239, g: 12, b: 34, alpha: 1 } },
  }).png().toBuffer();
  return new File([buf], name, { type: "image/png" });
}

test("загрузка настоящей картинки принимается и раздаётся по /uploads", async (t) => {
  const app = startApp();
  t.after(app.close);

  const form = new FormData();
  form.append("file", await pngFile("photo.png"));
  const res = await fetch(`${app.base}/api/admin/upload`, { method: "POST", headers: H_UPLOAD, body: form });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.url, /^\/uploads\/[a-f0-9]+\.webp$/);
  assert.equal(body.width, 800);
  assert.equal(body.format, "webp");

  const served = await fetch(`${app.base}${body.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/webp");
});

test("подделанное расширение (не настоящая картинка) отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const form = new FormData();
  form.append("file", new File([Buffer.from("это не картинка, просто текст")], "fake.png", { type: "image/png" }));
  const res = await fetch(`${app.base}/api/admin/upload`, { method: "POST", headers: H_UPLOAD, body: form });
  assert.equal(res.status, 422);
});

test("слишком маленькая загруженная картинка отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const form = new FormData();
  form.append("file", await pngFile("tiny.png", 50, 50));
  const res = await fetch(`${app.base}/api/admin/upload`, { method: "POST", headers: H_UPLOAD, body: form });
  assert.equal(res.status, 422);
});

test("загруженное фото можно сразу использовать в товаре без повторной HTTP-проверки", async (t) => {
  const app = startApp();
  t.after(app.close);
  const form = new FormData();
  form.append("file", await pngFile("photo.png"));
  const uploaded = await (await fetch(`${app.base}/api/admin/upload`, { method: "POST", headers: H_UPLOAD, body: form })).json();

  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Товар с локальным фото", price: 10, currency: "USD", image: uploaded.url }),
  });
  assert.equal(res.status, 201);
  const { product } = await res.json();
  assert.equal(product.image, uploaded.url);

  const optimized = await fetch(
    `${app.base}/api/images/webp?src=${encodeURIComponent(uploaded.url)}&w=96`
  );
  assert.equal(optimized.status, 200);
  assert.equal(optimized.headers.get("content-type"), "image/webp");
  const metadata = await sharp(Buffer.from(await optimized.arrayBuffer())).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 96);
});

// --- Группы, доступные цвета, акции ---------------------------------------

test("группа подсказывается по категории, если не указана явно", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "PlayStation 5 Slim", category: "Игровые приставки", price: 500, currency: "USD" }),
  });
  const { product } = await res.json();
  assert.equal(product.group, "Игры");
});

test("явно указанная группа не переопределяется подсказкой", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "Кастомный товар", category: "Игровые приставки", productGroup: "Аксессуары", price: 10, currency: "USD" }),
  });
  const { product } = await res.json();
  assert.equal(product.group, "Аксессуары");
});

test("недопустимая группа отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "Товар", productGroup: "Не существующая группа", price: 10, currency: "USD" }),
  });
  assert.equal(res.status, 400);
});

test("доступные цвета сохраняются и попадают в публичный каталог", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({
      name: "Товар с цветами", price: 10, currency: "USD",
      swatches: [["Чёрный", "#111111"], ["Белый", "не-hex-мусор"]],
    }),
  });
  const { product } = await res.json();
  assert.equal(product.swatches[0][0], "Чёрный");
  assert.equal(product.swatches[0][1], "#111111");
  assert.equal(product.swatches[1][1], "#cccccc", "невалидный hex заменяется на нейтральный цвет по умолчанию");

  const cat = await (await fetch(`${app.base}/api/catalog`)).json();
  const pub = cat.products.find((p) => p.name === "Товар с цветами");
  assert.equal(pub.swatches.length, 2);
});

test("акция считается корректно и видна в каталоге", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "Товар со скидкой", price: 350, currency: "USD", discountPercent: 20, discountLabel: "Летняя распродажа" }),
  });
  const { product } = await res.json();
  assert.equal(product.salePrice, 280);

  const cat = await (await fetch(`${app.base}/api/catalog`)).json();
  const pub = cat.products.find((p) => p.name === "Товар со скидкой");
  assert.equal(pub.price, 350, "исходная цена не перезаписывается");
  assert.equal(pub.salePrice, 280);
  assert.equal(pub.discountLabel, "Летняя распродажа");
});

test("акцию можно снять — цена возвращается к исходной", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "Товар", price: 100, currency: "USD", discountPercent: 50 }),
    })
  ).json();
  assert.equal(created.product.salePrice, 50);

  const updated = await (
    await fetch(`${app.base}/api/admin/products/${created.product.slug}`, {
      method: "PUT", headers: H, body: JSON.stringify({ discountPercent: "" }),
    })
  ).json();
  assert.equal(updated.product.discountPercent, null);
  assert.equal(updated.product.salePrice, null);
  assert.equal(updated.product.price, 100);
});

test("процент акции вне диапазона 1..99 отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/admin/products`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "Товар", price: 100, currency: "USD", discountPercent: 150 }),
  });
  assert.equal(res.status, 400);
});

// --- Журнал изменения цены -------------------------------------------------

test("создание и изменение цены попадают в /api/admin/price-history", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "Товар для истории цен", price: 100, currency: "USD" }),
    })
  ).json();
  await fetch(`${app.base}/api/admin/products/${created.product.slug}`, {
    method: "PUT", headers: H, body: JSON.stringify({ price: 120 }),
  });

  const history = await (await fetch(`${app.base}/api/admin/price-history`, { headers: H })).json();
  const changes = history.changes.filter((c) => c.productSlug === created.product.slug);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].oldPrice, 100);
  assert.equal(changes[0].newPrice, 120);
  assert.equal(changes[1].oldPrice, null);
  assert.equal(changes[1].newPrice, 100);
  assert.ok(changes.every((c) => c.source === "admin"));
});

test("обновление без изменения цены не создаёт лишней записи в истории", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/products`, {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "Товар без изменения цены", price: 100, currency: "USD" }),
    })
  ).json();
  await fetch(`${app.base}/api/admin/products/${created.product.slug}`, {
    method: "PUT", headers: H, body: JSON.stringify({ description: "просто поправили описание" }),
  });

  const history = await (await fetch(`${app.base}/api/admin/price-history`, { headers: H })).json();
  const changes = history.changes.filter((c) => c.productSlug === created.product.slug);
  assert.equal(changes.length, 1, "только запись о создании, апдейт описания цену не тронул");
});

// --- Новости --------------------------------------------------------------

test("создание новости, публичный список, черновик не виден публично", async (t) => {
  const app = startApp();
  t.after(app.close);

  const published = await fetch(`${app.base}/api/admin/posts`, {
    method: "POST", headers: H,
    body: JSON.stringify({ title: "Новая партия в наличии", body: "Текст новости" }),
  });
  assert.equal(published.status, 201);

  const draft = await fetch(`${app.base}/api/admin/posts`, {
    method: "POST", headers: H,
    body: JSON.stringify({ title: "Черновик", body: "Не публикуем пока", status: "draft" }),
  });
  assert.equal(draft.status, 201);

  const publicList = await (await fetch(`${app.base}/api/news`)).json();
  assert.equal(publicList.posts.length, 1);
  assert.equal(publicList.posts[0].title, "Новая партия в наличии");

  const adminList = await (await fetch(`${app.base}/api/admin/posts`, { headers: H })).json();
  assert.equal(adminList.posts.length, 2, "в админке видны и черновики");
});

test("редактирование и удаление новости", async (t) => {
  const app = startApp();
  t.after(app.close);
  const created = await (
    await fetch(`${app.base}/api/admin/posts`, {
      method: "POST", headers: H, body: JSON.stringify({ title: "Заголовок", body: "Текст" }),
    })
  ).json();

  const updated = await fetch(`${app.base}/api/admin/posts/${created.post.slug}`, {
    method: "PUT", headers: H, body: JSON.stringify({ title: "Новый заголовок" }),
  });
  assert.equal((await updated.json()).post.title, "Новый заголовок");

  const del = await fetch(`${app.base}/api/admin/posts/${created.post.slug}`, { method: "DELETE", headers: H });
  assert.equal(del.status, 200);

  const list = await (await fetch(`${app.base}/api/admin/posts`, { headers: H })).json();
  assert.ok(!list.posts.some((p) => p.slug === created.post.slug));
});

test("новость без заголовка или текста отклоняется", async (t) => {
  const app = startApp();
  t.after(app.close);
  const noTitle = await fetch(`${app.base}/api/admin/posts`, { method: "POST", headers: H, body: JSON.stringify({ body: "текст" }) });
  assert.equal(noTitle.status, 400);
  const noBody = await fetch(`${app.base}/api/admin/posts`, { method: "POST", headers: H, body: JSON.stringify({ title: "заголовок" }) });
  assert.equal(noBody.status, 400);
});
