const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeStoryFrames, normalizeStoryAnalysis, StoryAnalysisError } = require("../server/services/instagram/storyAnalyzer");

test("normalizeStoryAnalysis приводит полный корректный ответ к той же форме", () => {
  const raw = {
    summary: "На видео девушка показывает чёрные прямоугольные солнцезащитные очки.",
    products_visible: [{ name_guess: "чёрные солнцезащитные очки", category: "очки", brand: null, model: null, confidence: 0.92 }],
    visible_text: ["Новое поступление"],
    important_details: ["чёрная оправа", "прямоугольная форма"],
    contains_product: true,
  };
  assert.deepEqual(normalizeStoryAnalysis(raw), raw);
});

test("normalizeStoryAnalysis подставляет безопасные дефолты на неполный/кривой ответ модели", () => {
  const result = normalizeStoryAnalysis({ summary: 42, products_visible: "не массив", visible_text: null });
  assert.deepEqual(result, { summary: "", products_visible: [], visible_text: [], important_details: [], contains_product: false });
});

test("normalizeStoryAnalysis отбрасывает товар без name_guess и клэмпит confidence в [0,1]", () => {
  const result = normalizeStoryAnalysis({
    products_visible: [
      { category: "телефон" }, // без name_guess — отбрасывается
      { name_guess: "iPhone", confidence: 5 },
      { name_guess: "MacBook", confidence: -1 },
    ],
  });
  assert.equal(result.products_visible.length, 2);
  assert.equal(result.products_visible[0].confidence, 1);
  assert.equal(result.products_visible[1].confidence, 0);
});

test("normalizeStoryAnalysis выставляет contains_product=true, если товары есть, даже если модель забыла флаг", () => {
  const result = normalizeStoryAnalysis({ products_visible: [{ name_guess: "часы" }], contains_product: false });
  assert.equal(result.contains_product, true);
});

test("normalizeStoryAnalysis не выдумывает бренд/модель — сохраняет null как есть", () => {
  const result = normalizeStoryAnalysis({ products_visible: [{ name_guess: "чёрные кроссовки", brand: null, model: null, confidence: 0.4 }] });
  assert.equal(result.products_visible[0].brand, null);
  assert.equal(result.products_visible[0].model, null);
});

test("analyzeStoryFrames без ai.analyzeStoryFrames бросает vision_not_configured", async () => {
  await assert.rejects(
    () => analyzeStoryFrames({}, { images: [{ bytes: Buffer.from("x"), mimeType: "image/jpeg" }] }),
    (e) => e instanceof StoryAnalysisError && e.code === "vision_not_configured"
  );
});

test("analyzeStoryFrames оборачивает ошибку провайдера в StoryAnalysisError(vision_failed)", async () => {
  const ai = { analyzeStoryFrames: async () => { throw new Error("OpenAI: HTTP 429"); } };
  await assert.rejects(
    () => analyzeStoryFrames(ai, { images: [{ bytes: Buffer.from("x"), mimeType: "image/jpeg" }] }),
    (e) => e instanceof StoryAnalysisError && e.code === "vision_failed" && e.message.includes("HTTP 429")
  );
});

test("analyzeStoryFrames возвращает нормализованный результат при успехе", async () => {
  const ai = { analyzeStoryFrames: async () => ({ summary: "тест", products_visible: [], visible_text: [], important_details: [], contains_product: false }) };
  const result = await analyzeStoryFrames(ai, { images: [{ bytes: Buffer.from("x"), mimeType: "image/jpeg" }] });
  assert.equal(result.summary, "тест");
});
