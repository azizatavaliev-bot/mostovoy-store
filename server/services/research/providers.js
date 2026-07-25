// ProductResearchProvider — единственный источник реальных ссылок.
//
// У DeepSeek /chat/completions нет встроенного веб-поиска (проверено по
// api-docs.deepseek.com на 2026-07-24), поэтому факты и URL добывает
// отдельный провайдер с настоящим доступом в интернет, а модель только
// разбирает найденное. Провайдер по умолчанию — none: он честно ничего не
// находит, и товар создаётся со статусом needs_research, без выдуманных ссылок.
const config = require("../../config");
const logger = require("../../logger");
const { safeFetch, readLimited } = require("../../lib/safeFetch");

/**
 * Интерфейс провайдера:
 *   name: string
 *   available: boolean
 *   async search(query, { limit }): Promise<{
 *     results: Array<{ title, url, snippet }>,
 *     images:  Array<{ url, source, title }>
 *   }>
 */

class NullResearchProvider {
  constructor() {
    this.name = "none";
    this.available = false;
  }
  async search() {
    return { results: [], images: [] };
  }
}

class TavilyResearchProvider {
  constructor({ apiKey, timeoutMs, fetchImpl } = {}) {
    this.name = "tavily";
    this.apiKey = apiKey || config.research.tavilyApiKey;
    this.timeoutMs = timeoutMs || config.research.timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.available = Boolean(this.apiKey);
  }

  async search(query, { limit = 6 } = {}) {
    if (!this.available) return { results: [], images: [] };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: limit,
          include_images: true,
          include_image_descriptions: true,
          search_depth: "basic",
        }),
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}`);
      const data = await res.json();
      return {
        results: (data.results || []).map((r) => ({
          title: r.title || "",
          url: r.url,
          snippet: (r.content || "").slice(0, 600),
        })),
        images: (data.images || []).map((img) =>
          typeof img === "string"
            ? { url: img, source: "tavily", title: "" }
            : { url: img.url, source: "tavily", title: img.description || "" }
        ),
      };
    } catch (e) {
      logger.warn("research.tavily_failed", { error: e.message });
      return { results: [], images: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

class BraveResearchProvider {
  constructor({ apiKey, timeoutMs, fetchImpl } = {}) {
    this.name = "brave";
    this.apiKey = apiKey || config.research.braveApiKey;
    this.timeoutMs = timeoutMs || config.research.timeoutMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.available = Boolean(this.apiKey);
  }

  async search(query, { limit = 6 } = {}) {
    if (!this.available) return { results: [], images: [] };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
      const res = await this.fetchImpl(url, {
        headers: { accept: "application/json", "x-subscription-token": this.apiKey },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Brave ${res.status}`);
      const data = await res.json();
      const results = (data.web?.results || []).map((r) => ({
        title: r.title || "",
        url: r.url,
        snippet: (r.description || "").slice(0, 600),
      }));
      // Brave отдаёт превью-картинки, но они мелкие — как кандидаты не годятся,
      // основные изображения тянем со страниц (pageImages).
      return { results, images: [] };
    } catch (e) {
      logger.warn("research.brave_failed", { error: e.message });
      return { results: [], images: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

function createResearchProvider(overrides = {}) {
  const name = overrides.provider || config.research.provider;
  if (name === "tavily") return new TavilyResearchProvider(overrides);
  if (name === "brave") return new BraveResearchProvider(overrides);
  return new NullResearchProvider();
}

// --- Извлечение изображений со страницы-источника -------------------------

const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

// og:image → JSON-LD Product.image → галерея <img>. Строго по разметке страницы.
function extractImagesFromHtml(html, pageUrl) {
  const found = [];
  const push = (u, how) => {
    const abs = absolute(u, pageUrl);
    if (abs && abs.startsWith("https://")) found.push({ url: abs, source: pageUrl, via: how });
  };

  for (const m of html.matchAll(
    /<meta[^>]+(?:property|name)=["'](og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi
  )) {
    const content = m[0].match(/content=["']([^"']+)["']/i);
    if (content) push(content[1], "og:image");
  }

  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node !== "object") return;
        const type = node["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (isProduct && node.image) {
          const imgs = Array.isArray(node.image) ? node.image : [node.image];
          imgs.forEach((i) => push(typeof i === "string" ? i : i?.url, "json-ld"));
        }
        Object.values(node).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {
      /* битый JSON-LD — пропускаем */
    }
  }

  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/(?:data-src|data-original|src)=["']([^"']+)["']/i);
    if (src && IMG_EXT.test(src[1])) push(src[1], "gallery");
  }

  const seen = new Set();
  return found.filter((f) => (seen.has(f.url) ? false : seen.add(f.url)));
}

async function fetchPageImages(pageUrl, { timeoutMs, fetchImpl } = {}) {
  try {
    const { res, url } = await safeFetch(pageUrl, {
      timeoutMs: timeoutMs || config.research.timeoutMs,
      maxBytes: 2 * 1024 * 1024,
      headers: { accept: "text/html,application/xhtml+xml" },
      fetchImpl,
    });
    if (!res.ok) return [];
    const type = res.headers.get("content-type") || "";
    if (!type.includes("html")) return [];
    const body = await readLimited(res, 2 * 1024 * 1024);
    return extractImagesFromHtml(body.toString("utf8"), url);
  } catch (e) {
    logger.debug("research.page_fetch_failed", { pageUrl, error: e.message });
    return [];
  }
}

module.exports = {
  NullResearchProvider,
  TavilyResearchProvider,
  BraveResearchProvider,
  createResearchProvider,
  extractImagesFromHtml,
  fetchPageImages,
};
