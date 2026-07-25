// Исследование нового товара: реальный поиск → проверка картинок → разбор моделью.
//
// Порядок принципиален: сначала настоящий инструмент находит страницы и
// изображения, затем мы их проверяем, и только потом модель выбирает лучшее.
// Модель НЕ может добавить ссылку, которой не было во входных данных, — на
// выходе всё пересекается с белым списком (see enforceAllowedUrls).
const config = require("../../config");
const logger = require("../../logger");
const { createResearchProvider, fetchPageImages } = require("./providers");
const { verifyImageUrls } = require("../images");
const { validateResearch } = require("../../lib/validate");
const { RESEARCH_SYSTEM, buildResearchUser } = require("../../prompts");

// Официальные домены брендов — высший приоритет источника.
const OFFICIAL_DOMAINS = {
  sony: ["sony.com", "playstation.com", "sony.ru"],
  playstation: ["playstation.com"],
  nintendo: ["nintendo.com", "nintendo.co.uk"],
  valve: ["valvesoftware.com", "steampowered.com"],
  dji: ["dji.com"],
  philips: ["philips.com", "usa.philips.com"],
  amazon: ["amazon.com", "aboutamazon.com"],
  meta: ["meta.com"],
  fujifilm: ["fujifilm.com", "instax.com"],
  apple: ["apple.com"],
  samsung: ["samsung.com"],
  google: ["store.google.com"],
  xiaomi: ["mi.com", "xiaomi.com"],
};

// Крупные надёжные продавцы — используются, только если официального нет.
const TRUSTED_RETAILERS = [
  "amazon.com", "bestbuy.com", "walmart.com", "target.com",
  "mediamarkt.de", "currys.co.uk", "bhphotovideo.com", "adorama.com",
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function registrable(host) {
  return host.split(".").slice(-2).join(".");
}

// 100 — офсайт бренда, 90 — домен с именем бренда, 40 — крупный ритейл, 10 — прочее.
function sourceScore(url, brand) {
  const host = hostOf(url);
  if (!host) return 0;
  const reg = registrable(host);
  const brandKey = String(brand || "").toLowerCase().replace(/[^a-z]/g, "");
  const official = OFFICIAL_DOMAINS[brandKey] || [];
  if (official.some((d) => host === d || host.endsWith(`.${d}`))) return 100;
  if (brandKey && reg.startsWith(brandKey)) return 90;
  if (TRUSTED_RETAILERS.includes(reg)) return 40;
  return 10;
}

// Модель может вернуть только те URL, что реально были найдены инструментом.
function enforceAllowedUrls(parsed, allowedImages, allowedPages) {
  const imgSet = new Set(allowedImages);
  const pageSet = new Set(allowedPages);
  const dropped = [];

  const keepImage = (u) => {
    if (!u) return null;
    if (imgSet.has(u)) return u;
    dropped.push(u);
    return null;
  };
  const keepPage = (u) => {
    if (!u) return null;
    if (pageSet.has(u)) return u;
    dropped.push(u);
    return null;
  };

  const main = keepImage(parsed.main_image_url);
  const extra = (parsed.image_urls || []).map(keepImage).filter(Boolean);

  return {
    result: {
      ...parsed,
      // Если модель выбрала выдуманный main — берём первый проверенный.
      main_image_url: main || extra[0] || allowedImages[0] || null,
      image_urls: [...new Set([main, ...extra].filter(Boolean))],
      image_source_url: keepPage(parsed.image_source_url) || allowedPages[0] || null,
      source_page_url: keepPage(parsed.source_page_url) || allowedPages[0] || null,
    },
    dropped,
  };
}

class ProductResearchService {
  constructor({ provider, deepseek, db, fetchImpl } = {}) {
    this.provider = provider || createResearchProvider();
    this.deepseek = deepseek || null;
    this.db = db || null;
    this.fetchImpl = fetchImpl;
  }

  _cacheGet(normalizedKey) {
    if (!this.db) return null;
    const row = this.db
      .prepare(
        `SELECT payload, created_at FROM research_cache
         WHERE normalized_key = ?
           AND created_at > datetime('now', ?)`
      )
      .get(normalizedKey, `-${config.research.cacheTtlDays} days`);
    if (!row) return null;
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  }

  _cacheSet(normalizedKey, payload) {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO research_cache (normalized_key, provider, payload)
         VALUES (?, ?, ?)
         ON CONFLICT(normalized_key) DO UPDATE SET
           provider = excluded.provider,
           payload = excluded.payload,
           created_at = datetime('now')`
      )
      .run(normalizedKey, this.provider.name, JSON.stringify(payload));
  }

  /**
   * Полное исследование товара. Никогда не бросает — возвращает статус.
   * @returns {{status:'ok'|'skipped'|'failed', data:object|null, reason?:string}}
   */
  async research(product, normalizedKey) {
    const cached = this._cacheGet(normalizedKey);
    if (cached) {
      logger.debug("research.cache_hit", { key: normalizedKey });
      return { status: "ok", data: cached, cached: true };
    }

    if (!this.provider.available) {
      // Честно ничего не знаем. Ссылки не выдумываем.
      return { status: "skipped", data: null, reason: "research_provider_disabled" };
    }

    try {
      const data = await this._run(product);
      this._cacheSet(normalizedKey, data);
      return { status: "ok", data, cached: false };
    } catch (e) {
      logger.warn("research.failed", { product: product.official_name, error: e.message });
      return { status: "failed", data: null, reason: e.message };
    }
  }

  async _run(product) {
    const name = product.official_name;
    const brand = product.brand;

    // 1. Реальный поиск.
    const queries = [`${name} official product page`, `${name} specifications`];
    const seenUrl = new Set();
    const results = [];
    const providerImages = [];
    for (const q of queries) {
      const r = await this.provider.search(q, { limit: 6 });
      for (const item of r.results || []) {
        if (item.url && !seenUrl.has(item.url)) {
          seenUrl.add(item.url);
          results.push(item);
        }
      }
      for (const img of r.images || []) {
        if (img.url) providerImages.push(img);
      }
    }
    if (!results.length && !providerImages.length) {
      throw new Error("поиск не дал результатов");
    }

    // 2. Сортировка страниц по приоритету источника.
    results.sort((a, b) => sourceScore(b.url, brand) - sourceScore(a.url, brand));
    const topPages = results.slice(0, 4);

    // 3. Изображения со страниц-источников (og:image, JSON-LD, галерея).
    const pageImages = [];
    for (const page of topPages.slice(0, 3)) {
      const imgs = await fetchPageImages(page.url, { fetchImpl: this.fetchImpl });
      pageImages.push(...imgs.slice(0, 8));
    }

    // 4. Кандидаты, отсортированные по приоритету источника.
    const candidates = [...pageImages, ...providerImages]
      .filter((i) => i.url && i.url.startsWith("https://"))
      .sort((a, b) => sourceScore(b.source || b.url, brand) - sourceScore(a.source || a.url, brand));
    const uniqueCandidates = [...new Set(candidates.map((c) => c.url))].slice(0, 14);

    // 5. Проверка: настоящая ли это картинка нужного размера.
    const { good, rejected } = await verifyImageUrls(uniqueCandidates, {
      fetchImpl: this.fetchImpl,
      limit: config.images.maxPerProduct,
    });
    const verifiedUrls = good.map((g) => g.url);
    logger.info("research.images", {
      product: name,
      candidates: uniqueCandidates.length,
      verified: verifiedUrls.length,
      rejected: rejected.length,
    });

    // 6. Модель описывает товар и выбирает лучшие изображения.
    if (!this.deepseek || !this.deepseek.enabled) {
      // Без модели отдаём то, что нашли и проверили, без описания.
      return {
        official_name: name,
        brand,
        model: product.model,
        category: product.category,
        description: null,
        specifications: {},
        main_image_url: verifiedUrls[0] || null,
        image_urls: verifiedUrls,
        image_source_url: topPages[0]?.url || null,
        source_page_url: topPages[0]?.url || null,
        confidence: verifiedUrls.length ? 0.5 : 0.2,
        warning: "описание не сгенерировано: LLM недоступна",
        provider: this.provider.name,
      };
    }

    const parsed = validateResearch(
      await this.deepseek.chatJson({
        system: RESEARCH_SYSTEM,
        user: buildResearchUser(product, {
          pages: topPages.map((p) => ({ title: p.title, url: p.url, snippet: p.snippet })),
          verified_image_urls: verifiedUrls,
        }),
      })
    );

    // 7. Отсекаем всё, чего не было во входных данных.
    const pageUrls = topPages.map((p) => p.url);
    const { result, dropped } = enforceAllowedUrls(parsed, verifiedUrls, pageUrls);
    if (dropped.length) {
      logger.warn("research.hallucinated_urls_dropped", { product: name, dropped });
    }

    return { ...result, provider: this.provider.name };
  }
}

module.exports = { ProductResearchService, sourceScore, enforceAllowedUrls, OFFICIAL_DOMAINS };
