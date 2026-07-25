const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyImageUrl, verifyImageUrls, imageSize } = require("../server/services/images");
const { assertPublicUrl, isPrivateAddress } = require("../server/lib/safeFetch");
const { extractImagesFromHtml } = require("../server/services/research/providers");
const { enforceAllowedUrls } = require("../server/services/research");
const { makeFetch, pngBuffer } = require("./helpers");

const IMG = { headers: { "content-type": "image/png" }, body: pngBuffer(800, 600) };

test("нормальная картинка проходит проверку", async () => {
  const fetchImpl = makeFetch({ "dji.com/mic-mini.webp": IMG });
  const res = await verifyImageUrl("https://www.dji.com/mic-mini.webp", { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.width, 800);
  assert.equal(res.contentType, "image/png");
});

test("недоступная ссылка отклоняется", async () => {
  const fetchImpl = makeFetch({ "dji.com/gone.webp": { status: 404, headers: { "content-type": "image/png" } } });
  const res = await verifyImageUrl("https://www.dji.com/gone.webp", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "http_404");
});

test("HTML-страница вместо файла картинки отклоняется", async () => {
  const fetchImpl = makeFetch({
    "example.com/products/dji-mic-mini": { headers: { "content-type": "text/html; charset=utf-8" }, body: "<html></html>" },
  });
  const res = await verifyImageUrl("https://example.com/products/dji-mic-mini", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_an_image");
});

test("http вместо https отклоняется без запроса", async () => {
  const fetchImpl = makeFetch({});
  const res = await verifyImageUrl("http://www.dji.com/mic.png", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "not_https");
  assert.equal(fetchImpl.calls.length, 0);
});

test("логотипы, фавиконки и иконки отсеиваются по URL", async () => {
  const fetchImpl = makeFetch({});
  for (const url of [
    "https://dji.com/favicon.ico",
    "https://dji.com/assets/logo.png",
    "https://dji.com/img/icon-cart.png",
    "https://dji.com/img/placeholder.png",
  ]) {
    const res = await verifyImageUrl(url, { fetchImpl });
    assert.equal(res.ok, false, url);
    assert.equal(res.reason, "looks_like_icon_or_logo");
  }
});

test("временная подписанная ссылка отклоняется", async () => {
  const res = await verifyImageUrl(
    "https://cdn.example.com/p.jpg?X-Amz-Signature=abc&X-Amz-Credential=xyz",
    { fetchImpl: makeFetch({}) }
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, "temporary_signed_url");
});

test("слишком маленькое изображение отклоняется", async () => {
  const fetchImpl = makeFetch({
    "small.png": { headers: { "content-type": "image/png" }, body: pngBuffer(120, 120, 20000) },
  });
  const res = await verifyImageUrl("https://dji.com/small.png", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "low_resolution");
});

test("крошечный файл отклоняется как превью", async () => {
  const fetchImpl = makeFetch({
    "tiny.png": { headers: { "content-type": "image/png" }, body: pngBuffer(800, 600, 100) },
  });
  const res = await verifyImageUrl("https://dji.com/tiny.png", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "too_small_file");
});

test("картинка с чужого домена отклоняется, если ожидался домен источника", async () => {
  const fetchImpl = makeFetch({ "cdn.other.com/p.png": IMG });
  const res = await verifyImageUrl("https://cdn.other.com/p.png", { fetchImpl, expectedDomain: "dji.com" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "domain_mismatch");
});

test("verifyImageUrls сохраняет порядок и режет по лимиту", async () => {
  const fetchImpl = makeFetch({ "a.png": IMG, "b.png": IMG, "c.png": IMG });
  const { good, rejected } = await verifyImageUrls(
    ["https://dji.com/a.png", "https://dji.com/bad.png", "https://dji.com/b.png", "https://dji.com/c.png"],
    { fetchImpl, limit: 2 }
  );
  assert.deepEqual(good.map((g) => g.url), ["https://dji.com/a.png", "https://dji.com/b.png"]);
  assert.equal(rejected.length, 1);
});

test("размеры читаются из заголовка PNG", () => {
  assert.deepEqual(imageSize(pngBuffer(1200, 900)), { width: 1200, height: 900 });
  assert.equal(imageSize(Buffer.from("не картинка")), null);
});

// --- SSRF ---------------------------------------------------------------

test("приватные адреса распознаются", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress("93.184.216.34"), false);
});

test("localhost и приватные IP запрещены", async () => {
  await assert.rejects(() => assertPublicUrl("https://localhost/img.png"), /Внутренний хост/);
  await assert.rejects(() => assertPublicUrl("https://127.0.0.1/img.png"), /Приватный IP/);
  await assert.rejects(() => assertPublicUrl("https://192.168.1.1/img.png"), /Приватный IP/);
  await assert.rejects(() => assertPublicUrl("https://[::1]/img.png"), /Приватный IP/);
});

test("metadata endpoint облака запрещён", async () => {
  await assert.rejects(() => assertPublicUrl("https://169.254.169.254/latest/meta-data/"), /Приватный IP/);
});

// --- Извлечение картинок со страницы -------------------------------------

test("og:image и JSON-LD Product.image извлекаются со страницы", () => {
  const html = `<html><head>
    <meta property="og:image" content="https://www.dji.com/img/main.webp">
    <script type="application/ld+json">
      {"@type":"Product","name":"DJI Mic Mini","image":["https://www.dji.com/img/a.jpg","https://www.dji.com/img/b.jpg"]}
    </script>
    </head><body>
    <img src="/img/gallery-1.png"><img src="/not-an-image">
    </body></html>`;

  const found = extractImagesFromHtml(html, "https://www.dji.com/mic-mini");
  const urls = found.map((f) => f.url);
  assert.ok(urls.includes("https://www.dji.com/img/main.webp"));
  assert.ok(urls.includes("https://www.dji.com/img/a.jpg"));
  assert.ok(urls.includes("https://www.dji.com/img/gallery-1.png"), "относительный путь стал абсолютным");
  assert.ok(!urls.includes("https://www.dji.com/not-an-image"), "ссылка без расширения картинки не берётся");
});

// --- Защита от выдуманных ссылок -----------------------------------------

test("ссылки, которых не было в найденных материалах, выбрасываются", () => {
  const allowedImages = ["https://www.dji.com/img/real.webp"];
  const allowedPages = ["https://www.dji.com/mic-mini"];

  const { result, dropped } = enforceAllowedUrls(
    {
      main_image_url: "https://www.dji.com/img/ПРИДУМАНО.webp",
      image_urls: ["https://www.dji.com/img/real.webp", "https://fake.example.com/nope.jpg"],
      source_page_url: "https://www.dji.com/выдуманная-страница",
      image_source_url: "https://www.dji.com/mic-mini",
    },
    allowedImages,
    allowedPages
  );

  assert.equal(result.main_image_url, "https://www.dji.com/img/real.webp", "подставлена проверенная картинка");
  assert.deepEqual(result.image_urls, ["https://www.dji.com/img/real.webp"]);
  assert.equal(result.source_page_url, "https://www.dji.com/mic-mini");
  assert.equal(dropped.length, 3);
});
