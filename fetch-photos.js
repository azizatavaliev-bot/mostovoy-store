// Тянет настоящие фото товаров из Open Icecat и пишет JSON для фронтенда.
// Запуск: node fetch-photos.js
// Логин Icecat берётся из переменной окружения ICECAT_USER (или подставь свой ниже).
const https = require("https");
const fs = require("fs");

const USER = process.env.ICECAT_USER || "AzizAtavaliev";

// id товара (из frontend/src/data/phones.json) -> Brand + ProductCode для Icecat.
// Apple заблокирован Icecat (brand restrictions) — по iPhone остаются рендеры.
const MODELS = {
  "s24-ultra": ["Samsung", "SM-S928BZKHEUB"],
  "s24-plus":  ["Samsung", "SM-S926BZKDEUB"],
  "s24":       ["Samsung", "SM-S921BZKDEUB"],
  "s23-ultra": ["Samsung", "SM-S918BZKHEUB"],
  "s23-fe":    ["Samsung", "SM-S711BZADEUB"],
  "a55":       ["Samsung", "SM-A556BZKAEUB"],
  "a35":       ["Samsung", "SM-A356BZKBEUB"],
};

const get = (url) =>
  new Promise((res, rej) => {
    https.get(url, (r) => { let s = ""; r.on("data", (d) => (s += d)); r.on("end", () => res(s)); }).on("error", rej);
  });

(async () => {
  const out = {};
  for (const [id, [brand, code]] of Object.entries(MODELS)) {
    const url = `https://live.icecat.biz/api?lang=en&shopname=${USER}&Brand=${brand}&ProductCode=${encodeURIComponent(code)}&content=`;
    try {
      const j = JSON.parse(await get(url));
      const img = j.data && j.data.Image;
      if (img) {
        out[id] = img.Pic500x500 || img.HighPic;
        console.log(`✓ ${id}`);
      } else {
        console.log(`· ${id} — ${j.Message || j.Error || "нет фото"}`);
      }
    } catch (e) {
      console.log(`× ${id} — ошибка запроса`);
    }
  }
  fs.writeFileSync(
    "frontend/src/data/photos.json",
    JSON.stringify(out, null, 2) + "\n"
  );
  console.log(`\nГотово: ${Object.keys(out).length} фото → frontend/src/data/photos.json`);
})();
