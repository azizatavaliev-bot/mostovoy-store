const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFrames, pickTimestamps, FrameExtractionError } = require("../server/services/instagram/frameExtractor");

test("pickTimestamps: обычное видео (>=4с) — три кадра на 20/50/80%", () => {
  const ts = pickTimestamps(10);
  assert.equal(ts.length, 3);
  assert.deepEqual(ts.map((t) => Math.round(t * 10) / 10), [2, 5, 8]);
});

test("pickTimestamps: короткое видео (1.5-4с) — два кадра", () => {
  const ts = pickTimestamps(3);
  assert.equal(ts.length, 2);
});

test("pickTimestamps: очень короткое видео (<1.5с) — один кадр в середине", () => {
  const ts = pickTimestamps(1);
  assert.equal(ts.length, 1);
  assert.equal(ts[0], 0.5);
});

test("pickTimestamps: неизвестная длительность (ffprobe не смог определить) — один кадр на нулевой отметке", () => {
  assert.deepEqual(pickTimestamps(null), [0]);
  assert.deepEqual(pickTimestamps(0), [0]);
});

// В этом окружении ffmpeg/ffprobe не установлены (проверено — которые
// нужны для реального Railway-деплоя, см. итоговый отчёт: RAILPACK_PACKAGES=
// ffmpeg). Это ровно тот путь, который должен сработать в проде, если
// пакет забудут добавить — extractFrames обязана упасть предсказуемо, а
// не зависнуть/бросить неопознанную ошибку, и storyResolver обязан поймать
// именно этот код (см. instagram-story-resolver.test.js).
test("без установленного ffmpeg extractFrames падает с понятным FrameExtractionError(ffmpeg_not_found)", async () => {
  await assert.rejects(
    () => extractFrames(Buffer.from("не настоящее видео, но до парсинга не дойдёт — ffprobe/ffmpeg просто не найдутся"), { timeoutMs: 5000 }),
    (error) => {
      assert.ok(error instanceof FrameExtractionError);
      assert.equal(error.code, "ffmpeg_not_found");
      return true;
    }
  );
});
