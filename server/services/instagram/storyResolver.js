// Оркестратор: ссылка на Instagram Story/Highlight → StoryAnalysis.
// Единственная публичная операция — resolve(url). Никогда не бросает наружу:
// любой сбой на любом шаге даёт { ok: false, story_analysis_failed: true } —
// падение этого сервиса не должно ломать обработку сообщения клиента.
const config = require("../../config");
const logger = require("../../logger");
const { parseInstagramStoryUrl } = require("./parser");
const { downloadStoryMedia, MediaDownloadError } = require("./mediaDownloader");
const { extractFrames, FrameExtractionError } = require("./frameExtractor");
const { analyzeStoryFrames, StoryAnalysisError } = require("./storyAnalyzer");
const { matchCatalog } = require("./catalogMatcher");

// Один и тот же ключ никогда не резолвится параллельно дважды — второй
// запрос ждёт результат первого, а не запускает свой собственный download +
// vision. Тот же приём, что и withLock в server/queue.js, но локально
// (queue.js его не экспортирует, а зависимость ради 10 строк не стоит).
function singleFlight() {
  const inFlight = new Map();
  return function withSingleFlight(key, fn) {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(fn);
    inFlight.set(key, promise);
    promise.finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    return promise;
  };
}

class StoryResolver {
  constructor({ db, hikerClient, ai, cache, fetchImpl } = {}) {
    this.db = db;
    this.hikerClient = hikerClient;
    this.ai = ai;
    this.cache = cache;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this._withSingleFlight = singleFlight();
  }

  get enabled() {
    return Boolean(this.hikerClient?.enabled);
  }

  /**
   * @param {string} url
   * @returns {Promise<{ ok: true, cached: boolean, analysis: object, catalogMatches: Array }
   *                  | { ok: false, story_analysis_failed: true, reason: string }>}
   */
  async resolve(url) {
    const parsed = parseInstagramStoryUrl(url);
    if (!parsed) return null; // не Story/Highlight — резолверу тут нечего делать

    logger.info("instagram_story_detected", { type: parsed.type, cacheKey: parsed.cacheKey });

    if (!this.enabled) {
      logger.warn("instagram_story_failed", { cacheKey: parsed.cacheKey, reason: "not_configured" });
      return { ok: false, story_analysis_failed: true, reason: "not_configured" };
    }

    return this._withSingleFlight(parsed.cacheKey, () => this._resolveUncached(parsed));
  }

  async _resolveUncached(parsed) {
    const cached = this.cache?.get(parsed.cacheKey);
    if (cached) {
      logger.info("instagram_story_cache_hit", { cacheKey: parsed.cacheKey });
      return { ok: true, cached: true, analysis: cached.analysis, catalogMatches: cached.catalogMatches };
    }

    try {
      const story = await this._fetchStory(parsed);
      const media = await this._downloadMedia(parsed, story);
      const frames = await this._buildFrames(parsed, media);
      const analysis = await this._runVision(parsed, frames, story);
      const catalogMatches = this.db ? matchCatalog(this.db, analysis) : [];
      if (catalogMatches.length) {
        logger.info("instagram_story_catalog_match", { cacheKey: parsed.cacheKey, matches: catalogMatches.length });
      }

      const ttlHours = parsed.type === "highlight" ? config.instagram.highlightCacheTtlHours : config.instagram.storyCacheTtlHours;
      this.cache?.set(parsed.cacheKey, { analysis, catalogMatches, created_at: new Date().toISOString() }, ttlHours);

      return { ok: true, cached: false, analysis, catalogMatches };
    } catch (error) {
      const reason = error?.code || "unknown";
      logger.warn("instagram_story_failed", { cacheKey: parsed.cacheKey, reason, message: error?.message });
      return { ok: false, story_analysis_failed: true, reason };
    }
  }

  async _fetchStory(parsed) {
    if (parsed.type === "highlight") {
      const highlight = await this.hikerClient.resolveHighlightByUrl(parsed.normalizedUrl);
      const first = Array.isArray(highlight?.items) ? highlight.items[0] : null;
      if (!first) {
        const error = new Error("Highlight недоступен или пуст");
        error.code = "highlight_unavailable";
        throw error;
      }
      return first;
    }
    const story = await this.hikerClient.resolveStoryByUrl(parsed.normalizedUrl);
    if (!story || (!story.video_url && !story.thumbnail_url)) {
      const error = new Error("Story недоступна (удалена, истекла или не найдена)");
      error.code = "story_unavailable";
      throw error;
    }
    if (story.user?.is_private) {
      const error = new Error("Аккаунт приватный — Story недоступна");
      error.code = "private_account";
      throw error;
    }
    return story;
  }

  async _downloadMedia(parsed, story) {
    const isVideo = Boolean(story.video_url);
    const mediaUrl = isVideo ? story.video_url : story.thumbnail_url;
    if (!mediaUrl) {
      const error = new Error("HikerAPI не вернул media URL");
      error.code = "media_url_missing";
      throw error;
    }
    logger.info("instagram_story_download_started", { cacheKey: parsed.cacheKey, kind: isVideo ? "video" : "photo" });
    let downloaded;
    try {
      downloaded = await downloadStoryMedia(mediaUrl, {
        maxBytes: config.instagram.maxMediaBytes,
        timeoutMs: config.instagram.downloadTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof MediaDownloadError) throw error;
      const wrapped = new Error(error.message);
      wrapped.code = "download_failed";
      throw wrapped;
    }
    logger.info("instagram_story_download_success", { cacheKey: parsed.cacheKey, bytes: downloaded.bytes.length });
    return { ...downloaded, isVideo };
  }

  async _buildFrames(parsed, media) {
    if (!media.isVideo) {
      return [{ bytes: media.bytes, mimeType: media.contentType }];
    }
    let frames;
    try {
      frames = await extractFrames(media.bytes, {
        maxSide: config.instagram.frameMaxSide,
        quality: config.instagram.frameJpegQuality,
        timeoutMs: config.instagram.downloadTimeoutMs,
      });
    } catch (error) {
      if (error instanceof FrameExtractionError) throw error;
      const wrapped = new Error(error.message);
      wrapped.code = "frame_extraction_failed";
      throw wrapped;
    }
    logger.info("instagram_story_frames_extracted", { cacheKey: parsed.cacheKey, frames: frames.length });
    return frames.map((bytes) => ({ bytes, mimeType: "image/jpeg" }));
  }

  async _runVision(parsed, frames, story) {
    const caption = [story?.user?.username ? `Аккаунт: @${story.user.username}` : "", "Опиши, что видно на этих кадрах Story."]
      .filter(Boolean).join("\n");
    let analysis;
    try {
      analysis = await analyzeStoryFrames(this.ai, { images: frames, caption });
    } catch (error) {
      if (error instanceof StoryAnalysisError) throw error;
      const wrapped = new Error(error.message);
      wrapped.code = "vision_failed";
      throw wrapped;
    }
    logger.info("instagram_story_vision_success", { cacheKey: parsed.cacheKey, containsProduct: analysis.contains_product });
    return analysis;
  }
}

module.exports = { StoryResolver };
