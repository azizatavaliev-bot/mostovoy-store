// Скачивание медиафайла Story (фото/видео) по URL, который вернул HikerAPI.
// SSRF-защита, таймаут и лимит размера — через уже существующий safeFetch
// (server/lib/safeFetch.js), тот же модуль использует services/images.js.
// Никогда не скачивает произвольный URL от клиента — только media URL,
// пришедший от HikerAPI после успешного resolve.
const { safeFetch, readLimited, FetchGuardError } = require("../../lib/safeFetch");

class MediaDownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MediaDownloadError";
    this.code = code;
  }
}

/**
 * @param {string} mediaUrl
 * @param {{ maxBytes: number, timeoutMs: number, fetchImpl?: Function }} opts
 * @returns {Promise<{ bytes: Buffer, contentType: string }>}
 */
async function downloadStoryMedia(mediaUrl, { maxBytes, timeoutMs, fetchImpl } = {}) {
  if (!mediaUrl) throw new MediaDownloadError("Media URL отсутствует", "media_url_missing");
  let res;
  try {
    ({ res } = await safeFetch(mediaUrl, {
      timeoutMs,
      maxBytes,
      maxRedirects: 3,
      fetchImpl,
    }));
  } catch (error) {
    if (error instanceof FetchGuardError) {
      throw new MediaDownloadError(error.message, `download_${error.code}`);
    }
    throw new MediaDownloadError(`Сеть: ${error.message}`, "download_network");
  }
  if (!res.ok) throw new MediaDownloadError(`Media URL ответил HTTP ${res.status}`, "download_http_error");

  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new MediaDownloadError(`Неожиданный Content-Type: ${contentType || "не указан"}`, "unexpected_content_type");
  }

  let bytes;
  try {
    bytes = await readLimited(res, maxBytes);
  } catch (error) {
    if (error instanceof FetchGuardError) throw new MediaDownloadError(error.message, `download_${error.code}`);
    throw new MediaDownloadError(`Не удалось прочитать файл: ${error.message}`, "download_read_failed");
  }
  if (!bytes.length) throw new MediaDownloadError("Файл пустой", "download_empty");

  return { bytes, contentType };
}

module.exports = { downloadStoryMedia, MediaDownloadError };
