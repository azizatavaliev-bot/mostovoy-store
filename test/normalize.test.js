const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parsePrice,
  detectCurrency,
  normalizeStorage,
  normalizedKey,
  looksUnavailable,
  similarity,
  slugify,
} = require("../server/lib/normalize");

test("цены: 650$ распознаётся как 650 USD", () => {
  assert.deepEqual(parsePrice("Sony 5 slim 650$"), { price: 650, currency: "USD" });
});

test("цены: 2500 сом распознаётся как 2500 KGS", () => {
  assert.deepEqual(parsePrice("Philips one blade 2500 сом"), { price: 2500, currency: "KGS" });
});

test("цены: $ перед суммой", () => {
  assert.deepEqual(parsePrice("Amazon Kindle 16GB Black $135"), { price: 135, currency: "USD" });
});

test("цены: явный код валюты", () => {
  assert.deepEqual(parsePrice("Kindle PaperWhite 16GB Jade 195 USD"), { price: 195, currency: "USD" });
});

test("цены: пробел как разделитель тысяч", () => {
  assert.deepEqual(parsePrice("Подарочный набор Instax 11 000 сом"), { price: 11000, currency: "KGS" });
});

test("цены: разделитель-запятая", () => {
  assert.deepEqual(parsePrice("Meta Quest 3 1,299 USD"), { price: 1299, currency: "USD" });
});

test("цены: номер модели не приклеивается к цене", () => {
  // «Nintendo 2» за 470, а не 2470.
  assert.deepEqual(parsePrice("Nintendo 2 470$"), { price: 470, currency: "USD" });
  assert.deepEqual(parsePrice("Meta Quest 3 . 4k 512gb 512$"), { price: 512, currency: "USD" });
  assert.deepEqual(parsePrice("Steam deck oled 512g 550$"), { price: 550, currency: "USD" });
});

test("цены: лишний текст и тире не мешают", () => {
  assert.deepEqual(parsePrice("Самая топовая Петличка Dji mic 3 - 290$"), { price: 290, currency: "USD" });
});

test("цены: строка без цены даёт null", () => {
  assert.equal(parsePrice("Триммер"), null);
  assert.equal(parsePrice("Также есть петличка"), null);
});

test("валюта: словесные формы", () => {
  assert.equal(detectCurrency("500 сомов"), "KGS");
  assert.equal(detectCurrency("10 долларов"), "USD");
  assert.equal(detectCurrency("просто текст"), null);
});

test("память нормализуется к единому виду", () => {
  assert.equal(normalizeStorage("512g"), "512 GB");
  assert.equal(normalizeStorage("16GB"), "16 GB");
  assert.equal(normalizeStorage("1tb"), "1 TB");
  assert.equal(normalizeStorage("1 ТБ"), "1 TB");
  assert.equal(normalizeStorage(null), null);
});

test("нормализованный ключ имеет вид brand|model|storage|color|variant", () => {
  assert.equal(
    normalizedKey({ brand: "Sony", model: "PlayStation 5 Slim" }),
    "sony|playstation-5-slim|||standard"
  );
  assert.equal(
    normalizedKey({ brand: "Amazon", model: "Kindle Paperwhite", storage: "16GB", color: "Jade" }),
    "amazon|kindle-paperwhite|16-gb|jade|standard"
  );
});

test("ключ различает модели, отличающиеся только плюсом", () => {
  const a = normalizedKey({ brand: "Samsung", model: "Galaxy S24" });
  const b = normalizedKey({ brand: "Samsung", model: "Galaxy S24+" });
  assert.notEqual(a, b);
  assert.equal(slugify("Galaxy S24+"), "galaxy-s24-plus");
});

test("наличие: маркеры отсутствия", () => {
  assert.equal(looksUnavailable("iPhone 15 — нет в наличии"), true);
  assert.equal(looksUnavailable("Kindle sold out"), true);
  assert.equal(looksUnavailable("Steam Deck закончился"), true);
  assert.equal(looksUnavailable("продано"), true);
  assert.equal(looksUnavailable("PlayStation 5 Slim 650$"), false);
});

test("похожесть устойчива к опечаткам и регистру", () => {
  assert.ok(similarity("PlayStation 5 Slim", "playstation 5 slim") === 1);
  assert.ok(similarity("Dji mic mini", "DJI Mic Mini") === 1);
  assert.ok(similarity("PlayStation 5 Slim", "PlayStation 5 Pro") < 0.88);
  // Порог автосопоставления — 0.88, опечатка должна его проходить.
  assert.ok(similarity("Nintendo Switch 2", "Nintendo Swich 2") > 0.88);
});
