const test = require("node:test");
const assert = require("node:assert/strict");
const { parseInstagramStoryUrl, findInstagramStoryUrls } = require("../server/services/instagram/parser");

test("распознаёт ссылку на Story (с www и без)", () => {
  const withWww = parseInstagramStoryUrl("https://www.instagram.com/stories/mostovoyshop/3712345678901234567/");
  assert.equal(withWww.type, "story");
  assert.equal(withWww.username, "mostovoyshop");
  assert.equal(withWww.storyId, "3712345678901234567");
  assert.equal(withWww.cacheKey, "instagram_story:3712345678901234567");

  const noWww = parseInstagramStoryUrl("https://instagram.com/stories/mostovoyshop/3712345678901234567/");
  assert.equal(noWww.type, "story");
  assert.equal(noWww.cacheKey, withWww.cacheKey);
});

test("распознаёт ссылку на Highlight (с www и без, с query-параметрами)", () => {
  const parsed = parseInstagramStoryUrl("https://www.instagram.com/stories/highlights/17912345678901234/?igsh=abc123");
  assert.equal(parsed.type, "highlight");
  assert.equal(parsed.highlightId, "17912345678901234");
  assert.equal(parsed.cacheKey, "instagram_highlight:17912345678901234");

  const noWww = parseInstagramStoryUrl("https://instagram.com/stories/highlights/17912345678901234/");
  assert.equal(noWww.highlightId, "17912345678901234");
});

test("обычные ссылки Instagram (пост, рилс, профиль) не считаются Story", () => {
  assert.equal(parseInstagramStoryUrl("https://www.instagram.com/p/CxYzAbCdEfG/"), null);
  assert.equal(parseInstagramStoryUrl("https://www.instagram.com/reel/CxYzAbCdEfG/"), null);
  assert.equal(parseInstagramStoryUrl("https://www.instagram.com/mostovoyshop/"), null);
  assert.equal(parseInstagramStoryUrl("https://www.instagram.com/mostovoyshop/tagged/"), null);
  assert.equal(parseInstagramStoryUrl(""), null);
  assert.equal(parseInstagramStoryUrl("не ссылка вообще"), null);
  assert.equal(parseInstagramStoryUrl("https://example.com/stories/mostovoyshop/123/"), null, "чужой домен");
});

test("findInstagramStoryUrls находит ссылку внутри свободного текста и режет хвостовую пунктуацию", () => {
  const found = findInstagramStoryUrls("гляньте вот https://www.instagram.com/stories/mostovoyshop/3712345678901234567/, что это?");
  assert.equal(found.length, 1);
  assert.equal(found[0].storyId, "3712345678901234567");
});

test("findInstagramStoryUrls дедуплицирует одинаковую ссылку в одном сообщении", () => {
  const text = "https://www.instagram.com/stories/mostovoyshop/111/ и ещё раз https://instagram.com/stories/mostovoyshop/111/";
  const found = findInstagramStoryUrls(text);
  assert.equal(found.length, 1);
});

test("findInstagramStoryUrls игнорирует текст без ссылок на Story", () => {
  assert.deepEqual(findInstagramStoryUrls("Здравствуйте, есть iPhone 17?"), []);
  assert.deepEqual(findInstagramStoryUrls("https://www.instagram.com/p/CxYzAbCdEfG/ что это?"), []);
});
