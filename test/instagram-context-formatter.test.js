const test = require("node:test");
const assert = require("node:assert/strict");
const { formatStoryContext } = require("../server/services/instagram/contextFormatter");

test("null (не ссылка на Story) — контекст не добавляется вообще", () => {
  assert.equal(formatStoryContext(null), null);
});

test("fallback story_analysis_failed — просит уточнить, не выдумывает содержимое", () => {
  const context = formatStoryContext({ ok: false, story_analysis_failed: true, reason: "story_unavailable" });
  assert.match(context, /\[Instagram Story\]/);
  assert.match(context, /не удалось/);
  assert.match(context, /не придумывай|Не придумывай/i);
});

test("успешный результат с найденным товаром — включает summary, детали и Product ID", () => {
  const context = formatStoryContext({
    ok: true,
    cached: false,
    analysis: {
      summary: "На видео девушка показывает чёрные прямоугольные солнцезащитные очки.",
      products_visible: [{ name_guess: "чёрные солнцезащитные очки", category: "очки", brand: null, model: null, confidence: 0.92 }],
      visible_text: ["Новое поступление"],
      important_details: ["чёрная оправа", "прямоугольная форма"],
      contains_product: true,
    },
    catalogMatches: [
      { id: 125, name: "Ray-Ban Meta Gen 2", brand: "Ray-Ban", category: "Очки", price: 300, currency: "USD" },
      { id: 312, name: "Ray-Ban Wayfarer", brand: "Ray-Ban", category: "Очки", price: 250, currency: "USD" },
    ],
  });
  assert.match(context, /чёрные прямоугольные солнцезащитные очки/);
  assert.match(context, /категория: очки/);
  assert.match(context, /Новое поступление/);
  assert.match(context, /Product ID 125/);
  assert.match(context, /Product ID 312/);
  assert.match(context, /не утверждай.*найден/i);
});

test("успешный результат без совпадений в каталоге — явно говорит, что совпадений нет", () => {
  const context = formatStoryContext({
    ok: true,
    cached: false,
    analysis: { summary: "показывает часы", products_visible: [{ name_guess: "часы", category: null, brand: null, model: null, confidence: 0.5 }], visible_text: [], important_details: [], contains_product: true },
    catalogMatches: [],
  });
  assert.match(context, /Совпадений в каталоге не найдено/);
});

test("Story без видимого товара (contains_product=false) не утверждает наличие товара", () => {
  const context = formatStoryContext({
    ok: true,
    cached: true,
    analysis: { summary: "человек говорит на камеру", products_visible: [], visible_text: [], important_details: [], contains_product: false },
    catalogMatches: [],
  });
  assert.match(context, /не видно конкретного товара/);
});
