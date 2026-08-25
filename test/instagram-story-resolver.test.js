const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnection } = require("../server/db");
const { StoryResolver } = require("../server/services/instagram/storyResolver");
const { StoryCache } = require("../server/services/instagram/storyCache");
const { HikerApiError } = require("../server/services/instagram/hikerClient");

const STORY_URL = "https://www.instagram.com/stories/mostovoyshop/3712345678901234567/";
const HIGHLIGHT_URL = "https://www.instagram.com/stories/highlights/17912345678901234/";

function fakeAi(analysis = { summary: "тест", products_visible: [], visible_text: [], important_details: [], contains_product: false }) {
  return { analyzeStoryFrames: async () => analysis };
}

function fakeFetchImplForPhoto() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/jpeg" : "40") },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from("photo-bytes"); } },
  });
}

test("resolve() на обычной ссылке Instagram (не Story) возвращает null, HikerAPI не дёргается", async () => {
  let called = false;
  const resolver = new StoryResolver({
    hikerClient: { enabled: true, resolveStoryByUrl: async () => { called = true; } },
  });
  const result = await resolver.resolve("https://www.instagram.com/p/CxYzAbCdEfG/");
  assert.equal(result, null);
  assert.equal(called, false);
});

test("фича выключена (нет HIKER_API_KEY) — сразу story_analysis_failed(not_configured), без сети", async () => {
  let called = false;
  const resolver = new StoryResolver({
    hikerClient: { enabled: false, resolveStoryByUrl: async () => { called = true; } },
  });
  const result = await resolver.resolve(STORY_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "not_configured" });
  assert.equal(called, false);
});

test("успешный resolve фото-Story: анализ + сопоставление с каталогом + запись в кэш", async () => {
  const db = createConnection(":memory:");
  db.prepare("INSERT INTO products (slug, normalized_key, official_name, brand, category, price, currency, status) VALUES ('g1','g1','Ray-Ban Meta Gen 2','Ray-Ban','Очки',300,'USD','active')").run();
  const msg = db.prepare(
    `INSERT INTO telegram_messages (telegram_chat_id, telegram_message_id, telegram_message_updated_at, telegram_original_text, telegram_text_hash, last_sync_status)
     VALUES ('-1001', 1, '2026-08-01T10:00:00.000Z', 'пост', 'h1', 'ok')`
  ).run().lastInsertRowid;
  db.prepare("INSERT INTO message_products (message_id, product_id, price, currency, available, active) VALUES (?, 1, 300, 'USD', 1, 1)").run(msg);

  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => ({ pk: "1", media_type: 1, thumbnail_url: "https://scontent.cdninstagram.com/photo.jpg", video_url: null, user: { username: "mostovoyshop", is_private: false } }),
  };
  const ai = fakeAi({ summary: "чёрные очки", products_visible: [{ name_guess: "чёрные очки", category: "очки", brand: "Ray-Ban", model: null, confidence: 0.9 }], visible_text: [], important_details: [], contains_product: true });
  const cache = new StoryCache({ db });
  const resolver = new StoryResolver({ db, hikerClient, ai, cache, fetchImpl: fakeFetchImplForPhoto() });

  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.analysis.summary, "чёрные очки");
  assert.equal(result.catalogMatches.length, 1);
  assert.equal(result.catalogMatches[0].name, "Ray-Ban Meta Gen 2");

  // Повторный resolve той же ссылки — из кэша, HikerAPI второй раз не дёргается.
  let secondCallToHiker = false;
  resolver.hikerClient.resolveStoryByUrl = async () => { secondCallToHiker = true; };
  const second = await resolver.resolve(STORY_URL);
  assert.equal(second.cached, true);
  assert.equal(second.analysis.summary, "чёрные очки");
  assert.equal(secondCallToHiker, false);

  db.close();
});

test("Highlight: берёт первый item из items[]", async () => {
  const hikerClient = {
    enabled: true,
    resolveHighlightByUrl: async () => ({
      pk: "9", title: "Новинки",
      items: [{ pk: "1", media_type: 1, thumbnail_url: "https://scontent.cdninstagram.com/h.jpg", video_url: null, user: { username: "shop", is_private: false } }],
    }),
  };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi(), cache: new StoryCache({ db: createConnection(":memory:") }), fetchImpl: fakeFetchImplForPhoto() });
  const result = await resolver.resolve(HIGHLIGHT_URL);
  assert.equal(result.ok, true);
});

test("Highlight без items — story_analysis_failed(highlight_unavailable)", async () => {
  const hikerClient = { enabled: true, resolveHighlightByUrl: async () => ({ pk: "9", title: "Пусто", items: [] }) };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(HIGHLIGHT_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "highlight_unavailable" });
});

test("Story удалена/истекла (404 от HikerAPI) — story_analysis_failed(not_found)", async () => {
  const hikerClient = { enabled: true, resolveStoryByUrl: async () => { throw new HikerApiError("не найдено", "not_found"); } };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "not_found" });
});

test("приватный аккаунт — story_analysis_failed(private_account)", async () => {
  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => ({ pk: "1", media_type: 1, thumbnail_url: "https://x/photo.jpg", user: { username: "priv", is_private: true } }),
  };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "private_account" });
});

test("HikerAPI недоступен (сетевая ошибка) — story_analysis_failed(network)", async () => {
  const hikerClient = { enabled: true, resolveStoryByUrl: async () => { throw new HikerApiError("сеть упала", "network"); } };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "network" });
});

test("rate limit от HikerAPI — story_analysis_failed(rate_limited)", async () => {
  const hikerClient = { enabled: true, resolveStoryByUrl: async () => { throw new HikerApiError("много запросов", "rate_limited"); } };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.reason, "rate_limited");
});

test("malformed-ответ HikerAPI (нет ни video_url, ни thumbnail_url) — story_analysis_failed(story_unavailable)", async () => {
  const hikerClient = { enabled: true, resolveStoryByUrl: async () => ({ pk: "1", media_type: null }) };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.deepEqual(result, { ok: false, story_analysis_failed: true, reason: "story_unavailable" });
});

test("видео-Story: без ffmpeg в окружении честно даёт story_analysis_failed(ffmpeg_not_found), не ломая пайплайн", async () => {
  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => ({ pk: "1", media_type: 2, video_url: "https://scontent.cdninstagram.com/video.mp4", video_duration: 8, user: { username: "shop", is_private: false } }),
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "video/mp4" : "20") },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from("не настоящее видео, но до этого дело и не дойдёт — ffmpeg просто не установлен"); } },
  });
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi(), fetchImpl });
  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ffmpeg_not_found");
});

test("media URL отсутствует у HikerAPI, хотя формально Story «есть» — не должно быть достижимо (story_unavailable ловит раньше), но на всякий случай fetchStory сам проверяет", async () => {
  // thumbnail_url есть только пустой строкой — эквивалент отсутствия.
  const hikerClient = { enabled: true, resolveStoryByUrl: async () => ({ pk: "1", media_type: 1, thumbnail_url: "" }) };
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi() });
  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "story_unavailable");
});

test("файл слишком большой при скачивании — story_analysis_failed с кодом от mediaDownloader", async () => {
  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => ({ pk: "1", media_type: 1, thumbnail_url: "https://scontent.cdninstagram.com/big.jpg", user: { username: "shop", is_private: false } }),
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/jpeg" : String(50 * 1024 * 1024)) },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.alloc(10); } },
  });
  const resolver = new StoryResolver({ hikerClient, ai: fakeAi(), fetchImpl });
  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "download_too_large");
});

test("vision упал (ошибка провайдера) — story_analysis_failed(vision_failed), падение резолвера не всплывает", async () => {
  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => ({ pk: "1", media_type: 1, thumbnail_url: "https://scontent.cdninstagram.com/photo.jpg", user: { username: "shop", is_private: false } }),
  };
  const ai = { analyzeStoryFrames: async () => { throw new Error("OpenAI: HTTP 500"); } };
  const resolver = new StoryResolver({ hikerClient, ai, fetchImpl: fakeFetchImplForPhoto() });
  const result = await resolver.resolve(STORY_URL);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "vision_failed");
});

test("одновременные запросы одной и той же ссылки — HikerAPI и vision вызываются только один раз (single-flight)", async () => {
  let hikerCalls = 0;
  let visionCalls = 0;
  const hikerClient = {
    enabled: true,
    resolveStoryByUrl: async () => {
      hikerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { pk: "1", media_type: 1, thumbnail_url: "https://scontent.cdninstagram.com/photo.jpg", user: { username: "shop", is_private: false } };
    },
  };
  const ai = { analyzeStoryFrames: async () => { visionCalls++; return { summary: "x", products_visible: [], visible_text: [], important_details: [], contains_product: false }; } };
  const resolver = new StoryResolver({ hikerClient, ai, fetchImpl: fakeFetchImplForPhoto() });

  const [a, b, c] = await Promise.all([resolver.resolve(STORY_URL), resolver.resolve(STORY_URL), resolver.resolve(STORY_URL)]);
  assert.equal(hikerCalls, 1);
  assert.equal(visionCalls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});
