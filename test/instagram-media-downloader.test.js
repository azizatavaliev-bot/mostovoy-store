const test = require("node:test");
const assert = require("node:assert/strict");
const { downloadStoryMedia, MediaDownloadError } = require("../server/services/instagram/mediaDownloader");

function fakeResponse({ status = 200, contentType = "image/jpeg", body = Buffer.from("fake-image-bytes"), contentLength } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === "content-type") return contentType;
        if (key === "content-length") return contentLength != null ? String(contentLength) : String(body.length);
        return null;
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

test("без media URL сразу отдаёт media_url_missing, не пытаясь скачивать", async () => {
  await assert.rejects(() => downloadStoryMedia("", { maxBytes: 1000, timeoutMs: 1000 }), (e) => e instanceof MediaDownloadError && e.code === "media_url_missing");
});

test("успешно скачивает изображение в пределах лимита", async () => {
  const fetchImpl = async () => fakeResponse({ contentType: "image/jpeg", body: Buffer.alloc(1000, 1) });
  const result = await downloadStoryMedia("https://scontent.cdninstagram.com/photo.jpg", { maxBytes: 5000, timeoutMs: 5000, fetchImpl });
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.bytes.length, 1000);
});

test("файл больше лимита отклоняется по заявленному Content-Length", async () => {
  const fetchImpl = async () => fakeResponse({ contentLength: 50 * 1024 * 1024, body: Buffer.alloc(10) });
  await assert.rejects(
    () => downloadStoryMedia("https://scontent.cdninstagram.com/video.mp4", { maxBytes: 30 * 1024 * 1024, timeoutMs: 5000, fetchImpl }),
    (e) => e instanceof MediaDownloadError && e.code === "download_too_large"
  );
});

test("файл больше лимита отклоняется по факту чтения, даже если Content-Length соврал", async () => {
  const bigBody = Buffer.alloc(2000, 7);
  const fetchImpl = async () => fakeResponse({ contentLength: 10, body: bigBody });
  await assert.rejects(
    () => downloadStoryMedia("https://scontent.cdninstagram.com/video.mp4", { maxBytes: 500, timeoutMs: 5000, fetchImpl }),
    (e) => e instanceof MediaDownloadError && e.code === "download_too_large"
  );
});

test("неожиданный Content-Type (не image/* и не video/*) отклоняется", async () => {
  const fetchImpl = async () => fakeResponse({ contentType: "text/html" });
  await assert.rejects(
    () => downloadStoryMedia("https://scontent.cdninstagram.com/oops.html", { maxBytes: 1000, timeoutMs: 5000, fetchImpl }),
    (e) => e instanceof MediaDownloadError && e.code === "unexpected_content_type"
  );
});

test("HTTP-ошибка от media URL пробрасывается как MediaDownloadError", async () => {
  const fetchImpl = async () => fakeResponse({ status: 403 });
  await assert.rejects(
    () => downloadStoryMedia("https://scontent.cdninstagram.com/gone.jpg", { maxBytes: 1000, timeoutMs: 5000, fetchImpl }),
    (e) => e instanceof MediaDownloadError && e.code === "download_http_error"
  );
});

test("SSRF: приватный IP в media URL отклоняется (через safeFetch)", async () => {
  await assert.rejects(
    () => downloadStoryMedia("https://169.254.169.254/latest/meta-data/", { maxBytes: 1000, timeoutMs: 5000, fetchImpl: async () => fakeResponse() }),
    (e) => e instanceof MediaDownloadError && e.code === "download_private_ip"
  );
});

test("пустой файл (0 байт) отклоняется", async () => {
  const fetchImpl = async () => fakeResponse({ body: Buffer.alloc(0) });
  await assert.rejects(
    () => downloadStoryMedia("https://scontent.cdninstagram.com/empty.jpg", { maxBytes: 1000, timeoutMs: 5000, fetchImpl }),
    (e) => e instanceof MediaDownloadError && e.code === "download_empty"
  );
});
