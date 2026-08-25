// Вызов vision-модели на кадрах Story + приведение ответа к гарантированной
// форме. ai.analyzeStoryFrames() может отдать частично неполный JSON (модель
// пропустила поле, дала строку вместо массива и т.п.) — здесь всегда
// возвращается полная форма с безопасными дефолтами, чтобы дальше по
// пайплайну (catalogMatcher, crm.js) не приходилось проверять на undefined.
class StoryAnalysisError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StoryAnalysisError";
    this.code = code;
  }
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
}

function normalizeProduct(item) {
  if (!item || typeof item !== "object") return null;
  const nameGuess = typeof item.name_guess === "string" ? item.name_guess.trim().slice(0, 200) : "";
  if (!nameGuess) return null;
  return {
    name_guess: nameGuess,
    category: typeof item.category === "string" && item.category.trim() ? item.category.trim().slice(0, 100) : null,
    brand: typeof item.brand === "string" && item.brand.trim() ? item.brand.trim().slice(0, 100) : null,
    model: typeof item.model === "string" && item.model.trim() ? item.model.trim().slice(0, 100) : null,
    confidence: clampConfidence(item.confidence) ?? 0,
  };
}

function normalizeStringArray(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, 300))
    .slice(0, limit);
}

/** Приводит сырой ответ vision-модели к гарантированной форме StoryAnalysis. */
function normalizeStoryAnalysis(raw) {
  const products = Array.isArray(raw?.products_visible)
    ? raw.products_visible.map(normalizeProduct).filter(Boolean).slice(0, 5)
    : [];
  return {
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 500) : "",
    products_visible: products,
    visible_text: normalizeStringArray(raw?.visible_text, 10),
    important_details: normalizeStringArray(raw?.important_details, 10),
    contains_product: Boolean(raw?.contains_product) || products.length > 0,
  };
}

/**
 * @param {object} ai — AiRouter (или совместимый мок с analyzeStoryFrames)
 * @param {{ images: {bytes: Buffer, mimeType: string}[], caption?: string, onUsage?: Function }} input
 * @returns {Promise<object>} нормализованный StoryAnalysis
 */
async function analyzeStoryFrames(ai, { images, caption, onUsage }) {
  if (typeof ai?.analyzeStoryFrames !== "function") {
    throw new StoryAnalysisError("Vision для Story не настроен", "vision_not_configured");
  }
  let raw;
  try {
    raw = await ai.analyzeStoryFrames({ images, caption, onUsage });
  } catch (error) {
    throw new StoryAnalysisError(`Vision-анализ не удался: ${error.message}`, "vision_failed");
  }
  return normalizeStoryAnalysis(raw);
}

module.exports = { analyzeStoryFrames, normalizeStoryAnalysis, StoryAnalysisError };
