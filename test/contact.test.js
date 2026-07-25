const test = require("node:test");
const assert = require("node:assert/strict");
const { buildContactMessage, buildContactLink, buildWhatsappLink, GENERIC_MESSAGE } = require("../server/lib/contact");

test("сообщение по товару содержит название, цену и валюту", () => {
  const msg = buildContactMessage({ official_name: "PlayStation 5 Slim", price: 650, currency: "USD" });
  assert.equal(msg, "Здравствуйте! Меня интересует PlayStation 5 Slim за 650 USD. Подскажите, товар сейчас в наличии?");
});

test("выбранный цвет попадает в сообщение", () => {
  const msg = buildContactMessage({
    official_name: "Kindle Paperwhite 16 GB",
    storage: "16 GB",
    color: "Jade",
    price: 195,
    currency: "USD",
  });
  assert.equal(
    msg,
    "Здравствуйте! Меня интересует Kindle Paperwhite 16 GB, цвет Jade, за 195 USD. Подскажите, товар сейчас в наличии?"
  );
});

test("память не дублируется, если уже есть в названии", () => {
  const msg = buildContactMessage({ official_name: "Kindle Paperwhite 16 GB", storage: "16 GB", price: 195, currency: "USD" });
  assert.equal(msg.match(/16 GB/g).length, 1);
});

test("выбор на странице товара перекрывает значения по умолчанию", () => {
  const msg = buildContactMessage(
    { official_name: "Kindle Paperwhite", color: "Black", price: 195, currency: "USD" },
    { color: "Raspberry" }
  );
  assert.ok(msg.includes("цвет Raspberry"));
  assert.ok(!msg.includes("Black"));
});

test("без товара используется общее сообщение", () => {
  assert.equal(buildContactMessage(null), GENERIC_MESSAGE);
  assert.equal(GENERIC_MESSAGE, "Здравствуйте! Хочу проконсультироваться по выбору техники.");
});

test("ссылка ведёт в чат магазина, текст закодирован", () => {
  const link = buildContactLink("mostovoyshop", { official_name: "DJI Mic Mini", price: 95, currency: "USD" });
  assert.equal(link.url, "https://t.me/mostovoyshop");
  assert.ok(link.text.includes("DJI Mic Mini"));
  // Текст в share-ссылке должен быть корректно URL-кодирован.
  assert.ok(link.shareUrl.includes(encodeURIComponent(link.text)));
  assert.ok(!link.shareUrl.includes(" "));
});

test("@ в username не ломает ссылку", () => {
  assert.equal(buildContactLink("@mostovoyshop", null).url, "https://t.me/mostovoyshop");
});

test("WhatsApp-ссылка содержит номер и предзаполненный текст", () => {
  const link = buildWhatsappLink("996999110110", {
    official_name: "PlayStation 5 Slim",
    price: 650,
    currency: "USD",
  });
  assert.equal(link.phone, "996999110110");
  assert.ok(link.url.startsWith("https://wa.me/996999110110?text="));
  assert.equal(
    link.text,
    "Здравствуйте! Меня интересует PlayStation 5 Slim за 650 USD. Подскажите, товар сейчас в наличии?"
  );
  // Текст обязан быть корректно закодирован в URL.
  assert.ok(link.url.includes(encodeURIComponent(link.text)));
  assert.ok(!link.url.includes(" "));
  // Раскодированный обратно параметр совпадает с исходным текстом.
  assert.equal(new URL(link.url).searchParams.get("text"), link.text);
});

test("номер WhatsApp очищается от плюса, скобок и пробелов", () => {
  const link = buildWhatsappLink("+996 (999) 110-110", null);
  assert.equal(link.phone, "996999110110");
  assert.ok(link.url.startsWith("https://wa.me/996999110110?text="));
});

test("без товара в WhatsApp уходит общее сообщение", () => {
  const link = buildWhatsappLink("996999110110", null);
  assert.equal(link.text, GENERIC_MESSAGE);
});

test("выбранные цвет и память попадают в WhatsApp-заказ", () => {
  const link = buildWhatsappLink(
    "996999110110",
    { official_name: "Kindle Paperwhite", price: 195, currency: "USD" },
    { color: "Jade", storage: "16 GB" }
  );
  assert.ok(link.text.includes("цвет Jade"));
  assert.ok(link.text.includes("память 16 GB"));
});

test("цена без дробной части выводится без .00", () => {
  const msg = buildContactMessage({ official_name: "Test", price: 2500, currency: "KGS" });
  assert.ok(msg.includes("за 2500 KGS"));
});
