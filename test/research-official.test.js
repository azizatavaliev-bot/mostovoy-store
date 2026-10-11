const test = require("node:test");
const assert = require("node:assert/strict");
const { isOfficialUrl } = require("../server/services/research");

test("фото берутся только с официального домена бренда", () => {
  assert.equal(isOfficialUrl("https://images.samsung.com/ru/x.jpg", "Samsung"), true);
  assert.equal(isOfficialUrl("https://www.apple.com/iphone/", "Apple"), true);
  assert.equal(isOfficialUrl("https://www.garmin.com/tactix-8", "Garmin"), true);
  assert.equal(isOfficialUrl("https://www.amazon.com/dp/x", "Samsung"), false);
  assert.equal(isOfficialUrl("https://samsung-fake.com/x.jpg", "Samsung"), false);
});

test("бренд без списка официальных доменов не даёт ни одного фото", () => {
  assert.equal(isOfficialUrl("https://www.amazon.com/dp/x", "Unknownbrand"), false);
  assert.equal(isOfficialUrl("https://www.amazon.com/dp/x", ""), false);
});

test("кириллический бренд и новые официальные домены распознаются", () => {
  assert.equal(isOfficialUrl("https://alice.yandex.ru/station", "Яндекс"), true);
  assert.equal(isOfficialUrl("https://www.dyson.com/x", "Dyson"), true);
  assert.equal(isOfficialUrl("https://www.ray-ban.com/x", "Meta"), true);
  assert.equal(isOfficialUrl("https://www.fitbit.com/x", "Google"), true);
});

test("у игр без бренда обложки берутся только из PlayStation", () => {
  assert.equal(isOfficialUrl("https://store.playstation.com/x", null, "Игры"), true);
  assert.equal(isOfficialUrl("https://www.amazon.com/x", null, "Игры"), false);
  assert.equal(isOfficialUrl("https://store.playstation.com/x", null, "Наушники"), false);
});
